// DAP regression test -- the DAP/TCP counterpart of the upstream console
// harness. Spawns the mock srcds with the debugger_test plugin loaded, drives
// a full DAP session over TCP exactly like the VS Code client would, and
// asserts on the protocol responses (deterministic variable values included).
//
// INTEGRATION test: it needs the mock environment built by
// sp-console-debugger/tests/setup.sh and the gamedir staged by
// vscode/tests/dap/run_dap_tests.sh (which builds the extension). When those
// are missing the whole suite SKIPS, so a plain `bun test` stays green on a
// fresh checkout. Converted from the former vscode/tests/dap/dap-regression.mjs.
//
// The DAP client, the srcds process handling and the port probes live in
// ./harness.ts, shared with extension-lifecycle.test.ts.
import { afterAll, describe, expect, it } from "bun:test";
import {
  assertPortFree,
  DapClient,
  delay,
  mockEnvReady,
  PORT,
  SOURCE,
  SOURCE_NAME,
  startSrcds,
  type SrcdsHandle,
} from "./harness";

// Line 62 of debugger_test.sp -- inside BreakHere, after every local has been
// initialised. The console suite breaks on line 96 instead, but that is the
// function's closing brace: the locals have left scope there (its golden .out
// lists only globals and arguments), so it is the wrong place to assert on
// locInteger & co.
const LINE = parseInt(process.env.SP_LINE || "62", 10);

let server: SrcdsHandle | null = null;
const client = new DapClient();

afterAll(() => {
  client.close();
  server?.stop();
  server = null;
});

describe.skipIf(!mockEnvReady)("DAP regression (mock srcds)", () => {
  it(
    "drives a full debug session against debugger_test",
    async () => {
      await assertPortFree(PORT);
      server = startSrcds();
      await client.connect(PORT); // retries for ~60s while the server boots

      const init = await client.send("initialize", {
        clientID: "dap-regression",
        adapterID: "sp-debugger",
        linesStartAt1: true,
        columnsStartAt1: true,
      });
      expect(init.success).toBe(true);

      const launch = await client.send("launch", { program: SOURCE, stopOnEntry: false });
      expect(launch.success).toBe(true);

      const setbp = await client.send("setBreakpoints", {
        source: { path: SOURCE, name: SOURCE_NAME },
        breakpoints: [{ line: LINE }],
      });
      const bp0 = (setbp.body?.breakpoints || [])[0];
      expect(bp0?.verified).toBe(true);

      await client.send("configurationDone", {});

      // Trigger the plugin's `bp` server command; BreakHere() runs and hits
      // the breakpoint, which emits a `stopped` event.
      const stoppedP = client.waitForEvent("stopped", 15000);
      await delay(300); // let configurationDone settle on the VM thread
      server.send("bp");

      const stopped = await stoppedP;
      expect(stopped).not.toBeNull();

      const tid = stopped.body?.threadId ?? 1;
      const st = await client.send("stackTrace", { threadId: tid });
      const frames = st.body?.stackFrames || [];
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]?.name).toContain("BreakHere");

      // Deterministic values from debugger_test.sp (see its golden .out file).
      // Match leniently on formatting (floats render with %f, strings quoted).
      const vars = await client.collectVariables(frames[0].id);
      expect(Object.keys(vars).length).toBeGreaterThan(0);
      expect(vars["g_Integer"]).toBe("42");
      expect(vars["g_Float"]).toMatch(/^42\.4/);
      expect(vars["g_String"]).toContain("FortyTwo");
      expect(vars["locInteger"]).toBe("7");
      expect(vars["locString"]).toContain("local variable");
      expect(vars["argInteger"]).toBe("5");
      expect(vars["argString"]).toContain("some string");

      // Resume + disconnect cleanly so srcds unfreezes.
      await client
        .send("setBreakpoints", { source: { path: SOURCE, name: SOURCE_NAME }, breakpoints: [] })
        .catch(() => {});
      await client.send("continue", { threadId: tid }).catch(() => {});
      await client.send("disconnect", {}).catch(() => {});
    },
    120000,
  );
});

// Keep `bun test` output honest on machines without the mock environment.
describe.skipIf(mockEnvReady)("DAP regression (mock srcds)", () => {
  it.skip("skipped: mock env not staged (run sp-console-debugger/tests/setup.sh + vscode/tests/dap/run_dap_tests.sh)", () => {});
});
