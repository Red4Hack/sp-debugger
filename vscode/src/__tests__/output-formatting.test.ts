// Debug Console output discipline.
//
// Three defects motivated these tests, all of them visible to the user and all
// of them invisible to the rest of the suite:
//
//   1. `Error in variables: ...\\n` -- an escaped newline in a template literal,
//      which printed a literal "\n" at the end of the line.
//   2. Two lines for one benign condition: a raw "Error in ..." on stderr AND
//      the friendly explanation, every time VS Code polled variables while the
//      debuggee was running.
//   3. Decorative emoji in the output of a tool whose output is read in a
//      terminal-like console.
import { afterAll, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import * as SessionManagerModule from "../adapters/DebugSessionManager";
import { DebugProtocol } from "@vscode/debugprotocol";

const realSessionManagerModule = { ...SessionManagerModule };
let currentSessionManager: any = { on: mock(() => {}) };
const DebugSessionManagerMock = mock(function DebugSessionManager() {
  return currentSessionManager;
});
mock.module("../adapters/DebugSessionManager", () => ({
  ...realSessionManagerModule,
  DebugSessionManager: DebugSessionManagerMock,
}));

const { SourcePawnDebugSession } = await import("../debugAdapter");

afterAll(() => {
  mock.module("../adapters/DebugSessionManager", () => realSessionManagerModule);
});

// Anything a human would read as decoration rather than information: emoji,
// dingbats, arrows and the geometric shapes used for playback glyphs.
const DECORATIVE =
  /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2460}-\u{27BF}\u{2900}-\u{297F}\u{23F0}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

interface CapturedOutput {
  category: string;
  output: string;
}

function outputEvents(spy: any): CapturedOutput[] {
  return spy.mock.calls
    .map((call: any[]) => call[0])
    .filter((event: any) => event?.event === "output")
    .map((event: any) => ({
      category: event.body?.category ?? "",
      output: event.body?.output ?? "",
    }));
}

describe("Debug Console output", () => {
  let debugSession: InstanceType<typeof SourcePawnDebugSession>;
  let mockSessionManager: any;
  let sendEventSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionManager = {
      on: jest.fn(),
      requestVariables: jest.fn(),
      requestScopes: jest.fn(),
      requestStackTrace: jest.fn(),
      // The adapter snapshots session state into every error context.
      getState: jest.fn().mockReturnValue({ connected: true }),
    };
    currentSessionManager = mockSessionManager;
    debugSession = new SourcePawnDebugSession();
    sendEventSpy = jest.spyOn(debugSession, "sendEvent");
    jest.spyOn(debugSession, "sendResponse").mockImplementation(() => {});
    jest.spyOn(debugSession, "sendErrorResponse").mockImplementation(() => {});
  });

  const runningError = () => new Error("Cannot get variables - debugger state: running");

  const variablesResponse = (): DebugProtocol.VariablesResponse => ({
    seq: 1,
    type: "response",
    request_seq: 1,
    command: "variables",
    success: true,
    body: { variables: [] },
  });

  describe("polling while the debuggee runs", () => {
    beforeEach(() => {
      mockSessionManager.requestVariables.mockRejectedValue(runningError());
    });

    it("explains the state in exactly one line", async () => {
      await debugSession["variablesRequest"](variablesResponse(), {
        variablesReference: 1,
      });

      const events = outputEvents(sendEventSpy);
      expect(events.length).toBe(1);
      expect(events[0].output).toContain("Pause execution to inspect variables");
    });

    it("does not report it as an error", async () => {
      await debugSession["variablesRequest"](variablesResponse(), {
        variablesReference: 1,
      });

      const events = outputEvents(sendEventSpy);
      expect(events.some((e) => e.category === "stderr")).toBe(false);
      expect(events.some((e) => e.output.startsWith("Error in"))).toBe(false);
    });

    it("ends the line with a real newline, never a literal backslash-n", async () => {
      await debugSession["variablesRequest"](variablesResponse(), {
        variablesReference: 1,
      });

      const [{ output }] = outputEvents(sendEventSpy);
      expect(output.endsWith("\n")).toBe(true);
      expect(output).not.toContain("\\n");
    });

    it("still answers with an empty result so the panel does not hang", async () => {
      const response = variablesResponse();
      const sendResponse = jest.spyOn(debugSession, "sendResponse");

      await debugSession["variablesRequest"](response, { variablesReference: 1 });

      expect(sendResponse).toHaveBeenCalled();
      expect(response.body.variables).toEqual([]);
    });
  });

  describe("a genuine failure", () => {
    it("is still reported on stderr, terminated with a real newline", async () => {
      mockSessionManager.requestVariables.mockRejectedValue(
        new Error("connection reset by peer"),
      );

      await debugSession["variablesRequest"](variablesResponse(), {
        variablesReference: 1,
      });

      const events = outputEvents(sendEventSpy);
      const stderr = events.filter((e) => e.category === "stderr");
      expect(stderr.length).toBe(1);
      expect(stderr[0].output).toContain("Error in variables");
      expect(stderr[0].output.endsWith("\n")).toBe(true);
      expect(stderr[0].output).not.toContain("\\n");
    });
  });

  describe("no decorative characters", () => {
    it("keeps the running-state explanation plain", async () => {
      mockSessionManager.requestVariables.mockRejectedValue(runningError());

      await debugSession["variablesRequest"](variablesResponse(), {
        variablesReference: 1,
      });

      for (const { output } of outputEvents(sendEventSpy)) {
        expect(output).not.toMatch(DECORATIVE);
      }
    });

    it("keeps failure output plain", async () => {
      mockSessionManager.requestVariables.mockRejectedValue(new Error("boom"));

      await debugSession["variablesRequest"](variablesResponse(), {
        variablesReference: 1,
      });

      for (const { output } of outputEvents(sendEventSpy)) {
        expect(output).not.toMatch(DECORATIVE);
      }
    });

    it("keeps the session manager's connect/launch messages plain", () => {
      // These strings are emitted by DebugSessionManager as "output" events.
      // Reading them out of the source keeps the check honest even though the
      // methods around them need a live socket to run.
      const source = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", "adapters", "DebugSessionManager.ts"),
        "utf8",
      );
      const emitted = [...source.matchAll(/output:\s*`([^`]*)`/g)].map((m: any) => m[1]);
      expect(emitted.length).toBeGreaterThan(0);
      for (const line of emitted) {
        expect(line).not.toMatch(DECORATIVE);
      }
    });
  });
});
