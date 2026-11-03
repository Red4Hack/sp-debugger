/**
 * PerfViewProvider -- the "Realtime Performance" panel in the Run & Debug view.
 *
 * Polls the `sp_performance` custom request once a second while the panel is
 * visible and a SourcePawn session is active, feeds the answers into a
 * PerfHistory and posts the rendered SVG to the webview. The request is served
 * by the server's TCP thread, so the chart keeps moving while the VM is paused
 * at a breakpoint.
 *
 * Only the thin vscode glue lives here; the sampling maths is PerfHistory and
 * the drawing is perfChart (both pure and unit-tested).
 */
import * as vscode from "vscode";
import { PerfHistory, parsePerfRaw, pluginInfoOf } from "./PerfHistory";
import { renderPerfSvg } from "./perfChart";

const POLL_MS = 1000;
/** Short: a poll that hangs must not pile up behind the next one. */
const REQUEST_TIMEOUT_MS = 3000;
const FAILURES_BEFORE_NOTE = 3;

type WebviewMessage = { svg: string } | { text: string };

export class PerfViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "spDebuggerPerformance";

  private view: vscode.WebviewView | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly history = new PerfHistory();
  private inFlight = false;
  private sessionId: string | undefined;
  private failures = 0;
  /** The user clicked the peak line: ask the server to forget the peaks with the next poll. */
  private resetPeaks = false;
  /** Last thing posted, replayed when the webview (re)loads or becomes visible. */
  private lastMessage: WebviewMessage = { text: "Start a SourcePawn debug session to see server performance." };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage((m: unknown) => {
      const type = m ? (m as { type?: string }).type : undefined;
      if (type === "ready") {
        this.post(this.lastMessage);
      } else if (type === "resetPeaks") {
        // Sent with the next poll; do that one now instead of up to a second later.
        this.resetPeaks = true;
        void this.tick();
      }
    });
    view.onDidChangeVisibility(() => this.syncTimer());
    view.onDidDispose(() => {
      this.view = undefined;
      this.syncTimer();
    });
    this.syncTimer();
  }

  dispose(): void {
    this.stopTimer();
    this.view = undefined;
  }

  // --- polling -----------------------------------------------------------

  private syncTimer(): void {
    if (this.view && this.view.visible) {
      if (!this.timer) {
        void this.tick();
        this.timer = setInterval(() => void this.tick(), POLL_MS);
      }
    } else {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== "sp-debugger") {
      if (this.sessionId !== undefined || this.history.latest === undefined) {
        this.sessionId = undefined;
        this.history.reset();
        this.failures = 0;
        this.publish({ text: "Start a SourcePawn debug session to see server performance." });
      }
      return;
    }
    if (session.id !== this.sessionId) {
      this.sessionId = session.id;
      this.history.reset();
      this.failures = 0;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const args = this.resetPeaks ? { resetPeaks: true } : {};
      this.resetPeaks = false;
      const body = await withTimeout(session.customRequest("sp_performance", args), REQUEST_TIMEOUT_MS);
      const raw = parsePerfRaw(body);
      if (!raw) throw new Error("malformed sp_performance response");
      this.failures = 0;
      this.history.push(raw);
      this.publish({ svg: this.render() });
    } catch {
      this.failures++;
      if (this.failures >= FAILURES_BEFORE_NOTE) {
        // Keep the last chart; just say the data is stale.
        this.publish({
          svg: this.render("no response"),
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  // --- webview -----------------------------------------------------------

  private render(note?: string): string {
    return renderPerfSvg(this.history.points, {
      windowMs: this.history.window,
      plugin: pluginInfoOf(this.history.latestRaw),
      note,
    });
  }

  private publish(m: WebviewMessage): void {
    this.lastMessage = m;
    this.post(m);
  }

  private post(m: WebviewMessage): void {
    if (this.view) void this.view.webview.postMessage(m);
  }

  private html(): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    padding: 4px 8px 8px 8px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
  }
  svg { display: block; max-width: 100%; height: auto; }
  svg text { font-family: var(--vscode-font-family); }
  #msg { opacity: 0.7; font-size: var(--vscode-font-size); padding: 6px 0; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const root = document.getElementById("root");
  // The peak line carries data-reset: a click on it clears the peaks on the server.
  root.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.closest && t.closest("[data-reset]")) vscodeApi.postMessage({ type: "resetPeaks" });
  });
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (typeof m.svg === "string") {
      root.innerHTML = m.svg;
    } else if (typeof m.text === "string") {
      const d = document.createElement("div");
      d.id = "msg";
      d.textContent = m.text;
      root.replaceChildren(d);
    }
  });
  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}

function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
