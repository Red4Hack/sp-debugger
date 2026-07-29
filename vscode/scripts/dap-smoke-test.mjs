#!/usr/bin/env node
/**
 * Headless DAP smoke-test client for the SourcePawn debugger extension.
 *
 * Drives the C++ extension's TCP/DAP server directly (no VS Code), so the
 * debugger pipeline can be validated "via comando". It speaks the exact wire
 * protocol the VS Code adapter uses: Content-Length framed JSON messages with
 * { seq, type:"request", command, arguments }, responses echo `request_seq`.
 *
 * Usage:
 *   node vscode/scripts/dap-smoke-test.mjs [--host H] [--port P] [--program PATH]
 *                                   [--line N] [--no-pause]
 *
 * Phases:
 *   A) SNAPSHOT (non-pausing): sets a logpoint "{@all}" on --line and collects
 *      the output events it emits for a few seconds. Proves the live-observe
 *      feature works WITHOUT freezing the server.
 *   B) PAUSE (classic, freezes): sets a normal breakpoint, waits for `stopped`,
 *      then pulls stackTrace -> scopes -> variables and prints them, then
 *      clears the breakpoint and continues. Skip with --no-pause.
 *
 * Defaults target the repo's test plugin (sp-console-debugger/tests/
 * debugger_test.sp) on the mock srcds, which this script spawns and drives
 * itself (see vscode/scripts/lib/testenv.mjs for the one-time setup). Pass --host to
 * target a real server instead -- then pick a periodically-executing line via
 * --program/--line, and run B only against a TEST server (a real pause
 * freezes the game server until we continue/disconnect).
 */

import path from "node:path";
import {
  DEFAULT_PROGRAM, DEFAULT_LINE, LOCAL_FLOAT, LOCAL_INT, GLOBAL_FLOAT_ARRAY,
  maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";

// ----- args -------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const HOST = arg("host", "127.0.0.1");
const PORT = parseInt(arg("port", "8080"), 10);
const PROGRAM = arg("program", DEFAULT_PROGRAM);
// Line inside BreakHere() that the pumped `bp` command executes continuously,
// with `locFloat`/`locInteger` locals in scope (debugger_test.sp:62 -> the
// first OUTPUT call). Override with --line for another target.
const LINE = parseInt(arg("line", String(DEFAULT_LINE)), 10);
const DO_PAUSE = !argv.includes("--no-pause");
const SNAPSHOT_WINDOW_MS = parseInt(arg("snapshot-ms", "3500"), 10);

// ----- minimal DAP client ----------------------------------------------
let seq = 1;
let buffer = Buffer.alloc(0);
const pending = new Map(); // request_seq -> {resolve, reject, command}
const eventWaiters = []; // {event, resolve, timer}
const log = (...a) => console.log(...a);
const ok = (m) => log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => log(`  \x1b[36m·\x1b[0m ${m}`);

const summary = { pass: 0, fail: 0 };
function check(cond, msg) {
  if (cond) { ok(msg); summary.pass++; } else { bad(msg); summary.fail++; }
  return cond;
}

// Connected in main() -- after the mock srcds (if any) has booted.
let socket = null;
let mock = null;

function send(command, args) {
  const s = seq++;
  const msg = JSON.stringify({ seq: s, type: "request", command, arguments: args });
  const header = `Content-Length: ${Buffer.byteLength(msg, "utf8")}\r\n\r\n`;
  socket.write(header + msg);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(s);
      reject(new Error(`timeout waiting for ${command} (seq ${s})`));
    }, 30000);
    pending.set(s, { resolve, reject, command, timer });
  });
}

function waitForEvent(event, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = eventWaiters.findIndex((w) => w.timer === timer);
      if (i >= 0) eventWaiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    eventWaiters.push({ event, resolve, timer });
  });
}

