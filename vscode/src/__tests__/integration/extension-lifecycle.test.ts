// Extension load/unload/reload lifecycle against the mock server.
//
// A server owner updating the debugger types `sm exts reload` far more often
// than they restart the process, and this extension is unusually entangled with
// the host: it owns a listening socket and an accept thread, installs a
// debug-break handler in the VM, and keeps a map of plugin contexts. Getting any
// of that wrong on unload does not produce a nice error -- it takes the game
// server down with it.
//
// Two failures this suite exists to catch, both of them observed:
//   * `sm exts unload` froze the whole server. Stop() closed the listening
//     socket and then joined the accept thread, but closing a socket does not
//     wake a thread parked in accept(), so the join never returned -- on the
//     GAME thread.
//   * after a late load the plugin map stayed empty, so nothing was debuggable
//     until the plugin itself was reloaded.
//   * restarting the server after a debug session killed it with SIGSEGV. The
//     client threads were detached, so shutting down did not wait for them and
//     the .so was unloaded out from under a thread still running in it.
//
// INTEGRATION test: needs the staged mock environment, otherwise it skips (see
// ./harness.ts).
import { afterEach, describe, expect, it } from "bun:test";
import {
  assertPortFree,
  DapClient,
  delay,
  mockEnvReady,
  PORT,
  SOURCE,
  SOURCE_NAME,
  startSrcds,
  waitForPort,
  type SrcdsHandle,
} from "./harness";

const LINE = parseInt(process.env.SP_LINE || "62", 10);

// `sm exts list` prints "[03] Console Debugger (0.1.0): ...". The index is what
// unload/reload take, and it depends on what else the server loaded, so it has
// to be read rather than assumed.
const EXT_LIST_LINE = /\[(\d+)\]\s+Console Debugger/;
// The binary name `sm exts load` expects (no .so suffix).
const EXT_FILE = "sp-debugger.ext";

// Anything in the server output that means we broke the host process.
const CRASH_MARKERS = /segmentation fault|SIGSEGV|Assertion .* failed|core dumped/i;

let server: SrcdsHandle | null = null;

// Per test, not per file: each case runs its own server, and the next one
// cannot start until this one has released the DAP port.
afterEach(() => {
  server?.stop();
  server = null;
});

/**
 * The game thread is still processing console input.
 *
 * This is the cheap, fast probe for the deadlock: when Stop() hangs waiting to
 * join the accept thread it does so ON the game thread, so the server keeps its
 * process alive and its socket open while answering nothing. Without this check
 * the symptom surfaces 30 seconds later as an opaque "timeout: initialize".
 */
const EXT_LIST_REPLY = /Displaying \d+ extensions/g;

async function expectConsoleResponsive(srv: SrcdsHandle, step: string): Promise<void> {
  // Count replies rather than matching once: every step issues the same command,
  // so only a NEW reply proves the console answered this time.
  const replies = () => (srv.output().match(EXT_LIST_REPLY) || []).length;
  const before = replies();
  srv.send("sm exts list");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (replies() > before) return;
    await delay(100);
  }
  throw new Error(
    `server console stopped responding after ${step} -- the game thread is blocked ` +
      `(TcpServer::Stop() joining the accept thread is the usual cause)`,
  );
}

