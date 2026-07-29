import { EventEmitter } from "events";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Logger } from "../utils/Logger";
import { DAPMessage } from "../connections/TcpConnection";

export interface DAPRequest extends DebugProtocol.Request {
  seq: number;
  type: "request";
  command: string;
  arguments?: any;
}

export interface DAPResponse extends DebugProtocol.Response {
  seq: number;
  type: "response";
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: any;
}

export interface DAPEvent extends DebugProtocol.Event {
  seq: number;
  type: "event";
  event: string;
  body?: any;
}

/**
 * DAPMessageHandler parses and dispatches DAP messages.
 *
 * This class is responsible for:
 * - Parsing incoming DAP messages (responses and events)
 * - Validating message structure
 * - Emitting typed events for responses and events
 *
 * NOTE: This class NO LONGER manages sequence numbers or pending requests.
 * - Sequence numbers are managed by TcpConnection
 * - Pending requests are managed by RequestRegistry
 *
 * This simplification fixes the sequence number misalignment bug.
 */
export class DAPMessageHandler extends EventEmitter {
  private logger = Logger.getInstance();

  /**
   * Handle incoming DAP message from the server.
   * Parses the message and emits appropriate events.
   */
  handleMessage(message: DAPMessage): void {
    if (!this.isValidDAPMessage(message)) {
      this.logger.error(
        "DAPProtocol",
        "Invalid DAP message structure",
        message
      );
      return;
    }

    switch (message.type) {
      case "response":
        this.handleResponse(message as DAPResponse);
        break;
      case "event":
        this.handleEvent(message as DAPEvent);
        break;
      default:
        this.logger.warn(
          "DAPProtocol",
          `Unknown message type: ${message.type}`
        );
    }
  }

  /**
   * Handle DAP response message.
   * Emits 'response' event with the response object.
   */
  private handleResponse(response: DAPResponse): void {
    this.logger.debug(
      "DAPProtocol",
      `Response: ${response.command} seq:${response.seq} request_seq:${response.request_seq} success:${response.success}`
    );

    // Emit response event - ConnectionManager will handle promise resolution
    this.emit("response", response);
  }

  /**
   * Handle DAP event message.
   * Emits typed event with the event name and body.
   */
  private handleEvent(event: DAPEvent): void {
    this.logger.debug(
      "DAPProtocol",
      `Event: ${event.event} seq:${event.seq}`,
      event.body
    );

    // Emit event - ConnectionManager will forward to DebugSessionManager
    this.emit("event", event);
  }

  /**
   * Validate DAP message structure
   */
  private isValidDAPMessage(message: any): message is DAPMessage {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    // Events are dispatched by their `event` field and may omit `seq`.
    if (message.type === "event") {
      return typeof message.event === "string";
    }
    // Requests/responses are correlated by sequence number.
    return (
      typeof message.seq === "number" &&
      (message.type === "request" || message.type === "response")
    );
  }
}
