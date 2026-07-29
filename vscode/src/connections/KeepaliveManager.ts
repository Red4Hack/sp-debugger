import { EventEmitter } from "events";

export type KeepaliveState = "idle" | "running" | "paused" | "stopped";

export interface KeepaliveEvents {
  pingMissed: (missedCount: number) => void;
  connectionDead: () => void;
  pingSuccess: (latencyMs: number) => void;
  stateChanged: (newState: KeepaliveState, oldState: KeepaliveState) => void;
}

/**
 * Manages keepalive/heartbeat mechanism to detect silent disconnections.
 *
 * State Machine:
 * - idle: Initial state, not started
 * - running: Actively sending pings
 * - paused: Temporarily paused (e.g., debugger stopped at breakpoint)
 * - stopped: Explicitly stopped, requires start() to resume
 *
 * Valid transitions:
 * - idle -> running (via start())
 * - running -> paused (via pause())
 * - running -> stopped (via stop() or connectionDead)
 * - paused -> running (via resume())
 * - paused -> stopped (via stop())
 * - stopped -> running (via start())
 */
export class KeepaliveManager extends EventEmitter {
  private intervalHandle?: NodeJS.Timeout;
  private missedPings = 0;
  private readonly maxMissedPings: number;
  private state: KeepaliveState = "idle";
  private lastPingTime = 0;

  constructor(
    private readonly sendPing: () => Promise<boolean>,
    private readonly intervalMs: number = 15000,
    private readonly timeoutMs: number = 5000,
    maxMissedPings: number = 3
  ) {
    super();
    this.maxMissedPings = maxMissedPings;
  }

  /**
   * Start the keepalive mechanism.
   * Can be called from idle or stopped state.
   *
   * @returns true if successfully started, false if already running/paused
   */
  start(): boolean {
    if (this.state === "running" || this.state === "paused") {
      return false; // Already active
    }

    this.clearInterval();
    this.missedPings = 0;
    this.setState("running");
    this.intervalHandle = setInterval(() => this.ping(), this.intervalMs);
    return true;
  }

  /**
   * Stop the keepalive mechanism.
   * Can be called from any state.
   */
  stop(): void {
    if (this.state === "stopped" || this.state === "idle") {
      return; // Already stopped
    }

    this.clearInterval();
    this.setState("stopped");
  }

  /**
   * Clear the interval timer
   */
  private clearInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /**
   * Check if keepalive is active (running or paused)
   */
  isActive(): boolean {
    return this.state === "running" || this.state === "paused";
  }

  /**
   * Check if keepalive is currently running (not paused)
   */
  isRunning(): boolean {
    return this.state === "running";
  }

  /**
   * Get current missed ping count
   */
  getMissedPings(): number {
    return this.missedPings;
  }

  /**
   * Reset missed pings counter (call when receiving any valid response)
   */
  resetMissedPings(): void {
    this.missedPings = 0;
  }

  /**
   * Pause keepalive pings (e.g., when debugger is stopped at breakpoint).
   * The timer keeps running but pings are skipped while paused.
   *
   * Only valid when state is "running". No-op otherwise.
   *
   * @returns true if successfully paused, false if not in running state
   */
  pause(): boolean {
    if (this.state !== "running") {
      return false; // Can only pause when running
    }

    // Reset missed pings when pausing to avoid false positives
    this.missedPings = 0;
    this.setState("paused");
    return true;
  }

  /**
   * Resume keepalive pings after being paused.
   *
   * Only valid when state is "paused". No-op otherwise.
   *
   * @returns true if successfully resumed, false if not in paused state
   */
  resume(): boolean {
    if (this.state !== "paused") {
      return false; // Can only resume when paused
    }

    this.missedPings = 0;
    this.setState("running");
    return true;
  }

  /**
   * Check if keepalive is currently paused
   */
  getIsPaused(): boolean {
    return this.state === "paused";
  }

  /**
   * Get the current state of the keepalive manager
   */
  getState(): KeepaliveState {
    return this.state;
  }

  /**
   * Transition to a new state with event emission
   */
  private setState(newState: KeepaliveState): void {
    if (this.state === newState) {
      return; // No change
    }

    const oldState = this.state;
    this.state = newState;
    this.emit("stateChanged", newState, oldState);
  }

  private async ping(): Promise<void> {
    // Only ping when in running state (not paused, stopped, or idle)
    if (this.state !== "running") {
      return;
    }

    this.lastPingTime = Date.now();

    try {
      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("Ping timeout")), this.timeoutMs)
      );

      const success = await Promise.race([this.sendPing(), timeoutPromise]);

      if (success) {
        const latency = Date.now() - this.lastPingTime;
        this.missedPings = 0;
        this.emit("pingSuccess", latency);
      } else {
        this.handleMissedPing();
      }
    } catch {
      this.handleMissedPing();
    }
  }

  private handleMissedPing(): void {
    this.missedPings++;
    this.emit("pingMissed", this.missedPings);

    if (this.missedPings >= this.maxMissedPings) {
      this.emit("connectionDead");
      this.clearInterval();
      this.setState("stopped");
    }
  }
}
