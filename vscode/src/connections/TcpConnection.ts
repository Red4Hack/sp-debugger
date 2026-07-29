import * as net from "net";
import { EventEmitter } from "events";
import { Logger } from "../utils/Logger";
import { NETWORK_CONSTANTS, PROTOCOL_CONSTANTS, MESSAGES, formatMessage, } from "../constants/DebuggerConstants";

export interface ConnectionConfig {
  host: string;
  port: number;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface ConnectionState {
  isConnecting: boolean;
  isConnected: boolean;
  attemptCount: number;
  lastError?: Error;
}

export interface DAPMessage {
  seq: number;
  type: string;
  command?: string;
  event?: string;
  arguments?: any;
  body?: any;
}

export class TcpConnection extends EventEmitter {
  private socket: net.Socket | undefined;
  private connectionState: ConnectionState = {
    isConnecting: false,
    isConnected: false,
    attemptCount: 0,
    lastError: undefined,
  };
  // Raw byte buffer. DAP framing's Content-Length is a BYTE count, and message
  // bodies can contain multi-byte UTF-8 (e.g. CS chat strings with "»" =
  // U+00BB = 2 bytes / 1 char). Buffering as a JS string and slicing by
  // character count under-reads every multi-byte payload, truncating the JSON
  // and desyncing the stream. We frame on bytes and only decode to UTF-8 once a
  // full message body has been sliced out.
  private buffer: Buffer = Buffer.alloc(0);
  private messageSeq = 1;
  private connectionTimeout?: NodeJS.Timeout;
  private retryTimeout?: NodeJS.Timeout;
  private readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB max buffer
  private readonly MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB max message
  private readonly MAX_HEADER_SIZE = 1024; // 1KB max header
  private logger = Logger.getInstance();

  // The factory indirection exists for the unit tests: node builtins can't be
  // module-mocked reliably, so tests inject a factory returning a fake socket.
  // Production code never passes one.
  constructor(private socketFactory: () => net.Socket = () => new net.Socket()) {
    super();
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const retryAttempts = config.retryAttempts || 3;
    const retryDelay = config.retryDelay || 1000;
    const timeout = config.timeout || 5000;

    this.connectionState.attemptCount = 0;
    this.connectionState.lastError = undefined;

    return this.attemptConnection(config, retryAttempts, retryDelay, timeout);
  }

  private async attemptConnection(
    config: ConnectionConfig,
    maxAttempts: number,
    retryDelay: number,
    timeout: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const logger = Logger.getInstance();

      if (this.connectionState.isConnecting) {
        reject(new Error("Connection already in progress"));
        return;
      }

      this.connectionState.isConnecting = true;
      this.connectionState.attemptCount++;

      logger.info(
        "TcpConnection",
        `Attempt ${this.connectionState.attemptCount}/${maxAttempts} to connect to ${config.host}:${config.port}`,
      );

      // Clean up any existing socket
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
      }

      this.socket = this.socketFactory();

      // Set connection timeout with proper cleanup
      this.connectionTimeout = setTimeout(() => {
        this.cleanupConnection();
        const error = new Error(
          `Connection timeout after ${timeout}ms (attempt ${this.connectionState.attemptCount})`,
        );
        this.connectionState.lastError = error;

        if (this.connectionState.attemptCount < maxAttempts) {
          logger.warn(
            "TcpConnection",
            `${error.message}, retrying in ${retryDelay}ms...`,
          );
          this.retryTimeout = setTimeout(() => {
            this.connectionState.isConnecting = false;
            this.attemptConnection(config, maxAttempts, retryDelay, timeout)
              .then(resolve)
              .catch(reject);
          }, retryDelay);
        } else {
          logger.error(
            "TcpConnection",
            `${error.message}, max attempts exceeded`,
          );
          this.connectionState.isConnecting = false;
          reject(error);
        }
      }, timeout);

      this.socket.connect(config.port, config.host, () => {
        logger.info(
          "TcpConnection",
          `Successfully connected to ${config.host}:${config.port}`,
        );
        this.clearTimeouts();
        this.connectionState.isConnected = true;
        this.connectionState.isConnecting = false;
        this.connectionState.lastError = undefined;
        this.emit("connected", { host: config.host, port: config.port });
        resolve();
      });

