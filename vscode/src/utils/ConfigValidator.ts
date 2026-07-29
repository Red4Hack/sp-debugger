// Use conditional import to avoid vscode dependency in debug adapter
let vscode: any = null;
try {
  vscode = require("vscode");
} catch (e) {
  // Running in debug adapter context, vscode not available
}

import { FileUtils } from "./FileUtils";

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface DebugConfig {
  type: string;
  request: string;
  name: string;
  host: string;
  port: number;
  plugin?: string;
  timeout?: number;
  autoStart?: boolean;
}

export class ConfigValidator {
  static validateDebugConfiguration(config: any): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    // Check required fields
    if (!config.type || config.type !== "sp-debugger") {
      result.errors.push('Configuration type must be "sp-debugger"');
      result.isValid = false;
    }

    if (!config.request || !["launch", "attach"].includes(config.request)) {
      result.errors.push('Request must be either "launch" or "attach"');
      result.isValid = false;
    }

    if (!config.name || typeof config.name !== "string") {
      result.errors.push("Configuration name is required and must be a string");
      result.isValid = false;
    }

    // Validate host
    if (!config.host || typeof config.host !== "string") {
      result.errors.push("Host is required and must be a string");
      result.isValid = false;
    } else if (config.host.trim().length === 0) {
      result.errors.push("Host cannot be empty");
      result.isValid = false;
    }

    // Validate port
    if (config.port === undefined || config.port === null) {
      result.errors.push("Port is required");
      result.isValid = false;
    } else if (typeof config.port !== "number") {
      result.errors.push("Port must be a number");
      result.isValid = false;
    } else if (config.port < 1 || config.port > 65535) {
      result.errors.push("Port must be between 1 and 65535");
      result.isValid = false;
    } else if (!Number.isInteger(config.port)) {
      result.errors.push("Port must be an integer");
      result.isValid = false;
    }

    // Enhanced network validation
    if (config.host && config.port && result.isValid) {
      const networkValidation = this.validateNetworkConfig(
        config.host,
        config.port,
      );
      result.errors.push(...networkValidation.errors);
      result.warnings.push(...networkValidation.warnings);

      if (!networkValidation.isValid) {
        result.isValid = false;
      }
    }

    // Validate plugin for launch requests
    if (config.request === "launch") {
      if (!config.plugin || typeof config.plugin !== "string") {
        result.errors.push("Plugin path is required for launch requests");
        result.isValid = false;
      } else {
        const pluginPath = this.resolveVariables(config.plugin);
        const validationResult = this.validatePluginFile(pluginPath);

        result.errors.push(...validationResult.errors);
        result.warnings.push(...validationResult.warnings);

        if (!validationResult.isValid) {
          result.isValid = false;
        }
      }
    }

    // Validate optional timeout
    if (config.timeout !== undefined) {
      if (typeof config.timeout !== "number") {
        result.errors.push("Timeout must be a number");
        result.isValid = false;
      } else if (config.timeout < 0) {
        result.errors.push("Timeout must be non-negative");
        result.isValid = false;
      } else if (config.timeout > 0 && config.timeout < 1000) {
        result.warnings.push("Timeout less than 1000ms may be too short");
      }
    }

    // Validate optional autoStart
    if (
      config.autoStart !== undefined &&
      typeof config.autoStart !== "boolean"
    ) {
      result.errors.push("autoStart must be a boolean");
      result.isValid = false;
    }

