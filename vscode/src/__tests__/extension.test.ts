import * as vscode from "vscode"; // resolves to the mock registered in setup.ts
import { activate, deactivate } from "../extension";

describe("Extension", () => {
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    jest.clearAllMocks();

    mockContext = {
      subscriptions: [],
      extensionPath: "/test/path",
      globalState: {
        get: jest.fn(),
        update: jest.fn(),
      },
      workspaceState: {
        get: jest.fn(),
        update: jest.fn(),
      },
    } as any;
  });

  describe("activate", () => {
    it("should activate extension successfully", () => {
      activate(mockContext);

      expect(vscode.debug.registerDebugConfigurationProvider).toHaveBeenCalledWith(
        "sp-debugger",
        expect.any(Object),
      );
      expect(vscode.debug.registerDebugAdapterDescriptorFactory).toHaveBeenCalledWith(
        "sp-debugger",
        expect.any(Object),
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "sp-debugger.debugActiveFile",
        expect.any(Function),
      );
      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
        "spDebuggerPerformance",
        expect.any(Object),
      );
      // activate() also wires the profiler tree view + its commands, so the
      // subscription list is larger than just the three registrations above.
      expect(mockContext.subscriptions.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("deactivate", () => {
    it("should deactivate extension without errors", () => {
      expect(() => deactivate()).not.toThrow();
    });
  });

  describe("debugActiveFile command", () => {
    beforeEach(() => {
      activate(mockContext);
    });

    // Find the handler the command registration captured.
    const commandFunction = (): (() => Promise<void>) => {
      const commandCall = (
        vscode.commands.registerCommand as jest.Mock
      ).mock.calls.find((call) => call[0] === "sp-debugger.debugActiveFile");
      return commandCall![1];
    };

    it("should show error when no active editor", async () => {
      (vscode.window as any).activeTextEditor = null;

      await commandFunction()();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No active file to debug",
      );
    });

    it("should show error when file is not SourcePawn", async () => {
      (vscode.window as any).activeTextEditor = {
        document: {
          fileName: "/path/to/test.js",
        },
      };

      await commandFunction()();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "Active file is not a SourcePawn file (.sp or .inc)",
      );
    });

    it("should start debugging when file is SourcePawn", async () => {
      (vscode.window as any).activeTextEditor = {
        document: {
          fileName: "/path/to/test.sp",
        },
      };

      await commandFunction()();

      expect(vscode.debug.startDebugging).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          type: "sp-debugger",
          request: "launch",
          plugin: "/path/to/test.sp",
        }),
      );
    });
  });
});
