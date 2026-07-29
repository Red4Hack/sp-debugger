import { ProfileCapture, ProfileNode } from "./ProfilerTreeProvider";

/**
 * Converts a capture into the Chrome Trace Event Format — the JSON that
 * ui.perfetto.dev and chrome://tracing read.
 *
 * This is the view an aggregated flame graph structurally cannot give: a
 * timeline. Every call the tracer closed is emitted as a complete ("X") event
 * with its real begin and duration, so a capture can be read tick by tick —
 * *this* frame took 12 ms and here is what ran inside it — instead of only
 * "OnGameFrame cost 400 ms in total". For a game server, where a single spiking
 * tick is the whole problem, that difference is the point.
 *
 * The server already knows exactly where one Invoke ends and the next begins
 * (the VM's Invoke counter drives the tracer), so the top-level spans line up
 * with the server's own callback boundaries.
 */

interface TraceEvent {
  name: string;
  cat: string;
  ph: "X" | "M";
  ts: number; // microseconds
  dur?: number; // microseconds
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

export interface TraceDocument {
  traceEvents: TraceEvent[];
  displayTimeUnit: "ms" | "ns";
  otherData?: Record<string, string>;
}

const PID = 1;
const TID = 1;

// "antibhop.smx::OnGameFrame" -> { plugin, fn }
function splitName(name: string, group: string): { plugin: string; fn: string } {
  const idx = name.indexOf("::");
  if (idx >= 0) return { plugin: name.slice(0, idx), fn: name.slice(idx + 2) };
  return { plugin: group || "", fn: name || "(anonymous)" };
}

export function captureToTrace(capture: ProfileCapture | undefined): TraceDocument {
  const events: TraceEvent[] = [];

  // Name the process/thread so Perfetto shows something meaningful in the track
  // list instead of "Process 1".
  events.push({
    name: "process_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: PID,
    tid: TID,
    args: { name: "SourcePawn VM (game thread)" },
  });
  events.push({
    name: "thread_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: PID,
    tid: TID,
    args: { name: "plugin execution" },
  });

  // Server node id -> node, so a span can be labelled and annotated.
  const byId = new Map<number, ProfileNode>();
  const index = (n: ProfileNode) => {
    byId.set(n.id, n);
    for (const child of n.children) index(child);
  };
  for (const top of capture?.tree?.children ?? []) index(top);

  for (const span of capture?.spans?.items ?? []) {
    const node = byId.get(span.id);
    if (!node) continue;
    const { plugin, fn } = splitName(node.name, node.group);
    const args: Record<string, unknown> = {
      plugin,
      calls: node.calls,
      "self ms (all calls)": Number(node.selfMs.toFixed(4)),
      "total ms (all calls)": Number(node.totalMs.toFixed(4)),
    };
    if (node.lines && node.lines.length > 0) {
      args["hottest line"] = node.lines[0].line;
    }
    events.push({
      name: fn,
      cat: plugin || "sourcepawn",
      ph: "X",
      ts: Number(span.tsUs.toFixed(3)),
      // Perfetto drops zero-length slices; keep every call visible.
      dur: Math.max(0.001, Number(span.durUs.toFixed(3))),
      pid: PID,
      tid: TID,
      args,
    });
  }

  return {
    traceEvents: events,
    displayTimeUnit: "ms",
    otherData: {
      source: "sp-debugger",
      captureWindowMs: String(capture?.windowMs ?? 0),
      spansTruncated: String(capture?.spans?.truncated ?? false),
    },
  };
}