    return result;
  }

  static validateExtensionSettings(config: any): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    const host = config.get("host");
    if (host !== undefined && typeof host !== "string") {
      result.errors.push("sp-debugger.host must be a string");
      result.isValid = false;
    }

    const port = config.get("port");
    if (port !== undefined) {
      if (typeof port !== "number") {
        result.errors.push("sp-debugger.port must be a number");
        result.isValid = false;
      } else if (port < 1 || port > 65535) {
        result.errors.push("sp-debugger.port must be between 1 and 65535");
        result.isValid = false;
      }
    }

    const mode = config.get("mode");
    if (mode !== undefined && !["console", "tcp"].includes(mode)) {
      result.errors.push('sp-debugger.mode must be either "console" or "tcp"');
      result.isValid = false;
    }

    const timeout = config.get("timeout");
    if (timeout !== undefined) {
      if (typeof timeout !== "number") {
        result.errors.push("sp-debugger.timeout must be a number");
        result.isValid = false;
      } else if (timeout < 0) {
        result.errors.push("sp-debugger.timeout must be non-negative");
        result.isValid = false;
      }
    }

    const autoStart = config.get("autoStart");
    if (autoStart !== undefined && typeof autoStart !== "boolean") {
      result.errors.push("sp-debugger.autoStart must be a boolean");
      result.isValid = false;
    }

    return result;
  }

  private static resolveVariables(input: string): string {
    // Only resolve variables if vscode is available (extension context)
    if (!vscode) {
      return input; // Return as-is in debug adapter context
    }

    // Resolve common VS Code variables
    let resolved = input;

    try {
      // ${file} - current file
      if (vscode.window && vscode.window.activeTextEditor) {
        resolved = resolved.replace(
          /\${file}/g,
          vscode.window.activeTextEditor.document.fileName,
        );
      }

      // ${workspaceFolder} - workspace root
      if (
        vscode.workspace &&
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        resolved = resolved.replace(
          /\${workspaceFolder}/g,
          vscode.workspace.workspaceFolders[0].uri.fsPath,
        );
      }

      // ${workspaceFolderBasename} - workspace name
      if (
        vscode.workspace &&
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        const workspaceName = FileUtils.getBasename(
          vscode.workspace.workspaceFolders[0].uri.fsPath,
        );
        resolved = resolved.replace(
          /\${workspaceFolderBasename}/g,
          workspaceName,
        );
      }
    } catch (e) {
      // If any vscode operations fail, return input as-is
      return input;
    }

    return resolved;
  }

  static createDefaultLaunchConfig(activeFile?: string): DebugConfig {
    const config: DebugConfig = {
      type: "sp-debugger",
      request: "launch",
      name: "Debug SourcePawn Plugin",
      host: "localhost",
      port: 8080,
      plugin: activeFile || "${file}",
    };

    return config;
  }

  static createDefaultAttachConfig(): DebugConfig {
    return {
      type: "sp-debugger",
      request: "attach",
      name: "Attach to SourcePawn Debug Server",
      host: "localhost",
      port: 8080,
    };
  }

  private static validatePluginFile(pluginPath: string): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    try {
      // Check file extension
      if (!FileUtils.isSourcePawnFile(pluginPath)) {
        result.errors.push("Plugin must be a SourcePawn file (.sp or .inc)");
        result.isValid = false;
        return result; // Early return for invalid extension
      }

      // Check if path is absolute vs relative
      if (!FileUtils.isAbsolute(pluginPath)) {
        result.warnings.push(
          "Using relative path for plugin - ensure working directory is correct",
        );
      }

      // Check file existence
      if (!FileUtils.exists(pluginPath)) {
        result.warnings.push(`Plugin file does not exist: ${pluginPath}`);
        return result; // Can't perform further validation on non-existent file
      }

      // Check if it's actually a file (not directory)
      if (!FileUtils.isFile(pluginPath)) {
        result.errors.push(`Plugin path is not a file: ${pluginPath}`);
        result.isValid = false;
        return result;
      }

      // Enhanced file content validation
      try {
        const content = FileUtils.readFile(pluginPath);
        const contentValidation = this.validateSourcePawnContent(
          content,
          pluginPath,
        );

        result.errors.push(...contentValidation.errors);
        result.warnings.push(...contentValidation.warnings);

        if (!contentValidation.isValid) {
          result.isValid = false;
        }
      } catch (error) {
        result.errors.push(
          `Cannot read plugin file: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        result.isValid = false;
      }
    } catch (error) {
      result.errors.push(
        `Plugin validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      result.isValid = false;
    }

    return result;
  }

  private static validateSourcePawnContent(
    content: string,
    filePath: string,
  ): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    // Check if file is empty
    if (content.trim().length === 0) {
      result.errors.push("Plugin file is empty");
      result.isValid = false;
      return result;
    }

    // Check for basic SourcePawn syntax
    const hasInclude = /^\s*#include\s+[<"]/.test(content);
    const hasPlugin = /\bpublic\s+Plugin\s+myinfo\s*=/.test(content);
    const hasPublicFunction = /\bpublic\s+\w+/.test(content);

    const extension = FileUtils.getExtension(filePath);

    if (extension === ".sp") {
      // Main plugin file validation
      if (!hasPlugin) {
        result.warnings.push(
          "Plugin file does not contain standard plugin info declaration (public Plugin myinfo)",
        );
      }

      if (!hasPublicFunction) {
        result.warnings.push(
          "Plugin file does not contain any public functions",
        );
      }
    } else if (extension === ".inc") {
      // Include file validation
      if (hasPlugin) {
        result.warnings.push(
          "Include file contains plugin info declaration - this should typically be in .sp files",
        );
      }
    }

    // Check for common syntax errors
    if (content.includes("\r\n") && !content.includes("\n")) {
      result.warnings.push(
        "File uses Windows line endings - consider using Unix line endings for consistency",
      );
    }

    // Check file size
    const sizeKB = Buffer.byteLength(content, "utf8") / 1024;
    if (sizeKB > 1024) {
      // 1MB
      result.warnings.push(
        `Large plugin file (${sizeKB.toFixed(1)}KB) - may impact compilation time`,
      );
    }

    // Check for potential encoding issues
    if (content.includes("\ufffd")) {
      result.errors.push(
        "File contains invalid UTF-8 characters - check file encoding",
      );
      result.isValid = false;
    }

    return result;
  }

  static validateNetworkConfig(host: string, port: number): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    // Enhanced host validation
    const hostPatterns = {
      ipv4: /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
      ipv6: /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
      hostname: /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
      fqdn: /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    };

    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      // Local connections are usually fine
    } else if (hostPatterns.ipv4.test(host)) {
      // Valid IPv4
      if (
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        host.startsWith("172.")
      ) {
        result.warnings.push("Connecting to private network address");
      }
    } else if (hostPatterns.ipv6.test(host)) {
      // Valid IPv6
    } else if (hostPatterns.fqdn.test(host)) {
      // Valid FQDN
      result.warnings.push(
        "Using hostname - ensure DNS resolution is available",
      );
    } else {
      result.errors.push(`Invalid host format: ${host}`);
      result.isValid = false;
    }

    // Enhanced port validation
    const reservedPorts = [22, 23, 25, 53, 80, 110, 143, 443, 993, 995];
    const commonGamePorts = [27015, 27016, 27017, 27018, 27019, 27020];

    if (reservedPorts.includes(port)) {
      result.warnings.push(`Port ${port} is commonly used by other services`);
    }

    if (commonGamePorts.includes(port)) {
      result.warnings.push(
        `Port ${port} is commonly used for game servers - ensure debug server is configured correctly`,
      );
    }

    if (port < 1024) {
      result.warnings.push(
        `Port ${port} is in privileged range (< 1024) - may require elevated permissions`,
      );
    }

    return result;
  }
}
