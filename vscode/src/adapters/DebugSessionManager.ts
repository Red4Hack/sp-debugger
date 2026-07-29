import { EventEmitter } from "events";
import { DebugProtocol } from "@vscode/debugprotocol";
import { ConnectionManager } from "../connections/ConnectionManager";
import { DAPEvent } from "../protocols/DAPProtocol";
import {
  SourcePawnProtocol,
  SourcePawnLaunchArgs,
  SourcePawnAttachArgs,
  TimeoutConfig,
  DEFAULT_TIMEOUTS,
  ReconnectConfig,
} from "../protocols/SourcePawnProtocol";
import { Logger } from "../utils/Logger";
import { PathMapper } from "../utils/PathMapper";

export interface SessionState {
  isInitialized: boolean;
  isConfigurationDone: boolean;
  isConnected: boolean;
  currentPlugin?: string;
  threadId: number;
  debuggerState: "unknown" | "running" | "stopped";
  lastStoppedReason?: string;
  lastStoppedThreadId?: number;
}

/**
 * DebugSessionManager orchestrates the debug session lifecycle and handles DAP requests.
 *
 * Key Changes from Previous Version:
 * - Uses ConnectionManager instead of direct TcpConnection
 * - All methods are properly async/await
 * - Sends native DAP commands instead of evaluate-based REPL
 * - Event-driven state management
 * - No fire-and-forget operations
 * - Proper error propagation
 */
export class DebugSessionManager extends EventEmitter {
  private connectionManager: ConnectionManager;
  private state: SessionState;
  private logger = Logger.getInstance();
  private pathMapper = new PathMapper();

  constructor() {
    super();
    this.connectionManager = new ConnectionManager();
    this.state = {
      isInitialized: false,
      isConfigurationDone: false,
      isConnected: false,
      threadId: SourcePawnProtocol.THREAD_ID,
      debuggerState: "unknown",
      lastStoppedReason: undefined,
      lastStoppedThreadId: undefined,
    };

    this.setupConnectionHandlers();
  }

  /**
   * Set up connection event handlers
   */
  private setupConnectionHandlers(): void {
    this.connectionManager.on("connected", (info) => {
      this.state.isConnected = true;
      this.state.debuggerState = "running";
      this.logger.info(
        "DebugSession",
        `Connected to ${info.host}:${info.port}`
      );
      this.emit("log", `Connected to ${info.host}:${info.port}`);
    });

    this.connectionManager.on("disconnected", () => {
      this.state.isConnected = false;
      this.state.debuggerState = "unknown";
      this.logger.info("DebugSession", "Disconnected from server");
      this.emit("terminated");
    });

    this.connectionManager.on("event", (event: DAPEvent) => {
      this.handleServerEvent(event);
    });

    // Surface low-level transport anomalies (parse errors, buffer re-syncs,
    // orphan responses) in the Debug Console so framing/correlation issues are
    // visible without digging through the adapter log file.
    this.connectionManager.on("diagnostic", (message: string) => {
      this.logger.warn("DebugSession", `transport diagnostic: ${message}`);
      this.emit("output", {
        category: "console",
        output: `[sp-dbg] transport: ${message}\n`,
      });
    });

    this.connectionManager.on("error", (error) => {
      this.logger.error("DebugSession", `Connection error: ${error.message}`);
      this.emit("output", {
        category: "stderr",
        output: `Connection error: ${error.message}\n`,
      });
    });

    // Handle connection lost detection (keepalive failure)
    this.connectionManager.on("connectionLost", (reason: string) => {
      this.logger.warn("DebugSession", `Connection lost detected: ${reason}`);
      this.emit("output", {
        category: "console",
        output: `Connection lost (${reason}). Attempting to reconnect...\n`,
      });
    });

    // Handle successful reconnection
    this.connectionManager.on("reconnected", () => {
      this.logger.info("DebugSession", "Reconnected to debug server");
      this.emit("output", {
        category: "console",
        output: "Successfully reconnected to debug server\n",
      });
    });

    // Handle reconnection failure
    this.connectionManager.on("reconnectFailed", () => {
      this.logger.error("DebugSession", "Failed to reconnect to debug server");
      this.state.isConnected = false;
      this.state.debuggerState = "unknown";
      this.emit("output", {
        category: "stderr",
        output: "Failed to reconnect to debug server. Debug session terminated.\n",
      });
      this.emit("terminated");
    });
  }

