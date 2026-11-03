import { describe, expect, it } from "bun:test";
import { PerfPluginInfo, PerfPoint } from "../../perf/PerfHistory";
import { escapeXml, formatBytes, niceCeilingBytes, peakLine, pluginLegend, renderPerfSvg } from "../../perf/perfChart";

const MB = 1048576;
const pt = (t: number, cpuPct: number, rssMb: number, pluginMb = 1): PerfPoint => ({
  t, cpuPct, processPct: cpuPct, rssBytes: rssMb * MB, pluginBytes: pluginMb * MB, plugins: 3,
});
const legacy: PerfPluginInfo = { name: "debugger_test.smx", kind: "legacy", stackHeapBytes: 17032, dataBytes: 4036, heapLiveBytes: -1,
  stackPeakBytes: 48, heapPeakBytes: 6048, usedPeakBytes: 6096 };
const v2: PerfPluginInfo = { name: "new.smx", kind: "v2", stackHeapBytes: -1, dataBytes: 3616, heapLiveBytes: 7168,
  stackPeakBytes: -1, heapPeakBytes: -1, usedPeakBytes: -1 };

describe("formatBytes", () => {
  it("picks the unit and precision", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.4 * MB)).toBe("1.4 MB");
    expect(formatBytes(85 * MB)).toBe("85.0 MB");
    expect(formatBytes(243 * MB)).toBe("243 MB");
    expect(formatBytes(2.1 * 1024 * MB)).toBe("2.1 GB");
    expect(formatBytes(-1)).toBe("-");
    expect(formatBytes(NaN)).toBe("-");
  });
});

describe("niceCeilingBytes", () => {
  it("rounds up to a round number of MB, never below 10 MB", () => {
    expect(niceCeilingBytes(0)).toBe(10 * MB);
    expect(niceCeilingBytes(11 * MB)).toBe(15 * MB);
    expect(niceCeilingBytes(85 * MB)).toBe(100 * MB);
    expect(niceCeilingBytes(250 * MB)).toBe(250 * MB);
    expect(niceCeilingBytes(251 * MB)).toBe(300 * MB);
    expect(niceCeilingBytes(301 * MB)).toBe(400 * MB);
    expect(niceCeilingBytes(900 * MB)).toBe(1000 * MB);
    expect(niceCeilingBytes(NaN)).toBe(10 * MB);
  });
  it("is always >= the input", () => {
    for (let mb = 1; mb < 5000; mb += 37) expect(niceCeilingBytes(mb * MB)).toBeGreaterThanOrEqual(mb * MB);
  });
});

describe("pluginLegend", () => {
  it("shows a dash until a plugin is debugged", () => {
    expect(pluginLegend(undefined)).toMatchObject({ label: "Stack/heap", value: "-" });
  });
  it("shows a legacy plugin's Stack/heap size exactly as spcomp prints it", () => {
    expect(pluginLegend(legacy)).toMatchObject({ label: "Stack/heap", value: "17032 bytes" });
    expect(pluginLegend(legacy).tip).toContain("debugger_test.smx");
  });
  it("shows the live heap of a SourcePawn 2.0 plugin, which has no fixed size", () => {
    const l = pluginLegend(v2);
    expect(l.label).toBe("Heap in use");
    expect(l.value).toBe("7 KB");
    expect(l.tip).toContain("no fixed stack/heap size");
  });
  it("copes with sizes the server could not give", () => {
    expect(pluginLegend({ ...legacy, stackHeapBytes: -1 }).value).toBe("-");
    expect(pluginLegend({ ...v2, heapLiveBytes: -1 }).value).toBe("-");
    expect(pluginLegend({ ...legacy, kind: "" }).value).toBe("-");
  });
});

describe("peakLine", () => {
  it("compares the peak with the reserved Stack/heap size", () => {
    const l = peakLine(legacy)!;
    expect(l.text).toContain("Peak 6096 of 17032 bytes (36%)");
    expect(l.text).toContain("heap 6048");
    expect(l.text).toContain("stack 48");
    expect(l.tip).toContain("Click to reset");
  });
  it("shows a decimal below 10% (a big #pragma dynamic that is barely used)", () => {
    expect(peakLine({ ...legacy, stackHeapBytes: 524288, usedPeakBytes: 6096 })!.text).toContain("(1.2%)");
  });
  it("waits for the first line, and is absent for 2.0 plugins and without a plugin", () => {
    expect(peakLine({ ...legacy, usedPeakBytes: -1 })!.text).toContain("waiting");
    expect(peakLine(v2)).toBeUndefined();
    expect(peakLine(undefined)).toBeUndefined();
  });
});

