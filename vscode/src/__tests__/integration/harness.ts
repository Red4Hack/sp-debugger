// Shared plumbing for the integration tests: where the mock environment lives,
// how to start and stop the mock srcds, and a minimal DAP client speaking the
// same wire format as the VS Code adapter.
//
// This started as file-local code inside dap-regression.test.ts. It moved here
// when a second integration test (extension-lifecycle) needed the same client:
// one implementation means the framing, the timeouts and the process cleanup
// are fixed once for both.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location. */
export const REPO = path.resolve(HERE, "..", "..", "..", "..");
export const MOCK = path.join(REPO, "sp-console-debugger", "tests", "mock");

export const SRCDS =
  process.env.SP_SRCDS || path.join(MOCK, "hl2sdk-mock", "objdir", "dist", "x86_64", "srcds");
export const GAMEDIR = process.env.SP_GAMEDIR || path.join(MOCK, "gamedir");
export const SOURCE =
  process.env.SP_SOURCE || path.join(REPO, "sp-console-debugger", "tests", "debugger_test.sp");
export const SOURCE_NAME = path.basename(SOURCE);
export const PORT = parseInt(process.env.SP_PORT || "8080", 10);
export const MAP = process.env.SP_MAP || "de_dust2";

/** The plugin must be staged ENABLED (vscode/tests/dap/run_dap_tests.sh does it). */
export const PLUGIN_SMX = path.join(GAMEDIR, "addons", "sourcemod", "plugins", "debugger_test.smx");
export const EXT_DIR = path.join(GAMEDIR, "addons", "sourcemod", "extensions");

/**
 * Whether the mock environment is staged. Every integration suite gates on this
 * so a plain `bun test` on a fresh checkout stays green instead of failing on a
 * missing server.
 */
export const mockEnvReady =
  fs.existsSync(SRCDS) &&
  fs.existsSync(PLUGIN_SMX) &&
  (fs.existsSync(path.join(EXT_DIR, "sp-debugger.ext.so")) ||
    fs.existsSync(path.join(EXT_DIR, "x64", "sp-debugger.ext.so")));

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----- mock srcds ---------------------------------------------------------

export interface SrcdsHandle {
  proc: ChildProcess;
  /** How the process ended, once it has: exit code and/or fatal signal. */
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: string | null }>;
  /** Everything the server has printed so far (when captureOutput is set). */
  output(): string;
  /** Type a line into the server console. */
  send(line: string): void;
  /** Still running? */
  alive(): boolean;
  /** Wait until `pattern` shows up in the output, or give up. */
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<boolean>;
  stop(): void;
}

/**
 * Start the mock server. The tick budget is large because the VM's tick loop
 * freezes while paused at a breakpoint; it only has to cover boot plus the
 * short pre-pause window.
 */
export function startSrcds(options: { captureOutput?: boolean } = {}): SrcdsHandle {
  const capture = options.captureOutput ?? false;
  const proc = spawn(SRCDS, ["-game_dir", GAMEDIR, "+map", MAP, "-run-ticks", "100000"], {
    stdio: ["pipe", capture ? "pipe" : "ignore", capture ? "pipe" : "ignore"],
  });

  let text = "";
  if (capture) {
    proc.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
  }

  let exited = false;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.on("exit", (code, signal) => {
      exited = true;
      exitInfo = { code, signal: signal as string | null };
      resolve(exitInfo);
    });
  });

  const handle: SrcdsHandle = {
    proc,
    async waitForExit(timeoutMs = 30000) {
      if (exitInfo) return exitInfo;
      const timeout = delay(timeoutMs).then(() => ({ code: null, signal: "TIMEOUT" }));
      return Promise.race([exitPromise, timeout]);
    },
    output: () => text,
    send(line: string) {
      try {
        proc.stdin?.write(line.endsWith("\n") ? line : line + "\n");
      } catch {
        /* server already gone */
      }
    },
    alive: () => !exited && proc.exitCode === null && proc.signalCode === null,
    async waitForOutput(pattern: RegExp, timeoutMs = 15000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(text)) return true;
        await delay(100);
      }
      return false;
    },
    stop() {
      handle.send("quit");
      // Kill synchronously: bun tears the process down as soon as the test file
      // finishes, so a deferred kill never fires and the server would survive,
      // still holding the DAP port for the next run.
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    },
  };
  return handle;
}

