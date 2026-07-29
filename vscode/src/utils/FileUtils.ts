import * as fs from "fs";
import * as path from "path";

export class FileUtils {
  static exists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  static isFile(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  static isDirectory(filePath: string): boolean {
    try {
      const stats = fs.statSync(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  static readFile(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
  }

  static writeFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content, "utf8");
  }

  static ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static getExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase();
  }

  static getBasename(filePath: string, ext?: string): string {
    return path.basename(filePath, ext);
  }

  static getDirname(filePath: string): string {
    return path.dirname(filePath);
  }

  static resolve(...pathSegments: string[]): string {
    return path.resolve(...pathSegments);
  }

  static join(...pathSegments: string[]): string {
    return path.join(...pathSegments);
  }

  static isSourcePawnFile(filePath: string): boolean {
    const ext = this.getExtension(filePath);
    return ext === ".sp" || ext === ".inc";
  }

  static findSourcePawnFiles(
    directory: string,
    recursive: boolean = false,
  ): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(directory);

      for (const entry of entries) {
        const fullPath = path.join(directory, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory() && recursive) {
          files.push(...this.findSourcePawnFiles(fullPath, recursive));
        } else if (stats.isFile() && this.isSourcePawnFile(fullPath)) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore errors (permission denied, etc.)
    }

    return files;
  }

  static getRelativePath(from: string, to: string): string {
    return path.relative(from, to);
  }

  static normalizePath(filePath: string): string {
    return path.normalize(filePath);
  }

  static isAbsolute(filePath: string): boolean {
    return path.isAbsolute(filePath);
  }
}

export interface PathInfo {
  directory: string;
  name: string;
  extension: string;
  basename: string;
  absolute: string;
  relative?: string;
}

export class PathAnalyzer {
  static analyze(filePath: string, relativeTo?: string): PathInfo {
    const absolute = path.resolve(filePath);
    const directory = path.dirname(absolute);
    const extension = path.extname(absolute);
    const basename = path.basename(absolute, extension);
    const name = path.basename(absolute);

    const info: PathInfo = {
      directory,
      name,
      extension,
      basename,
      absolute,
    };

    if (relativeTo) {
      info.relative = path.relative(relativeTo, absolute);
    }

    return info;
  }
}
