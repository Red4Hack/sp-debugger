import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import * as SessionManagerModule from "../adapters/DebugSessionManager";
import { ConfigValidator } from "../utils/ConfigValidator";
import { DebugProtocol } from "@vscode/debugprotocol";

// Snapshot the real module so afterAll can undo the process-wide module mock.
const realSessionManagerModule = { ...SessionManagerModule };

// Mock the DebugSessionManager class: the constructor mock hands back whatever
// instance the current test installed (set in beforeEach). It starts as a
// bare stub because importing debugAdapter.ts already constructs one session
// at module scope (the file doubles as the standalone adapter entrypoint).
let currentSessionManager: any = { on: mock(() => {}) };
const DebugSessionManagerMock = mock(function DebugSessionManager() {
  return currentSessionManager;
});
mock.module("../adapters/DebugSessionManager", () => ({
  ...realSessionManagerModule,
  DebugSessionManager: DebugSessionManagerMock,
}));

// Import AFTER the module mock is registered (bun does not hoist mocks the
// way jest.mock did; the import itself is hoisted, so use a dynamic import).
const { SourcePawnDebugSession } = await import("../debugAdapter");

afterAll(() => {
  mock.module("../adapters/DebugSessionManager", () => realSessionManagerModule);
});

describe("SourcePawnDebugSession", () => {
  let debugSession: InstanceType<typeof SourcePawnDebugSession>;
  let mockSessionManager: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock DebugSessionManager instance (every method the adapter's request
    // handlers reach for must exist here).
    mockSessionManager = {
      on: jest.fn(),
      initialize: jest.fn().mockResolvedValue({}),
      configurationDone: jest.fn(),
      launch: jest.fn().mockResolvedValue(undefined),
      attach: jest.fn().mockResolvedValue(undefined),
      requestSetBreakpoints: jest.fn().mockResolvedValue({ breakpoints: [] }),
      getThreads: jest.fn().mockReturnValue({ threads: [] }),
      requestStackTrace: jest.fn().mockResolvedValue({ stackFrames: [] }),
      requestScopes: jest.fn().mockResolvedValue({ scopes: [] }),
      requestVariables: jest.fn().mockResolvedValue({ variables: [] }),
      requestContinue: jest.fn().mockResolvedValue({ allThreadsContinued: true }),
      requestNext: jest.fn().mockResolvedValue(undefined),
      requestStepIn: jest.fn().mockResolvedValue(undefined),
      requestStepOut: jest.fn().mockResolvedValue(undefined),
      requestPause: jest.fn().mockResolvedValue(undefined),
      requestEvaluate: jest.fn().mockResolvedValue({ result: "", variablesReference: 0 }),
      requestSetVariable: jest.fn().mockResolvedValue({ value: "" }),
      getState: jest.fn().mockReturnValue({ connected: false }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn(),
    };

    currentSessionManager = mockSessionManager;

    // Mock ConfigValidator (static method -- a spy on the class intercepts).
    jest.spyOn(ConfigValidator, "validateDebugConfiguration").mockReturnValue({
      isValid: true,
      errors: [],
      warnings: [],
    });

    debugSession = new SourcePawnDebugSession();
    // The base DebugSession schedules process.exit(0) from shutdown() (wired
    // to its 'close'/'error' events) -- fatal inside a test runner. Noop it.
    (debugSession as any).shutdown = () => {};
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should initialize debug session with correct settings", () => {
      expect(debugSession).toBeDefined();
      expect(DebugSessionManagerMock).toHaveBeenCalled();
    });

    it("should setup session handlers", () => {
      expect(mockSessionManager.on).toHaveBeenCalledWith(
        "log",
        expect.any(Function),
      );
      expect(mockSessionManager.on).toHaveBeenCalledWith(
        "stopped",
        expect.any(Function),
      );
      expect(mockSessionManager.on).toHaveBeenCalledWith(
        "continued",
        expect.any(Function),
      );
      expect(mockSessionManager.on).toHaveBeenCalledWith(
        "output",
        expect.any(Function),
      );
      expect(mockSessionManager.on).toHaveBeenCalledWith(
        "terminated",
        expect.any(Function),
      );
      expect(mockSessionManager.on).toHaveBeenCalledWith(
        "exited",
        expect.any(Function),
      );
    });
  });

  describe("initializeRequest", () => {
    it("should initialize successfully", async () => {
      const response: DebugProtocol.InitializeResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "initialize",
        success: true,
        body: {},
      };
      const args: DebugProtocol.InitializeRequestArguments = {
        clientID: "vscode",
        clientName: "Visual Studio Code",
        adapterID: "sp-debugger",
      };

      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");
      const sendEventSpy = jest.spyOn(debugSession, "sendEvent");

      await debugSession["initializeRequest"](response, args);

      expect(mockSessionManager.initialize).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
      // InitializedEvent is deliberately NOT sent here anymore: it is emitted
      // after launch/attach so setBreakpoints can't race ahead of the plugin
      // bind (see the comment in debugAdapter.ts initializeRequest).
      expect(sendEventSpy).not.toHaveBeenCalled();
    });

    it("should handle initialization error", async () => {
      const response: DebugProtocol.InitializeResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "initialize",
        success: true,
        body: {},
      };
      const args: DebugProtocol.InitializeRequestArguments = {
        clientID: "vscode",
        clientName: "Visual Studio Code",
        adapterID: "sp-debugger",
      };

      mockSessionManager.initialize.mockRejectedValue(new Error("Init failed"));
      const sendErrorResponseSpy = jest.spyOn(
        debugSession as any,
        "sendErrorResponse",
      );

      await debugSession["initializeRequest"](response, args);

      expect(sendErrorResponseSpy).toHaveBeenCalledWith(
        response,
        2000,
        "Initialize failed: Error: Init failed",
      );
    });
  });

  describe("launchRequest", () => {
    it("should launch successfully with valid configuration", async () => {
      const response: DebugProtocol.LaunchResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "launch",
        success: true,
      };
      const args = {
        type: "sp-debugger",
        request: "launch",
        name: "Test",
        host: "localhost",
        port: 8080,
        plugin: "test.sp",
      };

      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["launchRequest"](response, args);

      expect(ConfigValidator.validateDebugConfiguration).toHaveBeenCalledWith(
        args,
      );
      expect(mockSessionManager.launch).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });

    it("should reject invalid configuration", async () => {
      const response: DebugProtocol.LaunchResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "launch",
        success: true,
      };
      const args = {
        type: "invalid",
        request: "launch",
        name: "Test",
        host: "localhost",
        port: 8080,
        plugin: "test.sp",
      };

      (ConfigValidator.validateDebugConfiguration as jest.Mock).mockReturnValue(
        {
          isValid: false,
          errors: ["Invalid type"],
          warnings: [],
        },
      );

      const sendErrorResponseSpy = jest.spyOn(
        debugSession as any,
        "sendErrorResponse",
      );

      await debugSession["launchRequest"](response, args);

      expect(sendErrorResponseSpy).toHaveBeenCalledWith(
        response,
        2001,
        "Invalid configuration: Invalid type",
      );
    });
  });

  describe("attachRequest", () => {
    it("should attach successfully with valid configuration", async () => {
      const response: DebugProtocol.AttachResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "attach",
        success: true,
      };
      const args = {
        type: "sp-debugger",
        request: "attach",
        name: "Test",
        host: "localhost",
        port: 8080,
      };

      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["attachRequest"](response, args);

      expect(ConfigValidator.validateDebugConfiguration).toHaveBeenCalledWith(
        args,
      );
      expect(mockSessionManager.attach).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("setBreakPointsRequest", () => {
    it("should set breakpoints successfully", async () => {
      const response: DebugProtocol.SetBreakpointsResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "setBreakpoints",
        success: true,
        body: { breakpoints: [] },
      };
      const args: DebugProtocol.SetBreakpointsArguments = {
        source: { name: "test.sp", path: "/path/test.sp" },
        breakpoints: [{ line: 10 }],
      };

      mockSessionManager.requestSetBreakpoints.mockResolvedValue({ breakpoints: [] });
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["setBreakPointsRequest"](response, args);

      expect(mockSessionManager.requestSetBreakpoints).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("threadsRequest", () => {
    it("should get threads successfully", () => {
      const response: DebugProtocol.ThreadsResponse = {
        seq: 1,
        type: "response",
        request_seq: 1,
        command: "threads",
        success: true,
        body: { threads: [] },
      };

      mockSessionManager.getThreads.mockReturnValue({ threads: [] });
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      debugSession["threadsRequest"](response);

      expect(mockSessionManager.getThreads).toHaveBeenCalled();
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("continueRequest", () => {
    it("should continue execution successfully", async () => {
      const response: DebugProtocol.ContinueResponse = {
        seq: 3,
        type: "response",
        request_seq: 3,
        command: "continue",
        success: true,
        body: { allThreadsContinued: true },
      };
      const args: DebugProtocol.ContinueArguments = { threadId: 1 };

      mockSessionManager.requestContinue.mockResolvedValue({ allThreadsContinued: true });
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["continueRequest"](response, args);

      expect(mockSessionManager.requestContinue).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
      expect(response.body?.allThreadsContinued).toBe(true);
    });
  });

  describe("nextRequest", () => {
    it("should step over successfully", async () => {
      const response: DebugProtocol.NextResponse = {
        seq: 4,
        type: "response",
        request_seq: 4,
        command: "next",
        success: true,
      };
      const args: DebugProtocol.NextArguments = { threadId: 1 };

      mockSessionManager.requestNext.mockResolvedValue(undefined);
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["nextRequest"](response, args);

      expect(mockSessionManager.requestNext).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("stepInRequest", () => {
    it("should step in successfully", async () => {
      const response: DebugProtocol.StepInResponse = {
        seq: 5,
        type: "response",
        request_seq: 5,
        command: "stepIn",
        success: true,
      };
      const args: DebugProtocol.StepInArguments = { threadId: 1 };

      mockSessionManager.requestStepIn.mockResolvedValue(undefined);
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["stepInRequest"](response, args);

      expect(mockSessionManager.requestStepIn).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("stepOutRequest", () => {
    it("should step out successfully", async () => {
      const response: DebugProtocol.StepOutResponse = {
        seq: 6,
        type: "response",
        request_seq: 6,
        command: "stepOut",
        success: true,
      };
      const args: DebugProtocol.StepOutArguments = { threadId: 1 };

      mockSessionManager.requestStepOut.mockResolvedValue(undefined);
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["stepOutRequest"](response, args);

      expect(mockSessionManager.requestStepOut).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("pauseRequest", () => {
    it("should pause successfully", async () => {
      const response: DebugProtocol.PauseResponse = {
        seq: 7,
        type: "response",
        request_seq: 7,
        command: "pause",
        success: true,
      };
      const args: DebugProtocol.PauseArguments = { threadId: 1 };

      mockSessionManager.requestPause.mockResolvedValue(undefined);
      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["pauseRequest"](response, args);

      expect(mockSessionManager.requestPause).toHaveBeenCalledWith(args);
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });

  describe("disconnectRequest", () => {
    it("should disconnect successfully", async () => {
      const response: DebugProtocol.DisconnectResponse = {
        seq: 8,
        type: "response",
        request_seq: 8,
        command: "disconnect",
        success: true,
      };
      const args: DebugProtocol.DisconnectArguments = {};

      const sendResponseSpy = jest.spyOn(debugSession, "sendResponse");

      await debugSession["disconnectRequest"](response, args);

      // sessionManager.disconnect() takes no arguments (the DAP args only
      // matter to the adapter); the response is sent after it resolves.
      expect(mockSessionManager.disconnect).toHaveBeenCalled();
      expect(sendResponseSpy).toHaveBeenCalledWith(response);
    });
  });
});
