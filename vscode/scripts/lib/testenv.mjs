/**
 * Shared test-environment helpers for the vscode/scripts/ DAP dev tools.
 *
 * Every script defaults to the repo's own test plugin
 * (sp-console-debugger/tests/debugger_test.sp) running on the mock srcds that
 * sp-console-debugger/tests/setup.sh builds -- the same environment the CI
 * regression tests use. No personal plugins or servers involved.
 *
 * debugger_test.sp runs its code path when the `bp` server command is issued.
 * Unlike a real plugin's OnGameFrame (which executes every frame), nothing in
 * the test plugin runs periodically -- so when this module spawns the mock
 * srcds it also "pumps" the `bp` command into its stdin on an interval,
 * keeping the breakpoint line hot the way a per-frame function would be.
 *
 * Remote mode: pass --host / SP_HOST pointing at a real server and no mock is
 * spawned -- the scripts then behave as plain TCP clients and the operator is
 * responsible for the target line executing (pick a hot line with the env
 * overrides each script documents).
 *
 * Prerequisites for mock mode (one-time):
 *   sp-console-debugger/tests/setup.sh        # clones+builds sourcemod/hl2sdk-mock
 *   vscode/tests/dap/run_dap_tests.sh         # builds the extension + stages gamedir
 */
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..", ".."); // vscode/scripts/lib -> repo root
export const TESTS = path.join(REPO, "sp-console-debugger", "tests");
export const MOCK = path.join(TESTS, "mock");

// ----- shared defaults (all anchored to debugger_test.sp) -----------------
export const DEFAULT_PROGRAM = path.join(TESTS, "debugger_test.sp");
export const DEFAULT_PROGRAM_NAME = "debugger_test.sp";
// First OUTPUT() call inside BreakHere: every local, argument and global of
// the test plugin is initialized and in scope at this line.
export const DEFAULT_LINE = 62;
export const DEFAULT_FUNC = "BreakHere";
// Deterministic probe variables (values fixed by debugger_test.sp):
export const LOCAL_INT = "locInteger";        // 7
export const LOCAL_FLOAT = "locFloat";        // 8.0
export const LOCAL_STRING = "locString";      // "local variable"
export const GLOBAL_INT_ARRAY = "g_IntArray";     // int[20] = { 43, ... }
export const GLOBAL_FLOAT_ARRAY = "g_FloatArray"; // float[20] = { 43.43, ... }

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function portOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(t); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(t); resolve(false); });
  });
}

export function connectWithRetry(host, port, attempts = 20, gapMs = 500) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tryOnce = () => {
      const sock = net.createConnection({ host, port });
      sock.setNoDelay(true);
      sock.once("connect", () => resolve(sock));
      sock.once("error", () => {
        sock.destroy();
        if (++n >= attempts) return reject(new Error(`DAP port ${host}:${port} never opened`));
        setTimeout(tryOnce, gapMs);
      });
    };
    tryOnce();
  });
}

/**
 * Spawn the mock srcds with debugger_test loaded and pump `bp` into its stdin
 * every `pumpMs` so the test plugin's code path executes continuously.
 *
 * Returns { stop() } in mock mode, or null when:
 *  - `host` is not loopback (remote server: nothing to spawn), or
 *  - the port is already open locally (an srcds is already running; reuse it --
 *    but then YOU control its console, so keep the target line hot yourself).
 *
 * Exits the process with an actionable message when the mock environment is
 * missing or not staged.
 */
export async function maybeStartMockSrcds({ host, port, pumpMs = 100, map = "de_dust2" } = {}) {
  if (!LOOPBACK.has(host)) return null;

  if (await portOpen(host, port)) {
    console.log(`  \x1b[36m·\x1b[0m port ${port} already open locally -- using the running server ` +
                `(make sure the breakpoint line executes; e.g. run \`bp\` in its console)`);
    return null;
  }

  const srcdsBin = path.join(MOCK, "hl2sdk-mock", "objdir", "dist", "x86_64", "srcds");
  const gamedir = path.join(MOCK, "gamedir");
  const pluginLink = path.join(gamedir, "addons", "sourcemod", "plugins", "debugger_test.smx");
  const extDir = path.join(gamedir, "addons", "sourcemod", "extensions");

  const die = (msg, hint) => {
    console.error(`\x1b[31merror:\x1b[0m ${msg}`);
    console.error(`  ${hint}`);
    process.exit(2);
  };
  if (!fs.existsSync(srcdsBin))
    die(`mock srcds not found at ${srcdsBin}`,
        `run sp-console-debugger/tests/setup.sh once to build the mock environment`);
  if (!fs.existsSync(path.join(extDir, "sp-debugger.ext.so")) &&
      !fs.existsSync(path.join(extDir, "x64", "sp-debugger.ext.so")))
    die(`extension not staged in ${extDir}`,
        `run vscode/tests/dap/run_dap_tests.sh once (it builds the extension and stages the gamedir)`);

  // Test plugin, ENABLED (run_dap_tests.sh removes its symlink after each run).
  fs.mkdirSync(path.dirname(pluginLink), { recursive: true });
  try { fs.unlinkSync(pluginLink); } catch {}
  fs.symlinkSync(path.join(TESTS, "debugger_test_latest.smx"), pluginLink);

  // Quiet stdout/stderr: the pumped `bp` commands make debugger_test print its
  // OUTPUT lines on every hit, which would drown the script's own report.
  const srcds = spawn(srcdsBin, ["-game_dir", gamedir, "+map", map, "-run-ticks", "100000"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  srcds.on("error", (e) => die(`srcds spawn failed: ${e.message}`, `is the mock built for this arch?`));

  console.log(`  \x1b[36m·\x1b[0m mock srcds spawned (pid ${srcds.pid}); waiting for DAP port ${port}...`);
  // The caller connects with its own retry loop; here we only wait for boot.
  for (let i = 0; i < 120; i++) {
    if (await portOpen(host, port)) break;
    await delay(500);
    if (i === 119) { try { srcds.kill("SIGKILL"); } catch {} die(`DAP port ${port} never opened`, `check the extension loaded (mock srcds boot log)`); }
  }

  const write = (line) => { try { srcds.stdin.write(line + "\n"); } catch {} };
  // Keep the BreakHere line hot. While the VM is paused at a breakpoint the
  // mock console input queues up; queued `bp`s replay on continue, which is
  // exactly what re-arms the next stop -- same net effect as a per-frame hook.
  const pump = setInterval(() => write("bp"), pumpMs);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(pump);
    write("quit");
    setTimeout(() => { try { srcds.kill("SIGKILL"); } catch {} }, 2000).unref();
    try { fs.unlinkSync(pluginLink); } catch {}
  };
  process.on("exit", stop);
  return { srcds, stop };
}
