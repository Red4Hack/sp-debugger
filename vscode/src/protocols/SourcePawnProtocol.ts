import { DebugProtocol } from "@vscode/debugprotocol";
import * as path from "path";

/**
 * Timeout configuration for debug session connections and requests
 */
export interface TimeoutConfig {
  /** Connection timeout in ms (default: 10000) */
  connection: number;
  /** General request timeout in ms (default: 30000) */
  request: number;
  /** Stepping commands timeout in ms (default: 60000) - longer because server may be blocked */
  stepping: number;
  /** Keepalive interval in ms (default: 15000) */
  keepalive: number;
}

/**
 * Default timeout values
 */
export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  connection: 10000,
  request: 30000,
  stepping: 60000,
  keepalive: 15000,
};

/**
 * Commands that need longer timeout (server may be blocked during debug stepping)
 */
export const STEPPING_COMMANDS = [
  "continue",
  "next",
  "stepIn",
  "stepOut",
  "pause",
] as const;

/**
 * Commands that may return large responses and need extended timeout
 * These commands can return significant amounts of data (>60KB)
 */
export const LARGE_RESPONSE_COMMANDS = [
  "variables",
  "stackTrace",
] as const;

/**
 * Reconnection configuration
 */
export interface ReconnectConfig {
  /** Enable automatic reconnection (default: true) */
  enabled: boolean;
  /** Maximum reconnection attempts (default: 5) */
  maxAttempts: number;
  /** Base delay between attempts in ms (default: 1000) */
  baseDelay: number;
  /** Maximum delay between attempts in ms (default: 30000) */
  maxDelay: number;
}

export const DEFAULT_RECONNECT: ReconnectConfig = {
  enabled: true,
  maxAttempts: 5,
  baseDelay: 1000,
  maxDelay: 30000,
};

export interface SourcePawnLaunchArgs
  extends DebugProtocol.LaunchRequestArguments {
  host: string;
  port: number;
  plugin: string;
  // Shared secret configured on the server as "token" in
  // addons/sourcemod/configs/console-debugger.cfg. Required whenever the
  // server's DAP listener is bound to anything other than loopback; the server
  // refuses every request until it is presented.
  token?: string;
  timeout?: number | Partial<TimeoutConfig>;
  reconnect?: Partial<ReconnectConfig>;
  autoStart?: boolean;
  // When true, pause at the first executed line after launch. Defaults to
  // false so breakpoints drive the stops (pausing at a function's declaration
  // line shows no locals, which is confusing).
  stopOnEntry?: boolean;
  // When true, emit the verbose [sp-dbg] flow lines (continue, step over,
  // STOPPED, etc.) to the Debug Console. Off by default; turn on only when
  // troubleshooting the debugger itself.
  trace?: boolean;
}

export interface SourcePawnAttachArgs
  extends DebugProtocol.AttachRequestArguments {
  host: string;
  port: number;
  // Shared secret configured on the server as "token" in
  // addons/sourcemod/configs/console-debugger.cfg. Required whenever the
  // server's DAP listener is bound to anything other than loopback; the server
  // refuses every request until it is presented.
  token?: string;
  timeout?: number;
  // See SourcePawnLaunchArgs.trace.
  trace?: boolean;
}

export class SourcePawnProtocol {
  static readonly THREAD_ID = 1;
  static readonly DEFAULT_TIMEOUT = 5000;
  static readonly DEFAULT_PORT = 8080;

  static validatePluginFile(pluginPath: string): boolean {
    if (!pluginPath) return false;
    const ext = path.extname(pluginPath).toLowerCase();
    return ext === ".sp" || ext === ".inc";
  }

  static normalizePluginPath(pluginPath: string): string {
    return path.resolve(pluginPath);
  }

  static createInitializeCapabilities(): DebugProtocol.Capabilities {
    return {
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsStepBack: false,
      supportsDataBreakpoints: true, // Watch variables (watchpoint)
      supportsCompletionsRequest: false,
      supportsCancelRequest: true, // Pause support
      supportsBreakpointLocationsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsExceptionFilterOptions: false,
      supportsValueFormattingOptions: false,
      supportsExceptionInfoRequest: false,
      supportTerminateDebuggee: true,
      supportSuspendDebuggee: true, // Pause debugger
      supportsDelayedStackTraceLoading: false,
      supportsLoadedSourcesRequest: false,
      supportsLogPoints: true, // Logpoints: log values and continue (no freeze)
      supportsTerminateThreadsRequest: false,
      supportsSetVariable: true, // Set command
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsSteppingGranularity: false,
      supportsInstructionBreakpoints: false,
      supportsReadMemoryRequest: true, // Examine memory (x command)
      supportsDisassembleRequest: false,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
    };
  }

  static createDefaultThread(): DebugProtocol.Thread {
    return {
      id: this.THREAD_ID,
      name: "main thread",
    };
  }

