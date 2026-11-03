# SourcePawn Debugger — Usage Guide

This guide explains how to use every debugger feature. It's written for plugin developers who want to debug SourcePawn code running on a live game server from VS Code.

**Audience:** Plugin developers (no deep C++ knowledge needed)

## Table of Contents

1. [Installation](#installation)
2. [Setup](#setup)
3. [Breakpoints](#breakpoints)
4. [Stepping and Pause](#stepping-and-pause)
5. [Variable Inspection](#variable-inspection)
6. [Watches and Hovers](#watches-and-hovers)
7. [Debug Console REPL](#debug-console-repl)
8. [Data Breakpoints (Watchpoints)](#data-breakpoints-watchpoints)
9. [Memory Inspection](#memory-inspection)
10. [Call Stack Navigation](#call-stack-navigation)
11. [Function Profiler](#function-profiler)
12. [Common Workflows](#common-workflows)
13. [Timeout Configuration](#timeout-configuration)
14. [Troubleshooting](#troubleshooting)

## Installation

### From the VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "SourcePawn Debugger"
4. Click Install

### From Source

```bash
cd vscode
bun run compile
# Build the extension into out/
# Then: Cmd+Shift+P → "Extensions: Install from VSIX..." → select the .vsix file
```

## Setup

### 1. Enable line debugging in SourceMod (required)

The SourcePawn VM only emits the per-line debug callbacks this debugger relies
on when line debugging is enabled. In `addons/sourcemod/configs/core.cfg` set:

```
"EnableLineDebugging"    "yes"
```

> This noticeably slows the VM and is meant for development, not a busy public
> server. Turn it back to `"no"` when you're done debugging.

### 2. Ensure the C++ Extension is Deployed — and loaded BEFORE plugins

The debugger won't work without the C++ extension running on the game server. Check that these files exist:

```
addons/sourcemod/extensions/sp-debugger.ext.so            (32-bit)
addons/sourcemod/extensions/x64/sp-debugger.ext.so        (64-bit)
addons/sourcemod/configs/console-debugger.cfg             (auto-created on first load)
```

> **CRITICAL — the extension must load before plugins compile.** It enables
> line debugging in the VM only when loaded *at server startup* (non-late). If
> you deploy or update the `.so` with `sm exts load` / `sm exts reload`, it
> loads **late**, that step is skipped, and already-loaded plugins report
> "not debuggable" — every `launch` then fails with *"Failed to start debugging
> the specified plugin"* and no breakpoints verify. **Always do a full game-server
> restart** (stop the process and start it again, or `_restart`) after copying a
> new `.so`. A `sm exts reload` is not enough.

Verify it's loaded in-game:
```
sm exts list
```

Should output:
```
[01] SourceMod Console Debugger [RUNNING]
```

If it's not loaded, check the extension log at `addons/sourcemod/logs/errors_YYYY-MM-DD.log`.

> **Plugin dependencies must be satisfied.** A plugin only becomes debuggable
> once it actually loads. If it depends on another extension/plugin (e.g.
> SourceBans) that is missing or failed, the plugin won't be loaded and `launch`
> will report it can't be found/started. Confirm the target plugin shows up in
> `sm plugins list` as loaded before debugging.

### 3. Create a Launch Configuration

In your project root, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "sp-debugger",
      "request": "launch",
      "name": "Debug SourcePawn Plugin",
      "host": "your.server.ip",
      "port": 8080,
      "plugin": "${file}",
      "stopOnEntry": false
    }
  ]
}
```

Replace `your.server.ip` with the server's IP address (or `localhost` for a local server).

> **The server's debug port listens on `127.0.0.1` only**, because a debug
> session can read and write plugin memory and can freeze the server on a
> breakpoint. A remote `host` therefore will not connect until you either tunnel
> the port — `ssh -L 8080:127.0.0.1:8080 user@gameserver`, then point `host` at
> `127.0.0.1` — or set `bind` **and** a non-empty `token` in
> `addons/sourcemod/configs/console-debugger.cfg` and repeat that token here:
>
> ```json
> "host": "your.server.ip", "port": 8080, "token": "the-shared-secret"
> ```
>
> With a non-loopback `bind` and no token the extension refuses to open the port
> at all. See [Configuration](README.md#configuration).

### 4. (Optional) Configure Timeouts and Reconnection

For a slower network or flaky connection:

```json
{
  "type": "sp-debugger",
  "request": "launch",
  "name": "Debug with Custom Timeouts",
  "host": "your.server.ip",
  "port": 8080,
  "plugin": "${file}",
  "timeout": {
    "connection": 10000,      // ms to wait for initial connection
    "request": 30000,         // ms to wait for normal DAP requests
    "stepping": 60000,        // ms to wait for continue/step commands
    "keepalive": 15000        // interval between keepalive pings
  },
  "reconnect": {
    "enabled": true,
    "maxAttempts": 5,
    "baseDelay": 1000,        // ms, backed off exponentially
    "maxDelay": 30000
  }
}
```

**Default values** are reasonable for most setups. Only adjust if you're seeing timeouts in the Debug Console.

## Breakpoints

### Setting a Breakpoint

1. Open the `.sp` source file in VS Code
2. Click on the line number in the gutter (the left margin)
3. A red circle appears
4. The breakpoint is **pending** until the first line of your plugin executes

**Important:** Breakpoints are file-path and line-number based. The C++ extension resolves the .sp file from the debug info compiled into the plugin binary. If the file path in the binary doesn't match your local file, the breakpoint will stay **unverified** (red with a circle outline). See [Path Mapping](troubleshooting.md#path-mapping) if this happens.

### Conditional Breakpoints

Right-click the breakpoint (red circle) and select "Edit Breakpoint...":

```
x > 5
```

The expression can be:
- A simple comparison: `variable > value`, `x == 3`, `damage < 10`
- Supported operators: `==`, `!=`, `<`, `<=`, `>`, `>=`
- Variables can be locals, arguments, or globals visible in that frame

The breakpoint will only pause execution if the condition is true.

### Hit-Count Breakpoints

Right-click the breakpoint, choose "Edit Breakpoint...", and select "Hit Count".

> **What this debugger actually supports:** a **plain positive integer** `N`. The
> breakpoint is ignored until its `N`th hit, then it triggers on the `N`th hit
> **and every hit after that**. Operator forms (`== 10`, `>= 10`, `> 10`, `% 5`)
> are **not** parsed by the server — the value must be digits only, e.g.:

```
3
```

(The breakpoint fires from the 3rd time the line is reached onward.) Hit-count
combines with both pausing breakpoints and logpoints.

### Logpoints — Non-Pausing Observation (THE way to watch a live server)

A logpoint is a breakpoint with a **Log Message**: right-click the gutter →
"Add Logpoint…" (or "Edit Breakpoint…" → "Log Message"). In this debugger a
logpoint **never pauses** — the instant the line executes, the message is
formatted, printed to the Debug Console as an `output` event, and **execution
continues immediately**. The game server does **not** freeze.

> This is the killer feature for production debugging. Pausing a live server
> freezes the whole game (30 players all stop). A logpoint just emits a line of
> text per hit and keeps running. Use logpoints on production; reserve pausing
> breakpoints for a test server.

#### Message syntax

The message is literal text with **`{expression}`** placeholders. Each
placeholder is evaluated in the scope of that line and substituted:

| Placeholder | Renders | Example output |
|---|---|---|
| literal text | as-is | `reached reload check` |
| `{scalar}` | the value (int/float/bool) | `ct=155.250000` |
| `{g_arr[i]}` | one array element; index `i` may be a **literal or a variable** | `primary={g_PlayerPrimary[client]}` → `primary=7` |
| `{g_arr}` | a preview of the whole array | `{0, 7, 20, 30, 30, ...}` |
| `{buffer}` | a `char[]` rendered as text | `"hello"` |
| `{myStruct}` | enum-struct fields | `{x: 1, y: 2}` |
| `{@all}` | snapshot of **all locals + arguments** in scope (see note) | `deltaTime=0.0149 currentTime=157.4` |
| `{@locals}` | snapshot of locals only | |
| `{@args}` | snapshot of arguments only | |

Mix freely: `client {client}: primary={g_PlayerPrimary[client]} ammo={g_PlayerPrimaryAmmo[client]}`

> **`{@all}` covers locals + arguments, not globals.** Globals/statics aren't
> dumped by `{@all}` (a plugin can have 50+). Reference the ones you care about
> explicitly, e.g. `{@locals} valid={g_iValidBhops[client]}`.

An expression that can't be resolved (typo, out-of-scope name, bad index) is
**left literal** so you can see what failed — e.g. `{nonexistent}` prints
`{nonexistent}` rather than crashing or going blank.

#### Conditional logpoints

A logpoint can also carry a **condition** (Edit Breakpoint… → Expression). The
message is only logged when the condition is true — ideal for narrowing a flood
to one player:

```
Condition:   client == 1
Log Message: pos={g_PlayerPrimary[client]}
```

The condition supports a single comparison (`==`, `!=`, `<`, `<=`, `>`, `>=`)
between two operands (variables or literals). Compound `&&`/`||` are not
supported — use the tightest single comparison.

#### Example session

Log message `dt={deltaTime} ct={currentTime}` on a per-frame line produces, in
the Debug Console, one line every frame while the server keeps running:

```
[sp-dbg] dt=0.014999 ct=156.360001
[sp-dbg] dt=0.015015 ct=156.375000
[sp-dbg] dt=0.014999 ct=156.389999
...
```

## Stepping and Pause

### Toolbar Controls

Once paused at a breakpoint:

- **Continue** (▶ or F5) — Resume execution until the next breakpoint
- **Step Over** (⬇ or F10) — Execute the current line and pause at the next line (don't enter function calls)
- **Step Into** (⬇ with arrow or F11) — Enter a function call and pause at its first line
- **Step Out** (⬆ or Shift+F11) — Execute until the current function returns, pause at the caller
- **Pause** (⏸ or F6) — Interrupt execution and pause (async pause; used when not paused, e.g., to inspect the current state while the plugin is running)

### Timeout During Stepping

If you're stepping through slow code (e.g., a nested loop that runs millions of iterations), the debugger will timeout after `stepping` ms (default 60000 = 60 seconds). The Debug Console will show:

```
[sp-dbg] Stepping timeout after 60000 ms. Debugger state: running.
```

**Workaround:** Press Pause (F6) to stop and inspect, or increase the `stepping` timeout in your launch config.

## Variable Inspection

### The Variables Panel

When paused, the Variables panel (left sidebar) shows:

```
Scopes
├─ Locals
│  ├─ damage: 25
│  ├─ attacker: 1 (player index)
│  ├─ coords: [0, 100, 50]
│  └─ health: 100
├─ Arguments
│  ├─ this: 0
│  └─ other_data: 42
└─ Globals
   ├─ g_PlayerData: {...}
   ├─ g_MapName: "de_dust2"
   └─ g_AdminList: [...]
```

### Expanding Variables

Click the arrow (▶) next to an array, struct, or enum-struct to expand it:

```
g_PlayerData ▶
```

becomes:

```
g_PlayerData ▼
├─ [0]: {name: "Player1", kills: 5}
├─ [1]: {name: "Player2", kills: 3}
└─ [2]: {name: "Player3", kills: 1}
```

Click individual elements to expand them further:

```
[0] ▼
├─ name: "Player1"
├─ kills: 5
├─ deaths: 2
└─ money: 1600
```

### Type Rendering

Variables are rendered with type context:

```
x: 42 (int)
damage: 25.0 (float)
is_active: true (bool)
code: 65 'A' (char)
coords: [0, 100, 50] (int[3])
name: "Player1" (char[64])
```

**Null pointers and out-of-scope variables** are shown as `(null)` or `(not in scope)`.

### Variable Type Inference

The debugger reads SourcePawn's debug symbols (if the plugin was compiled with `-g`) to determine types. Without debug symbols, variables are shown as hex cells:

```
unknown_var: 0x2a
```

**Recommendation:** Always compile plugins with debug info for production use. It adds ~10% to the binary size but makes debugging invaluable.

## Watches and Hovers

### Setting a Watch

In the Debug Console panel, click the Watch panel tab and type an expression:

```
health + armor
```

The debugger will evaluate it in the context of the paused frame and show the result:

```
health + armor: 175
```

Watches persist across breakpoint stops within the same debug session.

### Hover Tooltips

Hover over a variable name in the source editor (when paused) to see its value and type:

```
damage
├─ type: int
├─ value: 25
└─ scope: Locals
```

## Debug Console REPL

The Debug Console allows you to type commands and inspect variables while paused. This is like the console-mode debugger commands, but in VS Code.

### Basic Commands

Type a variable name or expression:

```
> health
25
> health + armor
175
> coords[0]
0
```

### Debugger Commands

- `bt` or `backtrace` — Print the call stack (frame addresses, function names)
  ```
  > bt
  #0 OnGameFrame (cip=0x1a2b, frm=0x3000)
  #1 OnGameFrame (cip=0x1234, frm=0x2f00)
  #2 main (cip=0x0a00, frm=0x2e00)
  ```

- `p <var>` or `print <var>` — Print a variable's detailed type and value
  ```
  > p player_data
  player_data = {
    id: 5,
    name: "SomePlayer",
    kills: 10,
    health: 78
  }
  ```

- `frame [N]` — Select a frame (0 = current, 1 = caller, 2 = caller's caller, ...)
  ```
  > frame 1
  Selected frame 1
  > p other_var
  other_var = 42
  ```

- `x[/FMT] <addr>` — Examine memory at address (hex viewer)
  ```
  > x/8x 0x4000
  0x4000: 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07
  ```

- `break <file>:<line>` — Set a breakpoint
  ```
  > break antibhop.sp:400
  Breakpoint set at antibhop.sp:400
  ```

- `set <var> <value>` — Set a variable (only works in current frame, only for locals/arguments)
  ```
  > set health 100
  health = 100
  ```

- `files` — List all source files in the plugin
  ```
  > files
  antibhop.sp
  helpers.inc
  ```

- `funcs` — List all functions
  ```
  > funcs
  OnGameFrame
  CheckBhop
  TeleportPlayer
  ...
  ```

- `watch <var>` — Add a variable to the watch list (shown in the Variables panel)
  ```
  > watch g_PlayerCount
  Added watch: g_PlayerCount
  ```

- `cwatch <var>` — Remove a variable from the watch list
  ```
  > cwatch g_PlayerCount
  Removed watch: g_PlayerCount
  ```

- `position` — Print the current position (filename, line, function)
  ```
  > position
  antibhop.sp:363 in OnGameFrame
  ```

- `?` or `help` — Print help text
  ```
  > ?
  Commands: bt, break, cwatch, continue, files, frame, funcs, next, position, print, quit, set, step, watch, x, ?
  ```

### Execution-Control Commands Are Forbidden in REPL

You cannot type `continue`, `next`, `step`, `stepIn`, `stepOut`, or `quit` in the REPL. Use the toolbar buttons instead. If you try:

```
> continue
Error: Execution control commands are not allowed in REPL. Use the toolbar buttons instead.
```

This is intentional — execution control is driven by the DAP adapter, not the console.

## Data Breakpoints (Watchpoints)

Watch a global or static variable for changes. When the variable is written to, execution pauses.

### Setting a Data Breakpoint

In the Variables panel, right-click a global or static variable and select "Break on Value Change":

```
g_PlayerCount [right-click] → Break on Value Change
```

A watch icon appears next to the variable. The next time any code writes to `g_PlayerCount`, execution pauses.

**Limitations:**
- Only works on globals and statics (not locals/arguments)
- Some variables may not support watchpoints if they're not in a writable data section

### Removing a Data Breakpoint

Right-click the variable again and select "Break on Value Remove".

## Memory Inspection

Use the `readMemory` DAP command to view raw memory in hex. In the Debug Console:

```
> x/32x 0x4000
0x4000: 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f
0x4010: 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f
```

**Format specifiers** (after the `/`):
- `b` — 1 byte per cell
- `h` — 2 bytes per cell (half-word)
- `w` — 4 bytes per cell (word, default)
- `g` — 8 bytes per cell (giant)

And quantity:
- `x` — hex (default)
- `d` — decimal
- `u` — unsigned
- `o` — octal

Example:
```
> x/16b 0x4000
0x4000: 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f
```

## Call Stack Navigation

The Call Stack panel (left sidebar) shows the function call chain:

```
Call Stack
├─ OnGameFrame (antibhop.sp:363) - line 363, in OnGameFrame
├─ (internal VM frame) - internal function, not in source
└─ main (unknown location)
```

Click a frame to select it. The Variables and Watch panels update to show locals/args/globals for that frame.

**Multi-frame inspection** is supported to 4+ levels deep, so you can step back through the entire call chain.

## Realtime Performance

The **Realtime Performance** view (Run & Debug, next to the SourcePawn Profiler)
draws the server's load over the last 30 seconds, refreshed once a second while
the view is visible and a SourcePawn session is active:

- **CPU Usage** (red) -- CPU of the main game thread. 100% means the game loop
  is saturated, i.e. the server can't keep up. The scale on the left is fixed at
  0-100%.
- **Memory Used** (green) -- resident memory of the server process. The scale on
  the right is rounded up to a round number (shown in the top-right corner) and
  grows with the data.
- **Plugins** (blue) -- memory of all running plugins together, with the number
  of plugins counted. It is part of the process memory, so it shares the same
  scale and is usually a thin line near the bottom.
- **Stack/heap** (the ring, no line) -- the size of the plugin **you are
  debugging**, as the compiler prints it at build time (`Stack/heap size:
  17032 bytes`). It is a constant, set when the plugin is compiled (see
  `#pragma dynamic`), so it is shown, not plotted. The plugin's name and its
  `Data size` are shown under the legend; hover for details.
  - *Legacy plugins* (SourceMod 1.12, and 1.13 plugins built with
    `oldspcomp`): read from the `.smx` as the memory size minus the data size,
    which is exactly the number `spcomp` prints.
  - *SourcePawn 2.0 plugins* (SourceMod 1.13, default `spcomp`): the compiler
    prints no such line and the VM has no fixed stack/heap size, so the cell
    reads **Heap in use** instead -- the bytes in use in the plugin's allocator
    heap (arrays, strings, closures), an approximation from the allocator's
    per-page counters.

  Under the legend a **Peak** line (legacy plugins only) says how much of that
  region the plugin actually used:
  `Peak 6096 of 18608 bytes (33%) · heap 6048 · stack 48`. It is the most stack
  + heap seen in use at any source line since the plugin was launched; **click it
  to reset**. Use it to check whether `#pragma dynamic` is needed and whether a
  code change helped: the *code* decides the peak, the pragma only decides the
  reserved size. The same code built without and with `#pragma dynamic 131072`
  reports the same peak against 18608 and 524288 bytes (33% vs 1.2%).
  - In SourcePawn, **local arrays live on the heap** (freed when the function
    returns); the stack only holds call frames and scalars, so the peak is
    mostly heap. Heap and stack share the one region, which is why they are
    added together.
  - It is sampled at every line (the same debug breaks the profiler uses), so a
    peak that rises and falls inside a single line is missed. It needs the
    plugin to be compiled with debug info, as debugging itself does. 2.0 plugins
    have no fixed region and no peak line.
  - It restarts when you launch/relaunch the plugin or reload it.

  It shows `-` until a plugin is being debugged. The Plugins total includes the
  live heap of 2.0 plugins (the VM's own estimate leaves it out).

The chart keeps updating while the server is paused at a breakpoint (the
request is served by the debugger's network thread, not the game thread), which
makes the CPU line drop to ~0% -- a quick way to see that a pause is in effect.
If the server stops answering, the last chart stays on screen with a
"no response" note; if the server restarts the history starts over.

CPU is measured per thread on Linux; the Windows path is untested. The
live heap of a 2.0 plugin is read from SourceMod's own allocator by its layout;
that is only available on Linux and has only been verified on 32-bit SourceMod
1.13. If the layout isn't recognised the cell shows `-` instead of guessing. See
the [`sp_performance` request](protocol.md#sp_performance) for the raw data.

## Function Profiler

The profiler records how long each function takes, so you can see what to
optimize. It does **not pause** the server — it accumulates timing while the game
runs, driven by the debug-break tracer, and it measures the plugin you are
debugging (see [Scope](#scope-this-plugin) below).

### Taking a profile

1. Start a SourcePawn debug session.
2. Open the **Take Performance Profile** action, from any of:
   - Right-click the session/thread in the **Call Stack** panel → **Take Performance Profile**
   - The title bar of the **SourcePawn Profiler** view (inside Run & Debug)
   - Command Palette → **SourcePawn: Take Performance Profile**
3. A "Recording SourcePawn profile" toast appears. **Reproduce the load** on the
   server (play, fire events, etc.).
4. Click **Cancel** on the toast to stop (or it auto-stops after 60 s).
5. The capture opens as a **flame chart** in VS Code's built-in profile viewer
   (the same UI the JavaScript debugger uses): flame graph, plus a table with
   self/total time and caller/callee navigation. The **SourcePawn Profiler**
   tree (in Run & Debug) is also populated.

### Reading the results

- **Self time** — time spent in the function itself, excluding callees. High
  self time = the function's own code is the bottleneck.
- **Total time** — self time plus everything it called. High total but low self
  = the cost is in what it calls.
- **Calls** — how many times it ran in the window. A cheap function called
  100,000× can still dominate.

- **Self per call — min / p95 / max** (node tooltip) — the spread behind the
  average. "One 40 ms call" and "4000 calls of 10 µs" have the same total and
  call for completely different fixes.
- **Hot lines** (node tooltip, and per-line heat in the flame chart) — which
  *line* of the function burned the time. This is also where the cost of a
  native shows up: the VM reports no scope of its own for natives, so an
  expensive `SQL_Query` / file / engine call appears on the line that called it.

In the flame chart, width = total time; in the table view, sort by **Self Time**
to find the hottest functions. The Profiler tree lists call paths heaviest-first
with `total ms · self ms · N×` on each node.

**Open Flame Chart of Last Profile** re-opens the most recent capture without
re-recording. **Clear Profiler Tree** empties the view.

### Timeline export (Perfetto)

A flame chart aggregates: it answers *"where did the time go overall"*. For a
game server the sharper question is usually *"which tick spiked, and what ran in
it"* — and that needs a timeline.

**Export Profile as Trace (Perfetto)** (profiler view title bar, or the Command
Palette) writes the same capture as a Chrome Trace Event document: one slice per
call, with its real begin and duration, top-level slices aligned to the server's
own callback boundaries. Open the file at
[ui.perfetto.dev](https://ui.perfetto.dev) (drag & drop — it runs locally, the
file is not uploaded) or in `chrome://tracing`.

The action reports how many spans were exported, and offers to copy the file
path or reveal it in your file manager.

### Important notes

<a name="scope-this-plugin"></a>
- **Scope: the plugin you are debugging.** A capture contains one tree — the
  debugged plugin's full call tree, including its callees. There used to be a
  toggle to a second, "all plugins" tree taken from the VM's own profiling hook,
  but that one is measured on a different clock and only at top-level call
  boundaries; putting the two behind one switch invited comparing numbers that
  are not comparable, so it was removed. (The VM hook still runs on the server —
  it is what tells the tracer exactly when the VM enters and leaves the plugin.)
- **Relative, not absolute.** Profiling (and line debugging) slow the VM, so
  treat the numbers as a **ranking** of what's expensive, not as production
  latency. Percentages are a share of the plugin's traced execution, not of wall
  time: idle between server frames is deliberately excluded.
- **Needs the VM's profiling hooks.** They come from the stock VM (no patched
  build): the public API on SourceMod 1.12, `sourcemod.logic.so`'s symbol table on
  1.13. If they are missing, the server logs
  `SourcePawn VM profiling hooks unavailable; 'All plugins' profiler disabled` and
  the Take Performance Profile action reports the profiler is unavailable. See
  [Troubleshooting](troubleshooting.md).

## Common Workflows

### Debugging a Function That Runs Every Frame

1. Set a **snapshot logpoint** on the first line of the function:
   ```
   {@all}
   ```
2. Let the server run for a few seconds. The Debug Console fills with snapshots.
3. Analyze the snapshots to understand the state at each frame.
4. **Server never freezes.** Players don't notice.

### Debugging a Crash

1. Set a **breakpoint** just before the crash happens (e.g., before a math operation that might divide by zero).
2. Run the server and trigger the crash condition.
3. The debugger pauses.
4. Inspect variables to see the bad state.
5. Step through the bad code to find where it breaks.

### Finding a Memory Leak

1. Add a **watch** for the global counter:
   ```
   > watch g_AllocCount
   ```
2. Let the server run for a while.
3. In the Variables panel, expand Globals and watch `g_AllocCount` change.
4. If it keeps growing, there's a leak.

### Conditional Breakpoint on a Specific Player

Set a **conditional breakpoint**:

```
player_id == 5
```

The breakpoint only fires when that player is involved.

## Timeout Configuration

### When Timeouts Matter

- **connection** (default 10s) — How long to wait for the initial TCP connection to the server. If the server is slow or far away, increase this.
- **request** (default 30s) — How long to wait for normal DAP requests (setBreakpoints, variables, stackTrace, etc.). Most requests complete in <100ms.
- **stepping** (default 60s) — How long to wait for continue/step/pause commands. If you're stepping through a large loop or the server is under heavy load, you might need more time.
- **keepalive** (default 15s) — Interval between keepalive pings. If you're paused for longer than this, the client sends a ping to make sure the connection is still alive.

### Adjusting Timeouts

Edit `.vscode/launch.json`:

```json
{
  "type": "sp-debugger",
  "request": "launch",
  "name": "Debug with Slow Network",
  "host": "your.server.ip",
  "port": 8080,
  "plugin": "${file}",
  "timeout": {
    "connection": 30000,   // 30 seconds for initial connection
    "request": 60000,      // 60 seconds for normal requests
    "stepping": 120000,    // 2 minutes for stepping
    "keepalive": 30000     // 30 seconds between pings
  }
}
```

## Troubleshooting

### Breakpoint Not Breaking

**Symptom:** You set a breakpoint, but execution doesn't pause.

**Cause:** The breakpoint is unverified (red circle with outline). This means the debugger couldn't find the line in the plugin's debug info.

**Solution:** Check [Path Mapping](troubleshooting.md#path-mapping) in the troubleshooting guide.

### "Debugger state: running" — Cannot Get Variables

**Symptom:** You try to hover over a variable while the plugin is running, and you see:

```
Cannot get ... - debugger state: running
```

**Cause:** Variables can only be inspected when paused.

**Solution:** Set a breakpoint or use a snapshot logpoint to capture state without pausing.

### Connection Timeout

**Symptom:** Debug Console shows:

```
[sp-dbg] Connection timeout after 10000 ms
```

**Cause:** The debugger couldn't connect to the server within the timeout.

**Solution:** Check that:
1. The server IP and port in `launch.json` are correct
2. The C++ extension is loaded on the server (`sm exts list`)
3. The server's firewall allows inbound traffic on the port
4. Increase the `connection` timeout in `launch.json` if the server is slow to respond

### Transport Errors in Debug Console

**Symptom:**

```
[sp-dbg] transport: parse error at byte 42. Malformed JSON?
```

**Cause:** A message was corrupted during transmission (rare, usually indicates a bug).

**Solution:** See [Transport Anomalies](troubleshooting.md#transport-anomalies).

---

That's the full feature set. Start with snapshot logpoints for observing a live server, and use pausing breakpoints on a test server for deep debugging.
