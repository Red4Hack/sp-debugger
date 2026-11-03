/**
 * PerfHistory -- turns the raw, cumulative counters of the `sp_performance`
 * request into a rolling window of plot points (CPU %, memory).
 *
 * Pure (no vscode import) so it is unit-testable. The server sends CPU time as
 * ever-growing milliseconds; the percentage is a delta between two polls, so no
 * per-client state lives on the server.
 *
 * CPU % plotted = the main (game) thread's CPU time / wall time. The game loop
 * is one thread, so 100% means the server can't keep up. When the platform
 * can't report per-thread time (mainCpuMs < 0) it falls back to the whole
 * process divided by the core count.
 */

/** Body of an `sp_performance` response. */
export interface PerfRaw {
  wallMs: number;
  processCpuMs: number;
  /** -1 when the platform can't report the game thread separately. */
  mainCpuMs: number;
  rssBytes: number;
  pluginBytes: number;
  /** Age of pluginBytes; -1 = never measured. */
  pluginAgeMs: number;
  plugins: number;
  cpus: number;
  /** File name of the plugin this session debugs ("" = none, not loaded, or a server that predates this). */
  debugPlugin: string;
  /** Its compiler: "legacy" (before SourcePawn 2.0: fixed stack/heap), "v2" (SourcePawn 2.0), "" = unknown. */
  debugKind: "legacy" | "v2" | "";
  /** Legacy: the "Stack/heap size" spcomp prints. -1 = not available. */
  stackHeapBytes: number;
  /** The "Data size" spcomp prints. -1 = not available. */
  dataBytes: number;
  /** v2: bytes in use in the plugin's allocator heap (approximate). -1 = not available. */
  heapLiveBytes: number;
  /** Legacy: the most stack / heap / both together seen in use at any line since launch (or the last reset). -1 = none yet. */
  stackPeakBytes: number;
  heapPeakBytes: number;
  usedPeakBytes: number;
}

/** One plotted sample. `t` is the SERVER's wall clock in ms. */
export interface PerfPoint {
  t: number;
  /** 0..100, main thread (or process / cpus). */
  cpuPct: number;
  /** Whole-process CPU, % of ONE core (can exceed 100). Not plotted. */
  processPct: number;
  rssBytes: number;
  pluginBytes: number;
  plugins: number;
}

const NUM_FIELDS: Array<keyof PerfRaw> = [
  "wallMs", "processCpuMs", "mainCpuMs", "rssBytes", "pluginBytes", "pluginAgeMs", "plugins", "cpus",
];
/** Absent from servers that predate per-plugin sizes; -1 = not available. */
const OPTIONAL_NUMBERS: Array<keyof PerfRaw> = ["stackHeapBytes", "dataBytes", "heapLiveBytes", "stackPeakBytes", "heapPeakBytes", "usedPeakBytes"];

/** Validates an untrusted response body. Returns undefined if any field is missing/non-finite. */
export function parsePerfRaw(body: unknown): PerfRaw | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { [k: string]: unknown };
  const out: any = {};
  for (let i = 0; i < NUM_FIELDS.length; i++) {
    const k = NUM_FIELDS[i];
    const v = b[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    out[k] = v;
  }
  for (let i = 0; i < OPTIONAL_NUMBERS.length; i++) {
    const k = OPTIONAL_NUMBERS[i];
    const v = b[k];
    if (v === undefined) out[k] = -1;
    else if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    else out[k] = v;
  }
  const name = b.debugPlugin;
  if (name === undefined) out.debugPlugin = "";
  else if (typeof name !== "string") return undefined;
  else out.debugPlugin = name;
  out.debugKind = b.debugKind === "legacy" || b.debugKind === "v2" ? b.debugKind : "";
  return out as PerfRaw;
}

/** The debugged plugin's size, as the panel shows it. */
export interface PerfPluginInfo {
  name: string;
  kind: "legacy" | "v2" | "";
  stackHeapBytes: number;
  dataBytes: number;
  heapLiveBytes: number;
  stackPeakBytes: number;
  heapPeakBytes: number;
  usedPeakBytes: number;
}