  static createBreakpointFromLine(
    line: number,
    source: DebugProtocol.Source,
    condition?: string,
    hitCondition?: string,
    verified: boolean = true,
  ): DebugProtocol.Breakpoint {
    const breakpoint: DebugProtocol.Breakpoint = {
      id: Math.floor(Math.random() * 10000),
      verified,
      line,
      source,
    };

    if (condition !== undefined) {
      (breakpoint as any).condition = condition;
    }
    if (hitCondition !== undefined) {
      (breakpoint as any).hitCondition = hitCondition;
    }

    return breakpoint;
  }

  static createSourceFromPath(filePath: string): DebugProtocol.Source {
    return {
      name: path.basename(filePath),
      path: filePath,
      sourceReference: 0,
    };
  }

  static createStackFrame(
    id: number,
    name: string,
    source: DebugProtocol.Source,
    line: number,
    column: number = 0,
  ): DebugProtocol.StackFrame {
    return {
      id,
      name,
      source,
      line,
      column,
    };
  }

  static createScope(
    name: string,
    variablesReference: number,
    expensive: boolean = false,
  ): DebugProtocol.Scope {
    return {
      name,
      variablesReference,
      expensive,
    };
  }

  static createVariable(
    name: string,
    value: string,
    variablesReference: number = 0,
    type?: string,
  ): DebugProtocol.Variable {
    return {
      name,
      value,
      variablesReference,
      type,
    };
  }

  static parseStoppedReason(
    reason: string,
  ): DebugProtocol.StoppedEvent["body"]["reason"] {
    switch (reason.toLowerCase()) {
      case "step":
        return "step";
      case "breakpoint":
        return "breakpoint";
      case "exception":
        return "exception";
      case "pause":
        return "pause";
      case "entry":
        return "entry";
      default:
        return "pause";
    }
  }

  static isSourcePawnFile(filePath: string): boolean {
    if (!filePath) return false;
    const ext = path.extname(filePath).toLowerCase();
    return ext === ".sp" || ext === ".inc";
  }

  static extractPluginName(pluginPath: string): string {
    const basename = path.basename(pluginPath, path.extname(pluginPath));
    return basename;
  }

  /**
   * Maps DAP requests to console debugger commands
   */
  static createConsoleCommand(dapCommand: string, args?: any): string {
    switch (dapCommand) {
      case "stackTrace":
        return "backtrace";

      case "scopes":
        // Select frame and list variables
        const frameId = args?.frameId || 0;
        return `frame ${frameId}`;

      case "variables":
        // Print variables (with optional filter)
        if (args?.variablesReference && args.variablesReference > 0) {
          return "print"; // List all variables
        } else {
          return "print"; // List all variables
        }

      case "evaluate":
        // Print specific variable
        return `print ${args?.expression || ""}`;

      case "setVariable":
        // Set variable value
        const varName = args?.name || "";
        const varValue = args?.value || "";
        return `set ${varName} = ${varValue}`;

      case "setBreakpoints":
        // Handle breakpoints
        const source = args?.source?.path || "";
        const lines = args?.lines || [];
        if (lines.length > 0) {
          return lines
            .map((line: number) => `break ${source}:${line}`)
            .join("\n");
        }
        return "";

      case "clearBreakpoint":
        // Clear specific breakpoint
        const bpId = args?.id || "";
        return `cbreak ${bpId}`;

      case "setDataBreakpoints":
        // Watch variables (watchpoints)
        const watchExprs = args?.breakpoints || [];
        return watchExprs
          .map((bp: any) => `watch ${bp.dataId}`)
          .join("\n");

      case "clearDataBreakpoint":
        // Clear watchpoint
        const watchId = args?.dataId || "";
        return `cwatch ${watchId}`;

      case "readMemory":
        // Examine memory
        const memAddr = args?.memoryReference || "";
        const memCount = args?.count || 32;
        return `x/${memCount}xw ${memAddr}`;

      case "functions":
        // List functions
        return "functions";

      case "position":
        // Show current position
        return "position";

      case "continue":
        return "continue";

      case "next":
        return "next";

      case "stepIn":
        return "step";

      case "stepOut":
        return "stepout"; // Note: Native DAP command, this mapping is legacy and not used

      case "pause":
        // Interrupt execution - this might need special handling
        return "pause";

      case "terminate":
        return "quit";

      default:
        return dapCommand;
    }
  }

  /**
   * Parses console debugger output into DAP responses
   */
  static parseConsoleOutput(command: string, output: string): any {
    switch (command) {
      case "backtrace":
        return this.parseBacktraceOutput(output);

      case "print":
        return this.parsePrintOutput(output);

      case "frame":
        return this.parseFrameOutput(output);

      case "functions":
        return this.parseFunctionsOutput(output);

      case "position":
        return this.parsePositionOutput(output);

      case "set":
        return this.parseSetVariableOutput(output);

      case "watch":
        return this.parseWatchOutput(output);

      case "x":
        return this.parseMemoryOutput(output);

      default:
        return { raw: output };
    }
  }

