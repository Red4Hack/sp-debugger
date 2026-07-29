import { PathMapper } from "../../utils/PathMapper";
import { FileUtils } from "../../utils/FileUtils";
import * as path from "path";

// PathMapper reaches the filesystem only through FileUtils.exists/isFile
// (static methods -- property lookups on the class object), so spying on the
// class intercepts every call. Default to "nothing exists".
const mockFileUtils = {
  exists: undefined as unknown as jest.Mock,
  isFile: undefined as unknown as jest.Mock,
};

describe("PathMapper", () => {
  let pathMapper: PathMapper;

  beforeEach(() => {
    pathMapper = new PathMapper();
    mockFileUtils.exists = jest
      .spyOn(FileUtils, "exists")
      .mockReturnValue(false) as unknown as jest.Mock;
    mockFileUtils.isFile = jest
      .spyOn(FileUtils, "isFile")
      .mockReturnValue(false) as unknown as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("initialization", () => {
    it("should initialize with plugin path", () => {
      const pluginPath = "/home/user/project/addons/sourcemod/scripting/plugin.sp";
      pathMapper.initialize(pluginPath);

      const diagnostics = pathMapper.getDiagnostics();
      expect(diagnostics.initialized).toBe(true);
      expect(diagnostics.sourceRoot).toContain("scripting");
    });

    it("should handle plugin path without scripting directory", () => {
      const pluginPath = "/home/user/project/plugin.sp";
      pathMapper.initialize(pluginPath);

      const diagnostics = pathMapper.getDiagnostics();
      expect(diagnostics.initialized).toBe(true);
    });

    it("should handle empty plugin path", () => {
      pathMapper.initialize("");

      const diagnostics = pathMapper.getDiagnostics();
      expect(diagnostics.initialized).toBe(false);
    });
  });

  describe("path mapping", () => {
    beforeEach(() => {
      const pluginPath = "/home/user/dev/project/addons/sourcemod/scripting/plugin.sp";
      pathMapper.initialize(pluginPath);
    });

    it("should return path as-is if it exists locally", () => {
      const localPath = "/home/user/dev/project/addons/sourcemod/scripting/plugin.sp";
      mockFileUtils.exists.mockReturnValue(true);
      mockFileUtils.isFile.mockReturnValue(true);

      const mapped = pathMapper.mapPath(localPath);

      expect(mapped).toBe(path.normalize(localPath));
      expect(mockFileUtils.exists).toHaveBeenCalledWith(path.normalize(localPath));
    });

    it("should map old compilation path to local path", () => {
      const oldPath = "/old/location/project/addons/sourcemod/scripting/plugin.sp";
      const expectedPath = "/home/user/dev/project/addons/sourcemod/scripting/plugin.sp";

      // First call: original path doesn't exist
      // Second call: mapped path exists
      mockFileUtils.exists.mockImplementation((filePath: string) => {
        return filePath.includes("/home/user/dev/");
      });
      mockFileUtils.isFile.mockReturnValue(true);

      const mapped = pathMapper.mapPath(oldPath);

      expect(mapped).toContain("scripting");
      expect(mapped).toContain("plugin.sp");
    });

    it("should handle paths with different separators", () => {
      const windowsPath = "C:\\old\\project\\addons\\sourcemod\\scripting\\plugin.sp";

      mockFileUtils.exists.mockImplementation((filePath: string) => {
        return filePath.includes("scripting") && filePath.includes("plugin.sp");
      });
      mockFileUtils.isFile.mockReturnValue(true);

      const mapped = pathMapper.mapPath(windowsPath);

      expect(mapped).toBeTruthy();
    });

    it("should return original path if mapping fails", () => {
      const unknownPath = "/completely/unknown/path/file.sp";
      mockFileUtils.exists.mockReturnValue(false);
      mockFileUtils.isFile.mockReturnValue(false);

      const mapped = pathMapper.mapPath(unknownPath);

      expect(mapped).toBe(unknownPath);
    });

    it("should handle empty path", () => {
      const mapped = pathMapper.mapPath("");
      expect(mapped).toBe("");
    });
  });

  describe("scripting anchor mapping", () => {
    it("should map paths with scripting directory correctly", () => {
      const pluginPath = "/home/user/dev/myserver/addons/sourcemod/scripting/comms.sp";
      pathMapper.initialize(pluginPath);

      const oldPath = "/mnt/backup/myserver/addons/sourcemod/scripting/comms.sp";
      const expectedPath = "/home/user/dev/myserver/addons/sourcemod/scripting/comms.sp";

      mockFileUtils.exists.mockImplementation((filePath: string) => {
        return filePath.includes("/home/user/dev/") && filePath.includes("comms.sp");
      });
      mockFileUtils.isFile.mockReturnValue(true);

      const mapped = pathMapper.mapPath(oldPath);

      expect(mapped).toContain("scripting");
      expect(mapped).toContain("comms.sp");
      expect(mapped).not.toContain("/mnt/backup/");
    });
  });

  describe("diagnostics", () => {
    it("should provide diagnostic information", () => {
      const diagnostics = pathMapper.getDiagnostics();

      expect(diagnostics).toHaveProperty("initialized");
      expect(diagnostics).toHaveProperty("localBasePath");
      expect(diagnostics).toHaveProperty("sourceRoot");
    });

    it("should show uninitialized state", () => {
      const diagnostics = pathMapper.getDiagnostics();

      expect(diagnostics.initialized).toBe(false);
      expect(diagnostics.localBasePath).toBeNull();
      expect(diagnostics.sourceRoot).toBeNull();
    });

    it("should show initialized state", () => {
      pathMapper.initialize("/home/user/project/scripting/plugin.sp");
      const diagnostics = pathMapper.getDiagnostics();

      expect(diagnostics.initialized).toBe(true);
    });
  });

  describe("reset", () => {
    it("should reset mapper state", () => {
      pathMapper.initialize("/home/user/project/scripting/plugin.sp");
      expect(pathMapper.getDiagnostics().initialized).toBe(true);

      pathMapper.reset();
      expect(pathMapper.getDiagnostics().initialized).toBe(false);
    });
  });
});
