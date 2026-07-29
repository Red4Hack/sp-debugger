export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  component: string;
  message: string;
  data?: any;
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private logEntries: LogEntry[] = [];
  private maxEntries: number = 1000;
  private enableConsole: boolean = true;
  private isProduction: boolean = false;
  private rateLimitMap: Map<string, { count: number; lastReset: number }> =
    new Map();
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly RATE_LIMIT_MAX = 100; // Max 100 logs per component per minute

  private constructor() {
    // Detect production environment
    this.isProduction =
      process.env.NODE_ENV === "production" ||
      process.env.VSCODE_DEBUG !== "true";

    // Adjust log level for production
    if (this.isProduction) {
      this.logLevel = LogLevel.WARN;
      this.enableConsole = false;
    }
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  enableConsoleOutput(enabled: boolean): void {
    this.enableConsole = enabled;
  }

  setMaxEntries(max: number): void {
    this.maxEntries = max;
    this.trimEntries();
  }

  error(component: string, message: string, data?: any): void {
    this.log(LogLevel.ERROR, component, message, data);
  }

  warn(component: string, message: string, data?: any): void {
    this.log(LogLevel.WARN, component, message, data);
  }

  info(component: string, message: string, data?: any): void {
    this.log(LogLevel.INFO, component, message, data);
  }

  debug(component: string, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, component, message, data);
  }

  trace(component: string, message: string, data?: any): void {
    this.log(LogLevel.TRACE, component, message, data);
  }

  private log(
    level: LogLevel,
    component: string,
    message: string,
    data?: any,
  ): void {
    if (level > this.logLevel) {
      return;
    }

    // Apply rate limiting in production
    if (this.isProduction && !this.checkRateLimit(component, level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      component,
      message,
      data,
    };

    this.logEntries.push(entry);
    this.trimEntries();

    if (this.enableConsole && this.shouldLogToConsole(level)) {
      this.writeToConsole(entry);
    }
  }

  private checkRateLimit(component: string, level: LogLevel): boolean {
    // Don't rate limit ERROR and WARN levels
    if (level <= LogLevel.WARN) {
      return true;
    }

    const now = Date.now();
    const key = `${component}:${LogLevel[level]}`;
    const limit = this.rateLimitMap.get(key);

    if (!limit) {
      this.rateLimitMap.set(key, { count: 1, lastReset: now });
      return true;
    }

    // Reset counter if window has passed
    if (now - limit.lastReset > this.RATE_LIMIT_WINDOW) {
      limit.count = 1;
      limit.lastReset = now;
      return true;
    }

    // Check if under limit
    if (limit.count < this.RATE_LIMIT_MAX) {
      limit.count++;
      return true;
    }

    // Rate limited
    return false;
  }

  private shouldLogToConsole(level: LogLevel): boolean {
    // In production, only log ERROR and WARN to console
    if (this.isProduction) {
      return level <= LogLevel.WARN;
    }

    return true;
  }

  private writeToConsole(entry: LogEntry): void {
    const timestamp = this.isProduction
      ? entry.timestamp.toTimeString().split(" ")[0] // HH:MM:SS in production
      : entry.timestamp.toISOString(); // Full timestamp in development

    const levelName = LogLevel[entry.level];
    const prefix = this.isProduction
      ? `[${levelName}] [${entry.component}]` // Shorter prefix in production
      : `[${timestamp}] [${levelName}] [${entry.component}]`; // Full prefix in development

    const consoleMethod = this.getConsoleMethod(entry.level);

    if (entry.data && !this.isProduction) {
      // Only log data objects in development
      consoleMethod(`${prefix} ${entry.message}`, entry.data);
    } else {
      consoleMethod(`${prefix} ${entry.message}`);
    }
  }

  private getConsoleMethod(level: LogLevel): (...args: any[]) => void {
    switch (level) {
      case LogLevel.ERROR:
        return console.error;
      case LogLevel.WARN:
        return console.warn;
      case LogLevel.DEBUG:
      case LogLevel.TRACE:
        return console.debug;
      default:
        return console.log;
    }
  }

  private trimEntries(): void {
    if (this.logEntries.length > this.maxEntries) {
      this.logEntries = this.logEntries.slice(-this.maxEntries);
    }
  }

  getEntries(component?: string, level?: LogLevel): LogEntry[] {
    return this.logEntries.filter((entry) => {
      if (component && entry.component !== component) {
        return false;
      }
      if (level !== undefined && entry.level !== level) {
        return false;
      }
      return true;
    });
  }

  clear(): void {
    this.logEntries = [];
    this.rateLimitMap.clear();
  }

  setProductionMode(enabled: boolean): void {
    this.isProduction = enabled;

    if (enabled) {
      this.logLevel = LogLevel.WARN;
      this.enableConsole = false;
    } else {
      this.logLevel = LogLevel.DEBUG;
      this.enableConsole = true;
    }
  }

  getRateLimitStats(): {
    component: string;
    level: string;
    count: number;
    window: number;
  }[] {
    const stats: {
      component: string;
      level: string;
      count: number;
      window: number;
    }[] = [];
    const now = Date.now();

    for (const [key, limit] of this.rateLimitMap) {
      const [component, level] = key.split(":");
      stats.push({
        component,
        level,
        count: limit.count,
        window: now - limit.lastReset,
      });
    }

    return stats;
  }
}
