/**
 * perfChart -- renders the "Realtime Performance" chart as a standalone SVG
 * string (no DOM, no vscode import: unit-testable, and the webview just drops
 * the string into the page).
 *
 *   REALTIME PERFORMANCE                       CPU 100%
 *   .............................................
 *   :   red   = main-thread CPU %  (left scale, 0..100)
 *   :   green = process memory     (right scale, rounded ceiling)
 *   :   blue  = memory of all plugins (same scale, thin)
 *   30s ago                                  now
 *   o CPU Usage        41%      o Memory Used     85 MB
 *   o Plugins   1.4 MB (18)     o Stack/heap  17032 bytes     <- of the debugged plugin
 *   Plugin debugger_test.smx  .  Data 4036 bytes
 *   Peak 6096 of 18608 bytes (33%)  .  heap 6048  .  stack 48     <- click to reset
 *
 * The last legend cell is not a line: the plugin's stack/heap size is a number
 * fixed at compile time (what spcomp prints), so it is shown, not plotted.
 *
 * Text uses `currentColor` and no font-family, so the page's CSS (VS Code theme
 * variables) decides both -- the series colors are fixed.
 */
import { PerfPluginInfo, PerfPoint } from "./PerfHistory";

export const CPU_COLOR = "#f14c4c";
export const MEM_COLOR = "#3fb68b";
export const PLUGIN_COLOR = "#4da3ff";
export const HEAP_COLOR = "#e5a93d";

export interface PerfChartOptions {
  /** Visible span in ms; the right edge is the newest sample. Default 30000. */
  windowMs?: number;
  /** Text color. Default `currentColor`. */
  textColor?: string;
  /** Optional solid background (tests / rasterizers); the webview leaves it transparent. */
  background?: string;
  /** The plugin the session debugs: its stack/heap size goes in the legend. */
  plugin?: PerfPluginInfo;
  /** Faint hint under the legend (e.g. "reconnecting..."). */
  note?: string;
}

const W = 320;
const H = 212;
const PAD_L = 8;
const PAD_R = 8;
const PLOT_T = 28;
const PLOT_B = 128;
const PLOT_H = PLOT_B - PLOT_T;
const PLOT_W = W - PAD_L - PAD_R;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 85 MB, 1.4 MB, 512 KB, 2.1 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1) + " GB";
  if (bytes >= MB) return (bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1) + " MB";
  if (bytes >= KB) return Math.round(bytes / KB) + " KB";
  return Math.round(bytes) + " B";
}

/**
 * Smallest "round" byte count >= `bytes` (and >= 10 MB), for the memory axis:
 * 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^n MB. 85 MB -> 100 MB, 251 MB -> 300 MB.
 */
