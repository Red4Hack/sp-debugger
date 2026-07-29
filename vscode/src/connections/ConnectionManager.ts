import { EventEmitter } from "events";
import { TcpConnection, ConnectionConfig, DAPMessage } from "./TcpConnection";
import { RequestRegistry } from "./RequestRegistry";
import { DAPMessageHandler, DAPResponse, DAPEvent } from "../protocols/DAPProtocol";
import { Logger } from "../utils/Logger";
import { KeepaliveManager, KeepaliveState } from "./KeepaliveManager";
import { ReconnectionManager } from "./ReconnectionManager";
import {
  TimeoutConfig,
  DEFAULT_TIMEOUTS,
  STEPPING_COMMANDS,
  LARGE_RESPONSE_COMMANDS,
  ReconnectConfig,
  DEFAULT_RECONNECT,
} from "../protocols/SourcePawnProtocol";

/**
 * ConnectionManager provides a high-level interface for managing debug server connections
 * and DAP request/response cycles.
 *
 * This class orchestrates the interaction between:
 * - TcpConnection (low-level TCP socket management)
 * - RequestRegistry (promise-based request tracking)
 * - DAPMessageHandler (message parsing and validation)
 *
 * Key Responsibilities:
 * - Centralized connection lifecycle management
 * - Promise-based request/response handling
 * - Event propagation from server to clients
 * - Error handling and recovery
 */
export class ConnectionManager extends EventEmitter {
  private connection: TcpConnection;
  private registry: RequestRegistry;
  private messageHandler: DAPMessageHandler;
  private logger = Logger.getInstance();
  private isConnected = false;

  // Keepalive and reconnection managers
  private keepalive?: KeepaliveManager;
  private reconnection?: ReconnectionManager;

  // Configuration storage for reconnection
  private connectionConfig?: ConnectionConfig;
  private timeouts: TimeoutConfig = { ...DEFAULT_TIMEOUTS };
  private reconnectConfig: ReconnectConfig = { ...DEFAULT_RECONNECT };

  // Bound handlers to prevent accumulation on reconnect
  private boundHandlers = {
    onConnected: (info: any) => this.handleConnected(info),
    onDisconnected: (info?: { hadError?: boolean }) => this.handleDisconnected(info),
    onMessageReceived: (message: DAPMessage) => this.handleIncomingMessage(message),
    onError: (error: Error) => this.handleError(error),
    onDiagnostic: (msg: string) => this.emit("diagnostic", msg),
  };

  constructor() {
    super();
    this.connection = new TcpConnection();
    this.registry = new RequestRegistry();
    this.messageHandler = new DAPMessageHandler();

    this.setupConnectionHandlers();
    this.setupMessageHandlers();
  }

  /**
   * Set up TCP connection event handlers (idempotent)
   * Removes existing handlers first to prevent accumulation on reconnect
   */
  private setupConnectionHandlers(): void {
    // Remove existing handlers first (idempotent)
    this.connection.removeListener("connected", this.boundHandlers.onConnected);
    this.connection.removeListener("disconnected", this.boundHandlers.onDisconnected);
    this.connection.removeListener("messageReceived", this.boundHandlers.onMessageReceived);
    this.connection.removeListener("error", this.boundHandlers.onError);
    this.connection.removeListener("diagnostic", this.boundHandlers.onDiagnostic);

    // Add handlers
    this.connection.on("connected", this.boundHandlers.onConnected);
    this.connection.on("disconnected", this.boundHandlers.onDisconnected);
    this.connection.on("messageReceived", this.boundHandlers.onMessageReceived);
    this.connection.on("error", this.boundHandlers.onError);
    this.connection.on("diagnostic", this.boundHandlers.onDiagnostic);
  }

  /**
   * Set up DAP message handler event handlers
   */
  private setupMessageHandlers(): void {
    this.messageHandler.on("response", (response: DAPResponse) => {
      // Resolve the pending promise for this request
      const matched = this.registry.resolve(response.request_seq, response);
      if (!matched) {
        // A response arrived with no pending request -- it timed out earlier or
        // its seq was never registered. Surface it so we can tell "response
        // never arrived" from "arrived too late".
        this.emit(
          "diagnostic",
          `orphan response: ${response.command} req_seq=${response.request_seq} (no pending request)`
        );
      }
      this.emit("response", response);
    });

    this.messageHandler.on("event", (event: DAPEvent) => {
      // Forward events to listeners (DebugSessionManager)
      this.logger.debug(
        "ConnectionManager",
        `Received event: ${event.event}`,
        event.body
      );
      this.emit("event", event);
    });
  }

  /**
   * Handle incoming DAP messages from the TCP connection
   */
  private handleIncomingMessage(message: DAPMessage): void {
    try {
      this.messageHandler.handleMessage(message);
    } catch (error) {
      this.logger.error(
        "ConnectionManager",
        "Failed to handle incoming message",
        error as Error
      );
    }
  }

  /**
   * Handler for connected event
   */
  private handleConnected(info: any): void {
    this.isConnected = true;
    this.logger.info("ConnectionManager", `Connected to ${info.host}:${info.port}`);
    this.emit("connected", info);
  }

