import { beforeEach, describe, expect, it, jest } from "bun:test";
import { TcpConnection } from "../../connections/TcpConnection";
import { EventEmitter } from "events";

describe("TcpConnection", () => {
  let tcpConnection: TcpConnection;
  let mockSocket: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a mock socket that extends EventEmitter. Like the real API,
    // connect(port, host, cb) reports success by invoking the callback.
    mockSocket = Object.assign(new EventEmitter(), {
      connect: jest.fn((_port: number, _host: string, cb?: () => void) => {
        if (cb) setTimeout(cb, 5);
      }),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
      setEncoding: jest.fn(),
      readyState: "closed",
    }) as any;

    // TcpConnection takes a socket factory precisely for this: node builtins
    // can't be module-mocked reliably, injection sidesteps it entirely.
    tcpConnection = new TcpConnection(() => mockSocket);
  });

  describe("constructor", () => {
    it("should create TcpConnection", () => {
      expect(tcpConnection).toBeDefined();
    });
  });

  describe("connect", () => {
    it("should connect successfully", async () => {
      const config = { host: "localhost", port: 8080 };
      const connectPromise = tcpConnection.connect(config);

      // Simulate successful connection
      setTimeout(() => mockSocket.emit("connect"), 10);

      await expect(connectPromise).resolves.toBeUndefined();
      expect(mockSocket.connect).toHaveBeenCalledWith(
        8080,
        "localhost",
        expect.any(Function),
      );
    });

    it("should reject on connection error", async () => {
      // Single attempt (no retry) and a connect() that never reports success,
      // so the emitted error is what settles the promise.
      mockSocket.connect.mockImplementation(() => {});
      // TcpConnection also re-emits "error" on itself; without a listener an
      // EventEmitter error event is fatal to the process.
      tcpConnection.on("error", () => {});
      const config = { host: "localhost", port: 8080, retryAttempts: 1 };
      const connectPromise = tcpConnection.connect(config);

      // Simulate connection error
      const error = new Error("Connection failed");
      setTimeout(() => mockSocket.emit("error", error), 10);

      await expect(connectPromise).rejects.toThrow("Connection failed");
    });

    it("should setup socket event handlers", async () => {
      const config = { host: "localhost", port: 8080 };
      const connectPromise = tcpConnection.connect(config);

      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;

      // Verify that event listeners are set up
      expect(mockSocket.listenerCount("data")).toBeGreaterThan(0);
      expect(mockSocket.listenerCount("error")).toBeGreaterThan(0);
      expect(mockSocket.listenerCount("close")).toBeGreaterThan(0);
    });
  });

  describe("send", () => {
    beforeEach(async () => {
      // Connect first
      const config = { host: "localhost", port: 8080 };
      const connectPromise = tcpConnection.connect(config);
      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;
    });

    it("should send data when connected", () => {
      const data = { seq: 1, type: "request", command: "test" };

      tcpConnection.send(data);

      const expectedHeader = `Content-Length: ${Buffer.byteLength(JSON.stringify(data), "utf8")}\r\n\r\n`;
      const expectedMessage = expectedHeader + JSON.stringify(data);
      expect(mockSocket.write).toHaveBeenCalledWith(expectedMessage);
    });

    it("should throw error when not connected", () => {
      // Create new connection that hasn't connected
      const disconnectedConnection = new TcpConnection();

      const data = { seq: 1, type: "request", command: "test" };

      expect(() => disconnectedConnection.send(data)).toThrow(
        "Not connected to server",
      );
    });
  });

  describe("disconnect", () => {
    it("should end socket connection", async () => {
      // The socket only exists after a connect.
      const connectPromise = tcpConnection.connect({ host: "localhost", port: 8080 });
      await connectPromise;

      tcpConnection.disconnect();

      expect(mockSocket.end).toHaveBeenCalled();
    });
  });

  describe("isSocketConnected", () => {
    it("should return false when not connected", () => {
      expect(tcpConnection.isSocketConnected()).toBe(false);
    });

    it("should return true when connected", async () => {
      const config = { host: "localhost", port: 8080 };
      const connectPromise = tcpConnection.connect(config);
      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;

      expect(tcpConnection.isSocketConnected()).toBe(true);
    });

    it("should return false after disconnect", async () => {
      // Connect first
      const config = { host: "localhost", port: 8080 };
      const connectPromise = tcpConnection.connect(config);
      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;

      expect(tcpConnection.isSocketConnected()).toBe(true);

      // Disconnect
      tcpConnection.disconnect();

      expect(tcpConnection.isSocketConnected()).toBe(false);
    });
  });

  describe("data handling", () => {
    let onMessageSpy: jest.Mock;

    beforeEach(() => {
      onMessageSpy = jest.fn();
      tcpConnection.on("messageReceived", onMessageSpy);
    });

    it("should emit messageReceived events for complete DAP messages", async () => {
      // First connect
      const config = { host: "localhost", port: 8080, timeout: 100 };
      const connectPromise = tcpConnection.connect(config);
      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;

      const testData = { seq: 1, type: "response", command: "test" };
      const jsonData = JSON.stringify(testData);
      const message = `Content-Length: ${Buffer.byteLength(jsonData, "utf8")}\r\n\r\n${jsonData}`;

      mockSocket.emit("data", Buffer.from(message));

      expect(onMessageSpy).toHaveBeenCalledWith(testData);
    });

    it("should handle partial messages across multiple data chunks", async () => {
      // First connect
      const config = { host: "localhost", port: 8080, timeout: 100 };
      const connectPromise = tcpConnection.connect(config);
      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;

      const testData = { seq: 1, type: "response", command: "test" };
      const jsonData = JSON.stringify(testData);
      const message = `Content-Length: ${Buffer.byteLength(jsonData, "utf8")}\r\n\r\n${jsonData}`;
      const part1 = message.substring(0, 20);
      const part2 = message.substring(20);

      // Send first part
      mockSocket.emit("data", Buffer.from(part1));
      expect(onMessageSpy).not.toHaveBeenCalled();

      // Send second part
      mockSocket.emit("data", Buffer.from(part2));
      expect(onMessageSpy).toHaveBeenCalledWith(testData);
    });

    it("should handle invalid JSON gracefully", async () => {
      // First connect
      const config = { host: "localhost", port: 8080, timeout: 100 };
      const connectPromise = tcpConnection.connect(config);
      setTimeout(() => mockSocket.emit("connect"), 10);
      await connectPromise;

      const invalidJson = "{ invalid json }";
      const message = `Content-Length: ${Buffer.byteLength(invalidJson, "utf8")}\r\n\r\n${invalidJson}`;

      const onParseErrorSpy = jest.fn();
      tcpConnection.on("parseError", onParseErrorSpy);

      mockSocket.emit("data", Buffer.from(message));

      expect(onMessageSpy).not.toHaveBeenCalled();
      expect(onParseErrorSpy).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should emit error events when attempts are exhausted", async () => {
      // A socket error mid-retry-loop is retried silently; the connection
      // only emits "error" once the configured attempts are exhausted.
      mockSocket.connect.mockImplementation(() => {});
      const onErrorSpy = jest.fn();
      tcpConnection.on("error", onErrorSpy);

      const connectPromise = tcpConnection.connect({
        host: "localhost",
        port: 8080,
        retryAttempts: 1,
      });

      const error = new Error("Test error");
      setTimeout(() => mockSocket.emit("error", error), 10);

      await expect(connectPromise).rejects.toThrow("Test error");
      expect(onErrorSpy).toHaveBeenCalledWith(error);
    });
  });

  describe("close handling", () => {
    it("should emit disconnected events", async () => {
      // Socket event handlers are only attached during connect.
      await tcpConnection.connect({ host: "localhost", port: 8080 });

      const onDisconnectSpy = jest.fn();
      tcpConnection.on("disconnected", onDisconnectSpy);

      mockSocket.emit("close");

      expect(onDisconnectSpy).toHaveBeenCalled();
    });
  });
});