  /**
   * Handle DAP events from the server (stopped, continued, output, etc.)
   */
  private handleServerEvent(event: DAPEvent): void {
    this.logger.debug("DebugSession", `Received event: ${event.event}`, event.body);

    switch (event.event) {
      case "stopped":
        this.handleStoppedEvent(event.body);
        break;
      case "continued":
        this.handleContinuedEvent(event.body);
        break;
      case "output":
        this.emit("output", event.body);
        break;
      case "terminated":
        this.emit("terminated");
        break;
      default:
        this.logger.debug("DebugSession", `Unhandled event: ${event.event}`);
    }

    // Forward event to debugAdapter
    this.emit("event", event);
  }

  /**
   * Handle "stopped" event from debugger (breakpoint hit, step complete, etc.)
   */
  private handleStoppedEvent(body: any): void {
    const previousState = this.state.debuggerState;
    this.state.debuggerState = "stopped";
    this.state.lastStoppedReason = body.reason;
    this.state.lastStoppedThreadId = body.threadId;

    // Pause keepalive while stopped to prevent false disconnection detection
    // (the debugger may be waiting for user input indefinitely)
    // Only pause if we were previously running (avoid duplicate pause calls)
    if (previousState === "running") {
      const paused = this.connectionManager.pauseKeepalive();
      if (paused) {
        this.logger.debug("DebugSession", "Keepalive paused while debugger stopped");
      }
    }

    this.logger.info(
      "DebugSession",
      `Debugger stopped: ${body.reason} (thread: ${body.threadId})`
    );

    this.emit("stopped", body);
  }

  /**
   * Handle "continued" event from debugger
   */
  private handleContinuedEvent(body: any): void {
    const previousState = this.state.debuggerState;
    this.state.debuggerState = "running";
    this.state.lastStoppedReason = undefined;
    this.state.lastStoppedThreadId = undefined;

    // Resume keepalive now that debugger is running again
    // Only resume if we were previously stopped (avoid duplicate resume calls)
    if (previousState === "stopped") {
      const resumed = this.connectionManager.resumeKeepalive();
      if (resumed) {
        this.logger.debug("DebugSession", "Keepalive resumed after debugger continued");
      }
    }

    this.logger.info("DebugSession", "Debugger continued");
    this.emit("continued", body);
  }

  /**
   * Initialize debug session capabilities
   */
  async initialize(
    args: DebugProtocol.InitializeRequestArguments
  ): Promise<DebugProtocol.InitializeResponse["body"]> {
    this.logger.info("DebugSession", "Initializing debug session");

    this.state.isInitialized = true;
    return SourcePawnProtocol.createInitializeCapabilities();
  }

