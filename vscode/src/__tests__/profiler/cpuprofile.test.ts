// Validates the capture -> .cpuprofile and capture -> trace conversions.
// Converted from the former vscode/scripts/test-cpuprofile.mjs.
import { describe, expect, it } from "bun:test";
import { captureToCpuProfile } from "../../profiler/cpuprofile";
import { captureToTrace } from "../../profiler/trace";

// root(0) → OnGameFrame(1) (self 5ms, total 8) → IsValidClient(2) (self 3ms)
//         → other.smx::OnGameFrame(3) (self 1ms)
const tree = {
  id: 0,
  name: "<root>",
  group: "",
  totalMs: 0,
  selfMs: 0,
  calls: 0,
  minSelfMs: 0,
  maxSelfMs: 0,
  p95SelfMs: 0,
  children: [
    {
      id: 1,
      name: "debugger_test.smx::OnGameFrame",
      group: "sp",
      totalMs: 8,
      selfMs: 5,
      calls: 137,
      minSelfMs: 0.01,
      maxSelfMs: 0.9,
      p95SelfMs: 0.5,
      lines: [
        { line: 42, selfMs: 4 },
        { line: 43, selfMs: 1 },
      ],
      children: [
        {
          id: 2,
          name: "debugger_test.smx::IsValidClient",
          group: "sp",
          totalMs: 3,
          selfMs: 3,
          calls: 1370,
          minSelfMs: 0.001,
          maxSelfMs: 0.02,
          p95SelfMs: 0.01,
          children: [],
        },
      ],
    },
    {
      id: 3,
      name: "other.smx::OnGameFrame",
      group: "sp",
      totalMs: 1,
      selfMs: 1,
      calls: 137,
      minSelfMs: 0.001,
      maxSelfMs: 0.05,
      p95SelfMs: 0.01,
      children: [],
    },
  ],
};

describe("captureToCpuProfile — measured timeline", () => {
  // Three real samples: 2ms in OnGameFrame, 3ms in IsValidClient, 1ms in other.
  const capture = {
    tree,
    samples: {
      id: [1, 2, 3],
      dtUs: [2000, 3000, 1000],
      startUs: [0, 2000, 5000],
      truncated: false,
    },
    spans: { items: [], truncated: false },
    windowMs: 6,
  };
  const p = captureToCpuProfile(capture as any);

  it("produces root + one node per tree entry", () => {
    expect(p.nodes.length).toBe(4);
  });

  it("uses the MEASURED deltas instead of a synthetic cadence", () => {
    expect(p.timeDeltas).toEqual([2000, 3000, 1000]);
    expect(p.endTime).toBe(6000);
  });

  it("keeps samples and timeDeltas aligned", () => {
    expect(p.samples.length).toBe(p.timeDeltas.length);
  });

  it("maps server node ids onto cpuprofile node ids", () => {
    const fn = p.nodes.find(
      (n: any) =>
        n.callFrame.functionName === "OnGameFrame" && n.callFrame.url === "debugger_test.smx",
    );
    expect(fn).toBeDefined();
    expect(p.samples[0]).toBe(fn!.id);
  });

  it("counts one hit per measured sample", () => {
    const ivc = p.nodes.find((n: any) => n.callFrame.functionName === "IsValidClient");
    expect(ivc!.hitCount).toBe(1);
  });

  it("carries per-line self time as positionTicks", () => {
    const fn = p.nodes.find(
      (n: any) =>
        n.callFrame.functionName === "OnGameFrame" && n.callFrame.url === "debugger_test.smx",
    );
    expect(fn!.positionTicks).toEqual([
      { line: 42, ticks: 4000 },
      { line: 43, ticks: 1000 },
    ]);
  });

  it("anchors the frame on its hottest line (0-based)", () => {
    const fn = p.nodes.find(
      (n: any) =>
        n.callFrame.functionName === "OnGameFrame" && n.callFrame.url === "debugger_test.smx",
    );
    expect(fn!.callFrame.lineNumber).toBe(41);
  });

  it("gives every sample a valid node id", () => {
    const ids = new Set(p.nodes.map((n: any) => n.id));
    expect(p.samples.every((s: number) => ids.has(s))).toBe(true);
  });

  it("parents the top-level frames under the root", () => {
    const root = p.nodes.find((n: any) => n.callFrame.functionName === "(root)");
    expect(root!.children.length).toBe(2);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(p)).not.toThrow();
  });
});

describe("captureToCpuProfile — no measured timeline", () => {
  // A capture with no samples still has to open: fall back to synthesizing them
  // from self time at a fixed cadence (the pre-timeline behaviour).
  const p = captureToCpuProfile({ tree } as any);

  it("synthesizes samples from self time at 100µs", () => {
    const fn = p.nodes.find(
      (n: any) =>
        n.callFrame.functionName === "OnGameFrame" && n.callFrame.url === "debugger_test.smx",
    );
    expect(fn!.hitCount).toBe(50); // 5ms self @ 100µs
    expect(p.samples.length).toBe(90); // 50 + 30 + 10
  });

  it("produces an openable profile for an empty tree (>=1 sample)", () => {
    const empty = captureToCpuProfile({
      tree: { ...tree, children: [] },
    } as any);
    expect(empty.samples.length).toBeGreaterThanOrEqual(1);
  });
});

describe("captureToTrace", () => {
  const capture = {
    tree,
    samples: { id: [], dtUs: [], startUs: [], truncated: false },
    spans: {
      items: [
        { id: 1, tsUs: 0, durUs: 8000, depth: 0 },
        { id: 2, tsUs: 1000, durUs: 3000, depth: 1 },
      ],
      truncated: false,
    },
    windowMs: 12,
  };
  const t = captureToTrace(capture as any);

  it("emits one complete event per span, plus process/thread metadata", () => {
    const slices = t.traceEvents.filter((e: any) => e.ph === "X");
    expect(slices.length).toBe(2);
    expect(t.traceEvents.some((e: any) => e.name === "process_name")).toBe(true);
  });

  it("keeps the measured begin and duration", () => {
    const outer = t.traceEvents.find((e: any) => e.ph === "X" && e.name === "OnGameFrame");
    expect(outer!.ts).toBe(0);
    expect(outer!.dur).toBe(8000);
  });

  it("labels slices with the plugin and annotates the hottest line", () => {
    const outer: any = t.traceEvents.find((e: any) => e.ph === "X" && e.name === "OnGameFrame");
    expect(outer.cat).toBe("debugger_test.smx");
    expect(outer.args["hottest line"]).toBe(42);
  });

  it("skips spans whose node is unknown", () => {
    const orphan = captureToTrace({
      tree,
      spans: { items: [{ id: 999, tsUs: 0, durUs: 1, depth: 0 }], truncated: false },
    } as any);
    expect(orphan.traceEvents.filter((e: any) => e.ph === "X").length).toBe(0);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(t)).not.toThrow();
  });
});
