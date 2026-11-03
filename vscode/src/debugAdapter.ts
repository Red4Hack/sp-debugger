import { LoggingDebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ContinuedEvent, } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { DebugSessionManager } from "./adapters/DebugSessionManager";
import { SourcePawnLaunchArgs, SourcePawnAttachArgs, } from "./protocols/SourcePawnProtocol";
import { Logger, LogLevel } from "./utils/Logger";
import { ConfigValidator } from "./utils/ConfigValidator";

interface DebugErrorContext {
  operation: string;
  request?: any;
  sessionState?: any;
  timestamp: number;
}

class DebugError extends Error {
  constructor(
    message: string,
    public readonly context: DebugErrorContext,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = "DebugError";
  }
}

export class SourcePawnDebugSession extends LoggingDebugSession {
  private sessionManager: DebugSessionManager;
  private logger: Logger;
  private configurationDone = false;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  // Verbose [sp-dbg] flow tracing to the Debug Console. Off by default; enabled
  // per session via the launch/attach config "trace": true.
  private traceEnabled = false;

  public constructor() {
    super("sp-debugger.txt");
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    this.logger = Logger.getInstance();

    // Keep logging quiet by default: only errors/warnings reach the console.
    // Verbose DEBUG/console output is enabled only when actually developing the
    // extension itself (VS Code sets VSCODE_DEBUG=true in the Extension
    // Development Host). End users get a clean Debug Console.
    const isExtensionDev = process.env.VSCODE_DEBUG === "true";
    if (isExtensionDev) {
      this.logger.setLogLevel(LogLevel.DEBUG);
      this.logger.enableConsoleOutput(true);
    } else {
      this.logger.setProductionMode(true);
    }

    this.logger.debug("DebugAdapter", "Constructor called");
    this.logger.debug("DebugAdapter", "Creating session manager...");
    this.sessionManager = new DebugSessionManager();
    this.setupSessionHandlers();
    this.logger.debug("DebugAdapter", "Debug adapter initialized");

    this.logger.info("Adapter", "SourcePawn Debug Adapter started");
  }

  private setupSessionHandlers(): void {
    this.sessionManager.on("log", (message: string) => {
      this.logger.info("Session", message);
    });

    this.sessionManager.on("stopped", (body: any) => {
      this.logger.info(
        "DebugAdapter",
        `STOPPED EVENT RECEIVED: ${JSON.stringify(body)}`,
      );
      this.trace(
        `STOPPED (reason=${body.reason ?? "?"}, thread=${body.threadId ?? 1})` +
          (body.text ? ` — ${body.text}` : ""),
      );
      const stoppedEvent = new StoppedEvent(
        body.reason || "breakpoint",
        body.threadId || 1,
        body.text,
      );
      this.sendEvent(stoppedEvent);
      this.logger.info("DebugAdapter", "STOPPED EVENT SENT");
    });

    this.sessionManager.on(
      "continued",
      (body: DebugProtocol.ContinuedEvent["body"]) => {
        this.sendEvent(
          new ContinuedEvent(body.threadId, body.allThreadsContinued),
        );
      },
    );

    this.sessionManager.on(
      "output",
      (body: DebugProtocol.OutputEvent["body"]) => {
        this.logger.debug(
          "Output",
          `Output event: ${body.category} - ${body.output}`,
        );
        this.sendEvent(new OutputEvent(body.output, body.category));
      },
    );

    this.sessionManager.on(
      "terminated",
      (body?: DebugProtocol.TerminatedEvent["body"]) => {
        this.sendEvent(new TerminatedEvent(body?.restart));
      },
    );

    this.sessionManager.on(
      "exited",
      (body: DebugProtocol.ExitedEvent["body"]) => {
        this.sendEvent(new TerminatedEvent());
      },
    );
  }

