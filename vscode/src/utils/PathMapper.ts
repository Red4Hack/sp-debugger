import * as path from "path";
import { FileUtils } from "./FileUtils";
import { Logger } from "./Logger";

/**
 * PathMapper resolves debugger paths to local filesystem paths.
 *
 * Problem: Compiled .smx files contain debug symbols with the original compilation path,
 * which may differ from the current local path. When the debugger returns stack frames,
 * VS Code needs to map these paths to the actual source files.
 *
 * Solution: Use the launch config's plugin path as an anchor to map debugger paths
 * to local paths by matching relative path structures.
 *
 * Example:
 * - Launch config: /home/user/dev/myserver/addons/sourcemod/scripting/comms.sp
 * - Debugger path: /mnt/backup/myserver/addons/sourcemod/scripting/comms.sp
 * - Mapped path: /home/user/dev/myserver/addons/sourcemod/scripting/comms.sp
 */
export class PathMapper {
  private logger = Logger.getInstance();
  private localBasePath: string | null = null;
  private sourceRoot: string | null = null;
  private workspaceRoot: string | null = null;

  /**
   * Initialize path mapper with the local plugin path from launch config.
   * This establishes the anchor point for all path mappings.
   *
   * @param pluginPath - Absolute path to the .sp file being debugged (from launch config)
   * @param workspaceRoot - Optional workspace root for quality scoring (preferred path prefix)
   */
  initialize(pluginPath: string, workspaceRoot?: string): void {
    if (!pluginPath) {
      this.logger.warn("PathMapper", "No plugin path provided for initialization");
      return;
    }

    const normalized = path.normalize(pluginPath);

    // Store workspace root for quality scoring
    if (workspaceRoot) {
      this.workspaceRoot = path.normalize(workspaceRoot);
      this.logger.debug("PathMapper", `Workspace root set to: ${this.workspaceRoot}`);
    }

    // Extract the source root directory (typically .../scripting/)
    const scriptingDir = this.findScriptingDirectory(normalized);
    if (scriptingDir) {
      this.sourceRoot = scriptingDir;
      this.localBasePath = path.dirname(scriptingDir);
      this.logger.info(
        "PathMapper",
        `Initialized with local base path: ${this.localBasePath}, source root: ${this.sourceRoot}`
      );
    } else {
      // Fallback: use plugin's directory
      this.sourceRoot = path.dirname(normalized);
      this.localBasePath = this.sourceRoot;
      this.logger.warn(
        "PathMapper",
        `Could not find scripting directory, using plugin directory: ${this.sourceRoot}`
      );
    }
  }

  /**
   * Map a debugger path to a local filesystem path using quality scoring.
   *
   * Strategy:
   * 1. Try scripting/ anchor mapping FIRST
   * 2. Compare quality scores between mapped and original paths
   * 3. Return the path with highest quality score
   * 4. Fallback to filename search if both fail
   * 5. Return original path as last resort
   *
   * This prevents returning external drive paths when better local paths exist.
   *
   * @param debuggerPath - Path from debugger (may be old compilation path)
   * @returns Mapped local path, or original if mapping fails
   */
  mapPath(debuggerPath: string): string {
    if (!debuggerPath) {
      return debuggerPath;
    }

    const normalized = path.normalize(debuggerPath);

    // If not initialized, return original path
    if (!this.localBasePath || !this.sourceRoot) {
      this.logger.debug(
        "PathMapper",
        `Not initialized, returning original path: ${debuggerPath}`
      );
      return debuggerPath;
    }

    // STRATEGY 1: Try scripting/ anchor mapping FIRST
    const mappedPath = this.mapByScriptingAnchor(normalized);
    if (mappedPath && FileUtils.exists(mappedPath) && FileUtils.isFile(mappedPath)) {
      // Compare quality: mapped vs original
      const mappedQuality = this.getPathQuality(mappedPath);
      const originalQuality = this.getPathQuality(normalized);

      // Check if original also exists
      const originalExists =
        FileUtils.exists(normalized) && FileUtils.isFile(normalized);

      if (!originalExists) {
        // Original doesn't exist, use mapped
        this.logger.info(
          "PathMapper",
          `Mapped path by scripting anchor: ${debuggerPath} -> ${mappedPath}`
        );
        return mappedPath;
      }

      // Both exist - choose based on quality score
      if (mappedQuality >= originalQuality) {
        this.logger.info(
          "PathMapper",
          `Mapped path (quality ${mappedQuality} vs ${originalQuality}): ${debuggerPath} -> ${mappedPath}`
        );
        return mappedPath;
      } else {
        this.logger.info(
          "PathMapper",
          `Using original path (quality ${originalQuality} vs ${mappedQuality}): ${normalized}`
        );
        return normalized;
      }
    }

    // STRATEGY 2: Original exists (but mapped didn't)
    if (FileUtils.exists(normalized) && FileUtils.isFile(normalized)) {
      this.logger.debug("PathMapper", `Path exists locally: ${normalized}`);
      return normalized;
    }

    // STRATEGY 3: Match by filename in source tree
    const filename = path.basename(normalized);
    const filenameMapped = this.findFileByName(filename, this.sourceRoot);
    if (filenameMapped) {
      this.logger.info(
        "PathMapper",
        `Mapped path by filename search: ${debuggerPath} -> ${filenameMapped}`
      );
      return filenameMapped;
    }

    // Fallback: return original path
    this.logger.warn(
      "PathMapper",
      `Could not map path, returning original: ${debuggerPath}`
    );
    return debuggerPath;
  }