      this.socket.on("error", (err) => {
        logger.error("TcpConnection", `Connection error: ${err.message}`);
        this.cleanupConnection();
        this.connectionState.lastError = err;

        if (this.connectionState.attemptCount < maxAttempts) {
          logger.warn(
            "TcpConnection",
            `Retrying connection in ${retryDelay}ms... (attempt ${this.connectionState.attemptCount + 1}/${maxAttempts})`,
          );
          this.retryTimeout = setTimeout(() => {
            this.connectionState.isConnecting = false;
            this.attemptConnection(config, maxAttempts, retryDelay, timeout)
              .then(resolve)
              .catch(reject);
          }, retryDelay);
        } else {
          logger.error(
            "TcpConnection",
            `Connection failed after ${maxAttempts} attempts`,
          );
          this.connectionState.isConnecting = false;
          this.emit("error", err);
          reject(err);
        }
      });

      this.socket.on("data", (data: Buffer) => {
        this.handleIncomingData(data);
      });

      this.socket.on("close", (hadError: boolean) => {
        if (this.connectionState.isConnected) {
          logger.info(
            "TcpConnection",
            `Connection closed${hadError ? " (with error)" : ""}`
          );
          this.connectionState.isConnected = false;

          // Clear buffer to prevent corruption on reconnection
          if (this.buffer.length > 0) {
            logger.warn(
              "TcpConnection",
              `Discarding ${this.buffer.length} bytes of incomplete data in buffer`
            );
            this.buffer = Buffer.alloc(0);
          }

          this.emit("disconnected", { hadError });
        }
      });