describe("renderPerfSvg plugin cell", () => {
  const pts = [pt(0, 1, 10), pt(1000, 1, 10)];
  it("puts the stack/heap size in the legend and the plugin name under it", () => {
    const svg = renderPerfSvg(pts, { plugin: legacy });
    expect(svg).toContain("17032 bytes");
    expect(svg).toContain("Plugin debugger_test.smx");
    expect(svg).toContain("Data 4036 bytes");
  });
  it("is a ring, not a dot, because there is no line to match", () => {
    expect(renderPerfSvg(pts, { plugin: legacy })).toContain('fill="none" stroke="#e5a93d"');
  });
  it("escapes and clips a long plugin name", () => {
    const svg = renderPerfSvg(pts, { plugin: { ...legacy, name: "<x>" + "a".repeat(80) + ".smx" } });
    expect(svg).toContain("&lt;x&gt;");
    expect(svg).not.toContain("<x>");
    expect(svg).toContain("\u2026");
  });
  it("draws the clickable peak line for a legacy plugin only", () => {
    const svg = renderPerfSvg(pts, { plugin: legacy });
    expect(svg).toContain('data-reset="1"');
    expect(svg).toContain("Peak 6096 of 17032 bytes");
    expect(renderPerfSvg(pts, { plugin: v2 })).not.toContain("data-reset");
    expect(renderPerfSvg(pts)).not.toContain("data-reset");
  });
  it("draws no plugin line without a plugin", () => {
    expect(renderPerfSvg(pts)).not.toContain(">Plugin ");
  });
});

describe("escapeXml", () => {
  it("escapes markup", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
});

describe("renderPerfSvg", () => {
  it("shows a waiting state without data", () => {
    const svg = renderPerfSvg([]);
    expect(svg).toContain("REALTIME PERFORMANCE");
    expect(svg).toContain("Waiting for data");
    expect(svg).not.toContain("<polyline");
  });

  it("draws the three series and the live values", () => {
    const pts: PerfPoint[] = [];
    for (let i = 0; i < 31; i++) pts.push(pt(i * 1000, 41, 85));
    const svg = renderPerfSvg(pts);
    expect((svg.match(/<polyline/g) || []).length).toBe(3); // the stack/heap size is a constant: shown, not plotted
    expect(svg).toContain("CPU Usage");
    expect(svg).toContain("41%");
    expect(svg).toContain("Memory Used");
    expect(svg).toContain("85.0 MB");
    expect(svg).toContain("30s ago");
    expect(svg).toContain(">now<");
    expect(svg).toContain("Memory 100 MB"); // axis ceiling for an 85 MB peak (+10% headroom)
    expect(svg).toContain("1.0 MB (3)");
  });

  it("is well-formed and every coordinate is finite", () => {
    const pts = [pt(0, 0, 10), pt(1000, 100, 300), pt(2000, 50, 200)];
    const svg = renderPerfSvg(pts, { background: "#1e1e1e", textColor: "#ccc" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    expect(svg).toContain('fill="#1e1e1e"');
  });

  it("escapes the note", () => {
    expect(renderPerfSvg([], { note: "<b>" })).toContain("&lt;b&gt;");
  });

  it("clamps out-of-range values into the plot", () => {
    const svg = renderPerfSvg([pt(0, 250, 10), pt(1000, -5, 10)]);
    expect(svg).not.toContain("NaN");
    // y never leaves the 28..128 plot band
    const ys = (svg.match(/<polyline points="([^"]+)"/g) || [])
      .flatMap((s) => s.replace(/.*points="/, "").replace(/"$/, "").split(" "))
      .map((xy) => parseFloat(xy.split(",")[1]));
    for (const y of ys) { expect(y).toBeGreaterThanOrEqual(28); expect(y).toBeLessThanOrEqual(128); }
  });
});
