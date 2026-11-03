import * as vscode from "vscode";
import { ProviderResult } from "vscode";
import { ConfigValidator } from "./utils/ConfigValidator";
import { Logger } from "./utils/Logger";
import { FileUtils } from "./utils/FileUtils";
import { ProfilerTreeProvider } from "./profiler/ProfilerTreeProvider";
import { PerfViewProvider } from "./perf/PerfViewProvider";
import { captureToCpuProfile } from "./profiler/cpuprofile";
import { captureToTrace } from "./profiler/trace";
import { tmpdir as osTmpDir } from "os";
import { join as pathJoin } from "path";

export function activate(context: vscode.ExtensionContext) {
  const logger = Logger.getInstance();
  logger.info("Extension", "SourcePawn Debugger extension starting...");

  // Register debug configuration provider
  const provider = new SourcePawnConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("sp-debugger", provider),
  );

  // Register debug adapter descriptor factory
  const factory = new SourcePawnDebugAdapterDescriptorFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("sp-debugger", factory),
  );

  // Register command to debug active file
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sp-debugger.debugActiveFile",
      debugActiveFile,
    ),
  );

  // --- Function profiler --------------------------------------------------
  // The tree view lives inside the Run & Debug view container (see package.json
  // "views": { "debug": ... }), so it sits with Variables/Watch/Call Stack
  // rather than in a separate activity-bar item. The headline action,
  // "Take Performance Profile", records and then opens the capture in VS Code's
  // built-in .cpuprofile viewer (flame chart + table + call tree).
  const profilerProvider = new ProfilerTreeProvider();
  // Seed the toolbar context keys so the correct two-state buttons (mode /
  // sort) show their default state before the first capture.
  vscode.commands.executeCommand("setContext", "spDebugger.profilerMode", profilerProvider.mode);
  vscode.commands.executeCommand("setContext", "spDebugger.profilerSort", profilerProvider.sort);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "spDebuggerProfiler",
      profilerProvider,
    ),
  );

  // --- Realtime Performance ---------------------------------------------
  // CPU / memory of the game server, polled via `sp_performance` while the
  // panel is visible. Lives next to the profiler in Run & Debug.
  const perfProvider = new PerfViewProvider();
  context.subscriptions.push(
    perfProvider,
    vscode.window.registerWebviewViewProvider(PerfViewProvider.viewType, perfProvider),
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.type === "sp-debugger") {
        vscode.commands.executeCommand("setContext", "spDebugger.profiling", false);
      }
    }),
  );

  const requireSession = (): vscode.DebugSession | undefined => {
    const s = vscode.debug.activeDebugSession;
    if (!s || s.type !== "sp-debugger") {
      vscode.window.showWarningMessage(
        "Start a SourcePawn debug session first, then take a profile.",
      );
      return undefined;
    }
    return s;
  };

  const setProfiling = (on: boolean) =>
    vscode.commands.executeCommand("setContext", "spDebugger.profiling", on);

  // Write the capture as a .cpuprofile and open it in VS Code's native viewer.
  const openCpuProfile = async (capture: any) => {
    const profile = captureToCpuProfile(capture);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uri = vscode.Uri.file(
      pathJoin(osTmpDir(), `sourcepawn-${stamp}.cpuprofile`),
    );
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(profile)),
    );
    await vscode.commands.executeCommand("vscode.open", uri);
  };

  // Write the capture as a Chrome Trace Event document. VS Code has no viewer
  // for it, so the file path is what we hand back — it opens in ui.perfetto.dev
  // (drag & drop, runs locally) or chrome://tracing.
  const writeTrace = async (capture: any): Promise<vscode.Uri> => {
    const trace = captureToTrace(capture);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uri = vscode.Uri.file(
      pathJoin(osTmpDir(), `sourcepawn-${stamp}.trace.json`),
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(trace)));
    return uri;
  };

  // The ".smx" qualifier of the plugin being debugged, e.g. "antibhop.smx".
  // Used to default the profiler's "this plugin only" filter.
  const activePluginSmx = (session: vscode.DebugSession): string | undefined => {
    const p: string | undefined = session.configuration?.plugin;
    if (!p) return undefined;
    const base = p.replace(/\\/g, "/").split("/").pop() || p;
    return base.replace(/\.(sp|inc|smx)$/i, "") + ".smx";
  };

  // Headline: pick a duration, record, open the flame chart + populate the tree.
  context.subscriptions.push(
    vscode.commands.registerCommand("sp-debugger.takeProfile", async () => {
      const session = requireSession();
      if (!session) return;

      // Choose how long to record: until cancelled, or a fixed number of seconds.
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(stop-circle) Until I cancel",
            detail: "Record until you click Cancel",
            mode: "cancel" as const,
          },
          {
            label: "$(watch) Enter seconds…",
            detail: "Record for a fixed number of seconds, then stop automatically",
            mode: "seconds" as const,
          },
        ],
        { placeHolder: "Profile duration — reproduce the load while recording" },
      );
      if (!choice) return;

      let durationMs = 0; // 0 = record until the user cancels
      if (choice.mode === "seconds") {
        const input = await vscode.window.showInputBox({
          prompt: "How many seconds to record?",
          value: "5",
          validateInput: (v) => {
            const n = Number(v.trim());
            return Number.isFinite(n) && n > 0 && n <= 600
              ? undefined
              : "Enter a number of seconds between 1 and 600";
          },
        });
        if (input === undefined) return;
        durationMs = Math.round(Number(input.trim()) * 1000);
      }

      try {
        const start = await session.customRequest("sp_profileStart");
        if (start && start.active === false) {
          vscode.window.showErrorMessage(
            "Profiler unavailable on the server (the VM profiling hooks were not found; see docs/troubleshooting.md).",
          );
          return;
        }
        await setProfiling(true);

        const seconds = durationMs > 0 ? Math.round(durationMs / 1000) : 0;
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Recording SourcePawn profile",
            cancellable: true,
          },
          (progress, token) =>
            new Promise<void>((resolve) => {
              progress.report({
                message:
                  durationMs > 0
                    ? `Recording for ${seconds}s… reproduce the load (Cancel to stop early).`
                    : "Reproduce the load, then click Cancel to stop.",
              });
              // Fixed duration → auto-stop; "until cancel" → only Cancel resolves.
              const timer =
                durationMs > 0 ? setTimeout(resolve, durationMs) : undefined;
              token.onCancellationRequested(() => {
                if (timer) clearTimeout(timer);
                resolve();
              });
            }),
        );

        const res = await session.customRequest("sp_profileStop");
        await setProfiling(false);
        profilerProvider.setData(res, activePluginSmx(session));

        if (!profilerProvider.hasData()) {
          vscode.window.showInformationMessage(
            "Profiling captured, but no functions ran during the window.",
          );
          return;
        }
        // Populate the tree only. The flame chart opens on demand via the
        // "Open Flame Chart" button (so a capture doesn't steal the editor).
        const hot = profilerProvider.hottestBySelf();
        if (hot) {
          vscode.window.setStatusBarMessage(
            `SourcePawn profile: hottest ${hot.name} (${hot.selfMs.toFixed(2)} ms self) — open the flame chart from the profiler view`,
            8000,
          );
        }
      } catch (e) {
        await setProfiling(false);
        vscode.window.showErrorMessage(`Profiling failed: ${e}`);
      }
    }),
  );

  // Re-open the last capture as a flame chart (always the full, unfiltered tree).
  context.subscriptions.push(
    vscode.commands.registerCommand("sp-debugger.openFlameChart", async () => {
      const capture = profilerProvider.rawCapture();
      if (!capture) {
        vscode.window.showInformationMessage("No profile captured yet.");
        return;
      }
      await openCpuProfile(capture);
    }),
  );

  // Export the same capture as a timeline for Perfetto / chrome://tracing: one
  // slice per call, so a spiking tick can be found and opened, which the
  // aggregated flame chart cannot show.
  context.subscriptions.push(
    vscode.commands.registerCommand("sp-debugger.exportProfileTrace", async () => {
      const capture = profilerProvider.rawCapture();
      if (!capture) {
        vscode.window.showInformationMessage("No profile captured yet.");
        return;
      }
      const spans = capture.spans?.items?.length ?? 0;
      if (spans === 0) {
        vscode.window.showInformationMessage(
          "This capture has no call spans to export (nothing completed a call during the window).",
        );
        return;
      }
      const uri = await writeTrace(capture);
      const pick = await vscode.window.showInformationMessage(
        `Trace written with ${spans} call spans. Open it at ui.perfetto.dev (drag & drop; it runs locally).`,
        "Copy Path",
        "Reveal File",
      );
      if (pick === "Copy Path") await vscode.env.clipboard.writeText(uri.fsPath);
      if (pick === "Reveal File") await vscode.commands.executeCommand("revealFileInOS", uri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sp-debugger.clearProfiler", () =>
      profilerProvider.clear(),
    ),
    vscode.commands.registerCommand("sp-debugger.profilerToggleMode", () =>
      profilerProvider.toggleMode(),
    ),
    vscode.commands.registerCommand("sp-debugger.profilerToggleSort", () =>
      profilerProvider.toggleSort(),
    ),
    // Two-state mode/sort buttons (only one of each pair shows at a time via the
    // spDebugger.profilerMode / .profilerSort context keys); both just toggle.
    vscode.commands.registerCommand("sp-debugger.profilerModeShowFlat", () =>
      profilerProvider.toggleMode(),
    ),
    vscode.commands.registerCommand("sp-debugger.profilerModeShowTree", () =>
      profilerProvider.toggleMode(),
    ),
    vscode.commands.registerCommand("sp-debugger.profilerSortShowTotal", () =>
      profilerProvider.toggleSort(),
    ),
    vscode.commands.registerCommand("sp-debugger.profilerSortShowSelf", () =>
      profilerProvider.toggleSort(),
    ),

  );

  // Click a profiler row → jump to the function's source (best-effort search
  // over .sp/.inc files, biased toward the debugged plugin's file).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sp-debugger.revealProfileFunction",
      (qualified: string) => revealFunction(qualified),
    ),
  );

  logger.info("Extension", "SourcePawn Debugger extension activated");
}

