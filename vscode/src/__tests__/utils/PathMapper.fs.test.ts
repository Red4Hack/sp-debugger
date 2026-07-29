// Verifies PathMapper against a REAL on-disk tree (its sibling PathMapper.test.ts
// stubs the filesystem; this one exercises the actual heuristics end-to-end).
// If these resolve correctly, clicking a frame in the VS Code Call Stack opens
// the right line of the right file.
//
// Self-contained: builds a scratch server layout (addons/sourcemod/scripting/)
// in the OS tmpdir with the repo's own test plugin as the source file.
// Converted from the former vscode/scripts/test-path-mapper.mjs.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PathMapper } from "../../utils/PathMapper";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", ".."); // vscode/src/__tests__/utils -> repo root
const TEST_PLUGIN = path.join(REPO, "sp-console-debugger", "tests", "debugger_test.sp");
const PLUGIN_NAME = "debugger_test.sp";

let root: string;
let workspace: string;
let plugin: string;

beforeAll(() => {
  // Scratch layout: <tmp>/myserver/addons/sourcemod/scripting/debugger_test.sp
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-pathmapper-"));
  workspace = path.join(root, "myserver");
  const scripting = path.join(workspace, "addons", "sourcemod", "scripting");
  fs.mkdirSync(scripting, { recursive: true });
  plugin = path.join(scripting, PLUGIN_NAME);
  // The vendored test plugin is the natural fixture, but it only exists after
  // the sp-console-debugger tree has been fetched -- fall back to a stub.
  if (fs.existsSync(TEST_PLUGIN)) {
    fs.copyFileSync(TEST_PLUGIN, plugin);
  } else {
    fs.writeFileSync(plugin, "public void OnPluginStart() {}\n");
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PathMapper against a real filesystem tree", () => {
  const samples = () => [
    PLUGIN_NAME, //                                          bare basename (compiler's view)
    `./addons/sourcemod/scripting/${PLUGIN_NAME}`, //        relative anchor
    `/usr/build/addons/sourcemod/scripting/${PLUGIN_NAME}`, // absolute compile path
    `addons/sourcemod/scripting/${PLUGIN_NAME}`, //          no leading slash, anchored
    plugin, //                                               already absolute & correct
  ];

  it("maps every server-reported path variant to the local file", () => {
    const mapper = new PathMapper();
    mapper.initialize(plugin, workspace);

    for (const debugPath of samples()) {
      const local = mapper.mapPath(debugPath);
      expect(local && fs.existsSync(local)).toBe(true);
      expect(path.basename(local!)).toBe(PLUGIN_NAME);
    }
  });
});
