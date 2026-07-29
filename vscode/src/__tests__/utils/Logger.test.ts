import { Logger, LogLevel } from "../../utils/Logger";

describe("Logger", () => {
  let logger: Logger;
  let consoleSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleDebugSpy: jest.SpyInstance;

  beforeEach(() => {
    // Reset singleton instance
    (Logger as any).instance = undefined;
    logger = Logger.getInstance();
    logger.enableConsoleOutput(true); // Enable console output for testing

    // Mock console methods
    consoleSpy = jest.spyOn(console, "log").mockImplementation();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    consoleDebugSpy = jest.spyOn(console, "debug").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getInstance", () => {
    it("should return singleton instance", () => {
      const instance1 = Logger.getInstance();
      const instance2 = Logger.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("setLogLevel", () => {
    it("should set log level", () => {
      logger.setLogLevel(LogLevel.WARN);

      expect((logger as any).logLevel).toBe(LogLevel.WARN);
    });
  });

  describe("debug", () => {
    it("should log debug messages when level is DEBUG", () => {
      logger.setLogLevel(LogLevel.DEBUG);

      logger.debug("Test", "Debug message");

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[DEBUG\] \[Test\] Debug message/),
      );
    });

    it("should not log debug messages when level is INFO", () => {
      logger.setLogLevel(LogLevel.INFO);

      logger.debug("Test", "Debug message");

      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });

    it("should handle data argument", () => {
      logger.setLogLevel(LogLevel.DEBUG);

      logger.debug("Test", "Debug message", { key: "value" });

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[DEBUG\] \[Test\] Debug message/),
        { key: "value" },
      );
    });
  });

  describe("info", () => {
    it("should log info messages when level is INFO or lower", () => {
      logger.setLogLevel(LogLevel.INFO);

      logger.info("Test", "Info message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[Test\] Info message/),
      );
    });

    it("should not log info messages when level is WARN", () => {
      logger.setLogLevel(LogLevel.WARN);

      logger.info("Test", "Info message");

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should log info messages when level is DEBUG", () => {
      logger.setLogLevel(LogLevel.DEBUG);

      logger.info("Test", "Info message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[Test\] Info message/),
      );
    });
  });

  describe("warn", () => {
    it("should log warn messages when level is WARN or lower", () => {
      logger.setLogLevel(LogLevel.WARN);

      logger.warn("Test", "Warning message");

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[WARN\] \[Test\] Warning message/),
      );
    });

    it("should not log warn messages when level is ERROR", () => {
      logger.setLogLevel(LogLevel.ERROR);

      logger.warn("Test", "Warning message");

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("should log warn messages when level is DEBUG", () => {
      logger.setLogLevel(LogLevel.DEBUG);

      logger.warn("Test", "Warning message");

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[WARN\] \[Test\] Warning message/),
      );
    });
  });

  describe("error", () => {
    it("should log error messages at any level", () => {
      logger.setLogLevel(LogLevel.ERROR);

      logger.error("Test", "Error message");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[ERROR\] \[Test\] Error message/),
      );
    });

    it("should log error messages when level is DEBUG", () => {
      logger.setLogLevel(LogLevel.DEBUG);

      logger.error("Test", "Error message");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[ERROR\] \[Test\] Error message/),
      );
    });

    it("should handle error objects", () => {
      logger.setLogLevel(LogLevel.ERROR);
      const error = new Error("Test error");

      logger.error("Test", "Error occurred", error);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[ERROR\] \[Test\] Error occurred/),
        error,
      );
    });
  });

  describe("log levels hierarchy", () => {
    it("should respect log level hierarchy", () => {
      // Test DEBUG level (logs everything)
      logger.setLogLevel(LogLevel.DEBUG);
      logger.debug("Test", "debug");
      logger.info("Test", "info");
      logger.warn("Test", "warn");
      logger.error("Test", "error");

      expect(consoleDebugSpy).toHaveBeenCalledTimes(1); // debug
      expect(consoleSpy).toHaveBeenCalledTimes(1); // info
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1); // warn
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // error

      // Reset mocks
      jest.clearAllMocks();

      // Test WARN level (logs warn and error only)
      logger.setLogLevel(LogLevel.WARN);
      logger.debug("Test", "debug");
      logger.info("Test", "info");
      logger.warn("Test", "warn");
      logger.error("Test", "error");

      expect(consoleDebugSpy).not.toHaveBeenCalled(); // debug not called
      expect(consoleSpy).not.toHaveBeenCalled(); // info not called
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1); // warn called
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // error called
    });
  });

  describe("edge cases", () => {
    it("should handle empty messages", () => {
      logger.setLogLevel(LogLevel.INFO);

      logger.info("Test", "");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[Test\] $/),
      );
    });

    it("should handle undefined/null messages", () => {
      logger.setLogLevel(LogLevel.INFO);

      logger.info("Test", undefined as any);
      logger.info("Test", null as any);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[Test\] undefined$/),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[Test\] null$/),
      );
    });

    it("should handle empty category", () => {
      logger.setLogLevel(LogLevel.INFO);

      logger.info("", "Message");

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[\] Message$/),
      );
    });

    it("should handle numeric log levels", () => {
      logger.setLogLevel(LogLevel.INFO); // INFO level

      logger.debug("Test", "debug"); // Should not log
      logger.info("Test", "info"); // Should log

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[INFO\] \[Test\] info$/),
      );
    });
  });
});
