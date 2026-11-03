#!/usr/bin/env node
/**
 * Tests the `sp_performance` custom request end-to-end against the server (no
 * VS Code): launch -> poll sp_performance a few times -> check the raw counters
 * are present, monotonic where they must be, and turn into a sane CPU %.
 *
 * Also checks the request is answered while the VM is paused at a breakpoint
 * (it is served from the TCP thread, not the game thread).
 */
import {
  DEFAULT_PROGRAM, maybeStartMockSrcds, connectWithRetry,
} from "./lib/testenv.mjs";
const HOST = process.env.SP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.SP_PORT || "8080", 10);
const PROGRAM = process.env.SP_PROGRAM || DEFAULT_PROGRAM;
const POLLS = parseInt(process.env.SP_POLLS || "5", 10);
const INTERVAL_MS = parseInt(process.env.SP_INTERVAL || "1000", 10);

let seq = 1, buffer = Buffer.alloc(0);
const pending = new Map();
let sock = null, mock = null;
let pass = 0, fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`));
const bad = (m) => (fail++, console.log(`  \x1b[31m✗\x1b[0m ${m}`));
const info = (m) => console.log(`  \x1b[36m·\x1b[0m ${m}`);
function check(c, m) { return c ? ok(m) : bad(m), c; }

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
    if (m.type === "event") events.push(m);
    if (m.type === "response") { const p = pending.get(m.request_seq); if (p) { clearTimeout(p.t); pending.delete(m.request_seq); p.res(m); } }
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
function waitEvent(name, ms) {
  const t0 = Date.now();
  return new Promise((res) => {
    const iv = setInterval(() => {
      const e = events.find((x) => x.event === name);
      if (e) { clearInterval(iv); res(e); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(null); }
    }, 50);
  });
}
const mb = (b) => (b / 1048576).toFixed(1);

async function main() {
  console.log(`\n\x1b[1mPerformance test\x1b[0m  ${HOST}:${PORT}  polls=${POLLS} every ${INTERVAL_MS}ms`);
  mock = await maybeStartMockSrcds({ host: HOST, port: PORT });
  sock = await connectWithRetry(HOST, PORT, mock ? 120 : 10, 500);
  sock.on("data", feed);
  await send("initialize", { clientID: "perf-test" });
  const L = await send("launch", { program: PROGRAM, stopOnEntry: false });
  if (!L.success) { bad(`launch failed: ${L.message}`); process.exit(2); }
  ok("connected + launched");

  const samples = [];
  for (let i = 0; i < POLLS; i++) {
    const r = await send("sp_performance", {});
    if (!r.success) { bad(`sp_performance failed: ${r.message}`); break; }
    samples.push(r.body);
    if (i < POLLS - 1) await delay(INTERVAL_MS);
  }
  check(samples.length === POLLS, `${samples.length}/${POLLS} sp_performance responses`);

  const first = samples[0] || {};
  for (const k of ["wallMs", "processCpuMs", "mainCpuMs", "rssBytes", "pluginBytes", "pluginAgeMs", "plugins", "cpus"])
    check(typeof first[k] === "number", `field ${k} is a number (${first[k]})`);

  check(first.rssBytes > 1 << 20, `rss looks real: ${mb(first.rssBytes)} MB`);
  check(first.cpus >= 1, `cpus=${first.cpus}`);
  check(first.plugins >= 1, `${first.plugins} plugin(s) counted, ${mb(first.pluginBytes)} MB`);
  check(first.pluginBytes > 0, "plugin memory > 0");
  info(`plugin memory age: ${Math.round(first.pluginAgeMs)} ms`);

  // The plugin this session debugs, sized like the compiler prints it.
  check(/\.smx$/.test(first.debugPlugin), `debugged plugin reported: ${first.debugPlugin}`);
  check(first.debugKind === "legacy" || first.debugKind === "v2", `plugin kind: ${first.debugKind}`);
  check(first.dataBytes > 0, `Data size: ${first.dataBytes} bytes`);
  if (first.debugKind === "legacy") {
    info(`Stack/heap size: ${first.stackHeapBytes} bytes  (what spcomp prints)`);
    check(first.stackHeapBytes > 0, "Stack/heap size > 0");
    check(first.heapLiveBytes === -1, "legacy plugin has no live-heap figure");
  } else {
    info(`SourcePawn 2.0 plugin: live heap ${first.heapLiveBytes} bytes, no fixed stack/heap size`);
    check(first.stackHeapBytes === -1, "2.0 plugin has no fixed stack/heap size");
    check(first.heapLiveBytes >= 0, "live heap measured");
  }
  // What spcomp printed for the deployed .smx (SP_EXPECT_STACKHEAP / SP_EXPECT_DATA, or SP_EXPECT_KIND).
  if (process.env.SP_EXPECT_KIND) check(first.debugKind === process.env.SP_EXPECT_KIND, `kind is ${process.env.SP_EXPECT_KIND}`);
  if (process.env.SP_EXPECT_STACKHEAP) check(first.stackHeapBytes === +process.env.SP_EXPECT_STACKHEAP, `Stack/heap size == ${process.env.SP_EXPECT_STACKHEAP} (spcomp)`);
  if (process.env.SP_EXPECT_DATA) check(first.dataBytes === +process.env.SP_EXPECT_DATA, `Data size == ${process.env.SP_EXPECT_DATA} (spcomp)`);

  let mono = true, cpuPcts = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!(b.wallMs > a.wallMs && b.processCpuMs >= a.processCpuMs && b.mainCpuMs >= a.mainCpuMs)) mono = false;
    const dw = b.wallMs - a.wallMs;
    cpuPcts.push({ main: 100 * (b.mainCpuMs - a.mainCpuMs) / dw, proc: 100 * (b.processCpuMs - a.processCpuMs) / dw });
  }
  check(mono, "wall + CPU clocks are monotonic");
  check(cpuPcts.every((c) => c.main >= 0 && c.main <= 110), `main-thread CPU% in range: ${cpuPcts.map((c) => c.main.toFixed(1)).join(", ")}`);
  check(cpuPcts.every((c) => c.proc >= 0), `process CPU% (all threads): ${cpuPcts.map((c) => c.proc.toFixed(1)).join(", ")}`);
  const wallSpan = samples.at(-1).wallMs - samples[0].wallMs;
  check(Math.abs(wallSpan - (POLLS - 1) * INTERVAL_MS) < 1500, `server wall clock advanced ${Math.round(wallSpan)} ms`);

  // Peak stack/heap of the debugged (legacy) plugin, against the fixture's known use:
  // peak_probe keeps a 2048-byte local array and an n-cell dynamic array alive together.
  // In SourcePawn BOTH live on the plugin's heap (local arrays are heap-allocated and
  // freed on return); the stack only holds call frames and scalars.
  // Needs `peak_probe <n>` to run on the server (rcon pump) and SP_PROGRAM=.../peak_probe.sp.
  if (process.env.SP_PEAKS === "1") {
    const n = parseInt(process.env.SP_PEAK_N || "1000", 10);
    let p = null;
    for (let i = 0; i < 100; i++) {
      const r = await send("sp_performance", {});
      if (r.success && r.body.peakSamples > 0) { p = r.body; break; }
      await delay(100);
    }
    if (first.debugKind === "v2") {
      check(p === null, "2.0 plugin: peaks are not tracked (no samples)");
    } else if (!p) {
      bad("no peak samples arrived (is `peak_probe` running on the server?)");
    } else {
      await delay(1500); // let a few more runs land
      p = (await send("sp_performance", {})).body;
      const cap = p.stackHeapBytes;
      info(`PEAK  stack=${p.stackPeakBytes}  heap=${p.heapPeakBytes}  together=${p.usedPeakBytes}  of Stack/heap ${cap} bytes  (${(100 * p.usedPeakBytes / cap).toFixed(2)}%)  [${p.peakSamples} lines]`);
      check(p.stackPeakBytes > 0 && p.stackPeakBytes <= 256, `stack peak ${p.stackPeakBytes}: only call frames (arrays are on the heap)`);
      check(p.heapPeakBytes >= 2048 + 4 * n && p.heapPeakBytes <= 2048 + 4 * n + 64, `heap peak ${p.heapPeakBytes} ~ ${2048 + 4 * n} (int[512] + new int[${n}])`);
      check(p.usedPeakBytes >= p.heapPeakBytes && p.usedPeakBytes <= p.heapPeakBytes + p.stackPeakBytes, `stack + heap peak ${p.usedPeakBytes} is the peak of the sum`);
      check(p.usedPeakBytes <= cap, "peak fits in the reserved Stack/heap size");
      const before = p.peakSamples;
      const r = await send("sp_performance", { resetPeaks: true });
      check(r.success && r.body.peakSamples < before, `resetPeaks restarts the count (${before} -> ${r.body.peakSamples})`);
    }
  }

  // Served from the TCP thread: must still answer while the game thread is
  // stopped at a breakpoint. Needs `bp` to run on the server (rcon pump).
  if (process.env.SP_PAUSED === "1") {
    const line = parseInt(process.env.SP_LINE || "62", 10);
    const bp = await send("setBreakpoints", { source: { path: PROGRAM }, breakpoints: [{ line }] });
    check(bp.success, `breakpoint set at line ${line}`);
    await send("configurationDone", {});
    info("waiting for the breakpoint to hit...");
    const stopped = await waitEvent("stopped", 20000);
    if (!stopped) {
      bad("no stopped event within 20 s (is something running `bp` on the server?)");
    } else {
      ok(`VM paused (reason=${stopped.body && stopped.body.reason})`);
      const a1 = await send("sp_performance", {});
      await delay(1100);
      const b1 = await send("sp_performance", {});
      check(a1.success && b1.success, "sp_performance answers while the VM is paused");
      check(b1.success && a1.success && b1.body.wallMs > a1.body.wallMs, "server clock still advances while paused");
      if (a1.success && b1.success) {
        const pct = 100 * (b1.body.mainCpuMs - a1.body.mainCpuMs) / (b1.body.wallMs - a1.body.wallMs);
        info(`game-thread CPU while paused: ${pct.toFixed(1)}%`);
      }
      try { await send("continue", { threadId: (stopped.body && stopped.body.threadId) || 1 }); } catch {}
    }
  }

  console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
  try { await send("disconnect", {}); } catch {}
  sock.end();
  mock?.stop();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.log(`\x1b[31mfatal: ${e.message}\x1b[0m`); sock?.end(); mock?.stop(); process.exit(2); });
