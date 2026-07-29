import { EventEmitter } from "events";

export interface ReconnectionEvents {
  reconnectScheduled: (info: { attempt: number; delay: number }) => void;
  reconnectAttempt: (attempt: number) => void;
  reconnected: () => void;
  maxAttemptsReached: () => void;
  cancelled: () => void;
}

/**
 * Manages automatic reconnection with exponential backoff and jitter
 */
export class ReconnectionManager extends EventEmitter {
  private attempts = 0;
  private timeoutHandle?: NodeJS.Timeout;
  private isReconnecting = false;

  constructor(
    private readonly connect: () => Promise<boolean>,
    private readonly maxAttempts: number = 5,
    private readonly baseDelayMs: number = 1000,
    private readonly maxDelayMs: number = 30000
  ) {
    super();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  async scheduleReconnect(): Promise<void> {
    if (this.isReconnecting) {
      return; // Already reconnecting
    }

    if (this.attempts >= this.maxAttempts) {
      this.emit("maxAttemptsReached");
      this.reset();
      return;
    }

    this.isReconnecting = true;

    // Calculate delay with exponential backoff + jitter
    const exponentialDelay = this.baseDelayMs * Math.pow(2, this.attempts);
    const jitter = Math.random() * 1000; // 0-1000ms jitter
    const delay = Math.min(exponentialDelay + jitter, this.maxDelayMs);

    this.emit("reconnectScheduled", { attempt: this.attempts + 1, delay });

    this.timeoutHandle = setTimeout(async () => {
      this.attempts++;
      this.emit("reconnectAttempt", this.attempts);

      try {
        const success = await this.connect();
        if (success) {
          this.reset();
          this.emit("reconnected");
        } else {
          this.isReconnecting = false;
          await this.scheduleReconnect();
        }
      } catch {
        this.isReconnecting = false;
        await this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Reset the reconnection state
   */
  reset(): void {
    this.attempts = 0;
    this.isReconnecting = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  /**
   * Cancel any pending reconnection
   */
  cancel(): void {
    this.reset();
    this.emit("cancelled");
  }

  /**
   * Check if currently attempting to reconnect
   */
  isActive(): boolean {
    return this.isReconnecting;
  }

  /**
   * Get current attempt count
   */
  getAttemptCount(): number {
    return this.attempts;
  }
}