export function niceCeilingBytes(bytes: number): number {
  const MB = 1024 * 1024;
  const mb = Math.max(10, Number.isFinite(bytes) ? bytes / MB : 0);
  const mantissas = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const exp = Math.pow(10, Math.floor(Math.log(mb) / Math.LN10));
  for (let i = 0; i < mantissas.length; i++) {
    const c = mantissas[i] * exp;
    if (c >= mb - 1e-9) return c * MB;
  }
  return 10 * exp * MB;
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function polyline(xy: Array<[number, number]>): string {
  return xy.map((p) => fmt(p[0]) + "," + fmt(p[1])).join(" ");
}

export interface PluginLegend { label: string; value: string; tip: string }

/**
 * The legend cell of the debugged plugin. Legacy plugins (before SourcePawn 2.0)
 * have a fixed "Stack/heap size", the number spcomp prints; 2.0 plugins have none,
 * so their live heap is shown instead.
 */
export function pluginLegend(info: PerfPluginInfo | undefined): PluginLegend {
  if (!info) {
    return {
      label: "Stack/heap",
      value: "-",
      tip: "Stack/heap size of the plugin you debug, as spcomp prints it. Start debugging a plugin to see it.",
    };
  }
  if (info.kind === "legacy") {
    return {
      label: "Stack/heap",
      value: info.stackHeapBytes >= 0 ? info.stackHeapBytes + " bytes" : "-",
      tip: "Stack/heap size of " + info.name + ", as spcomp prints it (reserved at compile time; see #pragma dynamic)",
    };
  }
  if (info.kind === "v2") {
    return {
      label: "Heap in use",
      value: info.heapLiveBytes >= 0 ? formatBytes(info.heapLiveBytes) : "-",
      tip:
        info.name + " was built for SourcePawn 2.0, which has no fixed stack/heap size. " +
        "Bytes in use in its allocator heap (approximate).",
    };
  }
  return { label: "Stack/heap", value: "-", tip: info.name + " is not loaded or its file could not be read" };
}

export interface PeakLine { text: string; tip: string }

/**
 * The highest stack + heap the plugin has used at any line, against its reserved
 * Stack/heap size -- the number that says whether `#pragma dynamic` is needed and
 * whether a code change helped. Legacy plugins only (a 2.0 plugin has no fixed
 * region); undefined for anything else.
 */
export function peakLine(info: PerfPluginInfo | undefined): PeakLine | undefined {
  if (!info || info.kind !== "legacy") return undefined;
  const tip =
    "Most stack + heap in use at any line since the plugin was launched, against its Stack/heap size. " +
    "Sampled at every line, so a peak inside a single line can be missed. Click to reset.";
  if (info.usedPeakBytes < 0) return { text: "Peak: waiting for the plugin to run", tip };
  let pct = "";
  if (info.stackHeapBytes > 0) {
    const v = (100 * info.usedPeakBytes) / info.stackHeapBytes;
    pct = " (" + (v < 10 ? v.toFixed(1) : String(Math.round(v))) + "%)";
  }
  const of = info.stackHeapBytes > 0 ? " of " + info.stackHeapBytes + " bytes" : " bytes";
  return {
    text:
      "Peak " + info.usedPeakBytes + of + pct + "  \u00b7  heap " + info.heapPeakBytes +
      "  \u00b7  stack " + info.stackPeakBytes,
    tip,
  };
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

export function renderPerfSvg(points: ReadonlyArray<PerfPoint>, opts: PerfChartOptions = {}): string {
  const windowMs = opts.windowMs !== undefined ? opts.windowMs : 30000;
  const color = opts.textColor || "currentColor";
  const n = points.length;
  const latest = n ? points[n - 1] : undefined;
  const tNow = latest ? latest.t : 0;

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, points[i].rssBytes, points[i].pluginBytes);
  // 10% headroom so the busiest sample doesn't sit on the top border.
  const memCeil = niceCeilingBytes(peak * 1.1);

  const xOf = (t: number): number => {
    const f = (t - (tNow - windowMs)) / windowMs;
    return PAD_L + Math.min(1, Math.max(0, f)) * PLOT_W;
  };
  const yCpu = (pct: number): number => PLOT_B - (Math.min(100, Math.max(0, pct)) / 100) * PLOT_H;
  const yMem = (b: number): number => PLOT_B - Math.min(1, Math.max(0, b / memCeil)) * PLOT_H;

  const out: string[] = [];
  out.push(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H +
      '" width="100%" role="img" aria-label="Realtime performance: CPU and memory over the last ' +
      Math.round(windowMs / 1000) + ' seconds">',
  );
  if (opts.background) out.push('<rect width="' + W + '" height="' + H + '" fill="' + opts.background + '"/>');

  // Header: title left, scale labels right.
  out.push('<g fill="' + color + '" font-size="9">');
  out.push('<text x="' + PAD_L + '" y="12" font-weight="bold" letter-spacing="0.6" opacity="0.85">REALTIME PERFORMANCE</text>');
  out.push('<text x="' + PAD_L + '" y="23" font-size="8" opacity="0.6" fill="' + CPU_COLOR + '">CPU 100%</text>');
  out.push('<text x="' + (W - PAD_R) + '" y="23" font-size="8" opacity="0.6" text-anchor="end" fill="' + MEM_COLOR + '">Memory ' + escapeXml(formatBytes(memCeil)) + "</text>");
  out.push("</g>");

  // Grid: 4 bands.
  out.push('<g stroke="' + color + '" stroke-opacity="0.18" stroke-width="0.5" fill="none">');
  for (let i = 0; i <= 4; i++) {
    const y = PLOT_T + (PLOT_H * i) / 4;
    out.push('<line x1="' + PAD_L + '" y1="' + fmt(y) + '" x2="' + (W - PAD_R) + '" y2="' + fmt(y) + '"/>');
  }
  out.push("</g>");

  if (n >= 2) {
    const memXY = points.map((p): [number, number] => [xOf(p.t), yMem(p.rssBytes)]);
    const cpuXY = points.map((p): [number, number] => [xOf(p.t), yCpu(p.cpuPct)]);
    const plgXY = points.map((p): [number, number] => [xOf(p.t), yMem(p.pluginBytes)]);
    const area = (xy: Array<[number, number]>): string =>
      polyline(xy) + " " + fmt(xy[xy.length - 1][0]) + "," + PLOT_B + " " + fmt(xy[0][0]) + "," + PLOT_B;

    out.push('<polygon points="' + area(memXY) + '" fill="' + MEM_COLOR + '" fill-opacity="0.12"/>');
    out.push('<polygon points="' + area(cpuXY) + '" fill="' + CPU_COLOR + '" fill-opacity="0.12"/>');
    out.push('<polyline points="' + polyline(plgXY) + '" fill="none" stroke="' + PLUGIN_COLOR + '" stroke-width="1" stroke-linejoin="round"/>');
    out.push('<polyline points="' + polyline(memXY) + '" fill="none" stroke="' + MEM_COLOR + '" stroke-width="1.5" stroke-linejoin="round"/>');
    out.push('<polyline points="' + polyline(cpuXY) + '" fill="none" stroke="' + CPU_COLOR + '" stroke-width="1.5" stroke-linejoin="round"/>');
  } else {
    out.push(
      '<text x="' + W / 2 + '" y="' + (PLOT_T + PLOT_H / 2 + 3) + '" text-anchor="middle" font-size="9" fill="' + color + '" opacity="0.55">' +
        (n === 0 ? "Waiting for data..." : "Collecting...") + "</text>",
    );
  }

  // Time axis.
  out.push('<g fill="' + color + '" font-size="8" opacity="0.6">');
  out.push('<text x="' + PAD_L + '" y="' + (PLOT_B + 11) + '">' + Math.round(windowMs / 1000) + "s ago</text>");
  out.push('<text x="' + (W - PAD_R) + '" y="' + (PLOT_B + 11) + '" text-anchor="end">now</text>');
  out.push("</g>");

  // Legend: 2 x 2 cells, "dot label ........ value". Hover (SVG <title>) explains each.
  // The fourth is a ring, not a dot: it has no line in the chart.
  const cpuTxt = latest ? Math.round(latest.cpuPct) + "%" : "-";
  const memTxt = latest ? formatBytes(latest.rssBytes) : "-";
  const plgTxt = latest ? formatBytes(latest.pluginBytes) + " (" + latest.plugins + ")" : "-";
  const pl = pluginLegend(opts.plugin);
  const legend: Array<{ color: string; ring: boolean; label: string; value: string; tip: string }> = [
    { color: CPU_COLOR, ring: false, label: "CPU Usage", value: cpuTxt, tip: "CPU time of the main (game) thread, as % of wall time" },
    { color: MEM_COLOR, ring: false, label: "Memory Used", value: memTxt, tip: "Resident memory of the whole server process" },
    { color: PLUGIN_COLOR, ring: false, label: "Plugins", value: plgTxt, tip: "Memory of all running plugins together (their count)" },
    { color: HEAP_COLOR, ring: true, label: pl.label, value: pl.value, tip: pl.tip },
  ];
  const colW = (W - PAD_L - PAD_R) / 2;
  out.push('<g fill="' + color + '" font-size="8.5">');
  for (let i = 0; i < legend.length; i++) {
    const e = legend[i];
    const x = PAD_L + (i % 2) * colW;
    const y = 158 + Math.floor(i / 2) * 18;
    const dot = e.ring
      ? '<circle cx="' + fmt(x + 3) + '" cy="' + (y - 3) + '" r="2.4" fill="none" stroke="' + e.color + '" stroke-width="1.3"/>'
      : '<circle cx="' + fmt(x + 3) + '" cy="' + (y - 3) + '" r="3" fill="' + e.color + '"/>';
    out.push(
      "<g><title>" + escapeXml(e.tip) + "</title>" + dot +
        '<text x="' + fmt(x + 10) + '" y="' + y + '" opacity="0.7">' + escapeXml(e.label) + "</text>" +
        '<text x="' + fmt(x + colW - 8) + '" y="' + y + '" text-anchor="end" font-size="10" font-weight="bold">' + escapeXml(e.value) + "</text></g>",
    );
  }
  out.push("</g>");

  // Which plugin that cell is about, with its data size (spcomp's "Data size").
  if (opts.plugin) {
    const data = opts.plugin.dataBytes >= 0 ? "  \u00b7  Data " + opts.plugin.dataBytes + " bytes" : "";
    out.push(
      '<text x="' + PAD_L + '" y="192" font-size="8" fill="' + color + '" opacity="0.6">Plugin ' +
        escapeXml(clip(opts.plugin.name, 34)) + escapeXml(data) + "</text>",
    );
    const peak = peakLine(opts.plugin);
    if (peak) {
      // data-reset: the webview turns a click on it into "forget the peaks".
      out.push(
        '<g data-reset="1" style="cursor:pointer"><title>' + escapeXml(peak.tip) + "</title>" +
          '<text x="' + PAD_L + '" y="205" font-size="8.5" font-weight="bold" fill="' + color + '">' + escapeXml(peak.text) + "</text></g>",
      );
    }
  }

  if (opts.note) {
    out.push('<text x="' + (W - PAD_R) + '" y="12" text-anchor="end" font-size="8" fill="' + color + '" opacity="0.55">' + escapeXml(opts.note) + "</text>");
  }

  out.push("</svg>");
  return out.join("");
}