  /**
   * Handler for disconnected event
   */
  private handleDisconnected(info?: { hadError?: boolean }): void {
    this.isConnected = false;

    // Stop keepalive to prevent false alarms
    this.keepalive?.stop();

    // Reject all pending requests with descriptive reason
    const reason = info?.hadError
      ? "server disconnected unexpectedly"
      : "server closed connection";
    this.registry.clear(reason);

    this.logger.info(
      "ConnectionManager",
      `Disconnected from server (hadError: ${info?.hadError ?? false})`
    );
    this.emit("disconnected", info);
  }

  /**
   * Handler for error event
   */
  private handleError(error: Error): void {
    this.logger.error("ConnectionManager", `Connection error: ${error.message}`, error);
    this.emit("error", error);
  }

  /**
   * Connect to the debug server
   *
   * @param config - Connection configuration (host, port, timeout, etc.)
   * @param timeouts - Optional timeout configuration
   * @param reconnect - Optional reconnection configuration
   * @returns Promise that resolves when connected
   */
  async connect(
    config: ConnectionConfig,
    timeouts?: Partial<TimeoutConfig>,
    reconnect?: Partial<ReconnectConfig>
  ): Promise<void> {
    if (this.isConnected) {
      throw new Error("Already connected");
    }

    // Store configuration for reconnection
    this.connectionConfig = config;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.reconnectConfig = { ...DEFAULT_RECONNECT, ...reconnect };

    try {
      await this.connection.connect(config);
      this.setupKeepalive();
      this.setupReconnection();
    } catch (error) {
      this.logger.error(
        "ConnectionManager",
        "Failed to connect",
        error as Error
      );
      throw error;
    }
  }

  /**
   * Setup keepalive manager for heartbeat mechanism
   */
  private setupKeepalive(): void {
    // Clean up existing keepalive if any
    this.keepalive?.stop();

    this.keepalive = new KeepaliveManager(
      async () => {
        try {
          // Use "threads" as a lightweight ping (always available)
          await this.sendRequest("threads", {}, 5000);
          return true;
        } catch {
          return false;
        }
      },
      this.timeouts.keepalive,
      5000, // 5s ping timeout
      3 // 3 missed pings before declaring dead
    );

    this.keepalive.on("pingMissed", (count: number) => {
      this.logger.warn("ConnectionManager", `Keepalive ping missed (${count}/3)`);
    });

    this.keepalive.on("connectionDead", () => {
      this.logger.error("ConnectionManager", "Connection appears dead (3 missed pings)");
      this.emit("connectionLost", "keepalive");

      // Trigger reconnection if enabled
      if (this.reconnectConfig.enabled) {
        this.reconnection?.scheduleReconnect();
      }
    });

    this.keepalive.on("pingSuccess", (latency: number) => {
      this.logger.debug("ConnectionManager", `Keepalive ping success (${latency}ms)`);
    });

    this.keepalive.start();
    this.logger.info("ConnectionManager", `Keepalive started (${this.timeouts.keepalive}ms interval)`);
  }

  /**
   * Setup reconnection manager for automatic recovery
   */
  private setupReconnection(): void {
    // Clean up existing reconnection if any
    this.reconnection?.cancel();

    this.reconnection = new ReconnectionManager(
      async () => {
        if (!this.connectionConfig) {
          this.logger.error("ConnectionManager", "No connection config for reconnection");
          return false;
        }

        try {
          this.logger.info("ConnectionManager", "Attempting to reconnect...");
          await this.connection.connect(this.connectionConfig);
          this.keepalive?.start();
          return true;
        } catch (error) {
          this.logger.warn("ConnectionManager", `Reconnection failed: ${(error as Error).message}`);
          return false;
        }
      },
      this.reconnectConfig.maxAttempts,
      this.reconnectConfig.baseDelay,
      this.reconnectConfig.maxDelay
    );

    this.reconnection.on("reconnectScheduled", ({ attempt, delay }) => {
      this.logger.info("ConnectionManager", `Reconnection attempt ${attempt} scheduled in ${delay}ms`);
      this.emit("reconnectScheduled", { attempt, delay });
    });

    this.reconnection.on("reconnectAttempt", (attempt: number) => {
      this.logger.info("ConnectionManager", `Reconnection attempt ${attempt}...`);
      this.emit("reconnectAttempt", attempt);
    });

    this.reconnection.on("reconnected", () => {
      this.logger.info("ConnectionManager", "Successfully reconnected");
      this.emit("reconnected");
    });

    this.reconnection.on("maxAttemptsReached", () => {
      this.logger.error("ConnectionManager", "Max reconnection attempts reached");
      this.emit("reconnectFailed");
    });
  }

  /**
   * Disconnect from the debug server
   */
  disconnect(): void {
    // Stop keepalive and cancel any pending reconnection
    this.keepalive?.stop();
    this.reconnection?.cancel();

    if (!this.isConnected) {
      this.logger.warn("ConnectionManager", "Not connected");
      return;
    }

    this.connection.disconnect();
  }