/**
 * Best-effort "go to definition" for a profiled function. The profile carries
 * the function qualified as `plugin.smx::Func`, so we use the **plugin** part to
 * scope the search — otherwise a common name like `OnGameFrame` would open the
 * first plugin that happens to define it (the reported "opened stats.sp instead
 * of antibhop.sp" bug). Search order, all restricted to the named plugin:
 *   1. the plugin's own `<plugin>.sp`
 *   2. the plugin's module folder `<dir>/<plugin>/**` (multi-file plugins)
 *   3. shared includes next to it (`<dir>/include/**`)
 * We only accept a *definition* line, never a call site.
 */
async function revealFunction(qualified: string): Promise<void> {
  const sep = qualified.indexOf("::");
  const fn = sep >= 0 ? qualified.slice(sep + 2) : qualified;
  const pluginBase =
    sep > 0 ? qualified.slice(0, sep).replace(/\.smx$/i, "") : undefined;
  if (!/^[A-Za-z_]\w*$/.test(fn)) {
    vscode.window.showInformationMessage(`Can't locate source for "${fn}".`);
    return;
  }

  // A definition line: optional modifier + return type + Name( ... and NOT
  // ending in ';' on the same line (that would be a forward/native prototype,
  // still a fine jump target). Calls are excluded because they don't start the
  // line with an (optional) type before the name.
  const defRe = new RegExp(
    `^\\s*(?:public|stock|static|native|forward)?\\s*[\\w\\[\\]:<>]*\\s+\\b${fn}\\s*\\(`,
  );
  // Looser: name at column-ish start (handles `MyType:Name(` old syntax).
  const looseDefRe = new RegExp(`^\\s*[\\w\\[\\]:<>]*\\b${fn}\\s*\\(`);

  const searchFor = async (uris: vscode.Uri[]): Promise<boolean> => {
    for (const uri of uris) {
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        if (defRe.test(text) || looseDefRe.test(text)) {
          await showAt(uri, i);
          return true;
        }
      }
    }
    return false;
  };

  // Resolve the plugin's source file. Prefer the active session's configured
  // plugin path when it matches; otherwise find `<plugin>.sp` in the workspace.
  let pluginSp: vscode.Uri | undefined;
  const cfgPlugin: string | undefined =
    vscode.debug.activeDebugSession?.configuration?.plugin;
  if (
    pluginBase &&
    cfgPlugin &&
    cfgPlugin.replace(/\\/g, "/").split("/").pop()?.replace(/\.\w+$/, "") === pluginBase
  ) {
    pluginSp = vscode.Uri.file(cfgPlugin);
  } else if (pluginBase) {
    const found = await vscode.workspace.findFiles(`**/${pluginBase}.sp`, "**/node_modules/**", 5);
    pluginSp = found[0];
  }

  if (pluginBase && pluginSp) {
    // 1. the plugin's own file
    if (await searchFor([pluginSp])) return;
    // 2. its module folder, then 3. a sibling include/ folder
    const dirParts = pluginSp.fsPath.replace(/\\/g, "/").split("/");
    dirParts.pop(); // drop the filename
    const dir = dirParts.join("/");
    const moduleGlob = new vscode.RelativePattern(
      vscode.Uri.file(`${dir}/${pluginBase}`),
      "**/*.{sp,inc}",
    );
    const includeGlob = new vscode.RelativePattern(
      vscode.Uri.file(`${dir}/include`),
      "**/*.{sp,inc}",
    );
    const moduleFiles = await vscode.workspace.findFiles(moduleGlob, undefined, 400);
    if (await searchFor(moduleFiles)) return;
    const includeFiles = await vscode.workspace.findFiles(includeGlob, undefined, 400);
    if (await searchFor(includeFiles)) return;
    vscode.window.showInformationMessage(
      `No definition of "${fn}" found in ${pluginBase}'s sources.`,
    );
    return;
  }

  // Unknown plugin (e.g. a native or unqualified name): fall back to a
  // workspace-wide definition search.
  const all = await vscode.workspace.findFiles("**/*.{sp,inc}", "**/node_modules/**", 400);
  if (await searchFor(all)) return;
  vscode.window.showInformationMessage(`No source found for "${fn}".`);
}

