// Test preload (see bunfig.toml). Runs before any test file is imported.
import { mock } from "bun:test";
import * as vscodeMock from "./__mocks__/vscode";

// The "vscode" module only exists inside VS Code's extension host, so any
// import of it (extension.ts, ProfilerTreeProvider, ...) must resolve to the
// mock. Registering it here -- before test files load -- is the only ordering
// that works: module mocks are not hoisted like jest.mock was.
mock.module("vscode", () => vscodeMock);

// The Logger detects "production" from the environment and then suppresses
// INFO/DEBUG console output and drops the timestamp prefix -- which is not
// what the Logger tests assert. Force development mode for the test run.
process.env.VSCODE_DEBUG = "true";
