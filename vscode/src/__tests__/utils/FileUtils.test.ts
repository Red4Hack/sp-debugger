import { FileUtils } from "../../utils/FileUtils";
import * as fs from "fs";
import * as path from "path";

describe("FileUtils", () => {
  // Spy on the fs functions FileUtils calls (it does fs.existsSync/fs.statSync
  // property lookups on the module object, so spies on that object intercept).
  beforeEach(() => {
    jest.spyOn(fs, "existsSync").mockImplementation(() => false);
    jest.spyOn(fs, "statSync").mockImplementation((() => {
      throw new Error("not mocked");
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("exists", () => {
    it("should return true when file exists", () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const result = FileUtils.exists("/path/to/file.sp");

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith("/path/to/file.sp");
    });

    it("should return false when file does not exist", () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = FileUtils.exists("/path/to/nonexistent.sp");

      expect(result).toBe(false);
      expect(fs.existsSync).toHaveBeenCalledWith("/path/to/nonexistent.sp");
    });
  });

  describe("isFile", () => {
    it("should return true when path is a file", () => {
      const mockStats = { isFile: () => true };
      (fs.statSync as jest.Mock).mockReturnValue(mockStats);

      const result = FileUtils.isFile("/path/to/file.sp");

      expect(result).toBe(true);
      expect(fs.statSync).toHaveBeenCalledWith("/path/to/file.sp");
    });

    it("should return false when path is not a file", () => {
      const mockStats = { isFile: () => false };
      (fs.statSync as jest.Mock).mockReturnValue(mockStats);

      const result = FileUtils.isFile("/path/to/directory");

      expect(result).toBe(false);
      expect(fs.statSync).toHaveBeenCalledWith("/path/to/directory");
    });

    it("should return false when statSync throws error", () => {
      (fs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error("File not found");
      });

      const result = FileUtils.isFile("/path/to/nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("isDirectory", () => {
    it("should return true when path is a directory", () => {
      const mockStats = { isDirectory: () => true };
      (fs.statSync as jest.Mock).mockReturnValue(mockStats);

      const result = FileUtils.isDirectory("/path/to/directory");

      expect(result).toBe(true);
      expect(fs.statSync).toHaveBeenCalledWith("/path/to/directory");
    });

    it("should return false when path is not a directory", () => {
      const mockStats = { isDirectory: () => false };
      (fs.statSync as jest.Mock).mockReturnValue(mockStats);

      const result = FileUtils.isDirectory("/path/to/file.sp");

      expect(result).toBe(false);
      expect(fs.statSync).toHaveBeenCalledWith("/path/to/file.sp");
    });

    it("should return false when statSync throws error", () => {
      (fs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error("Path not found");
      });

      const result = FileUtils.isDirectory("/path/to/nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("isSourcePawnFile", () => {
    it("should return true for .sp files", () => {
      expect(FileUtils.isSourcePawnFile("/path/to/plugin.sp")).toBe(true);
      expect(FileUtils.isSourcePawnFile("plugin.sp")).toBe(true);
      expect(FileUtils.isSourcePawnFile("C:\\path\\to\\plugin.sp")).toBe(true);
    });

    it("should return true for .inc files", () => {
      expect(FileUtils.isSourcePawnFile("/path/to/include.inc")).toBe(true);
      expect(FileUtils.isSourcePawnFile("include.inc")).toBe(true);
      expect(FileUtils.isSourcePawnFile("C:\\path\\to\\include.inc")).toBe(
        true,
      );
    });

    it("should return false for other file types", () => {
      expect(FileUtils.isSourcePawnFile("/path/to/file.js")).toBe(false);
      expect(FileUtils.isSourcePawnFile("/path/to/file.txt")).toBe(false);
      expect(FileUtils.isSourcePawnFile("/path/to/file")).toBe(false);
      expect(FileUtils.isSourcePawnFile("/path/to/file.SP")).toBe(true); // toLowerCase converts to .sp
    });

    it("should handle empty or invalid paths", () => {
      expect(FileUtils.isSourcePawnFile("")).toBe(false);
      expect(FileUtils.isSourcePawnFile(".")).toBe(false);
      expect(FileUtils.isSourcePawnFile(".sp")).toBe(false); // No basename, just extension
      expect(FileUtils.isSourcePawnFile(".inc")).toBe(false); // No basename, just extension
    });
  });

  describe("join", () => {
    it("should join paths correctly", () => {
      const result = FileUtils.join("/path", "to", "file.sp");
      const expected = path.join("/path", "to", "file.sp");

      expect(result).toBe(expected);
    });

    it("should handle single path", () => {
      const result = FileUtils.join("/path/to/file.sp");
      const expected = path.join("/path/to/file.sp");

      expect(result).toBe(expected);
    });

    it("should handle empty paths", () => {
      const result = FileUtils.join("", "path", "", "file.sp");
      const expected = path.join("", "path", "", "file.sp");

      expect(result).toBe(expected);
    });
  });

  describe("getBasename", () => {
    it("should return basename of file path", () => {
      const result = FileUtils.getBasename("/path/to/file.sp");

      expect(result).toBe("file.sp");
    });

    it("should return basename of directory path", () => {
      const result = FileUtils.getBasename("/path/to/directory");

      expect(result).toBe("directory");
    });

    it("should handle paths with trailing slash", () => {
      const result = FileUtils.getBasename("/path/to/directory/");

      expect(result).toBe("directory");
    });

    it("should handle root path", () => {
      const result = FileUtils.getBasename("/");

      expect(result).toBe(""); // path.basename('/') returns empty string
    });

    it("should handle relative paths", () => {
      expect(FileUtils.getBasename("file.sp")).toBe("file.sp");
      expect(FileUtils.getBasename("./file.sp")).toBe("file.sp");
      expect(FileUtils.getBasename("../file.sp")).toBe("file.sp");
    });
  });

  describe("getDirname", () => {
    it("should return directory name of file path", () => {
      const result = FileUtils.getDirname("/path/to/file.sp");

      expect(result).toBe("/path/to");
    });

    it("should return directory name of directory path", () => {
      const result = FileUtils.getDirname("/path/to/directory");

      expect(result).toBe("/path/to");
    });

    it("should handle root path", () => {
      const result = FileUtils.getDirname("/file.sp");

      expect(result).toBe("/");
    });

    it("should handle relative paths", () => {
      expect(FileUtils.getDirname("file.sp")).toBe(".");
      expect(FileUtils.getDirname("./file.sp")).toBe(".");
      expect(FileUtils.getDirname("../file.sp")).toBe("..");
    });
  });

  describe("getExtension", () => {
    it("should return file extension", () => {
      expect(FileUtils.getExtension("/path/to/file.sp")).toBe(".sp");
      expect(FileUtils.getExtension("/path/to/file.inc")).toBe(".inc");
      expect(FileUtils.getExtension("file.txt")).toBe(".txt");
    });

    it("should return empty string for files without extension", () => {
      expect(FileUtils.getExtension("/path/to/file")).toBe("");
      expect(FileUtils.getExtension("file")).toBe("");
    });

    it("should handle hidden files", () => {
      expect(FileUtils.getExtension(".gitignore")).toBe("");
      expect(FileUtils.getExtension(".vscode")).toBe("");
      expect(FileUtils.getExtension(".env.local")).toBe(".local");
    });

    it("should handle multiple dots", () => {
      expect(FileUtils.getExtension("file.test.sp")).toBe(".sp");
      expect(FileUtils.getExtension("package.json")).toBe(".json");
    });
  });
});