const outputLog = []; // collected output-event strings
function onMessage(msg) {
  if (msg.type === "response") {
    const p = pending.get(msg.request_seq);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.request_seq);
      msg.success ? p.resolve(msg) : p.reject(new Error(msg.message || `${p.command} failed`));
    }
  } else if (msg.type === "event") {
    if (msg.event === "output" && msg.body && typeof msg.body.output === "string") {
      outputLog.push(msg.body.output.replace(/\n$/, ""));
    }
    // First matching waiter wins.
    const i = eventWaiters.findIndex((w) => w.event === msg.event);
    if (i >= 0) {
      const w = eventWaiters[i];
      clearTimeout(w.timer);
      eventWaiters.splice(i, 1);
      w.resolve(msg);
    }
  }
}

function feed(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const m = header.match(/Content-Length: (\d+)/i);
    if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString("utf8");
    buffer = buffer.slice(start + len);
    try { onMessage(JSON.parse(body)); } catch (e) { bad(`parse error: ${e.message}`); }
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- the test ---------------------------------------------------------
async function main() {
  log(`\n\x1b[1mDAP smoke test\x1b[0m  ${HOST}:${PORT}`);
  log(`  program: ${PROGRAM}`);
  log(`  line:    ${LINE} (${path.basename(PROGRAM)})\n`);

  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  socket = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  socket.on("data", feed);
  check(true, "TCP connected");

  // 1. initialize
  const init = await send("initialize", {
    clientID: "smoke-test", adapterID: "sp-debugger", linesStartAt1: true, columnsStartAt1: true,
  });
  check(init.success, "initialize responded");

  // 2. launch (binds active_plugin BEFORE setBreakpoints -- correct ordering)
  const launch = await send("launch", { program: PROGRAM, stopOnEntry: false });
  check(launch.success, `launch responded (plugin bound: ${path.basename(PROGRAM)})`);

  // ----- Phase A: non-pausing snapshot logpoint -----
  log(`\n\x1b[1m[A] Snapshot ({@all}) — non-pausing\x1b[0m`);
  outputLog.length = 0;
  const snap = await send("setBreakpoints", {
    source: { path: PROGRAM, name: path.basename(PROGRAM) },
    breakpoints: [{ line: LINE, logMessage: "SNAP {@all}" }],
  });
  const snapBp = (snap.body?.breakpoints || [])[0];
  check(snapBp && snapBp.verified, `snapshot breakpoint verified at line ${LINE}`);
  await send("configurationDone", {});
  info(`collecting snapshots for ${SNAPSHOT_WINDOW_MS}ms (server keeps running)...`);
  await delay(SNAPSHOT_WINDOW_MS);
  const snaps = outputLog.filter((s) => s.includes("SNAP "));
  check(snaps.length > 0, `received ${snaps.length} snapshot line(s) without pausing`);
  snaps.slice(0, 5).forEach((s) => info(s));
  if (snaps[0] && !/=/.test(snaps[0])) bad("snapshot produced no name=value pairs");

  // ----- Phase B: classic pause -----
  if (DO_PAUSE) {
    log(`\n\x1b[1m[B] Pause + inspect — freezes server until continue\x1b[0m`);
    const stoppedP = waitForEvent("stopped", 12000);
    const setbp = await send("setBreakpoints", {
      source: { path: PROGRAM, name: path.basename(PROGRAM) },
      breakpoints: [{ line: LINE }],
    });
    const bp0 = (setbp.body?.breakpoints || [])[0];
    check(bp0 && bp0.verified, `breakpoint verified at line ${LINE}`);

    const stopped = await stoppedP;
    if (check(stopped != null, "received 'stopped' event (breakpoint hit)")) {
      const tid = stopped.body?.threadId ?? 1;
      const st = await send("stackTrace", { threadId: tid });
      const frames = st.body?.stackFrames || [];
      check(frames.length > 0, `stackTrace: ${frames.length} frame(s); top=${frames[0]?.name}`);
      if (frames[0]) {
        const sc = await send("scopes", { frameId: frames[0].id });
        const scopes = sc.body?.scopes || [];
        check(scopes.length > 0, `scopes: ${scopes.map((s) => s.name).join(", ")}`);
        for (const scope of scopes) {
          const v = await send("variables", { variablesReference: scope.variablesReference });
          const vars = v.body?.variables || [];
          info(`${scope.name}: ${vars.length} var(s)` +
            (vars.length ? ` — ${vars.slice(0, 6).map((x) => `${x.name}=${x.value}`).join(", ")}` : ""));
        }
      }
      // Evaluate sub-test: hover/watch must rescue messy expressions. The
      // common offender is a hover on a declaration line, which arrives with
      // type keywords and a comment attached. The server should canonicalize
      // and still return the variable's value, not "<arithmetic ...>" garbage.
      if (frames[0]) {
        const fid = frames[0].id;
        const cases = [
          ["bare name", GLOBAL_FLOAT_ARRAY],
          ["indexed", `${GLOBAL_FLOAT_ARRAY}[3]`],
          ["declaration line", `float ${GLOBAL_FLOAT_ARRAY}[20] = { 43.43, ... }; // hover on a declaration line`],
        ];
        for (const [label, expr] of cases) {
          const ev = await send("evaluate", { expression: expr, context: "hover", frameId: fid }).catch((e) => ({ body: { result: `<error: ${e.message}>` } }));
          const out = ev.body?.result ?? "";
          const bad = /not fully implemented|not supported|variable not found/i.test(out);
          check(!bad && out.length > 0, `evaluate(${label}) -> ${out.slice(0, 80)}${out.length > 80 ? "…" : ""}`);
        }
      }
    }
    // Clear breakpoints and resume so the server unfreezes.
    await send("setBreakpoints", { source: { path: PROGRAM, name: path.basename(PROGRAM) }, breakpoints: [] });
    try { await send("continue", { threadId: 1 }); } catch {}
    ok("cleared breakpoints and continued (server resumed)");

    // Helpers reused across Phases C-G.
    const sourceArg = { source: { path: PROGRAM, name: path.basename(PROGRAM) } };
    const setBP = (bps) => send("setBreakpoints", { ...sourceArg, breakpoints: bps });
    const clearBP = () => setBP([]).catch(() => {});
    const resumeAndClear = async (tid) => {
      await clearBP();
      try { await send("continue", { threadId: tid ?? 1 }); } catch {}
    };
    const stopThen = async (label, cmd, args, timeoutMs = 6000) => {
      const sp = waitForEvent("stopped", timeoutMs);
      await send(cmd, args);
      const s = await sp;
      check(s != null, `${label}: stopped received` + (s ? ` (reason=${s.body?.reason})` : ""));
      return s;
    };

    // ----- Phase C: Stepping (next / stepIn / stepOut) -----
    log(`\n\x1b[1m[C] Stepping — next / stepIn / stepOut\x1b[0m`);
    let sP = waitForEvent("stopped", 8000);
    await setBP([{ line: LINE }]);
    const bC = await sP;
    if (check(bC != null, "C0: breakpoint hit (setup)")) {
      const tid = bC.body?.threadId ?? 1;
      await stopThen("C1 next",   "next",    { threadId: tid });
      await stopThen("C2 stepIn", "stepIn",  { threadId: tid });
      await stopThen("C3 stepOut","stepOut", { threadId: tid });
      await resumeAndClear(tid);
    } else {
      await resumeAndClear();
    }

    // ----- Phase D: Conditional breakpoint -----
    log(`\n\x1b[1m[D] Conditional breakpoint\x1b[0m`);
    // False condition: should NOT fire. Await the waiter to completion (so it
    // self-cleans before D2's waiter goes up -- otherwise a stale leftover
    // waiter steals D2's stopped event).
    const setD1 = await setBP([{ line: LINE, condition: `${LOCAL_FLOAT} > 999999` }]);
    check((setD1.body?.breakpoints || [])[0]?.verified, `D0: bp verified with condition '${LOCAL_FLOAT} > 999999'`);
    const falseResult = await waitForEvent("stopped", 1500);
    check(falseResult === null, `D1: false condition did NOT trigger stop`);
    await clearBP();
    // True condition: should fire (locFloat is 8.0 at this line).
    await stopThen("D2 true cond", "setBreakpoints", { ...sourceArg, breakpoints: [{ line: LINE, condition: `${LOCAL_FLOAT} > 0` }] }, 5000);
    await resumeAndClear();

    // ----- Phase E: Hit-count breakpoint -----
    log(`\n\x1b[1m[E] Hit-count breakpoint (hitCondition: "3")\x1b[0m`);
    // The mock pump issues `bp` every ~100ms; 3rd hit ~300ms after the
    // breakpoint arms. Cleared from D so the counter starts fresh on this bp.
    const setE = await stopThen("E1", "setBreakpoints", { ...sourceArg, breakpoints: [{ line: LINE, hitCondition: "3" }] }, 4000);
    if (setE) ok("E2: stop on 3rd hit (hitCondition honored)");
    await resumeAndClear();

    // ----- Phase F: Async pause request -----
    log(`\n\x1b[1m[F] Async pause request\x1b[0m`);
    await clearBP();
    await delay(250);
    // The pause request -- like F6 in VS Code -- should freeze the running VM
    // and emit a stopped event without any breakpoint configured.
    await stopThen("F1 pause", "pause", { threadId: 1 }, 5000);
    try { await send("continue", { threadId: 1 }); } catch {}
    ok("F2: resumed after pause");

    // ----- Phase G: setVariable + evaluate(watch/repl) -----
    log(`\n\x1b[1m[G] setVariable + evaluate contexts\x1b[0m`);
    sP = waitForEvent("stopped", 6000);
    await setBP([{ line: LINE }]);
    const gStop = await sP;
    if (check(gStop != null, "G0: breakpoint hit (setup)")) {
      const tid = gStop.body?.threadId ?? 1;
      const st = await send("stackTrace", { threadId: tid });
      const fid = st.body?.stackFrames?.[0]?.id;
      const sc = await send("scopes", { frameId: fid });
      const localsScope = (sc.body?.scopes || []).find((s) => /local/i.test(s.name));
      check(localsScope, "G1: Locals scope located");
      if (localsScope) {
        // Flip locFloat to a sentinel value; if setVariable works, evaluate
        // (same frame) reads back the new value.
        const setv = await send("setVariable", {
          variablesReference: localsScope.variablesReference,
          name: LOCAL_FLOAT,
          value: "999.5",
        }).catch((e) => ({ body: { value: `<err: ${e.message}>` } }));
        const newVal = setv.body?.value ?? "";
        check(/999/.test(newVal), `G2: setVariable ${LOCAL_FLOAT}=999.5 -> server reports ${newVal}`);
        const verify = await send("evaluate", { expression: LOCAL_FLOAT, context: "watch", frameId: fid })
          .catch((e) => ({ body: { result: `<err: ${e.message}>` } }));
        check(/999/.test(verify.body?.result ?? ""), `G3: evaluate(watch) ${LOCAL_FLOAT} -> ${verify.body?.result}`);
      }
      // Also exercise context: "repl" (Debug Console input).
      const repl = await send("evaluate", { expression: LOCAL_INT, context: "repl", frameId: fid })
        .catch((e) => ({ body: { result: `<err: ${e.message}>` } }));
      check((repl.body?.result ?? "").length > 0 && !/not supported|not found/i.test(repl.body.result),
            `G4: evaluate(repl) ${LOCAL_INT} -> ${repl.body?.result}`);
      await resumeAndClear(tid);
    } else {
      await resumeAndClear();
    }

    // ----- Phase H: UI integrity (stackFrame fields + variable expansion) -----
    log(`\n\x1b[1m[H] UI integrity — stackFrame fields + Variables expansion\x1b[0m`);
    sP = waitForEvent("stopped", 6000);
    await setBP([{ line: LINE }]);
    const hStop = await sP;
    if (check(hStop != null, "H0: breakpoint hit (setup)")) {
      const tid = hStop.body?.threadId ?? 1;
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      // Every field the VS Code Call Stack panel relies on to render and to
      // make the entry clickable. Missing source.path = the user can't jump.
      check(typeof f0?.id === "number", `H1: stackFrame.id is number (${f0?.id})`);
      check(typeof f0?.name === "string" && f0.name.length > 0, `H2: stackFrame.name "${f0?.name}"`);
      check(typeof f0?.line === "number" && f0.line > 0, `H3: stackFrame.line ${f0?.line} > 0`);
      check(typeof f0?.column === "number", `H4: stackFrame.column ${f0?.column}`);
      check(f0?.source && typeof f0.source.name === "string", `H5: source.name "${f0?.source?.name}"`);
      check(f0?.source && typeof f0.source.path === "string" && f0.source.path.length > 0, `H6: source.path "${f0?.source?.path}"`);
      check(f0?.presentationHint === "normal" || f0?.presentationHint === "subtle", `H7: presentationHint "${f0?.presentationHint}"`);

      // Variables expansion: in the UI, clicking ">" on an aggregate variable
      // fires a variables request with that var's variablesReference. Children
      // must come back, otherwise the user sees no array contents.
      const sc = await send("scopes", { frameId: f0.id });
      const globals = (sc.body?.scopes || []).find((s) => /global/i.test(s.name));
      if (globals) {
        const gv = await send("variables", { variablesReference: globals.variablesReference });
        const arrVar = (gv.body?.variables || []).find((v) => /[{[]/.test(v.value || "") && v.variablesReference > 0);
        if (arrVar) {
          const exp = await send("variables", { variablesReference: arrVar.variablesReference });
          const kids = exp.body?.variables || [];
          check(kids.length > 0, `H8: expand ${arrVar.name} -> ${kids.length} child(ren), first: ${kids[0]?.name}=${kids[0]?.value}`);
        } else {
          bad("H8: no aggregate variable found in Globals to expand");
        }
      }
      await resumeAndClear(tid);
    } else {
      await resumeAndClear();
    }

    // ----- Phase I: Data breakpoint (watchpoint) -----
    log(`\n\x1b[1m[I] Data breakpoint — dataBreakpointInfo + setDataBreakpoints\x1b[0m`);
    sP = waitForEvent("stopped", 6000);
    await setBP([{ line: LINE }]);
    const iStop = await sP;
    if (check(iStop != null, "I0: breakpoint hit (setup)")) {
      const tid = iStop.body?.threadId ?? 1;
      const st = await send("stackTrace", { threadId: tid });
      const fid = st.body?.stackFrames?.[0]?.id;
      const sc = await send("scopes", { frameId: fid });
      const locals = (sc.body?.scopes || []).find((s) => /local/i.test(s.name));

      // VS Code flow: right-click variable -> Break on Value Change:
      //   1) dataBreakpointInfo(name, variablesReference) -> dataId
      //   2) setDataBreakpoints(breakpoints: [{ dataId, accessType: "write" }])
      const info_ = await send("dataBreakpointInfo", {
        name: LOCAL_FLOAT,
        variablesReference: locals?.variablesReference,
      }).catch((e) => ({ body: { dataId: null, error: e.message } }));
      const dataId = info_.body?.dataId;
      check(typeof dataId === "string" && dataId.length > 0,
            `I1: dataBreakpointInfo(${LOCAL_FLOAT}) -> dataId="${dataId}"` +
            (info_.body?.description ? ` (${info_.body.description})` : ""));

      if (dataId) {
        const setdbp = await send("setDataBreakpoints", {
          breakpoints: [{ dataId, accessType: "write" }],
        }).catch((e) => ({ body: { breakpoints: [{ verified: false, message: e.message }] } }));
        const w0 = (setdbp.body?.breakpoints || [])[0];
        check(w0?.verified === true,
              `I2: setDataBreakpoints verified="${w0?.verified}"` +
              (w0?.message ? ` (${w0.message})` : ""));
        // Clear watches so they don't leak into later phases.
        await send("setDataBreakpoints", { breakpoints: [] }).catch(() => {});
      }
      await resumeAndClear(tid);
    } else {
      await resumeAndClear();
    }

    // ----- Phase J: readMemory -----
    log(`\n\x1b[1m[J] readMemory\x1b[0m`);
    sP = waitForEvent("stopped", 6000);
    await setBP([{ line: LINE }]);
    const jStop = await sP;
    if (check(jStop != null, "J0: breakpoint hit (setup)")) {
      const tid = jStop.body?.threadId ?? 1;
      // VS Code's hex memory viewer sends a memoryReference (typically a
      // hex/decimal cell address) and a byte count. With a plugin paused, any
      // small read from a valid VM cell should return base64 bytes.
      // We use a low-but-plausible address; the handler base64-encodes whatever
      // it can read or returns an error gracefully.
      const rm = await send("readMemory", {
        memoryReference: "0x100",
        offset: 0,
        count: 16,
      }).catch((e) => ({ body: { error: e.message } }));
      const data = rm.body?.data ?? "";
      const addr = rm.body?.address ?? "";
      const unread = rm.body?.unreadableBytes;
      const ok = typeof data === "string" && (data.length > 0 || typeof unread === "number");
      check(ok, `J1: readMemory addr=${addr} data.len=${data.length}` +
            (unread !== undefined ? ` unreadable=${unread}` : "") +
            (rm.body?.error ? ` (${rm.body.error})` : ""));
      await resumeAndClear(tid);
    } else {
      await resumeAndClear();
    }

    // ----- Phase K: Stress — repeated expand-globals + step cycle -----
    // Reproduces the user's pattern: stop, list scopes/variables, expand every
    // expandable global, step (next), repeat. The freeze we're chasing was a
    // 30s+ timeout on scopes/stackTrace after several iterations. Pass = the
    // whole cycle stays responsive (no individual call exceeds 5s).
    log(`\n\x1b[1m[K] Stress — N iterations of stop/expand-globals/step/continue\x1b[0m`);
    const ITERS = 6;
    let stressOK = true;
    let slowest = 0, slowestOp = "";
    await setBP([{ line: LINE }]);
    // Pre-register the first waiter before the bp can fire; subsequent waiters
    // are registered before each continue (below) so a re-fire is never missed.
    let sPk = waitForEvent("stopped", 8000);
    for (let it = 1; it <= ITERS; it++) {
      const s = await sPk;
      if (!s) { bad(`K${it}: stopped never arrived`); stressOK = false; break; }
      const tid = s.body?.threadId ?? 1;

      const t0 = Date.now();
      const st = await send("stackTrace", { threadId: tid });
      const fid = st.body?.stackFrames?.[0]?.id;
      const sc = await send("scopes", { frameId: fid });
      const globals = (sc.body?.scopes || []).find((g) => /global/i.test(g.name));
      let expanded = 0;
      if (globals) {
        const gv = await send("variables", { variablesReference: globals.variablesReference });
        const aggregates = (gv.body?.variables || [])
          .filter((v) => v.variablesReference > 0)
          .slice(0, 4);
        for (const a of aggregates) {
          await send("variables", { variablesReference: a.variablesReference });
          expanded++;
        }
      }
      const elapsed = Date.now() - t0;
      if (elapsed > slowest) { slowest = elapsed; slowestOp = `iter ${it}`; }
      info(`K${it}: stack+scopes+globals+${expanded}× expand in ${elapsed}ms`);
      if (elapsed > 5000) {
        bad(`K${it}: cycle exceeded 5s -- starting to back up`);
        stressOK = false;
      }
      // Step then continue: each cycle pauses at the bp, inspects, steps once,
      // resumes the VM so the bp can re-fire on the next pumped `bp` command.
      const stepP = waitForEvent("stopped", 5000);
      await send("next", { threadId: tid });
      await stepP;
      if (it === ITERS) {
        // Final iteration: clear the bp BEFORE continuing so it can't re-fire
        // into a waiter-less stopped event and wedge the VM for the next phase.
        await clearBP();
      } else {
        // Register the next iteration's waiter BEFORE the continue, so the bp
        // re-fire's stopped event can't slip through before we're listening.
        sPk = waitForEvent("stopped", 8000);
      }
      try { await send("continue", { threadId: tid }); } catch {}
    }
    await clearBP();
    check(stressOK, `K final: ${ITERS} iterations stayed responsive (slowest=${slowest}ms @ ${slowestOp})`);

    // ----- Phase L: Debug Console REPL (evaluate context:"repl") -----
    log(`\n\x1b[1m[L] Debug Console REPL — typed commands\x1b[0m`);
    {
      const sp = waitForEvent("stopped", 6000);
      await setBP([{ line: LINE }]);
      const s = await sp;
      if (check(s != null, "L0: breakpoint hit (setup)")) {
        const tid = s.body?.threadId ?? 1;
        const st = await send("stackTrace", { threadId: tid });
        const fid = st.body?.stackFrames?.[0]?.id;
        const repl = async (expr) => {
          const r = await send("evaluate", { expression: expr, context: "repl", frameId: fid })
            .catch((e) => ({ body: { result: `<error: ${e.message}>` } }));
          return r.body?.result ?? "";
        };
        const cases = [
          ["bt", /stack trace|BreakHere|#?0/i],
          ["backtrace", /stack trace|BreakHere/i],
          ["files", /debugger_test|\.sp|\.inc/i],
          ["funcs", /BreakHere|Command_Bp|\w+/],
          [`p ${LOCAL_INT}`, /\d/],
          ["?", /\w/],
        ];
        for (const [cmd, re] of cases) {
          const out = await repl(cmd);
          const oneline = out.replace(/\s+/g, " ").slice(0, 70);
          check(re.test(out) && !/^<error/.test(out), `repl "${cmd}" -> ${oneline}${out.length > 70 ? "…" : ""}`);
        }
        // Execution-control command must be refused with a hint, not run.
        const blocked = await repl("continue");
        check(/toolbar|desync|execution control/i.test(blocked), `repl "continue" refused -> ${blocked.slice(0, 60)}…`);
        // A bare variable name in the REPL still evaluates as a value.
        const bareVar = await repl(LOCAL_INT);
        check(/\d/.test(bareVar) && !/toolbar/i.test(bareVar), `repl bare "${LOCAL_INT}" -> ${bareVar}`);
      }
      await resumeAndClear();
    }
    // (A former Phase M tested the loadedSources request; the server dropped
    // support for it -- the "files" REPL command above covers that ground.)
  } else {
    info("\n[B] pause phase skipped (--no-pause)");
  }

  // teardown
  await send("setBreakpoints", { source: { path: PROGRAM, name: path.basename(PROGRAM) }, breakpoints: [] }).catch(() => {});
  try { await send("disconnect", { terminateDebuggee: false }); } catch {}
}

main()
  .then(() => {
    log(`\n\x1b[1mResult:\x1b[0m ${summary.pass} passed, ${summary.fail} failed\n`);
    socket?.end();
    mock?.stop();
    process.exit(summary.fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    bad(`\nfatal: ${e.message}`);
    socket?.end();
    mock?.stop();
    process.exit(2);
  });
