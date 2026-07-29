#!/usr/bin/env node
/**
 * Tests the function-timing profiler end-to-end against the server (no VS Code):
 * launch → sp_profileStart → let the VM run for a window → sp_profileStop →
 * inspect the returned call tree (total/self ms, call counts).
 *
 * Profiling captures the WHOLE VM (all plugins), so we just assert the tree is
 * populated with real timings and that a known function shows up. On the mock
 * srcds the pumped `bp` command keeps debugger_test's BreakHere executing
 * throughout the capture window.
 */
import {
  DEFAULT_PROGRAM, DEFAULT_FUNC, maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";
const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const WINDOW_MS = parseInt(process.env.SP_WINDOW || "2000", 10);
const EXPECT_FN = process.env.SP_EXPECT_FN || DEFAULT_FUNC;

let seq = 1, buffer = Buffer.alloc(0);
const pending = new Map();
let sock = null; // connected in main() after the mock srcds (if any) is up
let mock = null;
let pass = 0, fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`));
const bad = (m) => (fail++, console.log(`  \x1b[31m✗\x1b[0m ${m}`));
const info = (m) => console.log(`  \x1b[36m·\x1b[0m ${m}`);

function send(cmd, args) {
  const s = seq++;
  const m = JSON.stringify({ seq: s, type: "request", command: cmd, arguments: args });
  sock.write(`Content-Length: ${Buffer.byteLength(m, "utf8")}\r\n\r\n` + m);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(s); rej(new Error(`timeout ${cmd}`)); }, 65000);
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
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Flatten the tree to all nodes for assertions.
function flatten(node, out = []) {
  if (!node) return out;
  for (const c of node.children || []) { out.push(c); flatten(c, out); }
  return out;
}

async function main() {
  console.log(`\n\x1b[1mProfiler test\x1b[0m  ${HOST}:${PORT}  ${PROGRAM.split("/").pop()}  window=${WINDOW_MS}ms`);
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  sock = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  sock.on("data", feed);
  await send("initialize", { clientID: "profiler-test" });
  const L = await send("launch", { program: PROGRAM, stopOnEntry: false });
  if (!L.success) { bad(`launch failed: ${L.message}`); process.exit(2); }
  ok("connected + launched");

  const startRes = await send("sp_profileStart", {});
  ok(`sp_profileStart -> active=${startRes.body?.active}`);
  if (startRes.body?.active !== true) {
    bad("profiler did not activate (no v2 engine on server?)");
    try { await send("disconnect", {}); } catch {}
    sock.end(); process.exit(1);
  }

  info(`profiling for ${WINDOW_MS}ms (server keeps running)...`);
  await delay(WINDOW_MS);

  const stopRes = await send("sp_profileStop", {});
  const tree = stopRes.body?.tree;
  check(tree && Array.isArray(tree.children), "sp_profileStop returned a tree");
  const nodes = flatten(tree);
  check(nodes.length > 0, `tree has ${nodes.length} node(s)`);

  const withCalls = nodes.filter((n) => n.calls > 0);
  check(withCalls.length > 0, `${withCalls.length} node(s) recorded calls`);
  const withTime = nodes.filter((n) => n.totalMs >= 0 && (n.selfMs >= 0));
  check(withTime.length === nodes.length, "all nodes have non-negative total/self ms");

  const found = nodes.find((n) => n.name && n.name.includes(EXPECT_FN));
  check(!!found, `expected function "${EXPECT_FN}" present` + (found ? ` (calls=${found.calls}, total=${found.totalMs.toFixed(3)}ms)` : ""));

  // Show the top 8 by self time — what you'd actually look at to optimize.
  const top = [...nodes].sort((a, b) => b.selfMs - a.selfMs).slice(0, 8);
  console.log("\n  Top functions by self time:");
  for (const n of top) {
    console.log(`    ${n.selfMs.toFixed(3)} ms self · ${n.totalMs.toFixed(3)} ms total · ${n.calls}×  ${n.name}`);
  }

  console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
  try { await send("disconnect", {}); } catch {}
  sock.end();
  mock?.stop();
  process.exit(fail === 0 ? 0 : 1);
}
function check(c, m) { return c ? ok(m) : bad(m), c; }
main().catch((e) => { console.log(`\x1b[31mfatal: ${e.message}\x1b[0m`); sock?.end(); mock?.stop(); process.exit(2); });