/** One full DAP session: launch, breakpoint, trigger, stop. */
async function debugSessionWorks(srv: SrcdsHandle): Promise<boolean> {
  const client = new DapClient();
  try {
    await client.connect(PORT, 40, 500);
    await client.send("initialize", {
      clientID: "extension-lifecycle",
      adapterID: "sp-debugger",
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    const launch = await client.send("launch", { program: SOURCE, stopOnEntry: false });
    if (!launch.success) return false;

    const setbp = await client.send("setBreakpoints", {
      source: { path: SOURCE, name: SOURCE_NAME },
      breakpoints: [{ line: LINE }],
    });
    if (!(setbp.body?.breakpoints || [])[0]?.verified) return false;

    await client.send("configurationDone", {});
    const stoppedP = client.waitForEvent("stopped", 15000);
    await delay(300);
    srv.send("bp");
    const stopped = await stoppedP;
    if (!stopped) return false;

    // Leave the server running, or the next step of the suite inherits a frozen VM.
    const tid = stopped.body?.threadId ?? 1;
    await client
      .send("setBreakpoints", { source: { path: SOURCE, name: SOURCE_NAME }, breakpoints: [] })
      .catch(() => {});
    await client.send("continue", { threadId: tid }).catch(() => {});
    await client.send("disconnect", {}).catch(() => {});
    return true;
  } finally {
    client.close();
  }
}

describe.skipIf(!mockEnvReady)("extension lifecycle (mock srcds)", () => {
  it(
    "survives unload, load and reload without taking the server down",
    async () => {
      await assertPortFree(PORT);
      server = startSrcds({ captureOutput: true });

      // --- boot -----------------------------------------------------------
      expect(await waitForPort(PORT, true, 60000)).toBe(true);
      expect(server.alive()).toBe(true);

      // A debug session works before any lifecycle command, so a later failure
      // can only be blamed on the load/unload path.
      expect(await debugSessionWorks(server)).toBe(true);

      // --- find the extension index ----------------------------------------
      server.send("sm exts list");
      expect(await server.waitForOutput(EXT_LIST_LINE, 10000)).toBe(true);
      const index = server.output().match(EXT_LIST_LINE)![1];

      // --- unload -----------------------------------------------------------
      server.send(`sm exts unload ${index}`);
      // The listener must actually go away...
      expect(await waitForPort(PORT, false, 20000)).toBe(true);
      // ...and, crucially, the server must still be *serving*. A deadlocked game
      // thread leaves the process alive, so liveness alone proves nothing.
      expect(server.alive()).toBe(true);
      await expectConsoleResponsive(server, "unload");

      // --- load again -------------------------------------------------------
      server.send(`sm exts load ${EXT_FILE}`);
      expect(await waitForPort(PORT, true, 20000)).toBe(true);
      expect(server.alive()).toBe(true);
      await expectConsoleResponsive(server, "load");

      // Debugging has to work after a LATE load: the plugins were loaded long
      // before the extension came back, so the plugin map only has entries if
      // it was re-seeded on load.
      expect(await debugSessionWorks(server)).toBe(true);

      // --- reload -----------------------------------------------------------
      // Re-read the index: a reloaded extension can land at a different slot.
      const listed = [...server.output().matchAll(new RegExp(EXT_LIST_LINE.source, "g"))];
      const reloadIndex = listed[listed.length - 1]?.[1] ?? index;
      server.send(`sm exts reload ${reloadIndex}`);
      expect(await waitForPort(PORT, true, 20000)).toBe(true);
      expect(server.alive()).toBe(true);
      await expectConsoleResponsive(server, "reload");
      expect(await debugSessionWorks(server)).toBe(true);

      // --- nothing crashed along the way ------------------------------------
      expect(server.output()).not.toMatch(CRASH_MARKERS);
    },
    240000,
  );
});

describe.skipIf(!mockEnvReady)("server shutdown after debugging (mock srcds)", () => {
  // Restarting a game server is the most ordinary thing an operator does, and
  // it runs the extension's whole teardown: SourceMod unloads it, which stops
  // the TCP server and then unloads the .so. Anything of ours still running at
  // that moment takes the process down with it -- and a crash on restart is
  // both alarming and easy to blame on the wrong thing.
  //
  // Each case ends the server with a plain `quit` and demands a clean exit: no
  // fatal signal, no crash text. The connected/idle cases are the ones that
  // used to segfault, so they are worth keeping separate.
  const expectCleanExit = async (srv: SrcdsHandle) => {
    srv.send("quit");
    const exit = await srv.waitForExit(30000);
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
    expect(srv.output()).not.toMatch(CRASH_MARKERS);
  };

  it(
    "exits cleanly with debugger clients connected",
    async () => {
      await assertPortFree(PORT);
      const srv = startSrcds({ captureOutput: true });
      server = srv;
      expect(await waitForPort(PORT, true, 60000)).toBe(true);

      // Several connections, each with a request in flight, and no pause before
      // the shutdown. The bug this guards against is a race -- the .so being
      // unloaded while a client thread is still inside it -- so the test has to
      // make that window as wide as it can: one idle connection reproduced it
      // only about a third of the time, several busy ones nearly always.
      const clients: DapClient[] = [];
      for (let i = 0; i < 3; i++) {
        const client = new DapClient();
        await client.connect(PORT, 40, 500);
        clients.push(client);
      }
      // Fire a burst without awaiting, so every client thread is mid-request
      // when the server is told to quit. Volume matters: the wider the window,
      // the more reliably a teardown that does not wait for those threads is
      // caught (with one idle connection it slipped through two runs in three).
      for (const [i, client] of clients.entries()) {
        void client
          .send("initialize", { clientID: `shutdown-${i}`, linesStartAt1: true })
          .catch(() => {});
        for (let n = 0; n < 200; n++) void client.send("threads", {}).catch(() => {});
      }

      await expectCleanExit(srv);
      for (const client of clients) client.close();
      server = null;
    },
    120000,
  );

  it(
    "exits cleanly after a full debug session, client still attached",
    async () => {
      await assertPortFree(PORT);
      const srv = startSrcds({ captureOutput: true });
      server = srv;
      expect(await waitForPort(PORT, true, 60000)).toBe(true);
      expect(await debugSessionWorks(srv)).toBe(true);

      // debugSessionWorks disconnects at the end; attach again so the shutdown
      // races a live connection, which is what an operator restarting mid-debug
      // actually has.
      const client = new DapClient();
      await client.connect(PORT, 40, 500);
      await client.send("initialize", { clientID: "shutdown-attached", linesStartAt1: true });

      await expectCleanExit(srv);
      client.close();
      server = null;
    },
    120000,
  );
});

// Keep `bun test` output honest on machines without the mock environment.
describe.skipIf(mockEnvReady)("extension lifecycle (mock srcds)", () => {
  it.skip("skipped: mock env not staged (run sp-console-debugger/tests/setup.sh + vscode/tests/dap/run_dap_tests.sh)", () => {});
});