async function showAt(uri: vscode.Uri, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter,
  );
}

export function deactivate() {
  const logger = Logger.getInstance();
  logger.info("Extension", "SourcePawn Debugger extension deactivating...");

  try {
    // Clear any logger resources
    logger.clear();

    // Note: DebugSessionManager cleanup is handled by VS Code debug session lifecycle
    // Individual debug sessions will cleanup when disconnected/terminated

    logger.info("Extension", "SourcePawn Debugger extension deactivated");
  } catch (error) {
    logger.error("Extension", `Error during deactivation: ${error}`);
  }
}

async function debugActiveFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active file to debug");
    return;
  }

  if (!FileUtils.isSourcePawnFile(editor.document.fileName)) {
    vscode.window.showErrorMessage(
      "Active file is not a SourcePawn file (.sp or .inc)",
    );
    return;
  }

  const config = ConfigValidator.createDefaultLaunchConfig(
    editor.document.fileName,
  );

  // Start debugging with the generated configuration
  await vscode.debug.startDebugging(undefined, config);
}

class SourcePawnConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken,
  ): ProviderResult<vscode.DebugConfiguration> {
    const logger = Logger.getInstance();

    // If launch.json is missing or empty, create default configuration
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && FileUtils.isSourcePawnFile(editor.document.fileName)) {
        logger.info("Config", "Creating default launch configuration");
        return ConfigValidator.createDefaultLaunchConfig(
          editor.document.fileName,
        );
      } else {
        vscode.window.showErrorMessage(
          "Cannot debug: No SourcePawn file is open",
        );
        return undefined;
      }
    }

    // Apply default values if not specified
    if (!config.host) {
      config.host = "localhost";
    }
    if (!config.port) {
      config.port = 8080;
    }

    // Validate configuration
    const validation = ConfigValidator.validateDebugConfiguration(config);
    if (!validation.isValid) {
      const errorMessage = `Invalid debug configuration:\n${validation.errors.join("\n")}`;
      vscode.window.showErrorMessage(errorMessage);
      logger.error("Config", "Invalid configuration", validation.errors);
      return undefined;
    }

    // Show warnings
    validation.warnings.forEach((warning) => {
      vscode.window.showWarningMessage(warning);
      logger.warn("Config", warning);
    });

    logger.info("Config", "Configuration validated successfully");
    return config;
  }

  provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken,
  ): ProviderResult<vscode.DebugConfiguration[]> {
    return [
      ConfigValidator.createDefaultLaunchConfig(),
      ConfigValidator.createDefaultAttachConfig(),
    ];
  }
}

class SourcePawnDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined,
  ): ProviderResult<vscode.DebugAdapterDescriptor> {
    const logger = Logger.getInstance();

    // Check if Bun is available
    const bunPath = this.findBunExecutable();
    if (!bunPath) {
      logger.error(
        "Adapter",
        "Bun runtime not found. Please install Bun from https://bun.sh",
      );
      vscode.window.showErrorMessage(
        "Bun runtime not found. Please install Bun from https://bun.sh to use the SourcePawn Debugger.",
      );
      return undefined;
    }

    const adapterPath = FileUtils.join(__dirname, "debugAdapter.js");
    logger.info(
      "Adapter",
      `Using debug adapter: ${adapterPath} with Bun: ${bunPath}`,
    );

    return new vscode.DebugAdapterExecutable(bunPath, [adapterPath]);
  }

  private findBunExecutable(): string | undefined {
    const platform = process.platform;
    const bunName = platform === "win32" ? "bun.exe" : "bun";

    // Try common locations
    const commonPaths = [
      "/usr/local/bin/" + bunName,
      "/usr/bin/" + bunName,
      "/opt/homebrew/bin/" + bunName,
      process.env.HOME + "/.bun/bin/" + bunName,
    ];

    if (platform === "win32") {
      commonPaths.push(
        process.env.APPDATA + "\\bun\\bin\\" + bunName,
        process.env.LOCALAPPDATA + "\\bun\\bin\\" + bunName,
      );
    }

    for (const path of commonPaths) {
      if (FileUtils.exists(path) && FileUtils.isFile(path)) {
        return path;
      }
    }

    // Try PATH
    const pathEnv = process.env.PATH || "";
    const pathDirs = pathEnv.split(platform === "win32" ? ";" : ":");

    for (const dir of pathDirs) {
      const fullPath = FileUtils.join(dir, bunName);
      if (FileUtils.exists(fullPath) && FileUtils.isFile(fullPath)) {
        return fullPath;
      }
    }

    return undefined;
  }
}
