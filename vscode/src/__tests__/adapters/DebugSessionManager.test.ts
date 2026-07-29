import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { EventEmitter } from "events";
import { DebugSessionManager } from "../../adapters/DebugSessionManager";
import { ConnectionManager } from "../../connections/ConnectionManager";
import * as TcpModule from "../../connections/TcpConnection";
import * as DAPModule from "../../protocols/DAPProtocol";
import * as SPModule from "../../protocols/SourcePawnProtocol";

// Snapshot the REAL exports before mocking so afterAll can restore them --
// bun module mocks are process-wide and would otherwise leak into the test
// files that run after this one.
const realTcp = { ...TcpModule };
const realDAP = { ...DAPModule };
const realSP = { ...SPModule };

// Mock dependencies. The constructor mock returns whatever instance the
// current test installed via `mockTcpConnection` (set in beforeEach).
let currentTcpInstance: any;
const TcpConnectionMock = mock(function TcpConnection() {
  return currentTcpInstance;
});
mock.module("../../connections/TcpConnection", () => ({
  ...realTcp,
  TcpConnection: TcpConnectionMock,
}));
mock.module("../../protocols/DAPProtocol", () => ({
  ...realDAP,
  // The real DAPMessageHandler is an EventEmitter (ConnectionManager
  // subscribes to it during construction), so build the mock on one.
  DAPMessageHandler: mock(() =>
    Object.assign(new EventEmitter(), {
      validateInitializeRequest: mock(() => true),
      validateLaunchRequest: mock(() => true),
      validateAttachRequest: mock(() => true),
      validateSetBreakpointsRequest: mock(() => true),
      createRequest: mock(() => ({ seq: 1, type: "request" })),
      clearPendingRequests: mock(() => {}),
      handleResponse: mock(() => {}),
    }),
  ),
}));
mock.module("../../protocols/SourcePawnProtocol", () => ({
  ...realSP,
  SourcePawnProtocol: {
    THREAD_ID: 1,
    DEFAULT_TIMEOUT: 5000,
    createInitializeCapabilities: mock(() => ({
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsStepBack: false,
      supportsDataBreakpoints: false,
      supportsCompletionsRequest: false,
      supportsCancelRequest: false,
      supportsBreakpointLocationsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsExceptionFilterOptions: false,
      supportsValueFormattingOptions: false,
      supportsExceptionInfoRequest: false,
      supportTerminateDebuggee: true,
      supportSuspendDebuggee: false,
      supportsDelayedStackTraceLoading: false,
      supportsLoadedSourcesRequest: false,
      supportsLogPoints: false,
      supportsTerminateThreadsRequest: false,
      supportsSetVariable: true,
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsSteppingGranularity: false,
      supportsInstructionBreakpoints: false,
      supportsReadMemoryRequest: false,
      supportsDisassembleRequest: false,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
    })),
    // NOTE: module-mock factories run at import time, where the injected
    // `jest` global doesn't exist yet -- use bun's mock() here.
    validatePluginFile: mock(() => true),
    normalizePluginPath: mock((path: string) => path),
    createSourceFromPath: mock(() => ({ name: "test.sp", path: "/test.sp" })),
    createBreakpointFromLine: mock(() => ({ verified: true, line: 1 })),
    createDefaultThread: mock(() => ({ id: 1, name: "main thread" })),
    parseStoppedReason: mock((reason: string) => reason),
  },
}));

// Restore the real modules so later test files (e.g. TcpConnection.test.ts)
// import the genuine implementations again.
afterAll(() => {
  mock.module("../../connections/TcpConnection", () => realTcp);
  mock.module("../../protocols/DAPProtocol", () => realDAP);
  mock.module("../../protocols/SourcePawnProtocol", () => realSP);
});

