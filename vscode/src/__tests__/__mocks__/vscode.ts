// Mock implementation of the VS Code API for tests (registered for the
// "vscode" specifier by setup.ts via mock.module). Only the surface the
// extension actually touches at import/activate time needs to exist; all
// functions are bun mock() instances so tests can spy/inspect calls.
import { mock } from "bun:test";

export const debug = {
  registerDebugConfigurationProvider: mock(() => ({ dispose: () => {} })),
  registerDebugAdapterDescriptorFactory: mock(() => ({ dispose: () => {} })),
  onDidTerminateDebugSession: mock(() => ({ dispose: () => {} })),
  startDebugging: mock(async () => true),
  activeDebugSession: undefined as unknown,
};

export const commands = {
  registerCommand: mock(() => ({ dispose: () => {} })),
  executeCommand: mock(async () => undefined),
};

export const window = {
  createStatusBarItem: mock(() => ({
    text: "",
    tooltip: "",
    command: "",
    show: mock(() => {}),
    hide: mock(() => {}),
    dispose: mock(() => {}),
  })),
  registerTreeDataProvider: mock(() => ({ dispose: () => {} })),
  registerWebviewViewProvider: mock(() => ({ dispose: () => {} })),
  setStatusBarMessage: mock(() => ({ dispose: () => {} })),
  showErrorMessage: mock(async () => undefined),
  showWarningMessage: mock(async () => undefined),
  showInformationMessage: mock(async () => undefined),
  showInputBox: mock(async () => undefined),
  showQuickPick: mock(async () => undefined),
  showTextDocument: mock(async () => ({ revealRange: () => {} })),
  withProgress: mock(async (_opts: unknown, task: (p: unknown) => unknown) =>
    task({ report: () => {} }),
  ),
  activeTextEditor: null as unknown,
};

export const workspace = {
  getConfiguration: mock(() => ({
    get: mock(() => undefined),
    has: mock(() => false),
    update: mock(async () => undefined),
  })),
  findFiles: mock(async () => []),
  openTextDocument: mock(async () => ({ getText: () => "" })),
  fs: {
    writeFile: mock(async () => undefined),
  },
  workspaceFolders: null as unknown,
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, path, scheme: "file" }),
  parse: mock((s: string) => ({ fsPath: s, path: s, scheme: "file" })),
};

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };

export class DebugAdapterExecutable {
  constructor(
    public command: string,
    public args?: string[],
  ) {}
}

export class DebugAdapterInlineImplementation {
  constructor(public implementation: unknown) {}
}

export class TreeItem {
  constructor(
    public label?: unknown,
    public collapsibleState?: number,
  ) {}
}

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  value = "";
  constructor(value?: string) {
    if (value) this.value = value;
  }
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
  appendCodeblock(s: string) {
    this.value += s;
    return this;
  }
}

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

export class Selection extends Range {}

// VS Code-style event emitter: exposes `.event` for subscription and `.fire`
// to emit (NOT the node on/emit shape) -- ProfilerTreeProvider depends on it.
export class EventEmitter<T = unknown> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(data: T) {
    this.listeners.forEach((l) => l(data));
  }
  dispose() {
    this.listeners = [];
  }
}
