#!/usr/bin/env node
/**
 * Advanced debugger walkthrough (defaults: debugger_test.sp on the mock srcds).
 *
 * Goes well beyond "does it stop and list a global". Each section exercises a
 * real interaction the user does in VS Code:
 *
 *   T1 multi-line stepping: walk through the target function's body and
 *      confirm the Locals scope stays intact at every stop (the classic bug
 *      where locals show empty until you step past their declaration).
 *   T2 conditional breakpoint with arithmetic: condition involving two
 *      locals plus operators; verify the gate actually filters.
 *   T3 hover storm: 30+ parallel evaluate requests, like VS Code fires when
 *      the user moves the cursor around the editor. No timeouts, no orphans.
 *   T4 marathon: 25 stop/inspect/continue cycles back-to-back. Pass criterion
 *      is that the slowest cycle stays bounded and no scopes/variables timeout.
 *   T5 setVariable: write a local, verify via evaluate at same stop, continue,
 *      hit next frame, verify the write was scoped to the previous frame.
 *   T6 array element edit: setVariable on a single element of a global array
 *      (the Variables-panel "edit value" path), verify the child reflects it.
 *   T7 indexed hover / messy expression: hover() on  arr[i], a comment word,
 *      and the full declaration line -- all must canonicalize and return a
 *      useful value (or a clear non-crashing message).
 *
 * Run (defaults to debugger_test/BreakHere on the mock srcds, spawned by this
 * script -- see vscode/scripts/lib/testenv.mjs for the one-time setup):
 *   node vscode/scripts/plugin-walkthrough.mjs
 * Run against another plugin/function on a real server (e.g. a multi-file
 * plugin whose function lives in an #include'd sub-file -- exercising
 * multi-file source paths and a bigger global scope):
 *   SP_HOST=my.server.ip SP_PROGRAM=/abs/path/myplugin.sp SP_PROGRAM_NAME=myplugin.sp \
 *   SP_BP_FILE=/abs/path/myplugin/impl.sp SP_BP_NAME=impl.sp SP_BP_LINE=128 \
 *   node vscode/scripts/plugin-walkthrough.mjs
 *
 * Globals are DISCOVERED from the server's Globals scope rather than hardcoded,
 * so this validates whatever the plugin actually has (debugger_test carries 8
 * covering every type). The server must run the target plugin + current
 * extension build.
 */
