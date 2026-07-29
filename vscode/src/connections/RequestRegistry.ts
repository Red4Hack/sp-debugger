import { Logger } from "../utils/Logger";
import { DAPResponse } from "../protocols/DAPProtocol";

export interface PendingRequest {
  command: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  timestamp: number;
}

/**
 * RequestRegistry manages pending DAP requests and their corresponding promises.
 *
 * This class provides a centralized way to track requests sent to the debug server
 * and resolve/reject their promises when responses arrive or timeout.
 *
 * Key Features:
 * - Promise-based request tracking
 * - Automatic timeout handling
 * - Request/response correlation via sequence numbers
 * - Cleanup on disconnect
 */
export class RequestRegistry {
  private pending: Map<number, PendingRequest> = new Map();
  private logger = Logger.getInstance();

  /**
   * Register a new pending request and return a promise that will be resolved
   * when the corresponding response arrives.
   *
   * @param seq - Sequence number of the request (from TcpConnection)
   * @param command - DAP command name (for logging and debugging)
   * @param timeoutMs - Timeout in milliseconds (REQUIRED - no default to prevent timeout mismatch)
   * @returns Promise that resolves with response body or rejects on timeout/error
   */
  register(seq: number, command: string, timeoutMs: number): Promise<any> {
    if (timeoutMs <= 0) {
      throw new Error(`Invalid timeout value: ${timeoutMs}ms`);
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pending.delete(seq);
        const error = new Error(
          `Request timeout after ${timeoutMs}ms: ${command} (seq: ${seq})`
        );
        this.logger.error(
          "RequestRegistry",
          `Request timed out: ${command} (seq: ${seq})`,
          error
        );
        reject(error);
      }, timeoutMs);

      // Store pending request
      this.pending.set(seq, {
        command,
        resolve,
        reject,
        timeout,
        timestamp: Date.now(),
      });

      this.logger.debug(
        "RequestRegistry",
        `Registered request: ${command} (seq: ${seq}, timeout: ${timeoutMs}ms)`
      );
    });
  }

  /**
   * Resolve a pending request with the given response.
   *
   * @param seq - Sequence number from response.request_seq
   * @param response - DAP response object
   */
  resolve(seq: number, response: DAPResponse): boolean {
    const pending = this.pending.get(seq);

    if (!pending) {
      this.logger.warn(
        "RequestRegistry",
        `Received response for unknown request (seq: ${seq})`
      );
      return false;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    this.pending.delete(seq);

    const elapsed = Date.now() - pending.timestamp;
    this.logger.debug(
      "RequestRegistry",
      `Resolved request: ${pending.command} (seq: ${seq}, elapsed: ${elapsed}ms)`
    );

    // Check if response indicates success
    if (response.success) {
      pending.resolve(response.body || {});
    } else {
      const error = new Error(
        response.message || `Request failed: ${pending.command}`
      );
      this.logger.error(
        "RequestRegistry",
        `Request failed: ${pending.command} (seq: ${seq})`,
        error
      );
      pending.reject(error);
    }
    return true;
  }

  /**
   * Reject a pending request with an error.
   *
   * @param seq - Sequence number of the request
   * @param error - Error to reject with
   */
  reject(seq: number, error: Error): void {
    const pending = this.pending.get(seq);

    if (!pending) {
      this.logger.warn(
        "RequestRegistry",
        `Cannot reject unknown request (seq: ${seq})`
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(seq);

    this.logger.error(
      "RequestRegistry",
      `Rejected request: ${pending.command} (seq: ${seq})`,
      error
    );

    pending.reject(error);
  }

  /**
   * Clear all pending requests and reject their promises.
   * This is typically called when the connection is lost.
   *
   * @param reason - Optional reason for clearing (e.g., "server disconnected", "timeout")
   */
  clear(reason?: string): void {
    const pendingCount = this.pending.size;

    if (pendingCount > 0) {
      const pendingCommands = this.getPendingRequests()
        .map((r) => `${r.command}(seq:${r.seq}, elapsed:${r.elapsed}ms)`)
        .join(", ");

      this.logger.warn(
        "RequestRegistry",
        `Clearing ${pendingCount} pending requests: ${pendingCommands}`
      );

      const errorMessage = reason
        ? `Connection closed: ${reason}`
        : "Connection closed";
      const error = new Error(errorMessage);

      this.pending.forEach((pending, seq) => {
        clearTimeout(pending.timeout);
        const elapsed = Date.now() - pending.timestamp;
        this.logger.debug(
          "RequestRegistry",
          `Rejecting pending request: ${pending.command} (seq: ${seq}, elapsed: ${elapsed}ms)`
        );
        pending.reject(error);
      });

      this.pending.clear();
    }
  }

  /**
   * Get the number of pending requests (for debugging/monitoring).
   */
  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * Get information about all pending requests (for debugging).
   */
  getPendingRequests(): Array<{ seq: number; command: string; elapsed: number }> {
    const now = Date.now();
    const requests: Array<{ seq: number; command: string; elapsed: number }> = [];

    this.pending.forEach((pending, seq) => {
      requests.push({
        seq,
        command: pending.command,
        elapsed: now - pending.timestamp,
      });
    });

    return requests;
  }
}