/** undefined when the session debugs no (loaded) plugin or the server doesn't say. */
export function pluginInfoOf(raw: PerfRaw | undefined): PerfPluginInfo | undefined {
  if (!raw || raw.debugPlugin === "") return undefined;
  return {
    name: raw.debugPlugin,
    kind: raw.debugKind,
    stackHeapBytes: raw.stackHeapBytes,
    dataBytes: raw.dataBytes,
    heapLiveBytes: raw.heapLiveBytes,
    stackPeakBytes: raw.stackPeakBytes,
    heapPeakBytes: raw.heapPeakBytes,
    usedPeakBytes: raw.usedPeakBytes,
  };
}

export interface PerfHistoryOptions {
  /** Width of the visible window. Default 30 s. */
  windowMs?: number;
  /** Polls closer together than this are ignored (a CPU delta over ~0 s is noise). Default 400 ms. */
  minStepMs?: number;
  /** A gap longer than this (view hidden, server stalled) restarts the history. Default 5 s. */
  maxGapMs?: number;
}

export class PerfHistory {
  private pts: PerfPoint[] = [];
  private prev: PerfRaw | undefined;
  private last: PerfRaw | undefined;
  private readonly windowMs: number;
  private readonly minStepMs: number;
  private readonly maxGapMs: number;

  constructor(opts: PerfHistoryOptions = {}) {
    this.windowMs = opts.windowMs !== undefined ? opts.windowMs : 30000;
    this.minStepMs = opts.minStepMs !== undefined ? opts.minStepMs : 400;
    this.maxGapMs = opts.maxGapMs !== undefined ? opts.maxGapMs : 5000;
  }

  get window(): number { return this.windowMs; }
  get points(): ReadonlyArray<PerfPoint> { return this.pts; }
  /** Newest raw sample, for labels that don't need a delta (plugin count, cpus, ...). */
  get latestRaw(): PerfRaw | undefined { return this.last; }
  get latest(): PerfPoint | undefined { return this.pts.length ? this.pts[this.pts.length - 1] : undefined; }

  reset(): void {
    this.pts = [];
    this.prev = undefined;
    this.last = undefined;
  }

  /** Feed one response. Returns the new point, or undefined if this sample only primed the baseline / was skipped. */
  push(raw: PerfRaw): PerfPoint | undefined {
    const prev = this.prev;
    this.last = raw;

    // The first sample has no delta to compare with. A server restart makes the
    // clocks go backwards; a long gap makes the delta an average over a period
    // the user never saw. Either way: start over from this sample.
    if (
      !prev ||
      raw.wallMs < prev.wallMs ||
      raw.processCpuMs < prev.processCpuMs ||
      raw.wallMs - prev.wallMs > this.maxGapMs
    ) {
      this.pts = [];
      this.prev = raw;
      return undefined;
    }

    const dw = raw.wallMs - prev.wallMs;
    if (dw < this.minStepMs) return undefined; // keep prev: next delta spans more time

    const cpus = raw.cpus >= 1 ? raw.cpus : 1;
    const dProc = Math.max(0, raw.processCpuMs - prev.processCpuMs);
    const mainOk = raw.mainCpuMs >= 0 && prev.mainCpuMs >= 0 && raw.mainCpuMs >= prev.mainCpuMs;
    const rawPct = mainOk
      ? (100 * (raw.mainCpuMs - prev.mainCpuMs)) / dw
      : (100 * dProc) / dw / cpus;
    const pt: PerfPoint = {
      t: raw.wallMs,
      cpuPct: Math.min(100, Math.max(0, rawPct)), // clock granularity can overshoot a hair
      processPct: (100 * dProc) / dw,
      rssBytes: raw.rssBytes,
      pluginBytes: raw.pluginBytes,
      plugins: raw.plugins,
    };
    this.pts.push(pt);
    this.prev = raw;

    // Drop what scrolled out, but keep ONE point beyond the left edge so the
    // line enters the plot from the border instead of starting mid-air.
    const cutoff = raw.wallMs - this.windowMs;
    while (this.pts.length > 2 && this.pts[1].t < cutoff) this.pts.shift();
    return pt;
  }
}
