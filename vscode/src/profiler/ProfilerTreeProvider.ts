import * as vscode from "vscode";

/** Self time attributed to one source line of a function. */
export interface ProfileLine {
  line: number;
  selfMs: number;
}

/** One node of the call tree returned by the server's sp_profileStop command. */
export interface ProfileNode {
  /** Depth-first id assigned by the server; samples and spans reference it. */
  id: number;
  name: string;
  group: string;
  totalMs: number; // inclusive time across all calls on this path
  selfMs: number; // time in this function excluding callees
  calls: number;
  // Per-call distribution of self time. "1 call of 40 ms" and "4000 calls of
  // 10 us" have the same total and completely different meanings.
  minSelfMs: number;
  maxSelfMs: number;
  p95SelfMs: number;
  /** Self time per source line, heaviest first (absent when unavailable). */
  lines?: ProfileLine[];
  children: ProfileNode[];
}

/**
 * The measured timeline behind the tree: sample i means "node id[i] was on top
 * for dtUs[i] microseconds, starting at startUs[i] from the capture start".
 * Consecutive samples of the same node are merged server-side.
 */
export interface ProfileSamples {
  id: number[];
  dtUs: number[];
  startUs: number[];
  truncated: boolean;
}

/** One completed call, for the trace/timeline export. */
export interface ProfileSpanItem {
  id: number;
  tsUs: number;
  durUs: number;
  depth: number;
}

export interface ProfileSpans {
  items: ProfileSpanItem[];
  truncated: boolean;
}

/** Everything one sp_profileStop returns. */
export interface ProfileCapture {
  tree?: ProfileNode;
  samples?: ProfileSamples;
  spans?: ProfileSpans;
  windowMs?: number;
}

/** Aggregated row for the flat "Top functions" view (merged across call paths). */
interface FlatRow {
  name: string;
  selfMs: number; // summed self time across every occurrence
  totalMs: number; // summed inclusive time (can exceed wall time across paths)
  calls: number;
}

/** A tree item is either a call-tree node or a flat aggregate row. */
type Item =
  | { kind: "tree"; node: ProfileNode }
  | { kind: "flat"; row: FlatRow };

export type ProfilerMode = "tree" | "flat";
export type ProfilerSort = "self" | "total";

/**
 * Renders the captured profile in a VS Code TreeView.
 *
 * A capture contains exactly ONE tree: the debugged plugin's full intra-plugin
 * callee tree, from the debug-break tracer. There used to be a second "all
 * plugins" tree (the VM's IProfilingTool, top-level Invoke boundaries only) and
 * a toggle between them -- but the two are measured on different clocks and at
 * different granularity, so putting them behind one switch invited comparing
 * numbers that are not comparable. The VM profiler still runs on the server; it
 * is now purely the Invoke-boundary signal the tracer needs.
 *
 * Views: a **mode** (call tree vs flat "Top functions"), a **sort key** (self vs
 * total), and **% of total**. Clicking a node jumps to the function's source.
 */
