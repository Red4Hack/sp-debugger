// The vscode glue of the Realtime Performance panel, driven with a fake
// WebviewView and a fake debug session.
import { afterEach, describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { readFileSync } from "fs";
import { join } from "path";
import { PerfViewProvider } from "../../perf/PerfViewProvider";
import { PerfRaw } from "../../perf/PerfHistory";

function raw(wallMs: number, over: Partial<PerfRaw> = {}): PerfRaw {
  return {
    wallMs, processCpuMs: wallMs / 5, mainCpuMs: wallMs / 10, rssBytes: 85 * 1048576,
    pluginBytes: 1.4 * 1048576, pluginAgeMs: 100, plugins: 18, cpus: 4,
    debugPlugin: "debugger_test.smx", debugKind: "legacy", stackHeapBytes: 17032, dataBytes: 4036,
    heapLiveBytes: -1, stackPeakBytes: 48, heapPeakBytes: 6048, usedPeakBytes: 6096, ...over,
  };
}

function fakeView(visible = true) {
  const posted: any[] = [];
  const cb: { msg?: (m: unknown) => void; vis?: () => void } = {};
  const view: any = {
    visible,
    webview: {
      options: {},
      html: "",
      postMessage: async (m: unknown) => (posted.push(m), true),
      onDidReceiveMessage: (f: (m: unknown) => void) => ((cb.msg = f), { dispose() {} }),
    },
    onDidChangeVisibility: (f: () => void) => ((cb.vis = f), { dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  return { view, posted, cb };
}

const setSession = (s: unknown) => ((vscode.debug as any).activeDebugSession = s);
// resolveWebviewView() fires the first poll without awaiting it; let it finish
// (a second tick() while it is in flight is a deliberate no-op).
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("PerfViewProvider", () => {
  afterEach(() => setSession(undefined));

  it("is contributed in package.json under the id the code registers", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8"));
    const views = pkg.contributes.views.debug.map((v: any) => v.id);
    expect(views).toContain(PerfViewProvider.viewType);
    expect(pkg.contributes.views.debug.find((v: any) => v.id === PerfViewProvider.viewType).type).toBe("webview");
    expect(pkg.activationEvents).toContain("onView:" + PerfViewProvider.viewType);
  });

  it("renders a locked-down page and replays the last message on `ready`", () => {
    const p = new PerfViewProvider();
    const { view, posted, cb } = fakeView(false);
    p.resolveWebviewView(view);
    expect(view.webview.options.enableScripts).toBe(true);
    expect(view.webview.html).toContain("default-src 'none'");
    expect(view.webview.html).toMatch(/script-src 'nonce-[A-Za-z0-9]{32}'/);
    cb.msg!({ type: "ready" });
    expect(posted.length).toBe(1);
    expect(posted[0].text).toContain("debug session");
    p.dispose();
  });

  it("does not poll while hidden", () => {
    const p = new PerfViewProvider();
    const { view, posted } = fakeView(false);
    setSession({ id: "s", type: "sp-debugger", customRequest: async () => { throw new Error("must not be called"); } });
    p.resolveWebviewView(view);
    expect(posted.length).toBe(0);
    p.dispose();
  });

  it("charts the answers of an active sp-debugger session", async () => {
    const bodies = [raw(0), raw(1000), raw(2000)];
    let i = 0;
    const asked: string[] = [];
    setSession({ id: "s1", type: "sp-debugger", customRequest: async (c: string) => (asked.push(c), bodies[i++]) });
    const p = new PerfViewProvider();
    const { view, posted } = fakeView(true);
    p.resolveWebviewView(view); // first poll (primes the baseline)
    await settle();
    await (p as any).tick();    // -> point 1
    await (p as any).tick();    // -> point 2
    p.dispose();
    expect(asked.length).toBe(3);
    expect(asked[0]).toBe("sp_performance");
    const last = posted[posted.length - 1];
    expect(typeof last.svg).toBe("string");
    expect(last.svg).toContain("REALTIME PERFORMANCE");
    expect(last.svg).toContain("<polyline");
    // the debugged plugin's stack/heap size, as spcomp prints it
    expect(last.svg).toContain("Stack/heap");
    expect(last.svg).toContain("17032 bytes");
    expect(last.svg).toContain("debugger_test.smx");
    expect(last.svg).toContain("Peak 6096 of 17032 bytes");
  });

  it("sends resetPeaks with the next poll after a click on the peak line", async () => {
    const sent: any[] = [];
    let i = 0;
    setSession({ id: "s5", type: "sp-debugger", customRequest: async (_c: string, a: any) => (sent.push(a), raw(i++ * 1000)) });
    const p = new PerfViewProvider();
    const { view, cb } = fakeView(true);
    p.resolveWebviewView(view);
    await settle();
    expect(sent[0]).toEqual({});
    cb.msg!({ type: "resetPeaks" });
    await settle();
    expect(sent[1]).toEqual({ resetPeaks: true });
    await (p as any).tick();
    expect(sent[2]).toEqual({}); // once only
    p.dispose();
  });

  it("ignores other debuggers and says so", async () => {
    setSession({ id: "x", type: "node", customRequest: async () => { throw new Error("no"); } });
    const p = new PerfViewProvider();
    const { view, posted } = fakeView(true);
    p.resolveWebviewView(view);
    p.dispose();
    expect(posted[posted.length - 1].text).toContain("SourcePawn debug session");
  });

  it("keeps the chart and flags it after repeated failures", async () => {
    let n = 0;
    setSession({
      id: "s2", type: "sp-debugger",
      customRequest: async () => { n++; if (n <= 3) return raw(n * 1000); throw new Error("timeout"); },
    });
    const p = new PerfViewProvider();
    const { view, posted } = fakeView(true);
    p.resolveWebviewView(view); // ok #1 (baseline)
    await settle();
    await (p as any).tick();     // ok #2 -> point 1
    await (p as any).tick();     // ok #3 -> point 2 (a line needs two)
    expect(posted[posted.length - 1].svg).toContain("<polyline");
    await (p as any).tick();     // fail 1
    await (p as any).tick();     // fail 2
    expect(posted[posted.length - 1].svg).not.toContain("no response");
    await (p as any).tick();     // fail 3
    p.dispose();
    const last = posted[posted.length - 1];
    expect(last.svg).toContain("no response");
    expect(last.svg).toContain("<polyline"); // history is still drawn
  });

  it("rejects a malformed response instead of plotting NaN", async () => {
    setSession({ id: "s3", type: "sp-debugger", customRequest: async () => ({ wallMs: "x" }) });
    const p = new PerfViewProvider();
    const { view, posted } = fakeView(true);
    p.resolveWebviewView(view);
    await settle();
    await (p as any).tick();
    p.dispose();
    for (const m of posted) expect(JSON.stringify(m)).not.toContain("NaN");
  });
});
