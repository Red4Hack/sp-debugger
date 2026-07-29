# Testing the SourcePawn Debugger

All tests run through **one command**: `bun test` (from `vscode/`). The suite
has two tiers plus a set of standalone dev tools:

| Tier | Where | Needs | Command |
|---|---|---|---|
| Unit tests | `vscode/src/__tests__/**/*.test.ts` | nothing (VS Code API is mocked) | `bun test` |
| Integration tests | `vscode/src/__tests__/integration/` | mock srcds env (below) | `bun run test:integration` |
| Dev / debug tools | `vscode/scripts/*.mjs` | mock srcds env (spawned per run) | `node vscode/scripts/<tool>.mjs` |

## Unit tests (`bun test`)

TypeScript tests for the extension: adapter request handling, session manager,
TCP framing (byte-accurate UTF-8), path mapping (both stubbed and against a
real scratch filesystem), profiler `.cpuprofile` conversion, config validation,
logging. The `vscode` module (which only exists inside the editor) is replaced
by `src/__tests__/__mocks__/vscode.ts`, registered by the preload in
`bunfig.toml` (`src/__tests__/setup.ts`).

They need no server, no network and no build artifacts — safe on a fresh
checkout. The integration suite below is discovered by the same `bun test`
run but **skips itself** when the mock environment isn't staged, so the
command stays green everywhere.

## Integration tests

Both suites share `src/__tests__/integration/harness.ts`: the mock-environment
paths, the srcds process handling (spawn, console input, output capture, and a
kill that actually happens) and a minimal DAP client speaking the same
Content-Length framing as the VS Code adapter.

### DAP regression

`src/__tests__/integration/dap-regression.test.ts` spawns the mock srcds with
the `debugger_test` plugin loaded, drives a full DAP session over TCP exactly
like the VS Code client (initialize → launch → setBreakpoints →
configurationDone → trigger `bp` → stopped → stackTrace/scopes/variables →
continue → disconnect), and asserts the deterministic variable values from
`debugger_test.sp` (`g_Integer=42`, `locInteger=7`, `argString="some string"`, …).

### Extension lifecycle

`src/__tests__/integration/extension-lifecycle.test.ts` exercises what a server
owner actually does between releases: `sm exts unload`, `sm exts load`,
`sm exts reload` — without restarting the game server. It asserts, at every
step, that the DAP port opens and closes as it should, that the process is still
alive, that the **server console still answers** (a deadlocked game thread keeps
the process alive while serving nothing), and that a full debug session still
works afterwards — which also covers the late-load path, where the plugin map
has to be re-seeded or nothing is debuggable.

It also covers the other half of the lifecycle: **shutting the server down**
after debugging. Restarting a server runs the same teardown, and anything of
ours still executing when the `.so` is unloaded takes the process with it. Those
cases connect several clients with requests in flight and then `quit`, demanding
a clean exit (no fatal signal, no crash text).

This suite exists because all three failure modes were real: unload once froze
the whole server (`TcpServer::Stop()` joined an accept thread that a plain
`close()` never woke), a late load once left every plugin undebuggable, and a
restart with an editor attached segfaulted (client threads were detached, so
teardown never waited for them). The shutdown cases are deliberately
burst-heavy: with a single idle connection the race reproduced in only about a
third of runs; as written it caught the regression in four runs out of five.

`run_dap_tests.sh` (this folder) is the **stager**: it builds the extension
from the repo root, stages the package into the mock game dir, links
`debugger_test.smx` enabled, and then runs both suites. In CI this is the
"Run DAP regression test" step of `.github/workflows/test.yml`, right after
the console tests, reusing the same mock env.

### One-time mock environment setup

```sh
sp-console-debugger/tests/setup.sh     # clones + builds hl2sdk-mock, sourcemod, metamod
vscode/tests/dap/run_dap_tests.sh      # builds the extension + stages the gamedir (and runs the test)
```

(Needs network + the multilib toolchain; see the `test` GitHub workflow for
the exact apt packages. The vendored `sp-console-debugger/` tree itself is
fetched per `docs/updating-upstream.md`.)

## Dev and debug tools (`vscode/scripts/*.mjs`)

Headless clients that exercise the debugger over TCP — for interactive
debugging of the debugger itself, not for CI. All default to the repo's test
plugin on a mock srcds **spawned by the script itself**; the shared helper
`vscode/scripts/lib/testenv.mjs` pumps the `bp` server command into srcds
stdin (~10/s) to keep the breakpoint line hot, since `debugger_test.sp` has no
per-frame code.

| Tool | What it exercises |
|---|---|
| `dap-smoke-test.mjs` | End-to-end smoke (phases A–L): snapshot logpoint, pause + inspect, stepping, conditional and hit-count breakpoints, async pause, setVariable, data breakpoints, readMemory, stress cycles, Debug Console REPL |
| `plugin-walkthrough.mjs` | 9-section interaction walkthrough: globals discovery, stepping, hover storm, stop/inspect marathon, variable + array-element writes, messy-hover canonicalization, step-into storm |
| `test-logpoints.mjs` | Logpoint message forms (`{expr}`, arrays, `{@all}`), conditions, throughput; logging must never pause the server |
| `test-profiler.mjs` | Profiler capture window → call tree validation |
| `test-step-event-order.mjs` | continued/stopped wire-order during rapid stepping (the thread-sync bug) |
| `probe-bp.mjs` | Breakpoint bind/fire diagnostics across candidate lines |
| `probe-utf8.mjs` | Raw byte dump of a non-ASCII evaluate round-trip (Content-Length accounting) |

**Remote mode:** point any tool at a real server with `SP_HOST` (plus
`SP_PROGRAM`, `SP_BP_FILE`, `SP_BP_LINE`, … to pick a hot line); no mock is
spawned then. Only use pausing phases against TEST servers — a real pause
freezes the game server.

```sh
node vscode/scripts/dap-smoke-test.mjs                        # mock mode
node vscode/scripts/dap-smoke-test.mjs --host 192.168.1.100   # remote (test server!)
SP_HOST=myserver node vscode/scripts/test-profiler.mjs        # env-var override
```

> The former standalone checks `test-byte-framing.mjs`, `test-cpuprofile.mjs`
> and `test-path-mapper.mjs` are now proper unit tests inside
> `src/__tests__/` and run with `bun test`.
