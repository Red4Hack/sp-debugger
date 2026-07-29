#!/usr/bin/env node
/**
 * Advanced logpoint test. Logpoints observe a running plugin WITHOUT pausing:
 * the server formats the message, emits an `output` event, and keeps running.
 * This exercises every logMessage form and checks the rendered output, plus
 * verifies logpoints never freeze (many fire per second) and honor
 * conditions / hit counts.
 *
 * Talks directly to the server TCP. Defaults target debugger_test BreakHere:62
 * on the mock srcds (spawned by this script; the pumped `bp` command keeps the
 * line firing) with locals locInteger/locFloat and globals g_IntArray (int[]),
 * g_FloatArray (float[]). Point SP_HOST at a real server to test elsewhere.
 */
import {
  DEFAULT_PROGRAM, DEFAULT_PROGRAM_NAME, DEFAULT_LINE, LOCAL_INT, LOCAL_FLOAT,
  GLOBAL_INT_ARRAY, GLOBAL_FLOAT_ARRAY, maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";
const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const NAME = process.env.SP_PROGRAM_NAME || DEFAULT_PROGRAM_NAME;
const LINE = parseInt(process.env.SP_BP_LINE || String(DEFAULT_LINE), 10);

let seq = 1, buffer = Buffer.alloc(0);
const pending = new Map();
const outputs = []; // collected output-event strings
let sock = null; // connected in main() after the mock srcds (if any) is up
let mock = null;
let pass = 0, fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`));
const bad = (m) => (fail++, console.log(`  \x1b[31m✗\x1b[0m ${m}`));
const info = (m) => console.log(`  \x1b[36m·\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

function send(cmd, args) {
  const s = seq++;
  const m = JSON.stringify({ seq: s, type: "request", command: cmd, arguments: args });
  sock.write(`Content-Length: ${Buffer.byteLength(m, "utf8")}\r\n\r\n` + m);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(s); rej(new Error(`timeout ${cmd}`)); }, 15000);
    pending.set(s, { res, t });
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
    else if (m.type === "event" && m.event === "output" && m.body?.output != null) {
      outputs.push(String(m.body.output).replace(/\n$/, ""));
    }
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const src = { source: { path: PROGRAM, name: NAME } };

// Set a single logpoint and collect what it prints over `ms`.
async function logpoint(bp, ms = 900) {
  outputs.length = 0;
  const r = await send("setBreakpoints", { ...src, breakpoints: [bp] });
  const verified = (r.body?.breakpoints || [])[0]?.verified;
  await send("configurationDone", {}).catch(() => {});
  await delay(ms);
  await send("setBreakpoints", { ...src, breakpoints: [] }).catch(() => {});
  await delay(60);
  return { verified, lines: outputs.slice() };
}
// Most-recent matching line (logpoints fire many times; take a settled one).
const sample = (lines, needle) => lines.filter((l) => !needle || l.includes(needle)).slice(-1)[0] || "";

async function main() {
  console.log(`\n\x1b[1mAdvanced logpoint test\x1b[0m  ${HOST}:${PORT}  ${NAME}:${LINE}`);
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  sock = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  sock.on("data", feed);
  await send("initialize", { clientID: "logpoint-test" });
  await send("launch", { program: PROGRAM, stopOnEntry: false });

  // T1: literal text only
  head("T1 — literal text");
  {
    const { verified, lines } = await logpoint({ line: LINE, logMessage: "hello-logpoint" });
    ok(`verified=${verified}`);
    (lines.length > 0 ? ok : bad)(`fired ${lines.length}×, sample: "${sample(lines)}"`);
    (sample(lines) === "hello-logpoint" ? ok : bad)(`literal text exact: "${sample(lines)}"`);
  }

  // T2: scalar local interpolation (float)
  head(`T2 — scalar local {${LOCAL_FLOAT}}`);
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `ct={${LOCAL_FLOAT}}` });
    const s = sample(lines, "ct=");
    (/^ct=\d/.test(s) && !s.includes("{") ? ok : bad)(`interpolated: "${s}"`);
  }

  // T3: multiple expressions + text
  head(`T3 — mixed: dt={${LOCAL_INT}} ct={${LOCAL_FLOAT}}`);
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `dt={${LOCAL_INT}} ct={${LOCAL_FLOAT}}` });
    const s = sample(lines, "dt=");
    (/dt=[\d.]+ ct=[\d.]+/.test(s) && !s.includes("{") ? ok : bad)(`both interpolated: "${s}"`);
  }

  // T4: snapshot {@all}
  head("T4 — snapshot {@all}");
  {
    const { lines } = await logpoint({ line: LINE, logMessage: "SNAP {@all}" });
    const s = sample(lines, "SNAP");
    (new RegExp(`${LOCAL_FLOAT}=`).test(s) && new RegExp(`${LOCAL_INT}=`).test(s) ? ok : bad)(`snapshot locals: "${s.slice(0, 80)}"`);
  }

  // T5: global array element {g_IntArray[0]}  (the per-player case)
  head(`T5 — global array element {${GLOBAL_INT_ARRAY}[0]}`);
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `v0={${GLOBAL_INT_ARRAY}[0]}` });
    const s = sample(lines, "v0=");
    (/^v0=-?\d+$/.test(s) ? ok : bad)(`element resolved (not literal): "${s}"`);
  }

  // T6: float global array element {g_FloatArray[2]}
  head(`T6 — float array element {${GLOBAL_FLOAT_ARRAY}[2]}`);
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `r2={${GLOBAL_FLOAT_ARRAY}[2]}` });
    const s = sample(lines, "r2=");
    (/^r2=[\d.]+$/.test(s) ? ok : bad)(`float element: "${s}"`);
  }

  // T7: whole global array {g_IntArray}  -> ideally a {..} preview
  head(`T7 — whole array {${GLOBAL_INT_ARRAY}}`);
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `arr={${GLOBAL_INT_ARRAY}}` });
    const s = sample(lines, "arr=");
    (/arr=\{.*\}/.test(s) ? ok : bad)(`array preview (not single int): "${s.slice(0, 70)}"`);
  }

  // T8: unresolved expression -> kept literal, no crash
  head("T8 — unresolved {nonexistent_xyz}");
  {
    const { lines } = await logpoint({ line: LINE, logMessage: "x={nonexistent_xyz}" });
    const s = sample(lines, "x=");
    (/x=\{nonexistent_xyz\}|x=<.*>/.test(s) ? ok : bad)(`graceful unresolved: "${s}"`);
  }

  // T9: conditional logpoint (false) must NOT log
  head("T9 — conditional logpoint, false condition");
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `COND {${LOCAL_FLOAT}}`, condition: `${LOCAL_FLOAT} > 999999999` });
    (lines.filter((l) => l.includes("COND")).length === 0 ? ok : bad)(`false condition suppressed logging (${lines.length} lines)`);
  }

  // T10: conditional logpoint (true) must log
  head("T10 — conditional logpoint, true condition");
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `COND2 {${LOCAL_FLOAT}}`, condition: `${LOCAL_FLOAT} > 0` });
    (lines.filter((l) => l.includes("COND2")).length > 0 ? ok : bad)(`true condition logs (${lines.filter((l) => l.includes("COND2")).length} lines)`);
  }

  // T11: non-pausing — must fire repeatedly in the window. Cadence is set by
  // the mock's `bp` pump (~10/s), not a frame rate, so the bar is modest; the
  // point is that logging never pauses the VM between hits.
  head("T11 — non-pausing throughput");
  {
    const { lines } = await logpoint({ line: LINE, logMessage: "tick" }, 1000);
    info(`${lines.length} ticks in ~1s`);
    (lines.length >= 3 ? ok : bad)(`fired freely without pausing (${lines.length} >= 3)`);
  }

  // T12: indexed by a variable {g_IntArray[client]} where client is a local
  // (only meaningful if a local named in the index exists; BreakHere has no
  // 'client', so this should stay graceful, not crash).
  head(`T12 — index by missing var {${GLOBAL_INT_ARRAY}[client]}`);
  {
    const { lines } = await logpoint({ line: LINE, logMessage: `pc={${GLOBAL_INT_ARRAY}[client]}` });
    const s = sample(lines, "pc=");
    (s.length > 0 && !s.includes("CRASH") ? ok : bad)(`no crash on missing index var: "${s}"`);
  }

  console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
  await send("setBreakpoints", { ...src, breakpoints: [] }).catch(() => {});
  try { await send("disconnect", {}); } catch {}
  sock.end();
  mock?.stop();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.log(`\x1b[31mfatal: ${e.message}\x1b[0m`); sock?.end(); mock?.stop(); process.exit(2); });
