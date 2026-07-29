#!/usr/bin/env node
/**
 * Verifies the server emits step events in the correct wire order:
 * continued-then-stopped, NEVER stopped-then-continued. The reorder bug left
 * the adapter stuck in "running" state with a paused UI ("Cannot get ... -
 * debugger state: running"). Root cause was SetRunmode waking the VM thread
 * (which emits "stopped") before the "continued" event was flushed.
 *
 * Talks directly to the server TCP (bypasses the adapter), so it observes the
 * raw event order. Steps rapidly N times and flags any cycle where a "stopped"
 * is followed by a "continued" for the same step (the reorder).
 */
import {
  DEFAULT_PROGRAM, DEFAULT_PROGRAM_NAME, DEFAULT_LINE,
  maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";
const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const BP_FILE = process.env.SP_BP_FILE || PROGRAM;
const BP_NAME = process.env.SP_BP_NAME || DEFAULT_PROGRAM_NAME;
const LINE = parseInt(process.env.SP_BP_LINE || String(DEFAULT_LINE), 10);
// BreakHere + its caller offer ~35 steppable lines from the default bp; the
// loop tolerates stepping off the end (it just stops early).
const STEPS = parseInt(process.env.SP_STEPS || "25", 10);

let seq = 1, buffer = Buffer.alloc(0);
const pending = new Map();
const eventLog = []; // chronological list of {kind}
const waiters = [];
let sock = null; // connected in main() after the mock srcds (if any) is up
let mock = null;

function send(cmd, args) {
  const s = seq++;
  const m = JSON.stringify({ seq: s, type: "request", command: cmd, arguments: args });
  sock.write(`Content-Length: ${Buffer.byteLength(m, "utf8")}\r\n\r\n` + m);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(s); rej(new Error(`timeout ${cmd}`)); }, 15000);
    pending.set(s, { res, t });
  });
}
function waitFor(kind, ms) {
  return new Promise((r) => {
    const t = setTimeout(() => {
      const i = waiters.findIndex((w) => w.t === t); if (i >= 0) waiters.splice(i, 1); r(null);
    }, ms);
    waiters.push({ kind, r, t });
  });
}
function feed(c) {
  buffer = Buffer.concat([buffer, c]);
  for (;;) {
    const he = buffer.indexOf("\r\n\r\n"); if (he < 0) return;
    const hm = buffer.toString("latin1", 0, he).match(/Content-Length: (\d+)/i);
    if (!hm) { buffer = buffer.subarray(he + 4); continue; }
    const len = +hm[1], st = he + 4; if (buffer.length < st + len) return;
    const body = buffer.toString("utf8", st, st + len); buffer = buffer.subarray(st + len);
    let m; try { m = JSON.parse(body); } catch { continue; }
    if (m.type === "response") { const p = pending.get(m.request_seq); if (p) { clearTimeout(p.t); pending.delete(m.request_seq); p.res(m); } }
    else if (m.type === "event") {
      if (m.event === "stopped" || m.event === "continued") eventLog.push(m.event);
      const i = waiters.findIndex((w) => w.kind === m.event);
      if (i >= 0) { const w = waiters[i]; clearTimeout(w.t); waiters.splice(i, 1); w.r(m); }
    }
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  sock = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  sock.on("data", feed);
  await send("initialize", { clientID: "step-order" });
  await send("launch", { program: PROGRAM, stopOnEntry: false });
  const sp = waitFor("stopped", 10000);
  await send("setBreakpoints", { source: { path: BP_FILE, name: BP_NAME }, breakpoints: [{ line: LINE }] });
  const first = await sp;
  if (!first) { console.log("\x1b[31m✗ never hit initial breakpoint\x1b[0m"); process.exit(2); }
  let tid = first.body?.threadId ?? 1;
  console.log(`stepping ${STEPS}× and checking continued/stopped wire order...\n`);

  let reorders = 0, cycles = 0, missingContinued = 0;
  for (let i = 0; i < STEPS; i++) {
    eventLog.length = 0;
    const stopP = waitFor("stopped", 6000);
    await send("stepIn", { threadId: tid });
    const ev = await stopP;
    if (!ev) { console.log(`  step ${i + 1}: no stopped event`); break; }
    tid = ev.body?.threadId ?? tid;
    // Give any trailing (reordered) continued a moment to arrive.
    await delay(40);
    cycles++;
    // eventLog should be exactly ["continued","stopped"]. A reorder shows as
    // ["stopped","continued"] or a trailing continued after stopped.
    const stoppedIdx = eventLog.indexOf("stopped");
    const continuedIdx = eventLog.indexOf("continued");
    if (continuedIdx === -1) {
      missingContinued++;
    } else if (stoppedIdx !== -1 && continuedIdx > stoppedIdx) {
      reorders++;
      console.log(`  \x1b[31m✗ cycle ${i + 1}: REORDER -> [${eventLog.join(", ")}]\x1b[0m`);
    }
  }

  console.log(`\n  cycles: ${cycles}`);
  console.log(`  reorders (stopped-before-continued): ${reorders}`);
  console.log(`  cycles missing continued entirely:   ${missingContinued}`);
  const ok = reorders === 0;
  console.log(`\n\x1b[1m${ok ? "\x1b[32mPASS: continued always precedes stopped\x1b[0m" : "\x1b[31mFAIL: event reorder detected\x1b[0m"}\x1b[0m`);

  await send("setBreakpoints", { source: { path: BP_FILE, name: BP_NAME }, breakpoints: [] }).catch(() => {});
  try { await send("continue", { threadId: tid }); } catch {}
  try { await send("disconnect", {}); } catch {}
  sock.end();
  mock?.stop();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.log(`\x1b[31mfatal: ${e.message}\x1b[0m`); sock?.end(); mock?.stop(); process.exit(2); });