// ----- port probes --------------------------------------------------------

/** Resolves true if something accepts a connection on `port` right now. */
export function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ port, host: "127.0.0.1" });
    const done = (open: boolean) => {
      probe.destroy();
      resolve(open);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/** Poll until the port reaches `open`, or the timeout expires. */
export async function waitForPort(
  port: number,
  open: boolean,
  timeoutMs = 20000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portIsOpen(port)) === open) return true;
    await delay(200);
  }
  return false;
}

/**
 * Nothing may be listening on the DAP port before a test starts its own server:
 * if something is, the session would talk to that stranger (usually a leaked
 * srcds from an earlier run) and fail much later with a confusing timeout.
 */
export async function assertPortFree(port: number, graceMs = 10000): Promise<void> {
  // A short grace period first: when two integration files run back to back, the
  // previous server may still be releasing the port as this one starts. Only a
  // port that stays busy is a real problem.
  if (await waitForPort(port, false, graceMs)) return;
  throw new Error(
    `port ${port} is still in use after ${graceMs}ms -- a previous srcds is probably ` +
      `still running (pkill -f 'objdir/dist/.*/srcds'), or set SP_PORT to a free port`,
  );
}

// ----- minimal DAP client -------------------------------------------------

/** Same wire format as the VS Code adapter: Content-Length framed JSON. */
export class DapClient {
  private seq = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    number,
    { resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private eventWaiters: {
    event: string;
    resolve: (m: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private socket: net.Socket | null = null;

  /** Connect, retrying until the server has finished booting. */
  async connect(port: number, attempts = 120, gapMs = 500): Promise<void> {
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      let n = 0;
      const tryOnce = () => {
        const sock = net.createConnection({ host: "127.0.0.1", port });
        sock.setNoDelay(true);
        sock.once("connect", () => resolve(sock));
        sock.once("error", () => {
          sock.destroy();
          if (++n >= attempts) return reject(new Error(`DAP port ${port} never opened`));
          setTimeout(tryOnce, gapMs);
        });
      };
      tryOnce();
    });
    this.socket.on("data", (chunk: Buffer) => this.feed(chunk));
  }

  send(command: string, args: unknown = {}, timeoutMs = 30000): Promise<any> {
    const s = this.seq++;
    const msg = JSON.stringify({ seq: s, type: "request", command, arguments: args });
    this.socket!.write(`Content-Length: ${Buffer.byteLength(msg, "utf8")}\r\n\r\n${msg}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(s);
        reject(new Error(`timeout: ${command}`));
      }, timeoutMs);
      this.pending.set(s, { resolve, reject, timer });
    });
  }

  /** Resolves with the event, or null when it does not arrive in time. */
  waitForEvent(event: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.eventWaiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.eventWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.eventWaiters.push({ event, resolve, timer });
    });
  }

  /** Every variable across all scopes of a frame, flattened to name -> value. */
  async collectVariables(frameId: number): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const sc = await this.send("scopes", { frameId });
    for (const scope of sc.body?.scopes || []) {
      const v = await this.send("variables", { variablesReference: scope.variablesReference });
      for (const variable of v.body?.variables || []) out[variable.name] = variable.value;
    }
    return out;
  }

  close(): void {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    for (const w of this.eventWaiters) clearTimeout(w.timer);
    this.eventWaiters = [];
    try {
      this.socket?.destroy();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  private onMessage(msg: any) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.request_seq);
      msg.success ? p.resolve(msg) : p.reject(new Error(msg.message || "request failed"));
    } else if (msg.type === "event") {
      const i = this.eventWaiters.findIndex((w) => w.event === msg.event);
      if (i >= 0) {
        const w = this.eventWaiters[i];
        clearTimeout(w.timer);
        this.eventWaiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  }

  private feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const he = this.buffer.indexOf("\r\n\r\n");
      if (he < 0) return;
      const m = this.buffer.slice(0, he).toString("utf8").match(/Content-Length: (\d+)/i);
      if (!m) {
        this.buffer = this.buffer.slice(he + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = he + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.slice(start, start + len).toString("utf8");
      this.buffer = this.buffer.slice(start + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        /* framing noise is asserted elsewhere */
      }
    }
  }
}