  /**
   * Emit a concise, user-visible line to VS Code's Debug Console so the
   * client-side flow (the actions you take in the UI) can be shared alongside
   * the server log when diagnosing issues.
   */
  private trace(message: string): void {
    if (!this.traceEnabled) {
      return;
    }
    this.sendEvent(new OutputEvent(`[sp-dbg] ${message}\n`, "console"));
  }

  protected async initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments,
  ): Promise<void> {
    try {
      this.logger.debug(
        "Adapter",
        `Initialize request: ${JSON.stringify(args)}`,
      );
      const capabilities = await this.sessionManager.initialize(args);
      response.body = capabilities;
      this.logger.trace(
        "Adapter",
        `Initialize capabilities: ${JSON.stringify(capabilities)}`,
      );
      this.sendResponse(response);
      // NOTE: InitializedEvent is intentionally NOT sent here. It is what makes
      // VS Code send setBreakpoints, and the server can only verify breakpoints
      // once the connection is up and the plugin is bound -- which happens in
      // launchRequest/attachRequest. Emitting it here races setBreakpoints ahead
      // of the bind, landing on the server's "No active plugin" path so every
      // breakpoint comes back unverified. We emit it after launch/attach instead.
      this.logger.info("Adapter", "Initialization completed successfully");
    } catch (error) {
      this.logger.error("Adapter", `Initialize failed: ${error}`);
      this.sendErrorResponse(response, 2000, `Initialize failed: ${error}`);
    }
  }

  protected async configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments,
  ): Promise<void> {
    super.configurationDoneRequest(response, args);
    this.configurationDone = true;
    this.logger.debug("Adapter", "Configuration done request received");
    await this.sessionManager.configurationDone();
    this.sendResponse(response);
    this.logger.trace("Adapter", "Configuration done completed");
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: SourcePawnLaunchArgs,
  ): Promise<void> {
    const context: DebugErrorContext = {
      operation: "launch",
      request: args,
      sessionState: this.sessionManager.getState(),
      timestamp: Date.now(),
    };

    this.traceEnabled = args.trace === true;
    this.logger.debug(
      "DebugAdapter",
      `Launch request received: ${JSON.stringify(args)}`,
    );
    try {
      // Validate configuration
      const validation = ConfigValidator.validateDebugConfiguration(
        args as any,
      );
      if (!validation.isValid) {
        this.logger.error(
          "DebugAdapter",
          `Invalid configuration: ${validation.errors}`,
        );
        throw new DebugError(
          `Invalid configuration: ${validation.errors.join(", ")}`,
          context,
        );
      }

      // Log warnings
      validation.warnings.forEach((warning) => {
        this.logger.warn("Config", warning);
      });

      this.logger.debug("DebugAdapter", "Starting session manager launch...");
      await this.sessionManager.launch(args);
      this.logger.debug("DebugAdapter", "Launch successful, sending response");
      this.sendResponse(response);
      // Connection is up and the plugin is bound on the server: now it is safe
      // to ask VS Code for breakpoints. setBreakpoints will reach the server
      // with active_plugin set, so they verify reliably.
      this.sendEvent(new InitializedEvent());
    } catch (error) {
      this.handleDebugError(
        error as Error,
        context,
        response,
        2001,
        "Failed to launch debugger",
      );
    }
  }

  protected async attachRequest(
    response: DebugProtocol.AttachResponse,
    args: SourcePawnAttachArgs,
  ): Promise<void> {
    this.traceEnabled = args.trace === true;
    try {
      // Validate configuration
      const validation = ConfigValidator.validateDebugConfiguration(
        args as any,
      );
      if (!validation.isValid) {
        throw new Error(
          `Invalid configuration: ${validation.errors.join(", ")}`,
        );
      }

      await this.sessionManager.attach(args);
      this.sendResponse(response);
      // Connection up and attached: safe to request breakpoints now (see the
      // note in initializeRequest for why InitializedEvent is deferred to here).
      this.sendEvent(new InitializedEvent());
    } catch (error) {
      this.sendErrorResponse(response, 2002, `Failed to attach: ${error}`);
    }
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    try {
      const result = await this.sessionManager.requestSetBreakpoints(args);
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(
        response,
        2003,
        `Failed to set breakpoints: ${error}`,
      );
    }
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    try {
      const result = this.sessionManager.getThreads();
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2004, `Failed to get threads: ${error}`);
    }
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    const context: DebugErrorContext = {
      operation: "stackTrace",
      request: args,
      sessionState: this.sessionManager.getState(),
      timestamp: Date.now(),
    };

    try {
      this.logger.debug("DebugAdapter", "*** STACK TRACE REQUEST RECEIVED ***");
      this.logger.debug(
        "DebugAdapter",
        `Request args: ${JSON.stringify(args)}`,
      );

      const result = await this.sessionManager.requestStackTrace(args);
      this.logger.debug(
        "DebugAdapter",
        `Stack trace result: ${JSON.stringify(result)}`,
      );

      // Validate result before sending
      if (!result || !Array.isArray(result.stackFrames)) {
        throw new DebugError(
          "Invalid stack trace result from session manager",
          context,
        );
      }

      response.body = result;
      this.sendResponse(response);
      this.trace(
        `stackTrace -> ${result.stackFrames.length} frame(s): ` +
          result.stackFrames
            .map((f) => `#${f.id} ${f.name}@${f.line}`)
            .join(" | "),
      );
      this.logger.debug(
        "DebugAdapter",
        "Stack trace response sent successfully",
      );
    } catch (error) {
      this.handleDebugError(
        error as Error,
        context,
        response,
        2005,
        "Failed to get stack trace",
      );
    }
  }

  protected async scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): Promise<void> {
    const context: DebugErrorContext = {
      operation: "scopes",
      request: args,
      sessionState: this.sessionManager.getState(),
      timestamp: Date.now(),
    };

    try {
      this.logger.debug("DebugAdapter", "*** SCOPES REQUEST RECEIVED ***");
      this.logger.debug(
        "DebugAdapter",
        `Request args: ${JSON.stringify(args)}`,
      );

      const result = await this.sessionManager.requestScopes(args);
      this.logger.debug(
        "DebugAdapter",
        `Scopes result: ${JSON.stringify(result)}`,
      );

      // Validate result before sending
      if (!result || !Array.isArray(result.scopes)) {
        throw new DebugError(
          "Invalid scopes result from session manager",
          context,
        );
      }

      response.body = result;
      this.sendResponse(response);
      this.trace(
        `scopes(frame=${args.frameId}) -> ${result.scopes.map((s) => s.name).join(", ")}`,
      );
      this.logger.debug("DebugAdapter", "Scopes response sent successfully");
    } catch (error) {
      this.handleDebugError(
        error as Error,
        context,
        response,
        2006,
        "Failed to get scopes",
      );
    }
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    const context: DebugErrorContext = {
      operation: "variables",
      request: args,
      sessionState: this.sessionManager.getState(),
      timestamp: Date.now(),
    };

    try {
      this.logger.debug("DebugAdapter", "*** VARIABLES REQUEST RECEIVED ***");
      this.logger.debug(
        "DebugAdapter",
        `Request args: ${JSON.stringify(args)}`,
      );

      const result = await this.sessionManager.requestVariables(args);
      this.logger.debug(
        "DebugAdapter",
        `Variables result: ${JSON.stringify(result)}`,
      );

      // Validate result before sending
      if (!result || !Array.isArray(result.variables)) {
        throw new DebugError(
          "Invalid variables result from session manager",
          context,
        );
      }

      response.body = result;
      this.sendResponse(response);
      this.trace(
        `variables(ref=${args.variablesReference}) -> ${result.variables.length} item(s)` +
          (result.variables.length
            ? `: ${result.variables.slice(0, 8).map((v) => v.name).join(", ")}`
            : " (empty)"),
      );
      this.logger.debug("DebugAdapter", "Variables response sent successfully");
    } catch (error) {
      this.handleDebugError(
        error as Error,
        context,
        response,
        2007,
        "Failed to get variables",
      );
    }
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments,
  ): Promise<void> {
    try {
      this.trace("continue");
      const result = await this.sessionManager.requestContinue(args);
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2008, `Failed to continue: ${error}`);
    }
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments,
  ): Promise<void> {
    try {
      this.trace("step over (next)");
      await this.sessionManager.requestNext(args);
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2009, `Failed to step over: ${error}`);
    }
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): Promise<void> {
    try {
      this.trace("step in");
      await this.sessionManager.requestStepIn(args);
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2010, `Failed to step in: ${error}`);
    }
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
  ): Promise<void> {
    try {
      this.trace("step out");
      await this.sessionManager.requestStepOut(args);
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2011, `Failed to step out: ${error}`);
    }
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments,
  ): Promise<void> {
    try {
      this.logger.info("Adapter", `Pause request for thread ${args.threadId}`);
      this.trace("pause requested");
      await this.sessionManager.requestPause(args);
      this.sendResponse(response);
      this.logger.debug("Adapter", "Pause request sent to session manager");
    } catch (error) {
      this.logger.error("Adapter", `Failed to pause: ${error}`);
      this.sendErrorResponse(response, 2012, `Failed to pause: ${error}`);
    }
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
    try {
      const result = await this.sessionManager.requestEvaluate(args);
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2013, `Failed to evaluate: ${error}`);
    }
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
    try {
      this.logger.debug("DebugAdapter", `Setting ${args.name} = ${args.value}`);

      const result = await this.sessionManager.requestSetVariable(args);
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2014, `Failed to set variable: ${error}`);
    }
  }

  protected async dataBreakpointInfoRequest(
    response: DebugProtocol.DataBreakpointInfoResponse,
    args: DebugProtocol.DataBreakpointInfoArguments,
  ): Promise<void> {
    try {
      const dataId = `${args.variablesReference}:${args.name}`;
      response.body = {
        dataId: dataId,
        description: `Watch ${args.name}`,
        accessTypes: ["read", "write", "readWrite"],
        canPersist: false,
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2020, `Failed to get data breakpoint info: ${error}`);
    }
  }

  protected async setDataBreakpointsRequest(
    response: DebugProtocol.SetDataBreakpointsResponse,
    args: DebugProtocol.SetDataBreakpointsArguments,
  ): Promise<void> {
    try {
      this.logger.debug("DebugAdapter", `Watchpoints: ${args.breakpoints?.length || 0}`);

      const result = await this.sessionManager.requestSetDataBreakpoints(args);
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2017, `Failed to set data breakpoints: ${error}`);
    }
  }

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments,
  ): Promise<void> {
    try {
      this.logger.debug(
        "DebugAdapter",
        `Reading ${args.count} bytes from ${args.memoryReference}`
      );

      const result = await this.sessionManager.requestReadMemory(args);
      response.body = result;
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2018, `Failed to read memory: ${error}`);
    }
  }

  /**
   * Exception details for VS Code's exception widget when stopped on an
   * exception. Forwarded to the server, which returns the captured VM error
   * message (e.g. "Not enough space on the heap").
   */
  protected async exceptionInfoRequest(
    response: DebugProtocol.ExceptionInfoResponse,
    args: DebugProtocol.ExceptionInfoArguments,
  ): Promise<void> {
    try {
      const body = await this.sessionManager.sendCustomRequest(
        "exceptionInfo",
        args,
      );
      if (body) {
        response.body = body;
      }
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 2031, `exceptionInfo failed: ${error}`);
    }
  }

  /**
   * Custom (non-standard-DAP) requests. The function profiler uses
   * `sp_profileStart` / `sp_profileStop`, dispatched from the VS Code commands
   * via `session.customRequest(...)`; the Realtime Performance panel polls
   * `sp_performance`. We pass them straight through to the server and echo its
   * response body (e.g. `{ tree: ... }`).
   */
  protected async customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: any,
  ): Promise<void> {
    if (command === "sp_profileStart" || command === "sp_profileStop") {
      try {
        const body = await this.sessionManager.sendCustomRequest(command, args);
        response.body = body ?? {};
        this.sendResponse(response);
      } catch (error) {
        this.sendErrorResponse(response, 2030, `${command} failed: ${error}`);
      }
      return;
    }
    if (command === "sp_performance") {
      try {
        // Polled every second: fail fast instead of queueing behind a stuck poll.
        const body = await this.sessionManager.sendCustomRequest(command, args, 3000);
        response.body = body ?? {};
        this.sendResponse(response);
      } catch (error) {
        this.sendErrorResponse(response, 2032, `${command} failed: ${error}`);
      }
      return;
    }
    super.customRequest(command, response, args);
  }

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    try {
      await this.sessionManager.disconnect();
      this.sendResponse(response);

      // Cleanup adapter resources after disconnect (tracked so it can be
      // cancelled in cleanup() and never fires into a dead session).
      this.cleanupTimer = setTimeout(() => {
        void this.cleanup();
      }, 1500); // Allow time for disconnect to complete
    } catch (error) {
      this.sendErrorResponse(response, 2015, `Failed to disconnect: ${error}`);
      await this.cleanup(); // Cleanup even on error
    }
  }

  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    args: DebugProtocol.TerminateArguments,
  ): Promise<void> {
    try {
      await this.sessionManager.disconnect();
      this.sendResponse(response);

      // Cleanup after termination (tracked; cancelled by cleanup()).
      this.cleanupTimer = setTimeout(() => {
        void this.cleanup();
      }, 500);
    } catch (error) {
      this.sendErrorResponse(response, 2016, `Failed to terminate: ${error}`);
      await this.cleanup(); // Cleanup even on error
    }
  }

  private handleDebugError(
    error: Error,
    context: DebugErrorContext,
    response: DebugProtocol.Response,
    errorCode: number,
    fallbackMessage: string,
  ): void {
    const isDebugError = error instanceof DebugError;
    const originalError = isDebugError ? error.originalError : error;
    const errorMessage = error.message || fallbackMessage;

    // Log detailed error information
    this.logger.error("DebugAdapter", `ERROR in ${context.operation}:`, {
      message: errorMessage,
      operation: context.operation,
      timestamp: context.timestamp,
      sessionState: context.sessionState,
      originalError: originalError?.message,
      stack: originalError?.stack,
      context: context,
    });

    // Expected states (a variables/scopes poll while the debuggee runs) are not
    // failures: sendEmptyResultWithMessage below already explains them in one
    // plain line. Emitting a raw "Error in ..." on stderr as well turned every
    // such poll into two lines of noise, one of them alarming.
    const explained = this.shouldReturnEmptyResultWithMessage(context.operation, error);
    if (!explained) {
      // Note the real newline: this used to be an escaped "\\n", which printed a
      // literal backslash-n at the end of the line instead of breaking it.
      this.sendEvent(
        new OutputEvent(`Error in ${context.operation}: ${errorMessage}\n`, "stderr"),
      );
    }

    // Send appropriate error response
    if (explained) {
      // For state-related issues, return empty result with user-friendly message
      this.sendEmptyResultWithMessage(response, context.operation, errorMessage);
      this.logger.info(
        "DebugAdapter",
        `Returned empty result with message for ${context.operation}: ${errorMessage}`,
      );
    } else {
      // Send error response for critical failures
      this.sendErrorResponse(response, errorCode, errorMessage);
      this.logger.error(
        "DebugAdapter",
        `Sent error response for ${context.operation}: ${errorMessage}`,
      );
    }
  }

  /**
   * Determines if an error should result in an empty result with a user-facing message,
   * rather than a hard error that breaks the debug session.
   *
   * This is appropriate for state-related issues where the debugger is temporarily
   * unavailable (e.g., debugger running, connection issues).
   */
  private shouldReturnEmptyResultWithMessage(operation: string, error: Error): boolean {
    // State-related errors that are expected during normal operation
    const stateRelatedPatterns = [
      "debugger not stopped",
      "debugger state",
      "state unknown",
      "state: running",
      "connection lost",
      "not connected",
    ];
    const isStateError = stateRelatedPatterns.some((pattern) =>
      error.message.toLowerCase().includes(pattern),
    );

    // These operations can legitimately return empty results when state is inconsistent
    const gracefulOperations = ["stackTrace", "scopes", "variables"];

    return gracefulOperations.includes(operation) && isStateError;
  }

  /**
   * Send an empty result for operations that can gracefully handle unavailable data,
   * while still informing the user about the underlying issue.
   */
  private sendEmptyResultWithMessage(
    response: DebugProtocol.Response,
    operation: string,
    reason: string,
  ): void {
    // Always inform the user about why the result is empty
    const userMessage = this.getUserFriendlyMessage(operation, reason);
    this.sendEvent(
      new OutputEvent(
        `${operation}: ${userMessage}\n`,
        "console",
      ),
    );

    switch (operation) {
      case "stackTrace":
        (response as DebugProtocol.StackTraceResponse).body = {
          stackFrames: [],
          totalFrames: 0,
        };
        break;
      case "scopes":
        (response as DebugProtocol.ScopesResponse).body = { scopes: [] };
        break;
      case "variables":
        (response as DebugProtocol.VariablesResponse).body = { variables: [] };
        break;
      default:
        this.logger.warn(
          "DebugAdapter",
          `Unknown operation for empty result: ${operation}`,
        );
        return;
    }
    this.sendResponse(response);
  }

  /**
   * Convert technical error messages to user-friendly explanations.
   */
  private getUserFriendlyMessage(operation: string, reason: string): string {
    const lowerReason = reason.toLowerCase();

    if (lowerReason.includes("not stopped") || lowerReason.includes("state: running")) {
      return "Debugger is running. Pause execution to inspect " +
        (operation === "stackTrace" ? "the call stack" :
         operation === "scopes" ? "scopes" : "variables") + ".";
    }

    if (lowerReason.includes("not connected") || lowerReason.includes("connection lost")) {
      return "Not connected to debug server. Check connection status.";
    }

    if (lowerReason.includes("state unknown")) {
      return "Debugger state is unknown. Try pausing or continuing execution.";
    }

    // Return the original reason if no friendly message is available
    return reason;
  }

  private async cleanup(): Promise<void> {
    this.logger.debug("DebugAdapter", "Starting adapter cleanup");

    // Cancel the deferred-cleanup timer so it can't fire into a dead session.
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    try {
      // Cleanup session manager
      if (this.sessionManager) {
        await this.sessionManager.disconnect();
      }

      // Remove any event listeners
      this.removeAllListeners();

      this.logger.debug("DebugAdapter", "Adapter cleanup completed");
    } catch (error) {
      this.logger.error(
        "DebugAdapter",
        `Error during adapter cleanup: ${error}`,
      );
    }
  }
}

// Auto-start only when executed as the standalone adapter entrypoint
// (node out/debugAdapter.js, spawned by the extension). When this module is
// merely imported -- e.g. by the test suite -- starting a session would bind
// stdin/stdout and eventually process.exit(0) on shutdown, killing the host.
if (typeof require !== "undefined" && require.main === module) {
  const logger = Logger.getInstance();
  logger.info("DebugAdapter", "Starting SourcePawn Debug Adapter...");
  SourcePawnDebugSession.run(SourcePawnDebugSession);
}