  /**
   * Send a DAP request and wait for the response.
   *
   * This is the main method for sending requests to the debug server.
   * It returns a promise that resolves with the response body or rejects on timeout/error.
   *
   * Timeout is automatically selected based on command type:
   * - Stepping commands (continue, next, stepIn, stepOut, pause): uses timeouts.stepping (60s default)
   * - Other commands: uses timeouts.request (30s default)
   *
   * @param command - DAP command name (e.g., 'stackTrace', 'scopes', 'variables')
   * @param args - Command arguments (optional)
   * @param timeoutMs - Request timeout in milliseconds (optional, auto-selected if not provided)
   * @returns Promise that resolves with response body
   *
   * @example
   * ```typescript
   * const stackFrames = await connectionManager.sendRequest('stackTrace', {
   *   threadId: 1,
   *   startFrame: 0,
   *   levels: 20
   * });
   * ```
   */
  async sendRequest(
    command: string,
    args?: any,
    timeoutMs?: number
  ): Promise<any> {
    if (!this.isConnected) {
      throw new Error("Not connected to debug server");
    }

    // Auto-select timeout based on command type if not specified
    // Priority: stepping commands > large response commands > default request
    let timeout: number;
    if (timeoutMs !== undefined) {
      timeout = timeoutMs;
    } else if (STEPPING_COMMANDS.includes(command as typeof STEPPING_COMMANDS[number])) {
      timeout = this.timeouts.stepping;
    } else if (LARGE_RESPONSE_COMMANDS.includes(command as typeof LARGE_RESPONSE_COMMANDS[number])) {
      // Large response commands get stepping timeout (60s) to handle slow transfers
      timeout = this.timeouts.stepping;
    } else {
      timeout = this.timeouts.request;
    }

    // Send request via TcpConnection and get sequence number
    const seq = this.connection.sendRequest(command, args);

    // Reset keepalive missed pings on successful send (connection is alive)
    this.keepalive?.resetMissedPings();

    // Register promise with RequestRegistry
    // This promise will be resolved when the response arrives
    return this.registry.register(seq, command, timeout);
  }

  /**
   * Send a raw DAP message (for special cases)
   *
   * @param message - DAP message object
   */
  send(message: string): void {
    this.connection.send(message);
  }

  /**
   * Check if connected to debug server
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Pause keepalive pings (call when debugger is stopped at a breakpoint).
   * This prevents false disconnection detection while waiting for user input.
   *
   * Only has effect when keepalive is in "running" state.
   *
   * @returns true if successfully paused, false if keepalive is not running
   */
  pauseKeepalive(): boolean {
    if (!this.keepalive) {
      this.logger.warn("ConnectionManager", "Cannot pause keepalive: not initialized");
      return false;
    }

    const currentState = this.keepalive.getState();
    if (currentState !== "running") {
      this.logger.debug(
        "ConnectionManager",
        `Cannot pause keepalive: current state is "${currentState}", expected "running"`
      );
      return false;
    }

    const success = this.keepalive.pause();
    if (success) {
      this.logger.debug("ConnectionManager", "Keepalive paused (debugger stopped)");
    }
    return success;
  }

  /**
   * Resume keepalive pings (call when debugger continues execution).
   *
   * Only has effect when keepalive is in "paused" state.
   *
   * @returns true if successfully resumed, false if keepalive is not paused
   */
  resumeKeepalive(): boolean {
    if (!this.keepalive) {
      this.logger.warn("ConnectionManager", "Cannot resume keepalive: not initialized");
      return false;
    }

    const currentState = this.keepalive.getState();
    if (currentState !== "paused") {
      this.logger.debug(
        "ConnectionManager",
        `Cannot resume keepalive: current state is "${currentState}", expected "paused"`
      );
      return false;
    }

    const success = this.keepalive.resume();
    if (success) {
      this.logger.debug("ConnectionManager", "Keepalive resumed (debugger running)");
    }
    return success;
  }

  /**
   * Get the current keepalive state.
   *
   * @returns Current keepalive state or "idle" if not initialized
   */
  getKeepaliveState(): KeepaliveState {
    return this.keepalive?.getState() ?? "idle";
  }

  /**
   * Get diagnostic information about pending requests (for debugging)
   */
  getDiagnostics(): {
    isConnected: boolean;
    pendingRequests: number;
    requests: Array<{ seq: number; command: string; elapsed: number }>;
    keepalive: { state: KeepaliveState; active: boolean; missedPings: number };
    reconnection: { active: boolean; attempts: number };
    timeouts: TimeoutConfig;
  } {
    return {
      isConnected: this.isConnected,
      pendingRequests: this.registry.getPendingCount(),
      requests: this.registry.getPendingRequests(),
      keepalive: {
        state: this.keepalive?.getState() ?? "idle",
        active: this.keepalive?.isActive() ?? false,
        missedPings: this.keepalive?.getMissedPings() ?? 0,
      },
      reconnection: {
        active: this.reconnection?.isActive() ?? false,
        attempts: this.reconnection?.getAttemptCount() ?? 0,
      },
      timeouts: this.timeouts,
    };
  }
}