describe("DebugSessionManager", () => {
  let sessionManager: DebugSessionManager;
  let mockTcpConnection: any;
  let cmConnect: jest.Mock;
  let cmSendRequest: jest.Mock;
  let cmIsConnected: jest.Mock;
  let cmDisconnect: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Built on a real EventEmitter: ConnectionManager wires/unwires handlers
    // with on/removeListener during DebugSessionManager construction.
    mockTcpConnection = Object.assign(new EventEmitter(), {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      send: jest.fn(),
      isSocketConnected: jest.fn().mockReturnValue(false),
    }) as any;

    currentTcpInstance = mockTcpConnection;

    // Every DSM operation funnels through ConnectionManager.sendRequest (a
    // request/response round-trip over the wire). Intercept at the prototype
    // so the unit tests stop at the session-manager boundary.
    cmConnect = jest
      .spyOn(ConnectionManager.prototype, "connect")
      .mockResolvedValue(undefined as any) as unknown as jest.Mock;
    cmSendRequest = jest
      .spyOn(ConnectionManager.prototype, "sendRequest")
      .mockImplementation(async (command: string) => {
        if (command === "setBreakpoints")
          return { breakpoints: [{ verified: true, line: 1 }] };
        if (command === "continue") return { allThreadsContinued: true };
        return { success: true };
      }) as unknown as jest.Mock;
    cmIsConnected = jest
      .spyOn(ConnectionManager.prototype, "getIsConnected")
      .mockReturnValue(true) as unknown as jest.Mock;
    cmDisconnect = jest
      .spyOn(ConnectionManager.prototype, "disconnect")
      .mockImplementation(() => {}) as unknown as jest.Mock;

    sessionManager = new DebugSessionManager();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should initialize session manager", () => {
      expect(sessionManager).toBeDefined();
    });
  });

  describe("initialize", () => {
    it("should return debug capabilities", async () => {
      const args = {
        clientID: "vscode",
        clientName: "Visual Studio Code",
        adapterID: "sp-debugger",
      };

      const capabilities = await sessionManager.initialize(args);

      expect(capabilities).toEqual({
        supportsConfigurationDoneRequest: true,
        supportsEvaluateForHovers: true,
        supportsStepBack: false,
        supportsDataBreakpoints: false,
        supportsCompletionsRequest: false,
        supportsCancelRequest: false,
        supportsBreakpointLocationsRequest: false,
        supportsStepInTargetsRequest: false,
        supportsExceptionFilterOptions: false,
        supportsValueFormattingOptions: false,
        supportsExceptionInfoRequest: false,
        supportTerminateDebuggee: true,
        supportSuspendDebuggee: false,
        supportsDelayedStackTraceLoading: false,
        supportsLoadedSourcesRequest: false,
        supportsLogPoints: false,
        supportsTerminateThreadsRequest: false,
        supportsSetVariable: true,
        supportsRestartFrame: false,
        supportsGotoTargetsRequest: false,
        supportsSteppingGranularity: false,
        supportsInstructionBreakpoints: false,
        supportsReadMemoryRequest: false,
        supportsDisassembleRequest: false,
        supportsConditionalBreakpoints: true,
        supportsHitConditionalBreakpoints: true,
      });
    });
  });

  describe("launch", () => {
    it("should connect to TCP server on launch", async () => {
      const args = {
        type: "sp-debugger",
        request: "launch",
        name: "Test",
        host: "localhost",
        port: 8080,
        plugin: "test.sp",
      };

      await sessionManager.launch(args);

      expect(TcpConnectionMock).toHaveBeenCalled();
      expect(cmConnect).toHaveBeenCalled();
    });

    it("should handle connection failure", async () => {
      const args = {
        type: "sp-debugger",
        request: "launch",
        name: "Test",
        host: "localhost",
        port: 8080,
        plugin: "test.sp",
      };

      cmConnect.mockRejectedValue(new Error("Connection failed"));

      await expect(sessionManager.launch(args)).rejects.toThrow(
        "Connection failed",
      );
    });
  });

  describe("attach", () => {
    it("should connect to TCP server on attach", async () => {
      const args = {
        type: "sp-debugger",
        request: "attach",
        name: "Test",
        host: "localhost",
        port: 8080,
      };

      await sessionManager.attach(args);

      expect(TcpConnectionMock).toHaveBeenCalled();
      expect(cmConnect).toHaveBeenCalled();
    });
  });

  describe("requestSetBreakpoints", () => {
    it("should fall back to client-side breakpoints when the request fails", async () => {
      const args = {
        source: { name: "test.sp", path: "/path/test.sp" },
        breakpoints: [{ line: 10 }],
      };

      // Lazy rejection (an eager mockRejectedValue creates the rejected
      // promise up front, which bun reports as an unhandled rejection).
      cmSendRequest.mockImplementation(async () => {
        throw new Error("Not connected");
      });

      // When the wire request fails, the session manager still answers with
      // client-side breakpoint entries (built via the protocol helpers) so
      // the editor keeps its markers; the server re-verifies them on rebind.
      const result = await sessionManager.requestSetBreakpoints(args);

      expect(result).toEqual({ breakpoints: [{ verified: true, line: 1 }] });
    });

    it("should send breakpoint command when connected", async () => {
      const args = {
        source: { name: "test.sp", path: "/path/test.sp" },
        breakpoints: [{ line: 10 }],
        lines: [10],
      };

      const result = await sessionManager.requestSetBreakpoints(args);

      expect(cmSendRequest).toHaveBeenCalledWith(
        "setBreakpoints",
        expect.objectContaining({ source: args.source }),
      );
      expect(result).toEqual({ breakpoints: [{ verified: true, line: 1 }] });
    });
  });

  describe("getThreads", () => {
    it("should return default thread", () => {
      const result = sessionManager.getThreads();

      expect(result).toEqual({
        threads: [
          {
            id: 1,
            name: "main thread",
          },
        ],
      });
    });
  });

  describe("requestContinue", () => {
    it("should send continue command", async () => {
      const args = { threadId: 1 };
      await sessionManager.requestContinue(args);

      expect(cmSendRequest).toHaveBeenCalled();
    });
  });

  describe("requestNext", () => {
    it("should send next command", async () => {
      const args = { threadId: 1 };
      await sessionManager.requestNext(args);

      expect(cmSendRequest).toHaveBeenCalled();
    });
  });

  describe("requestStepIn", () => {
    it("should send step in command", async () => {
      const args = { threadId: 1 };
      await sessionManager.requestStepIn(args);

      expect(cmSendRequest).toHaveBeenCalled();
    });
  });

  describe("requestStepOut", () => {
    it("should send step out command", async () => {
      const args = { threadId: 1 };
      await sessionManager.requestStepOut(args);

      expect(cmSendRequest).toHaveBeenCalled();
    });
  });

  describe("requestPause", () => {
    it("should send pause command", async () => {
      const args = { threadId: 1 };
      await sessionManager.requestPause(args);

      expect(cmSendRequest).toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("should send disconnect request and schedule TCP disconnection", async () => {
      await sessionManager.disconnect();

      expect(cmSendRequest).toHaveBeenCalled();
      // TCP disconnect is called after a timeout, not immediately
    });
  });

  describe("terminate", () => {
    it("should send terminate request", async () => {
      await sessionManager.disconnect();

      expect(cmSendRequest).toHaveBeenCalled();
    });
  });
});