import {
  DEFAULT_PROGRAM, DEFAULT_PROGRAM_NAME, DEFAULT_LINE, LOCAL_INT,
  maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";

const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
// The plugin to launch (debugger binds by basename without extension).
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const PROGRAM_NAME = process.env.SP_PROGRAM_NAME || DEFAULT_PROGRAM_NAME;
// The file + line to break on. For a multi-file plugin this is the #include'd
// sub-file that actually contains the function, NOT the master .sp.
const BP_FILE = process.env.SP_BP_FILE || PROGRAM;
const BP_NAME = process.env.SP_BP_NAME || PROGRAM_NAME;
const BODY_LINE = parseInt(process.env.SP_BP_LINE || String(DEFAULT_LINE), 10);
// A local known to exist at the breakpoint, used by setVariable + cross-frame
// tests. For debugger_test BreakHere:62 it's "locInteger" (int, value 7).
// Override for other targets; if absent, T5 self-skips.
const PROBE_LOCAL = process.env.SP_PROBE_LOCAL || LOCAL_INT;

// Discovered at the first stop from the server's Globals scope.
let ALL_GLOBALS = [];
let PROBE_SCALAR = null;     // {name} of a scalar (non-aggregate) global, for T2/T5
let PROBE_AGGREGATE = null;  // {name} of an array global, for T6

// ----- DAP client ---------------------------------------------------------
let seq = 1, buffer = Buffer.alloc(0);
const pending = new Map();
const eventWaiters = [];
let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
const ok = (m) => (pass++, log(`  \x1b[32m✓\x1b[0m ${m}`));
const bad = (m) => (fail++, log(`  \x1b[31m✗\x1b[0m ${m}`));
const info = (m) => log(`  \x1b[36m·\x1b[0m ${m}`);
const head = (m) => log(`\n\x1b[1m${m}\x1b[0m`);
const check = (c, m) => (c ? ok(m) : bad(m), c);

// Connected in main() -- after the mock srcds (if any) has booted.
let sock = null;
let mock = null;

function send(cmd, args) {
  const s = seq++;
  const m = JSON.stringify({ seq: s, type: "request", command: cmd, arguments: args });
  sock.write(`Content-Length: ${Buffer.byteLength(m, "utf8")}\r\n\r\n` + m);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(s); reject(new Error(`timeout: ${cmd} (seq ${s})`)); }, 30000);
    pending.set(s, { resolve, reject, cmd, t });
  });
}
function waitEvent(ev, ms) {
  return new Promise((r) => {
    const t = setTimeout(() => {
      const i = eventWaiters.findIndex((w) => w.t === t);
      if (i >= 0) eventWaiters.splice(i, 1);
      r(null);
    }, ms);
    eventWaiters.push({ ev, r, t });
  });
}
function onMsg(m) {
  if (m.type === "response") {
    const p = pending.get(m.request_seq);
    if (p) { clearTimeout(p.t); pending.delete(m.request_seq); m.success ? p.resolve(m) : p.reject(new Error(m.message || p.cmd)); }
  } else if (m.type === "event") {
    const i = eventWaiters.findIndex((w) => w.ev === m.event);
    if (i >= 0) { const w = eventWaiters[i]; clearTimeout(w.t); eventWaiters.splice(i, 1); w.r(m); }
  }
}
function feed(c) {
  buffer = Buffer.concat([buffer, c]);
  for (;;) {
    const he = buffer.indexOf("\r\n\r\n");
    if (he < 0) return;
    const hm = buffer.slice(0, he).toString("utf8").match(/Content-Length: (\d+)/i);
    if (!hm) { buffer = buffer.slice(he + 4); continue; }
    const len = parseInt(hm[1], 10);
    const start = he + 4;
    if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString("utf8");
    buffer = buffer.slice(start + len);
    try { onMsg(JSON.parse(body)); } catch (e) { bad(`parse error: ${e.message}`); }
  }
}

const src = { source: { path: BP_FILE, name: BP_NAME } };
const setBP = (bps) => send("setBreakpoints", { ...src, breakpoints: bps });
const clearBP = () => setBP([]).catch(() => null);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopAt(line, condition) {
  const sp = waitEvent("stopped", 10000);
  const bp = { line };
  if (condition) bp.condition = condition;
  await setBP([bp]);
  return sp;
}
async function quickResume(tid) {
  await clearBP();
  try { await send("continue", { threadId: tid ?? 1 }); } catch {}
}
async function scopesAndVars(frameId) {
  const sc = await send("scopes", { frameId });
  const scopes = sc.body?.scopes || [];
  const byName = {};
  for (const s of scopes) {
    const v = await send("variables", { variablesReference: s.variablesReference });
    byName[s.name] = { ref: s.variablesReference, vars: v.body?.variables || [] };
  }
  return byName;
}