      this.socket.on("end", () => {
        if (this.connectionState.isConnected) {
          logger.info("TcpConnection", "Connection ended by server");
          this.connectionState.isConnected = false;

          // Clear buffer to prevent corruption on reconnection
          if (this.buffer.length > 0) {
            logger.warn(
              "TcpConnection",
              `Discarding ${this.buffer.length} bytes of incomplete data in buffer`
            );
            this.buffer = Buffer.alloc(0);
          }

          this.emit("disconnected", { hadError: false });
        }
      });
    });
  }

  send(message: DAPMessage | string): void {
    if (!this.socket || !this.connectionState.isConnected) {
      throw new Error("Not connected to server");
    }

    if (this.connectionState.isConnecting) {
      throw new Error("Connection in progress, cannot send message");
    }

    const json = typeof message === "string" ? message : JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    const fullMessage = header + json;

    this.socket.write(fullMessage);
    this.emit("messageSent", message);
  }

  sendRequest(command: string, args?: any): number {
    const seq = this.messageSeq++;
    const message: DAPMessage = {
      seq,
      type: "request",
      command,
      arguments: args,
    };

    this.send(message);
    return seq;
  }

  disconnect(): void {
    this.clearTimeouts();
    this.cleanupConnection();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.end();
      this.socket = undefined;
    }

    this.connectionState.isConnected = false;
    this.connectionState.isConnecting = false;

    // CRITICAL: Reset for next session to prevent buffer/sequence corruption
    this.buffer = Buffer.alloc(0);
    this.messageSeq = 1;

    this.logger.info(
      "TcpConnection",
      "Disconnected and reset state (buffer cleared, messageSeq reset to 1)"
    );
  }

  isSocketConnected(): boolean {
    return (
      this.connectionState.isConnected &&
      this.socket !== undefined &&
      !this.socket.destroyed
    );
  }

  getConnectionState(): Readonly<ConnectionState> {
    return { ...this.connectionState };
  }

  private clearTimeouts(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }
  }

  private cleanupConnection(): void {
    this.clearTimeouts();
    this.connectionState.isConnected = false;
  }

  private handleIncomingData(data: Buffer): void {
    const logger = Logger.getInstance();

    try {
      // Validate incoming data size
      if (data.length > this.MAX_MESSAGE_SIZE) {
        throw new Error(
          `Incoming data chunk too large: ${data.length} bytes (max: ${this.MAX_MESSAGE_SIZE})`,
        );
      }

      // Check buffer size before appending
      if (this.buffer.length + data.length > this.MAX_BUFFER_SIZE) {
        logger.error(
          "TcpConnection",
          `Buffer overflow prevented: current=${this.buffer.length}, incoming=${data.length}, max=${this.MAX_BUFFER_SIZE}`,
        );
        this.buffer = Buffer.alloc(0); // Reset buffer to prevent memory exhaustion
        this.emit(
          "error",
          new Error("Buffer overflow - connection may be under attack"),
        );
        return;
      }

      logger.debug(
        "TcpConnection",
        `Received data chunk (${data.length} bytes)`,
      );
      this.buffer = Buffer.concat([this.buffer, data]);
      logger.debug(
        "TcpConnection",
        `Buffer size after append: ${this.buffer.length} bytes`,
      );

      this.processBufferedMessages();
    } catch (error) {
      logger.error("TcpConnection", `Error handling incoming data: ${error}`);
      this.emit("error", error);
    }
  }

  private processBufferedMessages(): void {
    const logger = Logger.getInstance();
    let processedMessages = 0;
    const MAX_MESSAGES_PER_CYCLE = 10; // Prevent infinite loop attacks

    while (processedMessages < MAX_MESSAGES_PER_CYCLE) {
      const result = this.extractNextMessage();
      if (!result) {
        break; // No complete message available
      }

      const { message, remainingBuffer } = result;
      this.buffer = remainingBuffer;

      try {
        this.processMessage(message);
        processedMessages++;
      } catch (error) {
        logger.error("TcpConnection", `Error processing message: ${error}`);
        this.emit("parseError", { error, content: message });
        this.emit(
          "diagnostic",
          `parse error: ${error instanceof Error ? error.message : String(error)} ` +
            `(message ${message.length} chars: ${message.substring(0, 80)})`,
        );
        // The framing offset may now be misaligned. Re-sync to the next header
        // so one bad message doesn't make every subsequent response unparseable.
        this.resyncBuffer();
      }
    }

    if (processedMessages >= MAX_MESSAGES_PER_CYCLE) {
      logger.warn(
        "TcpConnection",
        `Rate limiting: processed ${MAX_MESSAGES_PER_CYCLE} messages, deferring remaining`,
      );
      // Defer remaining processing to prevent DoS
      setImmediate(() => this.processBufferedMessages());
    }
  }

  /**
   * Recover from a corrupted/misaligned byte buffer by discarding everything up
   * to the next "Content-Length:" header. With byte-accurate framing this
   * should essentially never fire, but it's kept as a safety net so a single
   * malformed frame can't wedge the whole session.
   */
  private resyncBuffer(): void {
    const logger = Logger.getInstance();
    const needle = Buffer.from("Content-Length:");
    const idx = this.buffer.indexOf(needle);
    if (idx > 0) {
      logger.warn("TcpConnection", `Re-syncing buffer: discarding ${idx} bytes`);
      this.emit("diagnostic", `buffer re-sync: discarded ${idx} bytes of garbage`);
      this.buffer = this.buffer.subarray(idx);
    } else if (idx === -1 && this.buffer.length > 0) {
      logger.warn(
        "TcpConnection",
        `Re-syncing buffer: no header found, dropping ${this.buffer.length} bytes`,
      );
      this.emit(
        "diagnostic",
        `buffer re-sync: no header in ${this.buffer.length} bytes, dropped`,
      );
      this.buffer = Buffer.alloc(0);
    }
  }

  private extractNextMessage(): {
    message: string;
    remainingBuffer: Buffer;
  } | null {
    const logger = Logger.getInstance();

    // Find header end (byte offset). The header is ASCII so latin1 decoding for
    // the Content-Length match is byte-exact.
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      logger.debug(
        "TcpConnection",
        `No complete header found, waiting for more data`,
      );
      return null;
    }

    // Validate header size
    if (headerEnd > this.MAX_HEADER_SIZE) {
      logger.error(
        "TcpConnection",
        `Header too large: ${headerEnd} bytes (max: ${this.MAX_HEADER_SIZE})`,
      );
      throw new Error(`Invalid header size: ${headerEnd} bytes`);
    }

    const header = this.buffer.toString("latin1", 0, headerEnd);
    const contentLengthMatch = header.match(/^Content-Length: (\d+)$/m);

    if (!contentLengthMatch) {
      logger.warn(
        "TcpConnection",
        `No valid Content-Length header found, skipping invalid message`,
      );
      this.emit(
        "diagnostic",
        `header without Content-Length, skipping ${headerEnd + 4} bytes`,
      );
      // Skip this malformed message
      return {
        message: "",
        remainingBuffer: this.buffer.subarray(headerEnd + 4),
      };
    }

    const contentLength = parseInt(contentLengthMatch[1], 10);

    // Validate content length
    if (isNaN(contentLength) || contentLength < 0) {
      throw new Error(`Invalid Content-Length: ${contentLengthMatch[1]}`);
    }

    if (contentLength > this.MAX_MESSAGE_SIZE) {
      throw new Error(
        `Message too large: ${contentLength} bytes (max: ${this.MAX_MESSAGE_SIZE})`,
      );
    }

    const messageStart = headerEnd + 4;

    logger.debug(
      "TcpConnection",
      `Expected content length: ${contentLength}, available: ${this.buffer.length - messageStart}`,
    );

    // Check if we have the complete message (compare BYTE counts).
    if (this.buffer.length < messageStart + contentLength) {
      logger.debug(
        "TcpConnection",
        `Incomplete message, waiting for more data`,
      );
      return null;
    }

    // Slice exactly contentLength BYTES, then decode that slice as UTF-8.
    const messageContent = this.buffer.toString(
      "utf8",
      messageStart,
      messageStart + contentLength,
    );
    const remainingBuffer = this.buffer.subarray(messageStart + contentLength);

    logger.debug(
      "TcpConnection",
      `Extracted complete message (${contentLength} bytes)`,
    );

    return { message: messageContent, remainingBuffer };
  }

  private processMessage(messageContent: string): void {
    const logger = Logger.getInstance();

    if (!messageContent.trim()) {
      logger.debug("TcpConnection", "Skipping empty message");
      return;
    }

    try {
      const message = JSON.parse(messageContent);

      // Basic message structure validation
      if (!this.isValidDAPMessage(message)) {
        throw new Error("Invalid DAP message structure");
      }

      logger.debug(
        "TcpConnection",
        `Successfully parsed ${message.type} seq:${message.seq} ${message.command || message.event || ""}`,
      );

      // Enhanced diagnostic logging for debug-related messages
      if (
        message.type === "response" &&
        message.command &&
        ["stackTrace", "scopes", "variables"].includes(message.command)
      ) {
        logger.debug(
          "TcpConnection",
          `Debug response received:`,
          JSON.stringify(message, null, 2),
        );
        logger.debug(
          "TcpConnection",
          `Response success: ${(message as any).success}, has body: ${!!message.body}`,
        );

        if (message.body) {
          if (message.command === "stackTrace" && message.body.stackFrames) {
            logger.debug(
              "TcpConnection",
              `StackTrace has ${message.body.stackFrames.length} frames`,
            );
          }
          if (message.command === "scopes" && message.body.scopes) {
            logger.debug(
              "TcpConnection",
              `Scopes has ${message.body.scopes.length} scopes`,
            );
          }
          if (message.command === "variables" && message.body.variables) {
            logger.debug(
              "TcpConnection",
              `Variables has ${message.body.variables.length} variables`,
            );
          }
        }
      }

      // Special logging for stopped events
      if (message.type === "event" && message.event === "stopped") {
        logger.debug(
          "TcpConnection",
          `STOPPED EVENT received:`,
          JSON.stringify(message.body, null, 2),
        );
      }

      this.emit("messageReceived", message);
      logger.debug("TcpConnection", `Message emitted to handlers`);
    } catch (error) {
      logger.error("TcpConnection", `Parse error: ${error}`);
      logger.error(
        "TcpConnection",
        `Raw content (${Math.min(messageContent.length, 1000)} chars):`,
        messageContent.substring(0, 1000),
      );
      throw error; // Re-throw to be handled by caller
    }
  }

  private isValidDAPMessage(obj: any): obj is DAPMessage {
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
      return false;
    }
    if (!["request", "response", "event"].includes(obj.type)) {
      return false;
    }
    // Events are routed by their `event` field and the server legitimately
    // emits them without a `seq` (output, stopped, continued, terminated). Do
    // NOT require seq for events -- requiring it rejected the "Successfully
    // started debugging" output event and would reject every stopped event,
    // desyncing the stream on the first breakpoint.
    if (obj.type === "event") {
      return typeof obj.event === "string";
    }
    // Requests and responses must carry a positive sequence number.
    return (
      typeof obj.seq === "number" &&
      obj.seq > 0 &&
      obj.seq <= Number.MAX_SAFE_INTEGER
    );
  }
}