  /**
   * Map path by matching structure from scripting/ directory.
   *
   * @param debuggerPath - Path from debugger
   * @returns Mapped path or null if pattern doesn't match
   */
  private mapByScriptingAnchor(debuggerPath: string): string | null {
    // Find "scripting/" in the path
    const scriptingIndex = debuggerPath.indexOf("scripting/");
    if (scriptingIndex === -1) {
      // Try alternative separators and case variations
      const altIndex = debuggerPath.toLowerCase().indexOf("scripting");
      if (altIndex === -1) {
        return null;
      }
    }

    // Extract relative path from scripting/
    const scriptingIdx = debuggerPath.indexOf("scripting");
    if (scriptingIdx === -1) {
      return null;
    }

    const relativeFromScripting = debuggerPath.substring(scriptingIdx);

    // Combine with local base path
    if (this.localBasePath) {
      const localPath = path.join(this.localBasePath, relativeFromScripting);
      return path.normalize(localPath);
    }

    return null;
  }

  /**
   * Find file by name in the source tree.
   * Recursively searches for a file with matching basename.
   *
   * @param filename - File basename to search for
   * @param searchRoot - Root directory to search from
   * @returns Full path to file, or null if not found
   */
  private findFileByName(filename: string, searchRoot: string): string | null {
    try {
      // Check if the filename exists in search root
      const directPath = path.join(searchRoot, filename);
      if (FileUtils.exists(directPath) && FileUtils.isFile(directPath)) {
        return directPath;
      }

      // Search recursively (limit depth to avoid performance issues)
      return this.searchRecursive(filename, searchRoot, 3);
    } catch (error) {
      this.logger.error(
        "PathMapper",
        `Error searching for file ${filename}`,
        error as Error
      );
      return null;
    }
  }

  /**
   * Recursively search for a file by name.
   *
   * @param filename - File basename to find
   * @param directory - Directory to search in
   * @param maxDepth - Maximum recursion depth
   * @returns Full path to file, or null if not found
   */
  private searchRecursive(
    filename: string,
    directory: string,
    maxDepth: number
  ): string | null {
    if (maxDepth <= 0) {
      return null;
    }

    try {
      const fs = require("fs");
      const entries = fs.readdirSync(directory);

      for (const entry of entries) {
        const fullPath = path.join(directory, entry);

        try {
          const stats = fs.statSync(fullPath);

          if (stats.isFile() && entry === filename) {
            return fullPath;
          } else if (stats.isDirectory()) {
            const found = this.searchRecursive(filename, fullPath, maxDepth - 1);
            if (found) {
              return found;
            }
          }
        } catch {
          // Skip entries that can't be accessed
          continue;
        }
      }
    } catch {
      // Skip directories that can't be read
    }

    return null;
  }

  /**
   * Find the scripting directory in a path.
   * Looks for common SourceMod structure patterns.
   *
   * @param filePath - Path to analyze
   * @returns Path to scripting directory, or null if not found
   */
  private findScriptingDirectory(filePath: string): string | null {
    const parts = filePath.split(path.sep);

    // Find "scripting" in path components
    const scriptingIdx = parts.findIndex(
      (part) => part.toLowerCase() === "scripting"
    );

    if (scriptingIdx !== -1) {
      // Reconstruct path up to and including scripting/
      return parts.slice(0, scriptingIdx + 1).join(path.sep);
    }

    return null;
  }

  /**
   * Reset mapper state (useful for testing or reinitialization)
   */
  reset(): void {
    this.localBasePath = null;
    this.sourceRoot = null;
    this.logger.debug("PathMapper", "Reset path mapper state");
  }

  /**
   * Get diagnostic information about mapper state
   */
  getDiagnostics(): {
    initialized: boolean;
    localBasePath: string | null;
    sourceRoot: string | null;
  } {
    return {
      initialized: this.localBasePath !== null && this.sourceRoot !== null,
      localBasePath: this.localBasePath,
      sourceRoot: this.sourceRoot,
    };
  }

  /**
   * Calculate quality score for a file path.
   * Higher scores indicate better/more preferred paths.
   *
   * Scoring criteria:
   * - Workspace paths get +100 (highest priority)
   * - Shorter paths get bonus points
   * - External drives (/run/media/, /mnt/, /media/) get -50 penalty
   * - /home/ paths get +20 bonus
   *
   * @param filePath - Path to score
   * @returns Quality score (higher is better)
   */
  private getPathQuality(filePath: string): number {
    let score = 0;

    // Workspace paths are strongly preferred
    if (this.workspaceRoot && filePath.startsWith(this.workspaceRoot)) {
      score += 100;
    }

    // Local base path is also preferred
    if (this.localBasePath && filePath.startsWith(this.localBasePath)) {
      score += 100;
    }

    // Shorter paths are slightly preferred (avoid deeply nested)
    // Max 50 points, decreases as path gets longer
    score += Math.max(0, 50 - filePath.length / 10);

    // Penalize external drives (usually old backup locations)
    if (
      filePath.includes("/run/media/") ||
      filePath.includes("/mnt/") ||
      filePath.includes("/media/")
    ) {
      score -= 50;
    }

    // Slight bonus for /home/ paths (user's home directory)
    if (filePath.startsWith("/home/")) {
      score += 20;
    }

    return score;
  }
}