  /**
   * Launch debug session - connect to server and start debugging
   */
  async launch(args: SourcePawnLaunchArgs): Promise<void> {
    if (!SourcePawnProtocol.validatePluginFile(args.plugin)) {
      throw new Error("Invalid plugin file. Must be a .sp or .inc file");
    }

    this.logger.info(
      "DebugSession",
      `Launching debug session for plugin: ${args.plugin}`
    );
    this.emit("output", {
      category: "stdout",
      output: `Launching debug session for plugin: ${args.plugin}\n`,
    });

    // Connect to debug server
    try {
      // Extract connection timeout from args.timeout (can be number or TimeoutConfig)
      let connectionTimeout: number;
      let timeoutConfig: Partial<TimeoutConfig> | undefined;

      if (typeof args.timeout === "number") {
        connectionTimeout = args.timeout;
      } else if (args.timeout) {
        connectionTimeout = args.timeout.connection ?? DEFAULT_TIMEOUTS.connection;
        timeoutConfig = args.timeout;
      } else {
        connectionTimeout = SourcePawnProtocol.DEFAULT_TIMEOUT;
      }

      await this.connectionManager.connect(
        { host: args.host, port: args.port, timeout: connectionTimeout },
        timeoutConfig,
        args.reconnect
      );

      this.logger.info("DebugSession", "Connected to SourceMod server");
      this.emit("output", {
        category: "stdout",
        output: `Connected to ${args.host}:${args.port}\n`,
      });
    } catch (error) {
      this.logger.error("DebugSession", "Failed to connect", error as Error);
      this.emit("output", {
        category: "stderr",
        output: `Connection failed: ${error}\n\nTroubleshooting:\n1. Ensure SourceMod console debugger is running\n2. Check port ${args.port} is accessible\n3. Verify server address: ${args.host}\n`,
      });
      throw error;
    }

    this.state.currentPlugin = SourcePawnProtocol.normalizePluginPath(args.plugin);

    // Calculate workspace root. Prefer anchoring on the "/addons/" segment so
    // this is correct regardless of how deeply the project is nested; fall back
    // to "3 levels up" (addons/sourcemod/scripting/x.sp) for non-standard layouts.
    // Example: /home/user/dev/myserver/addons/sourcemod/scripting/myplugin.sp
    //       → /home/user/dev/myserver
    const nodePath = require("path");
    const normalizedPlugin = this.state.currentPlugin.replace(/\\/g, "/");
    const addonsIdx = normalizedPlugin.indexOf("/addons/");
    const workspaceRoot =
      addonsIdx > 0
        ? this.state.currentPlugin.substring(0, addonsIdx)
        : nodePath.dirname(nodePath.dirname(nodePath.dirname(this.state.currentPlugin)));

    // Initialize path mapper with the plugin path and workspace root
    this.pathMapper.initialize(this.state.currentPlugin, workspaceRoot);
    this.logger.info(
      "DebugSession",
      `Path mapper initialized with plugin: ${this.state.currentPlugin}, workspace: ${workspaceRoot}`
    );

    // Send launch request to server
    const pluginName = require("path").basename(
      args.plugin,
      require("path").extname(args.plugin)
    );

    try {
      // Default to NOT stopping on entry: pausing at a function's declaration
      // line shows no locals (they aren't in scope yet), forcing the user to
      // step. Breakpoint-driven debugging stops inside the body where locals
      // are visible. Honour an explicit stopOnEntry/autoStart === true.
      const stopOnEntry = args.stopOnEntry === true || args.autoStart === true;
      await this.connectionManager.sendRequest("launch", {
        program: pluginName,
        stopOnEntry,
        // Present the shared secret when one is configured. The server only
        // demands it when its listener is exposed beyond loopback, and ignores
        // the field otherwise, so sending it unconditionally is safe.
        ...(args.token ? { token: args.token } : {}),
      });

      this.logger.info("DebugSession", "Launch request sent successfully");
      this.emit("output", {
        category: "stdout",
        output: `Debugging ${pluginName}\n`,
      });
    } catch (error) {
      this.logger.error("DebugSession", "Launch request failed", error as Error);
      throw error;
    }
  }

  /**
   * Attach to running debug session
   */
  async attach(args: SourcePawnAttachArgs): Promise<void> {
    await this.connectionManager.connect(
      {
        host: args.host,
        port: args.port,
        timeout: args.timeout || SourcePawnProtocol.DEFAULT_TIMEOUT,
      },
      undefined, // No custom timeout config for attach
      undefined  // No custom reconnect config for attach
    );

    await this.connectionManager.sendRequest("attach", args.token ? { token: args.token } : {});
  }

  /**
   * Forward a custom (non-standard-DAP) request straight to the server and
   * return its response body. Used by the function profiler
   * (sp_profileStart / sp_profileStop), which doesn't depend on the
   * paused/running state. A generous timeout covers a large call-tree dump.
   */
  async sendCustomRequest(command: string, args?: any): Promise<any> {
    return this.connectionManager.sendRequest(command, args ?? {}, 60000);
  }

  /**
   * Signal that configuration is done
   */
  async configurationDone(): Promise<void> {
    this.state.isConfigurationDone = true;

    try {
      await this.connectionManager.sendRequest("configurationDone", {});
      this.logger.info("DebugSession", "Configuration done");
    } catch (error) {
      this.logger.error("DebugSession", "configurationDone failed", error as Error);
      // Don't throw - not critical
    }
  }

