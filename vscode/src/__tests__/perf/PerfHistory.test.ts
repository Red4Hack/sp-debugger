// Sampling maths of the Realtime Performance panel: cumulative server counters
// -> CPU % deltas in a rolling 30 s window.
import { describe, expect, it } from "bun:test";
import { PerfHistory, PerfRaw, parsePerfRaw, pluginInfoOf } from "../../perf/PerfHistory";

function raw(over: Partial<PerfRaw> = {}): PerfRaw {
  return {
    wallMs: 1000,
    processCpuMs: 0,
    mainCpuMs: 0,
    rssBytes: 100 * 1048576,
    pluginBytes: 2 * 1048576,
    pluginAgeMs: 200,
    plugins: 5,
    cpus: 4,
    debugPlugin: "debugger_test.smx",
    debugKind: "legacy",
    stackHeapBytes: 17032,
    dataBytes: 4036,
    heapLiveBytes: -1,
    stackPeakBytes: 48,
    heapPeakBytes: 6048,
    usedPeakBytes: 6096,
    ...over,
  };
}

describe("parsePerfRaw", () => {
  it("accepts a full body", () => {
    expect(parsePerfRaw(raw())).toEqual(raw());
  });
  it("defaults the plugin fields for servers that predate them", () => {
    const {
      debugPlugin, debugKind, stackHeapBytes, dataBytes, heapLiveBytes, stackPeakBytes, heapPeakBytes, usedPeakBytes, ...old
    } = raw();
    expect(parsePerfRaw(old)).toEqual({
      ...raw(), debugPlugin: "", debugKind: "", stackHeapBytes: -1, dataBytes: -1, heapLiveBytes: -1,
      stackPeakBytes: -1, heapPeakBytes: -1, usedPeakBytes: -1,
    });
  });
  it("rejects plugin fields that are present but invalid", () => {
    expect(parsePerfRaw({ ...raw(), debugPlugin: 5 })).toBeUndefined();
    expect(parsePerfRaw({ ...raw(), stackHeapBytes: "1" })).toBeUndefined();
    expect(parsePerfRaw({ ...raw(), dataBytes: NaN })).toBeUndefined();
    expect(parsePerfRaw({ ...raw(), usedPeakBytes: "6096" })).toBeUndefined();
  });
  it("treats an unknown debugKind as unknown", () => {
    expect(parsePerfRaw({ ...raw(), debugKind: "banana" })!.debugKind).toBe("");
    expect(parsePerfRaw({ ...raw(), debugKind: "v2" })!.debugKind).toBe("v2");
  });
  it("rejects missing, non-numeric and non-finite fields", () => {
    expect(parsePerfRaw(undefined)).toBeUndefined();
    expect(parsePerfRaw("x")).toBeUndefined();
    const { rssBytes, ...rest } = raw();
    expect(parsePerfRaw(rest)).toBeUndefined();
    expect(parsePerfRaw({ ...raw(), cpus: "4" })).toBeUndefined();
    expect(parsePerfRaw({ ...raw(), wallMs: NaN })).toBeUndefined();
    expect(parsePerfRaw({ ...raw(), wallMs: Infinity })).toBeUndefined();
  });
});

describe("pluginInfoOf", () => {
  it("is undefined without a debugged plugin", () => {
    expect(pluginInfoOf(undefined)).toBeUndefined();
    expect(pluginInfoOf(raw({ debugPlugin: "" }))).toBeUndefined();
  });
  it("carries the sizes of the debugged plugin", () => {
    expect(pluginInfoOf(raw())).toEqual({
      name: "debugger_test.smx", kind: "legacy", stackHeapBytes: 17032, dataBytes: 4036, heapLiveBytes: -1,
      stackPeakBytes: 48, heapPeakBytes: 6048, usedPeakBytes: 6096,
    });
  });
});

describe("PerfHistory", () => {
  it("needs two samples before it can plot", () => {
    const h = new PerfHistory();
    expect(h.push(raw())).toBeUndefined();
    expect(h.points.length).toBe(0);
    const p = h.push(raw({ wallMs: 2000, mainCpuMs: 410, processCpuMs: 600 }));
    expect(p).toBeDefined();
    expect(h.points.length).toBe(1);
  });

  it("computes the main-thread CPU % from deltas", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 1000, mainCpuMs: 100, processCpuMs: 150 }));
    const p = h.push(raw({ wallMs: 2000, mainCpuMs: 510, processCpuMs: 950 }))!;
    expect(p.cpuPct).toBeCloseTo(41, 5);
    expect(p.processPct).toBeCloseTo(80, 5);
    expect(p.t).toBe(2000);
  });

  it("falls back to process CPU / cores when the game thread is unknown", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 0, mainCpuMs: -1, processCpuMs: 0, cpus: 4 }));
    const p = h.push(raw({ wallMs: 1000, mainCpuMs: -1, processCpuMs: 400, cpus: 4 }))!;
    expect(p.cpuPct).toBeCloseTo(10, 5); // 400 ms of 1000 ms across 4 cores
    expect(p.processPct).toBeCloseTo(40, 5);
  });

  it("clamps clock-granularity overshoot to 0..100", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 0, mainCpuMs: 0 }));
    expect(h.push(raw({ wallMs: 1000, mainCpuMs: 1030 }))!.cpuPct).toBe(100);
  });

  it("ignores polls closer than minStepMs without losing the baseline", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 0, mainCpuMs: 0 }));
    expect(h.push(raw({ wallMs: 100, mainCpuMs: 10 }))).toBeUndefined();
    // the next delta spans from t=0, not from the skipped sample
    const p = h.push(raw({ wallMs: 1000, mainCpuMs: 200 }))!;
    expect(p.cpuPct).toBeCloseTo(20, 5);
  });

  it("restarts after a server restart (clocks go backwards)", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 10000, processCpuMs: 5000, mainCpuMs: 4000 }));
    h.push(raw({ wallMs: 11000, processCpuMs: 5100, mainCpuMs: 4050 }));
    expect(h.points.length).toBe(1);
    expect(h.push(raw({ wallMs: 500, processCpuMs: 20, mainCpuMs: 10 }))).toBeUndefined();
    expect(h.points.length).toBe(0);
  });

  it("restarts after a long gap instead of plotting a misleading average", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 0 }));
    h.push(raw({ wallMs: 1000 }));
    expect(h.push(raw({ wallMs: 60000 }))).toBeUndefined();
    expect(h.points.length).toBe(0);
    expect(h.push(raw({ wallMs: 61000 }))).toBeDefined();
  });

  it("keeps a 30 s window plus one point beyond the left edge", () => {
    const h = new PerfHistory();
    for (let i = 0; i <= 60; i++) h.push(raw({ wallMs: i * 1000, mainCpuMs: i * 100 }));
    const pts = h.points;
    expect(pts[pts.length - 1].t).toBe(60000);
    // oldest kept is the last one at/before the cutoff (30000)
    expect(pts[0].t).toBeLessThanOrEqual(30000);
    expect(pts[1].t).toBeGreaterThanOrEqual(30000);
    expect(pts.length).toBeLessThanOrEqual(32);
  });

  it("reset() clears everything", () => {
    const h = new PerfHistory();
    h.push(raw({ wallMs: 0 }));
    h.push(raw({ wallMs: 1000 }));
    h.reset();
    expect(h.points.length).toBe(0);
    expect(h.latest).toBeUndefined();
    expect(h.latestRaw).toBeUndefined();
  });
});