  private static parseBacktraceOutput(
    output: string,
  ): DebugProtocol.StackTraceResponse["body"] {
    const lines = output.split("\n").filter((line) => line.trim());
    const stackFrames: DebugProtocol.StackFrame[] = [];

    // Parse backtrace format: "#0 function_name() at file.sp:line"
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(/#(\d+)\s+(.+?)\s+at\s+(.+?):(\d+)/);

      if (match) {
        const [, frameId, functionName, fileName, lineNumber] = match;

        stackFrames.push({
          id: parseInt(frameId, 10),
          name: functionName,
          source: {
            name: path.basename(fileName),
            path: fileName,
          },
          line: parseInt(lineNumber, 10),
          column: 0,
        });
      }
    }

    return {
      stackFrames,
      totalFrames: stackFrames.length,
    };
  }

  private static parsePrintOutput(
    output: string,
  ): DebugProtocol.VariablesResponse["body"] {
    const lines = output.split("\n").filter((line) => line.trim());
    const variables: DebugProtocol.Variable[] = [];

    // Parse variable format: "variable_name = value"
    for (const line of lines) {
      const match = line.trim().match(/^(.+?)\s*=\s*(.+)$/);

      if (match) {
        const [, name, value] = match;

        variables.push({
          name: name.trim(),
          value: value.trim(),
          variablesReference: 0,
        });
      }
    }

    return { variables };
  }

  private static parseFrameOutput(
    output: string,
  ): DebugProtocol.ScopesResponse["body"] {
    // Check if frame selection was successful from output
    const isFrameSelected =
      output.includes("Frame") || output.includes("frame") || output.length > 0;

    // Return standard scopes for SourcePawn debugging
    return {
      scopes: [
        {
          name: "Local Variables",
          variablesReference: 1,
          expensive: false,
        },
        {
          name: "Global Variables",
          variablesReference: 2,
          expensive: true,
        },
        {
          name: "Registers",
          variablesReference: 3,
          expensive: false,
        },
      ].filter((scope) => isFrameSelected || scope.name === "Local Variables"), // Show all scopes if frame selected
    };
  }

  private static parseFunctionsOutput(output: string): any {
    const lines = output.split("\n").filter((line) => line.trim());
    const functions: Array<{ name: string; file?: string; line?: number }> = [];

    // Parse functions output format
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("Functions:")) {
        // Parse function format: "function_name at file.sp:line" or just "function_name"
        // Try full format first (3 capture groups)
        const fullMatch = trimmed.match(/^(.+?)\s+at\s+(.+?):(\d+)$/);
        if (fullMatch) {
          const [, funcName, fileName, lineNumber] = fullMatch;
          functions.push({
            name: funcName.trim(),
            file: fileName.trim(),
            line: parseInt(lineNumber, 10),
          });
        } else {
          // Fallback to just function name (1 capture group)
          const simpleMatch = trimmed.match(/^(.+)$/);
          if (simpleMatch) {
            functions.push({
              name: simpleMatch[1].trim(),
              file: undefined,
              line: undefined,
            });
          }
        }
      }
    }

    return { functions };
  }

  private static parsePositionOutput(output: string): any {
    const lines = output.split("\n").filter((line) => line.trim());

    // Parse position format: "at file.sp:line" or "Current position: file.sp:line"
    for (const line of lines) {
      const match = line.match(/(?:at|Current position:)\s*(.+?):(\d+)/) ||
                   line.match(/(.+?):(\d+)/);

      if (match) {
        const [, fileName, lineNumber] = match;
        return {
          source: {
            name: path.basename(fileName),
            path: fileName,
          },
          line: parseInt(lineNumber, 10),
          column: 0,
        };
      }
    }

    return { raw: output };
  }

  private static parseSetVariableOutput(output: string): any {
    // Check if set operation was successful
    const success = !output.toLowerCase().includes("error") &&
                   !output.toLowerCase().includes("failed");

    return {
      success,
      message: output.trim(),
    };
  }

  private static parseWatchOutput(output: string): any {
    // Parse watch command output
    const success = !output.toLowerCase().includes("error") &&
                   !output.toLowerCase().includes("failed");

    return {
      success,
      watchId: success ? Date.now().toString() : null, // Generate simple watch ID
      message: output.trim(),
    };
  }

  private static parseMemoryOutput(output: string): any {
    const lines = output.split("\n").filter((line) => line.trim());
    const memoryData: Array<{ address: string; data: string }> = [];

    // Parse memory examination output format
    for (const line of lines) {
      const trimmed = line.trim();
      // Parse format like: "0x12345678: 0x01234567 0x89abcdef ..."
      const match = trimmed.match(/^(0x[0-9a-fA-F]+):\s*(.+)$/);

      if (match) {
        const [, address, data] = match;
        memoryData.push({
          address: address.trim(),
          data: data.trim(),
        });
      }
    }

    return { memoryData, raw: output };
  }
}
