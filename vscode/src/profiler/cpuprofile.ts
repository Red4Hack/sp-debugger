import { ProfileCapture, ProfileNode } from "./ProfilerTreeProvider";

/**
 * Converts a capture into a V8 ".cpuprofile" document. VS Code ships custom
 * editors for `.cpuprofile` (the same flame chart / table / call-tree UI the JS
 * debugger uses), so emitting this format gives a rich, native profiler view for
 * free — no custom webview needed.
 *
 * The samples are the ones the server actually measured: each break credits the
 * elapsed gap to the function that was executing, and consecutive gaps in the
 * same function are merged. Earlier versions had no timeline to work with and
 * synthesized samples at a fixed 100µs cadence from each node's self time —
 * which made the viewer's time axis fiction (ordering, spikes and zoom all
 * meaningless). With real `timeDeltas`, "when" is now as trustworthy as "how
 * much".
 *
 * Per-line self time rides along as `positionTicks`, which is what makes the
 * viewer attribute heat to individual lines of a function. That is also where a
 * native call's cost surfaces: the VM reports no native-level scopes, so the
 * time lands on the line that called it.
 */

interface CpuCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}
interface CpuPositionTick {
  line: number;
  ticks: number;
}
interface CpuNode {
  id: number;
  callFrame: CpuCallFrame;
  hitCount: number;
  children: number[];
  positionTicks?: CpuPositionTick[];
}
export interface CpuProfile {
  nodes: CpuNode[];
  startTime: number; // microseconds
  endTime: number; // microseconds
  samples: number[];
  timeDeltas: number[];
}

// Fallback cadence, used only when a capture carries no measured timeline
// (older server, or a capture where nothing was sampled).
const SYNTHETIC_INTERVAL_US = 100;

// "antibhop.smx::OnGameFrame" -> { url: "antibhop.smx", fn: "OnGameFrame" }.
function splitName(name: string, group: string): { url: string; fn: string } {
  const idx = name.indexOf("::");
  if (idx >= 0) {
    return { url: name.slice(0, idx), fn: name.slice(idx + 2) };
  }
  return { url: group || "", fn: name || "(anonymous)" };
}

export function captureToCpuProfile(capture: ProfileCapture | undefined): CpuProfile {
  const nodes: CpuNode[] = [];
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  // Server node id -> cpuprofile node id. The server numbers its tree
  // depth-first and its samples reference those ids.
  const idMap = new Map<number, number>();
  let nextId = 1;

  // Synthetic root so the flame chart has a single base frame.
  const rootId = nextId++;
  const root: CpuNode = {
    id: rootId,
    callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
    hitCount: 0,
    children: [],
  };
  nodes.push(root);

  const byCpuId = new Map<number, CpuNode>();

  const visit = (n: ProfileNode, parent: CpuNode) => {
    const { url, fn } = splitName(n.name, n.group);
    const id = nextId++;
    // Anchor the frame on its hottest line so the viewer opens at the code that
    // actually costs, rather than at line 0.
    const anchorLine = n.lines && n.lines.length > 0 ? n.lines[0].line : 0;
    const cpu: CpuNode = {
      id,
      callFrame: {
        functionName: fn,
        scriptId: "1",
        url,
        lineNumber: anchorLine > 0 ? anchorLine - 1 : 0, // cpuprofile lines are 0-based
        columnNumber: 0,
      },
      hitCount: 0,
      children: [],
    };
    if (n.lines && n.lines.length > 0) {
      cpu.positionTicks = n.lines.map((l) => ({
        line: l.line,
        // "ticks" only has to be proportional within a function; microseconds
        // of self time keep the relative weights exact.
        ticks: Math.max(1, Math.round(l.selfMs * 1000)),
      }));
    }
    nodes.push(cpu);
    byCpuId.set(id, cpu);
    idMap.set(n.id, id);
    parent.children.push(id);
    for (const child of n.children) visit(child, cpu);
  };

  for (const top of capture?.tree?.children ?? []) visit(top, root);

  const measured = capture?.samples;
  if (measured && measured.id.length > 0) {
    for (let i = 0; i < measured.id.length; i++) {
      const cpuId = idMap.get(measured.id[i]);
      if (cpuId === undefined) continue;
      samples.push(cpuId);
      // cpuprofile deltas are microseconds; keep them integral and never zero so
      // the viewer's timeline stays monotonic.
      timeDeltas.push(Math.max(1, Math.round(measured.dtUs[i] ?? 0)));
      const node = byCpuId.get(cpuId);
      if (node) node.hitCount += 1;
    }
  } else {
    // No measured timeline: fall back to the old synthesis so a capture from an
    // older server still opens (with a fabricated, evenly-spaced time axis).
    const synth = (n: ProfileNode) => {
      const cpuId = idMap.get(n.id);
      const node = cpuId !== undefined ? byCpuId.get(cpuId) : undefined;
      if (cpuId !== undefined && node) {
        const count = Math.max(0, Math.round((n.selfMs * 1000) / SYNTHETIC_INTERVAL_US));
        node.hitCount = count;
        for (let i = 0; i < count; i++) {
          samples.push(cpuId);
          timeDeltas.push(SYNTHETIC_INTERVAL_US);
        }
      }
      for (const child of n.children) synth(child);
    };
    for (const top of capture?.tree?.children ?? []) synth(top);
  }

  // Every cpuprofile needs at least one sample; if nothing self-timed, anchor
  // a single root sample so the viewer opens cleanly.
  if (samples.length === 0) {
    samples.push(rootId);
    timeDeltas.push(SYNTHETIC_INTERVAL_US);
  }

  const total = timeDeltas.reduce((a, b) => a + b, 0);
  return { nodes, startTime: 0, endTime: total, samples, timeDeltas };
}
