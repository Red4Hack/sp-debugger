#!/usr/bin/env node
// Diagnose why a breakpoint doesn't bind/fire. Sets breakpoints across a range
// of candidate lines, prints which verified, then waits to see which (if any)
// actually fires. Defaults to debugger_test.sp's BreakHere body on the mock
// srcds (spawned here; the pumped `bp` command executes the body repeatedly).
// For a multi-file plugin on a real server, point SP_BP_FILE/SP_BP_NAME at the
// #include'd sub-file that owns the code, NOT the master .sp.
import {
  DEFAULT_PROGRAM, DEFAULT_PROGRAM_NAME, maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";
const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const BP_FILE = process.env.SP_BP_FILE || PROGRAM;
const BP_NAME = process.env.SP_BP_NAME || DEFAULT_PROGRAM_NAME;
// Candidate lines spanning BreakHere's body (declarations, OUTPUT calls, end).
const LINES = (process.env.SP_LINES || "53,58,62,65,73,84,90,96").split(",").map(Number);

let seq = 1, buffer = Buffer.alloc(0);
const pending = new Map();
let sock = null;
let mock = null;
function send(cmd, args) {
  const s = seq++;
  const m = JSON.stringify({ seq: s, type: "request", command: cmd, arguments: args });
  sock.write(`Content-Length: ${Buffer.byteLength(m, "utf8")}\r\n\r\n` + m);
  return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(s); rej(new Error(`timeout ${cmd}`)); }, 15000); pending.set(s, { res, t }); });
}
function feed(c) {
  buffer = Buffer.concat([buffer, c]);
  for (;;) {
    const he = buffer.indexOf("\r\n\r\n"); if (he < 0) return;
    const hm = buffer.slice(0, he).toString().match(/Content-Length: (\d+)/i); if (!hm) { buffer = buffer.slice(he + 4); continue; }
    const len = +hm[1], start = he + 4; if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString(); buffer = buffer.slice(start + len);
    let m; try { m = JSON.parse(body); } catch { continue; }
    if (m.type === "response") { const p = pending.get(m.request_seq); if (p) { clearTimeout(p.t); pending.delete(m.request_seq); p.res(m); } }
    else if (m.type === "event" && m.event === "stopped") {
      console.log(`\n🛑 STOPPED reason=${m.body?.reason} thread=${m.body?.threadId}`);
      send("stackTrace", { threadId: m.body?.threadId ?? 1 }).then((st) => {
        const f = st.body?.stackFrames?.[0];
        console.log(`   frame: ${f?.name} @ ${f?.source?.path}:${f?.line}`);
        mock?.stop();
        process.exit(0);
      });
    }
  }
}
async function main() {
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  sock = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  sock.on("data", feed);
  await send("initialize", { clientID: "probe-bp" });
  await send("launch", { program: PROGRAM, stopOnEntry: false });
  const r = await send("setBreakpoints", { source: { path: BP_FILE, name: BP_NAME }, breakpoints: LINES.map((l) => ({ line: l })) });
  console.log(`setBreakpoints on ${BP_NAME} lines ${LINES.join(",")}:`);
  for (const bp of (r.body?.breakpoints || [])) {
    console.log(`   line ${bp.line}: verified=${bp.verified}${bp.message ? " (" + bp.message + ")" : ""}`);
  }
  await send("configurationDone", {});
  console.log("\nwaiting up to 8s for a stop (mock pumps `bp` every ~100ms)...");
  setTimeout(() => { console.log("❌ no stop within 8s — breakpoint bound but never hit (is the code path executing?)"); mock?.stop(); process.exit(1); }, 8000);
}
main().catch((e) => { console.log(`fatal: ${e.message}`); mock?.stop(); process.exit(2); });