  /**
   * Set breakpoints for a source file
   * Returns verified breakpoints from server
   */
  async requestSetBreakpoints(
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<DebugProtocol.SetBreakpointsResponse["body"]> {
    this.logger.debug(
      "DebugSession",
      `Setting breakpoints for ${args.source.path}`,
      args.breakpoints
    );

    try {
      // Send native DAP setBreakpoints command
      const response = await this.connectionManager.sendRequest("setBreakpoints", {
        source: args.source,
        lines: args.lines,
        breakpoints: args.breakpoints,
        sourceModified: args.sourceModified,
      });

      this.logger.info(
        "DebugSession",
        `Breakpoints set: ${response.breakpoints?.length || 0} verified`
      );

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Failed to set breakpoints", error as Error);

      // Return unverified breakpoints on error
      const breakpoints = (args.breakpoints || []).map((bp) =>
        SourcePawnProtocol.createBreakpointFromLine(
          bp.line,
          SourcePawnProtocol.createSourceFromPath(args.source.path!),
          bp.condition,
          bp.hitCondition,
          false // not verified
        )
      );

      return { breakpoints };
    }
  }

  /**
   * Get thread list (SourcePawn is single-threaded)
   */
  getThreads(): DebugProtocol.ThreadsResponse["body"] {
    return {
      threads: [SourcePawnProtocol.createDefaultThread()],
    };
  }

  /**
   * Request stack trace when debugger is stopped
   */
  async requestStackTrace(
    args: DebugProtocol.StackTraceArguments
  ): Promise<DebugProtocol.StackTraceResponse["body"]> {
    if (!this.isDebuggerStopped()) {
      const reason = this.getDebuggerStateDescription();
      this.logger.debug(
        "DebugSession",
        `Cannot get stack trace - ${reason}`
      );
      throw new Error(`Cannot get stack trace - debugger state: ${this.state.debuggerState}`);
    }

    try {
      // Send native DAP stackTrace command
      const response = await this.connectionManager.sendRequest("stackTrace", {
        threadId: args.threadId,
        startFrame: args.startFrame,
        levels: args.levels,
      });

      this.logger.debug(
        "DebugSession",
        `Stack trace received: ${response.stackFrames?.length || 0} frames`
      );

      // Map debugger paths to local paths
      if (response.stackFrames && Array.isArray(response.stackFrames)) {
        response.stackFrames = this.mapStackFramePaths(response.stackFrames);
      }

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Stack trace request failed", error as Error);
      // Surface genuine request failures (timeout, transport) in the Debug
      // Console instead of silently returning an empty stack. State errors are
      // thrown earlier (before the try) and handled gracefully by the adapter.
      this.emit("output", {
        category: "stderr",
        output: `Stack trace request failed: ${(error as Error).message}\n`,
      });
      return { stackFrames: [], totalFrames: 0 };
    }
  }

  /**
   * Request scopes for a stack frame
   */
  async requestScopes(
    args: DebugProtocol.ScopesArguments
  ): Promise<DebugProtocol.ScopesResponse["body"]> {
    if (!this.isDebuggerStopped()) {
      const reason = this.getDebuggerStateDescription();
      this.logger.debug(
        "DebugSession",
        `Cannot get scopes - ${reason}`
      );
      throw new Error(`Cannot get scopes - debugger state: ${this.state.debuggerState}`);
    }

    try {
      // Send native DAP scopes command
      const response = await this.connectionManager.sendRequest("scopes", {
        frameId: args.frameId,
      });

      this.logger.debug(
        "DebugSession",
        `Scopes received: ${response.scopes?.length || 0}`
      );

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Scopes request failed", error as Error);
      this.emit("output", {
        category: "stderr",
        output: `Scopes request failed: ${(error as Error).message}\n`,
      });
      return { scopes: [] };
    }
  }

  /**
   * Request variables for a scope
   */
  async requestVariables(
    args: DebugProtocol.VariablesArguments
  ): Promise<DebugProtocol.VariablesResponse["body"]> {
    if (!this.isDebuggerStopped()) {
      const reason = this.getDebuggerStateDescription();
      this.logger.debug(
        "DebugSession",
        `Cannot get variables - ${reason}`
      );
      throw new Error(`Cannot get variables - debugger state: ${this.state.debuggerState}`);
    }

    try {
      // Send native DAP variables command
      const response = await this.connectionManager.sendRequest("variables", {
        variablesReference: args.variablesReference,
        filter: args.filter,
        start: args.start,
        count: args.count,
      });

      this.logger.debug(
        "DebugSession",
        `Variables received: ${response.variables?.length || 0}`
      );

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Variables request failed", error as Error);
      this.emit("output", {
        category: "stderr",
        output: `Variables request failed: ${(error as Error).message}\n`,
      });
      return { variables: [] };
    }
  }

  /**
   * Continue execution
   */
  async requestContinue(
    args: DebugProtocol.ContinueArguments
  ): Promise<DebugProtocol.ContinueResponse["body"]> {
    this.logger.info("DebugSession", "Continue execution");

    try {
      const response = await this.connectionManager.sendRequest("continue", {
        threadId: args.threadId,
      });

      // State will be updated by "continued" event
      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Continue request failed", error as Error);
      return { allThreadsContinued: false };
    }
  }

  /**
   * Step over (next line in same function)
   */
  async requestNext(
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    this.logger.info("DebugSession", "Step over (next)");

    try {
      await this.connectionManager.sendRequest("next", {
        threadId: args.threadId,
        granularity: args.granularity,
      });

      // State will be updated by "stopped" event with reason "step"
    } catch (error) {
      this.logger.error("DebugSession", "Next request failed", error as Error);
      throw error;
    }
  }

  /**
   * Step into function
   */
  async requestStepIn(
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    this.logger.info("DebugSession", "Step in");

    try {
      await this.connectionManager.sendRequest("stepIn", {
        threadId: args.threadId,
        targetId: args.targetId,
        granularity: args.granularity,
      });

      // State will be updated by "stopped" event
    } catch (error) {
      this.logger.error("DebugSession", "StepIn request failed", error as Error);
      throw error;
    }
  }

  /**
   * Step out of function
   */
  async requestStepOut(
    args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.logger.info("DebugSession", "Step out");

    try {
      await this.connectionManager.sendRequest("stepOut", {
        threadId: args.threadId,
        granularity: args.granularity,
      });

      // State will be updated by "stopped" event
    } catch (error) {
      this.logger.error("DebugSession", "StepOut request failed", error as Error);
      throw error;
    }
  }

  /**
   * Pause execution
   */
  async requestPause(
    args: DebugProtocol.PauseArguments
  ): Promise<void> {
    this.logger.info("DebugSession", "Pause execution");

    try {
      await this.connectionManager.sendRequest("pause", {
        threadId: args.threadId,
      });

      // State will be updated by "stopped" event with reason "pause"
    } catch (error) {
      this.logger.error("DebugSession", "Pause request failed", error as Error);
      throw error;
    }
  }

  /**
   * Evaluate expression
   */
  async requestEvaluate(
    args: DebugProtocol.EvaluateArguments
  ): Promise<DebugProtocol.EvaluateResponse["body"]> {
    this.logger.info("DebugSession", `Evaluate: ${args.expression}`);

    try {
      const response = await this.connectionManager.sendRequest("evaluate", {
        expression: args.expression,
        frameId: args.frameId,
        context: args.context,
      });

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Evaluate request failed", error as Error);
      return {
        result: `Error: ${error}`,
        variablesReference: 0,
      };
    }
  }

  /**
   * Set a variable value
   */
  async requestSetVariable(
    args: DebugProtocol.SetVariableArguments
  ): Promise<DebugProtocol.SetVariableResponse["body"]> {
    if (!this.isDebuggerStopped()) {
      throw new Error(`Cannot set variable - debugger state: ${this.state.debuggerState}`);
    }

    try {
      const response = await this.connectionManager.sendRequest("setVariable", {
        variablesReference: args.variablesReference,
        name: args.name,
        value: args.value,
        format: args.format,
      });

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Set variable failed", error as Error);
      throw error;
    }
  }

  /**
   * Set data breakpoints (watchpoints)
   */
  async requestSetDataBreakpoints(
    args: DebugProtocol.SetDataBreakpointsArguments
  ): Promise<DebugProtocol.SetDataBreakpointsResponse["body"]> {
    try {
      const response = await this.connectionManager.sendRequest("setDataBreakpoints", {
        breakpoints: args.breakpoints,
      });

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Set data breakpoints failed", error as Error);

      // Return failed breakpoints
      const breakpoints = (args.breakpoints || []).map(() => ({
        verified: false,
        message: `Failed to set watchpoint: ${error}`,
      }));

      return { breakpoints };
    }
  }

  /**
   * Read memory from debugger
   */
  async requestReadMemory(
    args: DebugProtocol.ReadMemoryArguments
  ): Promise<DebugProtocol.ReadMemoryResponse["body"]> {
    if (!this.isDebuggerStopped()) {
      throw new Error(`Cannot read memory - debugger state: ${this.state.debuggerState}`);
    }

    try {
      const response = await this.connectionManager.sendRequest("readMemory", {
        memoryReference: args.memoryReference,
        offset: args.offset || 0,
        count: args.count,
      });

      return response;
    } catch (error) {
      this.logger.error("DebugSession", "Read memory failed", error as Error);
      throw error;
    }
  }

  /**
   * Disconnect from debug session and reset all state
   */
  async disconnect(): Promise<void> {
    this.logger.info("DebugSession", "Disconnecting");

    try {
      if (this.connectionManager.getIsConnected()) {
        await this.connectionManager.sendRequest("disconnect", {}, 2000);
      }
    } catch (error) {
      this.logger.warn("DebugSession", "Disconnect request failed", error as Error);
      // Continue with disconnect anyway
    }

    this.connectionManager.disconnect();

    // Reset session state for next connection
    this.state.isConnected = false;
    this.state.debuggerState = "unknown";
    this.state.lastStoppedReason = undefined;
    this.state.lastStoppedThreadId = undefined;

    // Reset path mapper
    this.pathMapper.reset();

    this.logger.info("DebugSession", `Disconnect complete: ${JSON.stringify(this.state)}`);
  }

  /**
   * Map debugger paths in stack frames to local filesystem paths.
   *
   * This is critical for correct source file display in VS Code.
   * Compiled .smx files contain debug symbols with original compilation paths,
   * which may differ from current local paths.
   *
   * @param stackFrames - Stack frames from debugger
   * @returns Stack frames with mapped local paths
   */
  private mapStackFramePaths(
    stackFrames: DebugProtocol.StackFrame[]
  ): DebugProtocol.StackFrame[] {
    return stackFrames.map((frame) => {
      if (!frame.source?.path) {
        return frame;
      }

      const originalPath = frame.source.path;
      const mappedPath = this.pathMapper.mapPath(originalPath);

      if (mappedPath !== originalPath) {
        this.logger.info(
          "DebugSession",
          `Mapped stack frame path: ${originalPath} -> ${mappedPath}`
        );

        // Create new frame with mapped path
        return {
          ...frame,
          source: {
            ...frame.source,
            path: mappedPath,
            name: require("path").basename(mappedPath),
          },
        };
      }

      return frame;
    });
  }

  /**
   * Check if debugger is currently stopped
   */
  private isDebuggerStopped(): boolean {
    return this.state.debuggerState === "stopped";
  }

  /**
   * Get a user-friendly description of why an operation cannot be performed
   * in the current debugger state.
   */
  private getDebuggerStateDescription(): string {
    switch (this.state.debuggerState) {
      case "running":
        return "debugger is currently running - pause execution first";
      case "unknown":
        return "debugger state is unknown - try continuing or pausing execution";
      case "stopped":
        return "debugger is stopped";
      default:
        return `debugger state: ${this.state.debuggerState}`;
    }
  }

  /**
   * Get current session state (for debugging)
   */
  getState(): Readonly<SessionState> {
    return { ...this.state };
  }

  /**
   * Get diagnostic information
   */
  getDiagnostics(): any {
    return {
      state: this.getState(),
      connection: this.connectionManager.getDiagnostics(),
      pathMapper: this.pathMapper.getDiagnostics(),
    };
  }
}
