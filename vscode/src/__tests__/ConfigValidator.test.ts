import { ConfigValidator } from "../utils/ConfigValidator";

describe("ConfigValidator", () => {
  describe("validateDebugConfiguration", () => {
    it("should validate a correct launch configuration", () => {
      const config = {
        type: "sp-debugger",
        request: "launch",
        name: "Test Debug",
        host: "localhost",
        port: 8080,
        plugin: "test.sp",
      };

      const result = ConfigValidator.validateDebugConfiguration(config);

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("should reject configuration with invalid type", () => {
      const config = {
        type: "invalid",
        request: "launch",
        name: "Test Debug",
        host: "localhost",
        port: 8080,
        plugin: "test.sp",
      };

      const result = ConfigValidator.validateDebugConfiguration(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Configuration type must be "sp-debugger"',
      );
    });

    it("should reject configuration with invalid port", () => {
      const config = {
        type: "sp-debugger",
        request: "launch",
        name: "Test Debug",
        host: "localhost",
        port: -1,
        plugin: "test.sp",
      };

      const result = ConfigValidator.validateDebugConfiguration(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Port must be between 1 and 65535");
    });
  });

  describe("createDefaultLaunchConfig", () => {
    it("should create a valid default launch configuration", () => {
      const config = ConfigValidator.createDefaultLaunchConfig();

      expect(config.type).toBe("sp-debugger");
      expect(config.request).toBe("launch");
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(8080);
    });
  });

  describe("createDefaultAttachConfig", () => {
    it("should create a valid default attach configuration", () => {
      const config = ConfigValidator.createDefaultAttachConfig();

      expect(config.type).toBe("sp-debugger");
      expect(config.request).toBe("attach");
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(8080);
    });
  });
});
