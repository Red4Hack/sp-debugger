/**
 * Centralized constants for the SourcePawn Debugger
 */

export const NETWORK_CONSTANTS = {
  DEFAULT_HOST: "localhost",
  DEFAULT_PORT: 8080,
  DEFAULT_TIMEOUT: 5000,
  DEFAULT_RETRY_ATTEMPTS: 3,
  DEFAULT_RETRY_DELAY: 1000,
  MAX_RETRY_ATTEMPTS: 10,
  MIN_TIMEOUT: 1000,
  MAX_TIMEOUT: 60000,
} as const;

export const PROTOCOL_CONSTANTS = {
  THREAD_ID: 1,
  HEADER_SEPARATOR: "\r\n\r\n",
  CONTENT_LENGTH_PATTERN: /^Content-Length: (\d+)$/m,
  MAX_BUFFER_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_MESSAGE_SIZE: 5 * 1024 * 1024, // 5MB
  MAX_HEADER_SIZE: 1024, // 1KB
  MAX_MESSAGES_PER_CYCLE: 10,
} as const;

export const DEBUG_CONSTANTS = {
  DEFAULT_THREAD_ID: 1,
  STATE_TIMEOUT: 30000, // 30 seconds
  MONITOR_INTERVAL: 10000, // 10 seconds
  THROTTLE_DELAY: 200, // 200ms
  SCOPES_THROTTLE: 100, // 100ms
  VARIABLES_THROTTLE: 100, // 100ms
} as const;

export const LOGGING_CONSTANTS = {
  DEFAULT_MAX_ENTRIES: 1000,
  RATE_LIMIT_WINDOW: 60000, // 1 minute
  RATE_LIMIT_MAX: 100, // Max logs per component per minute
  PRODUCTION_LOG_LEVEL: "WARN",
  DEVELOPMENT_LOG_LEVEL: "DEBUG",
} as const;

export const FILE_CONSTANTS = {
  SOURCEPAWN_EXTENSIONS: [".sp", ".inc"],
  MAX_FILE_SIZE: 1024 * 1024, // 1MB
  SUPPORTED_ENCODINGS: ["utf8", "utf-8"],
} as const;

export const ERROR_CODES = {
  INITIALIZE_FAILED: 2000,
  LAUNCH_FAILED: 2001,
  ATTACH_FAILED: 2002,
  BREAKPOINTS_FAILED: 2003,
  THREADS_FAILED: 2004,
  STACK_TRACE_FAILED: 2005,
  SCOPES_FAILED: 2006,
  VARIABLES_FAILED: 2007,
  CONTINUE_FAILED: 2008,
  NEXT_FAILED: 2009,
  STEP_IN_FAILED: 2010,
  STEP_OUT_FAILED: 2011,
  PAUSE_FAILED: 2012,
  EVALUATE_FAILED: 2013,
  SET_VARIABLE_FAILED: 2014,
  DISCONNECT_FAILED: 2015,
  TERMINATE_FAILED: 2016,
} as const;

export const PATHS = {
  DEBUG_ADAPTER: "debugAdapter.js",
  LOG_FILE: "sp-debugger.txt",
} as const;

export const EXTENSION_CONSTANTS = {
  NAME: "sp-debugger",
  DISPLAY_NAME: "SourcePawn Debugger",
  COMMAND_DEBUG_ACTIVE_FILE: "sp-debugger.debugActiveFile",
  CONFIGURATION_PROVIDER: "sp-debugger",
  DEBUGGER_TYPE: "sp-debugger",
} as const;

/**
 * Validation patterns and limits
 */
export const VALIDATION = {
  HOST_PATTERNS: {
    IPV4: /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    IPV6: /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
    HOSTNAME: /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    FQDN: /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  },
  PORT_RANGES: {
    MIN: 1,
    MAX: 65535,
    PRIVILEGED_MAX: 1024,
    RESERVED_PORTS: [22, 23, 25, 53, 80, 110, 143, 443, 993, 995],
    COMMON_GAME_PORTS: [27015, 27016, 27017, 27018, 27019, 27020],
  },
  FILE_SIZE: {
    WARNING_THRESHOLD: 1024 * 1024, // 1MB
    MAX_SIZE: 10 * 1024 * 1024, // 10MB
  },
} as const;

/**
 * Messages and templates
 */
export const MESSAGES = {
  ERRORS: {
    CONNECTION_TIMEOUT: "Connection timeout after {timeout}ms",
    INVALID_CONFIGURATION: "Invalid configuration: {errors}",
    PLUGIN_FILE_NOT_FOUND: "Plugin file does not exist: {path}",
    BUFFER_OVERFLOW: "Buffer overflow - connection may be under attack",
    INVALID_MESSAGE_SIZE: "Message too large: {size} bytes (max: {max})",
    PARSE_ERROR: "Failed to parse message: {error}",
    NETWORK_ERROR: "Network error: {error}",
    DEBUGGER_STATE_ERROR: "Debugger state error: {state}",
  },
  WARNINGS: {
    LARGE_FILE: "Large plugin file ({size}KB) - may impact compilation time",
    RELATIVE_PATH:
      "Using relative path for plugin - ensure working directory is correct",
    PRIVATE_NETWORK: "Connecting to private network address",
    RESERVED_PORT: "Port {port} is commonly used by other services",
    PRIVILEGED_PORT:
      "Port {port} is in privileged range (< 1024) - may require elevated permissions",
  },
  INFO: {
    CONNECTION_ESTABLISHED: "Connected to SourcePawn debugger at {host}:{port}",
    DEBUGGER_STARTED: "SourcePawn Debug Adapter started",
    PLUGIN_LOADED: "Starting debugging for plugin: {plugin}",
    BREAKPOINT_SET: "Setting {count} breakpoint(s) in {source}",
    DEBUG_STOPPED: "Debugger stopped: {reason}",
    DEBUG_CONTINUED: "Execution resumed",
  },
} as const;

/**
 * Environment detection
 */
export const ENVIRONMENT = {
  PRODUCTION_INDICATORS: ["NODE_ENV=production", "VSCODE_DEBUG!=true"],
  BUN_EXECUTABLE_NAMES: ["bun", "bun.exe"],
  BUN_COMMON_PATHS: [
    "/usr/local/bin/bun",
    "/usr/bin/bun",
    "/opt/homebrew/bin/bun",
  ],
} as const;

/**
 * Type guards for constants
 */
export function isValidErrorCode(code: number): boolean {
  return Object.values(ERROR_CODES).includes(code as any);
}

export function isValidSourcePawnExtension(ext: string): boolean {
  return FILE_CONSTANTS.SOURCEPAWN_EXTENSIONS.includes(
    ext.toLowerCase() as any,
  );
}

export function isReservedPort(port: number): boolean {
  return VALIDATION.PORT_RANGES.RESERVED_PORTS.includes(port as any);
}

export function isCommonGamePort(port: number): boolean {
  return VALIDATION.PORT_RANGES.COMMON_GAME_PORTS.includes(port as any);
}

/**
 * Message formatting utilities
 */
export function formatMessage(
  template: string,
  params: Record<string, any>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key]?.toString() || match;
  });
}