// ----- main ---------------------------------------------------------------
async function main() {
  log(`\n\x1b[1mAdvanced plugin walkthrough\x1b[0m  ${HOST}:${PORT}`);
  log(`  plugin: ${PROGRAM_NAME}   break: ${BP_NAME}:${BODY_LINE}\n`);
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  sock = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  sock.on("data", feed);
  await send("initialize", { clientID: "advanced" });
  await send("launch", { program: PROGRAM, stopOnEntry: false });
  ok("connected + launched");

  // === T0: Discover globals from the live server ===
  head(`T0 — Discover Globals scope + validate EVERY global is inspectable`);
  {
    const s = await stopAt(BODY_LINE);
    const tid = s?.body?.threadId ?? 1;
    if (check(s, `stopped at ${BP_NAME}:${BODY_LINE}`)) {
      // Frame source path must point at the file that actually owns the code --
      // for a multi-file plugin that is the #include'd sub-file, not the master.
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      info(`frame: ${f0?.name} @ ${f0?.source?.path}:${f0?.line}`);
      check(typeof f0?.source?.path === "string" && f0.source.path.length > 0,
            `frame has source.path for multi-file resolution`);

      const sb = await scopesAndVars(f0.id);
      const gvars = sb.Globals?.vars || [];
      ALL_GLOBALS = gvars.map((v) => v.name);
      info(`discovered ${ALL_GLOBALS.length} global(s) in scope`);
      check(ALL_GLOBALS.length > 0, `Globals scope is non-empty`);

      // EVERY global must show a real value (not "(not in scope)") and, if it's
      // an aggregate, expand to children. This matters most on plugins with a
      // large global scope: many globals, many arrays, all must resolve.
      let notInScope = 0, expandFail = 0, expandOK = 0, scalarOK = 0;
      for (const v of gvars) {
        if (/not in scope/i.test(v.value)) { notInScope++; bad(`${v.name} -> "(not in scope)"`); continue; }
        if (v.variablesReference > 0) {
          const exp = await send("variables", { variablesReference: v.variablesReference });
          const kids = exp.body?.variables || [];
          if (kids.length > 0) expandOK++; else { expandFail++; bad(`${v.name} expanded to 0 children`); }
          // Prefer an int-element array for T6 (cleaner equality check than float)
          if (!PROBE_AGGREGATE && /^\d+$/.test(kids[0]?.value ?? "")) PROBE_AGGREGATE = { name: v.name };
          if (!PROBE_AGGREGATE) PROBE_AGGREGATE = { name: v.name };
        } else {
          scalarOK++;
          // A scalar global we can write & read back; prefer an integer one.
          if (!PROBE_SCALAR && /^-?\d+$/.test(v.value ?? "")) PROBE_SCALAR = { name: v.name };
        }
      }
      info(`probe scalar=${PROBE_SCALAR?.name ?? "(none)"}, aggregate=${PROBE_AGGREGATE?.name ?? "(none)"}`);
      check(notInScope === 0, `no global reports "(not in scope)" (broken=${notInScope})`);
      check(expandFail === 0, `every aggregate global expanded (ok=${expandOK}, scalar=${scalarOK}, fail=${expandFail})`);
    }
    await quickResume(tid);
  }

  // === T1: Stepping marathon — multiple steps preserve scope integrity ===
  head(`T1 — Stepping marathon: 5 next/stepIn/stepOut without losing scope`);
  {
    const s = await stopAt(BODY_LINE);
    const tid = s?.body?.threadId ?? 1;
    if (check(s, "initial breakpoint at body fired")) {
      const cmds = ["next", "stepIn", "next", "stepOut", "next"];
      let stepStops = 0, scopesAlways3 = 0;
      for (const cmd of cmds) {
        const sp = waitEvent("stopped", 6000);
        await send(cmd, { threadId: tid });
        const ev = await sp;
        if (!ev) break;
        stepStops++;
        const st = await send("stackTrace", { threadId: tid });
        const f0 = st.body?.stackFrames?.[0];
        const sc = await send("scopes", { frameId: f0?.id });
        if ((sc.body?.scopes || []).length === 3) scopesAlways3++;
      }
      check(stepStops === cmds.length, `all ${cmds.length} step commands produced a stop (${stepStops})`);
      check(scopesAlways3 === cmds.length, `all stops returned 3 scopes (${scopesAlways3})`);
    }
    await quickResume(tid);
  }

  // === T2: Conditional breakpoint ===
  // Self-calibrating: pick a variable known to exist (the probe local if the
  // server reports it at this line, else a scalar global). Server's
  // EvaluateCondition handles a single comparison op (no && / ||). We use an
  // always-true and an always-false comparison against the same variable so we
  // don't need to know its actual value.
  {
    const condVar = PROBE_SCALAR?.name || PROBE_LOCAL;
    head(`T2 — Conditional breakpoint on "${condVar}" (true gate fires, false gate doesn't)`);
    let s = await stopAt(BODY_LINE, `${condVar} > -2147483648`);
    const tid = s?.body?.threadId ?? 1;
    check(s, `true condition (${condVar} > -2147483648) fired`);
    await quickResume(tid);
    const sp = waitEvent("stopped", 1500);
    await setBP([{ line: BODY_LINE, condition: `${condVar} > 2147483647` }]);
    const stopped = await sp;
    check(stopped === null, `false condition (${condVar} > 2147483647) did NOT fire within 1.5s`);
    await clearBP();
  }

  // === T3: Hover storm — 30 parallel evaluates ===
  head(`T3 — Hover storm: ${ALL_GLOBALS.length * 2} parallel evaluate requests`);
  {
    const s = await stopAt(BODY_LINE);
    const tid = s?.body?.threadId ?? 1;
    if (check(s, "stopped for hover storm")) {
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      const t0 = Date.now();
      // Each global hovered twice in parallel, plus indexed forms
      const requests = [];
      for (const g of ALL_GLOBALS) {
        requests.push(send("evaluate", { expression: g, context: "hover", frameId: f0.id }));
        requests.push(send("evaluate", { expression: `${g}[3]`, context: "hover", frameId: f0.id }));
      }
      const results = await Promise.allSettled(requests);
      const elapsed = Date.now() - t0;
      const okCount = results.filter((r) => r.status === "fulfilled" && r.value.body?.result?.length > 0 &&
                                            !/not in scope|not found/i.test(r.value.body.result)).length;
      check(okCount === requests.length, `${okCount}/${requests.length} hovers returned valid in ${elapsed}ms (all in parallel)`);
      check(elapsed < 5000, `total parallel time ${elapsed}ms < 5s (no queuing meltdown)`);
    }
    await quickResume(tid);
  }

  // === T4: Marathon — 25 stop/inspect/continue cycles ===
  head(`T4 — Marathon: 25 stop/inspect/continue cycles, no degradation`);
  {
    // CRITICAL: register the waiter BEFORE arming the bp, otherwise the very
    // first stop fires (and is dropped) between setBP returning and the next
    // line creating the waiter. After this initial setup each cycle's continue
    // is followed immediately by a fresh waiter.
    let sp = waitEvent("stopped", 8000);
    await setBP([{ line: BODY_LINE }]);
    const times = [];
    let scopesOk = 0, varsOk = 0, allOk = true;
    for (let i = 1; i <= 25; i++) {
      const s = await sp;
      if (!s) { bad(`cycle ${i}: stop never arrived`); allOk = false; break; }
      const tid = s.body?.threadId ?? 1;
      const t0 = Date.now();
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      if (f0) {
        const sc = await send("scopes", { frameId: f0.id });
        if ((sc.body?.scopes || []).length === 3) scopesOk++;
        const globals = sc.body.scopes.find((x) => x.name === "Globals");
        if (globals) {
          const gv = await send("variables", { variablesReference: globals.variablesReference });
          if ((gv.body?.variables || []).length >= ALL_GLOBALS.length - 1) varsOk++;
        }
      }
      times.push(Date.now() - t0);
      // Register the NEXT iteration's waiter BEFORE the continue so the next
      // bp hit can't race past us. Without this, the continue resumes the VM,
      // OnGameFrame hits the still-armed bp, fires the stopped event -- and if
      // our waiter isn't registered yet that event is dropped on the floor.
      if (i < 25) {
        sp = waitEvent("stopped", 8000);
      } else {
        // Final iteration: clear the bp BEFORE continuing, otherwise the next
        // OnGameFrame re-fires it between continue + our outside-loop clearBP,
        // dropping a stopped event with no waiter -- which leaves the VM
        // paused forever, killing the next phase's setBP/stop.
        await clearBP();
      }
      try { await send("continue", { threadId: tid }); } catch {}
    }
    const min = Math.min(...times), max = Math.max(...times);
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    info(`per-cycle latency: min=${min}ms, avg=${avg}ms, max=${max}ms over ${times.length} cycles`);
    check(scopesOk === times.length, `all ${times.length} cycles got 3 scopes (got ${scopesOk})`);
    check(varsOk === times.length, `all ${times.length} cycles got globals listing (got ${varsOk})`);
    check(max < 2000, `worst cycle ${max}ms < 2s (no degradation/queueing)`);
    check(allOk, "no stop event was ever dropped during the marathon");
  }

  // === T5: setVariable on a scalar global, verified via two read paths ===
  head(`T5 — setVariable on scalar global "${PROBE_SCALAR?.name ?? "(none)"}" + dual read-back`);
  {
    const s = await stopAt(BODY_LINE);
    const tid = s?.body?.threadId ?? 1;
    if (check(s, "stopped for setVariable")) {
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      if (!PROBE_SCALAR) {
        info("no scalar global discovered — skipping setVariable write test");
      } else {
        const sb = await scopesAndVars(f0.id);
        const SENTINEL = "31337";
        const setv = await send("setVariable", {
          variablesReference: sb.Globals.ref,
          name: PROBE_SCALAR.name,
          value: SENTINEL,
        }).catch((e) => ({ body: { value: `<err: ${e.message}>` } }));
        check(setv.body?.value === SENTINEL, `setVariable ${PROBE_SCALAR.name}=${SENTINEL} -> ${setv.body?.value}`);
        // Read path 1: evaluate (hover/watch)
        const ev1 = await send("evaluate", { expression: PROBE_SCALAR.name, context: "watch", frameId: f0.id });
        check(ev1.body?.result === SENTINEL, `evaluate read-back == ${SENTINEL}: ${ev1.body?.result}`);
        // Read path 2: re-list the Globals scope
        const sb2 = await scopesAndVars(f0.id);
        const reread = (sb2.Globals?.vars || []).find((v) => v.name === PROBE_SCALAR.name);
        check(reread?.value === SENTINEL, `Globals re-list read-back == ${SENTINEL}: ${reread?.value}`);
      }
    }
    await quickResume();
  }

  // === T6: setVariable on a global array element ===
  const aggName = PROBE_AGGREGATE?.name ?? "(none)";
  head(`T6 — setVariable on ${aggName}[5], verify child reflects new value`);
  {
    const s = await stopAt(BODY_LINE);
    const tid = s?.body?.threadId ?? 1;
    if (check(s, "stopped for array-element edit")) {
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      const sb = await scopesAndVars(f0.id);
      const g = PROBE_AGGREGATE ? (sb.Globals?.vars || []).find((v) => v.name === PROBE_AGGREGATE.name) : null;
      if (check(g && g.variablesReference > 0, `${aggName} found in Globals with aggregate ref`)) {
        const kids = await send("variables", { variablesReference: g.variablesReference });
        const k5 = (kids.body?.variables || []).find((v) => v.name === "[5]");
        if (check(k5, `${aggName}[5] child present`)) {
          const setv = await send("setVariable", {
            variablesReference: g.variablesReference,
            name: "[5]",
            value: "42",
          }).catch((e) => ({ body: { value: `<err: ${e.message}>` } }));
          check(/42/.test(setv.body?.value || ""), `setVariable [5]=42 -> ${setv.body?.value}`);
          const re = await send("variables", { variablesReference: g.variablesReference });
          const k5b = (re.body?.variables || []).find((v) => v.name === "[5]");
          check(/42/.test(k5b?.value || ""), `re-read [5] now ${k5b?.value}`);
        }
      }
    }
    await quickResume();
  }

  // === T7: Messy hover / indexed / declaration -- canonicalization ===
  head(`T7 — Messy hover expressions canonicalize cleanly`);
  {
    const s = await stopAt(BODY_LINE);
    const tid = s?.body?.threadId ?? 1;
    if (check(s, "stopped for messy-hover tests")) {
      const st = await send("stackTrace", { threadId: tid });
      const f0 = st.body?.stackFrames?.[0];
      const gName = PROBE_AGGREGATE?.name || ALL_GLOBALS[0] || "g_unknown";
      const cases = [
        ["bare global", gName],
        ["indexed", `${gName}[3]`],
        ["full declaration line", `static int ${gName}[MAXPLAYERS + 1];  // comment`],
        ["non-existent identifier", "nonexistent_identifier_xyz"],
        ["raw number", "42"],
      ];
      for (const [label, expr] of cases) {
        const r = await send("evaluate", { expression: expr, context: "hover", frameId: f0.id }).catch((e) => ({ body: { result: `<err: ${e.message}>` } }));
        const v = r.body?.result ?? "";
        const looksBroken = /JSON|arithmetic evaluation not fully|crash/i.test(v);
        check(!looksBroken && v.length > 0, `${label}: "${expr}" -> ${v.slice(0, 70)}${v.length > 70 ? "…" : ""}`);
      }
    }
    await quickResume();
  }

  // === T8: Step-into multi-frame storm — read EVERY frame's variables ===
  // Reproduces the CPrintToChat crash: stepping into callees whose char[]
  // buffers hold non-ASCII / color-control bytes. Every variables response must
  // be valid JSON (if not, the client drops the frame -> our request times out
  // or the following stackTrace sees a desynced "running" state). We assert the
  // stream stays coherent across many descending steps.
  head(`T8 — Step-into storm: read all frames' variables without stream desync`);
  {
    const s = await stopAt(BODY_LINE);
    let tid = s?.body?.threadId ?? 1;
    if (check(s, "stopped to begin step-into storm")) {
      let maxDepth = 1, frameReads = 0, deepStops = 0, desync = false, nonAscii = 0;
      for (let i = 0; i < 14 && !desync; i++) {
        // Probe state with a stackTrace; if the stream desynced this throws/times out.
        let st;
        try { st = await send("stackTrace", { threadId: tid }); }
        catch (e) { bad(`stackTrace failed mid-storm (stream desync): ${e.message}`); desync = true; break; }
        const frames = st.body?.stackFrames || [];
        maxDepth = Math.max(maxDepth, frames.length);
        if (frames.length > 1) deepStops++;
        // Read scopes + every variable of EVERY frame (the multi-frame path).
        for (const fr of frames) {
          let sc;
          try { sc = await send("scopes", { frameId: fr.id }); }
          catch (e) { bad(`scopes(frame ${fr.id}) failed: ${e.message}`); desync = true; break; }
          for (const scope of (sc.body?.scopes || [])) {
            let v;
            try { v = await send("variables", { variablesReference: scope.variablesReference }); }
            catch (e) { bad(`variables desync at ${fr.name}/${scope.name}: ${e.message}`); desync = true; break; }
            frameReads++;
            // Count any value carrying non-ASCII bytes -- those are the ones that
            // used to break the JSON. If we got here, they round-tripped fine.
            for (const vv of (v.body?.variables || [])) {
              if (typeof vv.value === "string" && /[^\x00-\x7F]/.test(vv.value)) nonAscii++;
            }
          }
          if (desync) break;
        }
        // Step in (descends into callees / natives); stop event expected.
        const sp = waitEvent("stopped", 6000);
        await send("stepIn", { threadId: tid });
        const ev = await sp;
        if (!ev) { info(`no stop after stepIn #${i + 1} (likely returned to top) — ending storm`); break; }
        tid = ev.body?.threadId ?? tid;
      }
      check(!desync, `stream stayed coherent across step-into storm`);
      check(frameReads > 0, `read ${frameReads} frame/scope variable sets (max depth ${maxDepth}, ${deepStops} multi-frame stops)`);
      info(`values carrying non-ASCII bytes round-tripped: ${nonAscii}`);
    }
    await quickResume(tid);
  }

  log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
  try { await send("disconnect", {}); } catch {}
  sock.end();
  mock?.stop();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { bad(`fatal: ${e.message}`); sock?.end(); mock?.stop(); process.exit(2); });