export class ProfilerTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    Item | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: ProfileNode[] = []; // debugged plugin (callees)
  private capture: ProfileCapture | undefined;
  private capturedAt: Date | undefined;
  private grandTotalMs = 0; // sum of top-level totals
  private captureWindowMs = 0; // real wall-clock duration of the capture window

  mode: ProfilerMode = "tree";
  sort: ProfilerSort = "self";

  private get rawRoots(): ProfileNode[] {
    return this.roots;
  }

  // ---- data ---------------------------------------------------------------

  setData(capture: ProfileCapture | undefined, _activePluginSmx?: string): void {
    this.capture = capture;
    this.roots = capture?.tree?.children ?? [];
    this.captureWindowMs = capture?.windowMs ?? 0;
    this.sortRecursive(this.roots);
    this.capturedAt = new Date();
    this.recomputeTotal();
    this.refreshContext();
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.roots = [];
    this.capture = undefined;
    this.capturedAt = undefined;
    this.grandTotalMs = 0;
    this.captureWindowMs = 0;
    this._onDidChangeTreeData.fire();
  }

  hasData(): boolean {
    return this.roots.length > 0;
  }

  /** The whole capture (tree + measured timeline), for the exporters. */
  rawCapture(): ProfileCapture | undefined {
    return this.roots.length > 0 ? this.capture : undefined;
  }

  /** Tree (root container) for flame-chart export. */
  rawTree(): ProfileNode | undefined {
    if (this.roots.length === 0) return undefined;
    return {
      id: 0,
      name: "<root>",
      group: "",
      totalMs: 0,
      selfMs: 0,
      calls: 0,
      minSelfMs: 0,
      maxSelfMs: 0,
      p95SelfMs: 0,
      children: this.roots,
    };
  }

  /** Wall-clock duration of the capture window, in ms (0 when unknown). */
  windowMs(): number {
    return this.captureWindowMs;
  }

  hottestBySelf(): { name: string; selfMs: number } | undefined {
    const flat = this.flatten(this.rawRoots);
    let best: FlatRow | undefined;
    for (const r of flat.values()) if (!best || r.selfMs > best.selfMs) best = r;
    return best;
  }

  // ---- toggles ------------------------------------------------------------

  toggleMode(): void {
    this.mode = this.mode === "tree" ? "flat" : "tree";
    this.refreshContext();
    this._onDidChangeTreeData.fire();
  }
  toggleSort(): void {
    this.sort = this.sort === "self" ? "total" : "self";
    this.refreshContext();
    this._onDidChangeTreeData.fire();
  }
  private recomputeTotal(): void {
    this.grandTotalMs = this.rawRoots.reduce((a, n) => a + n.totalMs, 0);
  }

  /**
   * Denominator for the "% of …" column: the sum of top-level totals. The tracer
   * measures time only while the plugin is executing (between-frame idle is
   * deliberately excluded), so a percentage here means "share of the plugin's
   * traced execution", never "share of wall time" — dividing by the capture
   * window would silently mix the two.
   */
  private get denominatorMs(): number {
    return this.grandTotalMs;
  }


  private refreshContext(): void {
    vscode.commands.executeCommand("setContext", "spDebugger.profilerMode", this.mode);
    vscode.commands.executeCommand("setContext", "spDebugger.profilerSort", this.sort);
  }

  // ---- TreeDataProvider ---------------------------------------------------

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "flat") return this.flatRowItem(item.row);
    return this.treeNodeItem(item.node);
  }

  getChildren(item?: Item): Item[] {
    if (this.mode === "flat") {
      if (item) return []; // flat list has no nesting
      return this.flatItems();
    }
    // tree mode
    const nodes = item && item.kind === "tree" ? item.node.children : this.rawRoots;
    return this.sortNodes(nodes).map((node) => ({ kind: "tree", node }));
  }

  // ---- rendering ----------------------------------------------------------

  private pct(ms: number): string {
    const denom = this.denominatorMs;
    if (denom <= 0) return "";
    return `${((ms / denom) * 100).toFixed(1)}%`;
  }

  private treeNodeItem(node: ProfileNode): vscode.TreeItem {
    const hasChildren = node.children && node.children.length > 0;
    const item = new vscode.TreeItem(
      this.shortName(node.name),
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const lead = this.sort === "self" ? node.selfMs : node.totalMs;
    item.description =
      `${this.pct(lead)} · total ${node.totalMs.toFixed(3)} ms · ` +
      `self ${node.selfMs.toFixed(3)} ms · ${node.calls}×`;
    item.tooltip = this.tooltip(node.name, node.totalMs, node.selfMs, node.calls, false, node);
    item.iconPath = new vscode.ThemeIcon(node.selfMs >= 1 ? "flame" : "symbol-method");
    item.command = this.revealCommand(node.name);
    return item;
  }

  private flatRowItem(row: FlatRow): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.shortName(row.name),
      vscode.TreeItemCollapsibleState.None,
    );
    const lead = this.sort === "self" ? row.selfMs : row.totalMs;
    item.description =
      `${this.pct(lead)} · self ${row.selfMs.toFixed(3)} ms · ` +
      `total ${row.totalMs.toFixed(3)} ms · ${row.calls}×`;
    item.tooltip = this.tooltip(row.name, row.totalMs, row.selfMs, row.calls, true);
    item.iconPath = new vscode.ThemeIcon(row.selfMs >= 1 ? "flame" : "symbol-method");
    item.command = this.revealCommand(row.name);
    return item;
  }

  private tooltip(
    name: string,
    total: number,
    self: number,
    calls: number,
    flat = false,
    node?: ProfileNode,
  ): vscode.MarkdownString {
    const lines = [
      `**${name || "<anonymous>"}**`,
      "",
      `- Self (exclusive): **${self.toFixed(3)} ms** (${this.pct(self)})`,
      `- Total (inclusive${flat ? ", summed across call sites" : ""}): **${total.toFixed(3)} ms**`,
      `- Calls: **${calls}**`,
      calls > 0 ? `- Avg self/call: **${(self / calls).toFixed(4)} ms**` : "",
    ];

    // Per-call spread: separates "one slow call" from "many cheap ones", which
    // the average alone hides.
    if (node && calls > 1 && node.maxSelfMs > 0) {
      lines.push(
        `- Self per call — min **${node.minSelfMs.toFixed(4)} ms** · ` +
          `p95 **${node.p95SelfMs.toFixed(4)} ms** · max **${node.maxSelfMs.toFixed(4)} ms**`,
      );
    }

    // Hottest lines inside the function. A native's cost lands on the line that
    // called it (the VM reports no native-level scopes), so this is also where
    // an expensive SQL/file/engine call shows up.
    const hotLines = node?.lines?.slice(0, 5) ?? [];
    if (hotLines.length > 0) {
      lines.push("", "**Hot lines** (self ms)");
      for (const l of hotLines) {
        lines.push(`- line ${l.line}: **${l.selfMs.toFixed(3)} ms**`);
      }
    }

    lines.push("", "_Click to open the function source._");
    return new vscode.MarkdownString(lines.join("\n"));
  }

  private revealCommand(name: string): vscode.Command {
    return {
      command: "sp-debugger.revealProfileFunction",
      title: "Open Function Source",
      arguments: [name],
    };
  }

  // "antibhop.smx::OnGameFrame" -> "OnGameFrame  (antibhop.smx)" for display.
  private shortName(name: string): string {
    const idx = name.indexOf("::");
    if (idx < 0) return name;
    return `${name.slice(idx + 2)}  ·  ${name.slice(0, idx)}`;
  }

  // ---- filtering / sorting / aggregation ----------------------------------

  private sortNodes(nodes: ProfileNode[]): ProfileNode[] {
    const key = this.sort;
    return [...nodes].sort((a, b) => (key === "self" ? b.selfMs - a.selfMs : b.totalMs - a.totalMs));
  }

  private sortRecursive(nodes: ProfileNode[]): void {
    nodes.sort((a, b) => b.totalMs - a.totalMs);
    nodes.forEach((n) => this.sortRecursive(n.children));
  }

  private flatten(roots: ProfileNode[]): Map<string, FlatRow> {
    const map = new Map<string, FlatRow>();
    const walk = (n: ProfileNode) => {
      const r = map.get(n.name) ?? { name: n.name, selfMs: 0, totalMs: 0, calls: 0 };
      r.selfMs += n.selfMs;
      r.totalMs += n.totalMs;
      r.calls += n.calls;
      map.set(n.name, r);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    return map;
  }

  private flatItems(): Item[] {
    const rows = [...this.flatten(this.rawRoots).values()];
    rows.sort((a, b) => (this.sort === "self" ? b.selfMs - a.selfMs : b.totalMs - a.totalMs));
    return rows.map((row) => ({ kind: "flat", row }));
  }

  get lastCaptureTime(): Date | undefined {
    return this.capturedAt;
  }
}
