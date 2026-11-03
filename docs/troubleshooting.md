# SourcePawn Debugger — Troubleshooting Guide

This guide addresses common issues and their solutions. It's organized by symptom, with root-cause analysis and mitigation strategies.

**Audience:** Plugin developers using the debugger, and support engineers

## Table of Contents

1. [The Freeze Model](#the-freeze-model)
2. [Connection Issues](#connection-issues)
3. [Breakpoint Issues](#breakpoint-issues)
4. [Variable Inspection Issues](#variable-inspection-issues)
5. [Transport Anomalies](#transport-anomalies)
6. [Profiler Issues](#profiler-issues)
7. [SourceMod & VM Compatibility](#sourcemod--vm-compatibility)
8. [Timeout Issues](#timeout-issues)
9. [Path Mapping](#path-mapping)
10. [Reconnection Behavior](#reconnection-behavior)
11. [Performance Considerations](#performance-considerations)

## The Freeze Model

### Why Does the Server Freeze When I Hit a Breakpoint?

**Answer:** The SourcePawn VM is single-threaded and runs on the game server's main thread. When a breakpoint fires, the VM thread blocks in a condition variable until the DAP client sends a continue command. While the main thread is blocked:

- The game loop doesn't advance
- Physics doesn't update
- Network packets aren't processed
- All players appear frozen

**This is not a bug.** It's inherent to running an in-process debugger on a live game server. You cannot have interactive debugging without freezing.

### How Long Does the Server Freeze?

The freeze lasts from when the breakpoint fires until you click Continue (or timeout). Typical freeze times:

- Normal breakpoint hit → inspect variables → continue: **10-30 seconds**
- Stepping through code: **seconds to minutes** (depending on code complexity)
- Paused with no interaction: **indefinite** (until you resume or the session times out)

### How to Avoid Freezing Production Servers

Use **snapshot logpoints** instead of pausing breakpoints:

```
{@all}
```

Snapshot logpoints capture variable state and continue immediately — no freeze. The downside is you can't interact with the debugger (step, inspect other variables); you just get snapshots.

**Best practice:**
- **Production servers:** Snapshot logpoints only
- **Staging/test servers:** Pausing breakpoints for interactive debugging
- **Development:** Whatever makes you most productive

### Can I Reduce Freeze Time?

Partially:

1. **Use snapshot logpoints** — The only way to observe a live server without freezing
2. **Set breakpoints strategically** — Don't break on every frame; use conditional breakpoints
3. **Use hit-count breakpoints** — Break every Nth iteration, not on every hit
4. **Avoid stepping in tight loops** — Instead, set a breakpoint after the loop and continue
5. **Close unused panels** — Variable expansion is lazy (on-demand), so closing unused panels might save a few milliseconds

## Connection Issues

### "Connection timeout after 10000 ms"

**Symptom:** Debug Console shows:

```
[sp-dbg] Connection timeout after 10000 ms
```

**Causes:**

1. Server IP/port in launch.json is wrong
2. C++ extension is not loaded on the server
3. Server firewall blocks the port
4. Network latency is high (> 10 seconds to establish TCP connection)

**Solutions:**

1. **Verify the server IP and port:**
   ```json
   {
     "type": "sp-debugger",
     "request": "launch",
     "name": "Debug",
     "host": "your.server.ip",
     "port": 8080,
     "plugin": "${file}"
   }
   ```
   Check with `ping your.server.ip`.

2. **Verify the extension is loaded:**
   ```
   sm exts list
   ```
   Should show `[01] SourceMod Console Debugger [RUNNING]`.

   If not, the extension binary is missing or failed to load. Check the log:
   ```
   addons/sourcemod/logs/errors_*.log
   ```

3. **Check firewall:**
   ```bash
   sudo ufw allow 8080/tcp  # On Linux
   ```

4. **Increase the connection timeout:**
   ```json
   {
     "type": "sp-debugger",
     "request": "launch",
     "name": "Debug with Slow Network",
     "host": "your.server.ip",
     "port": 8080,
     "plugin": "${file}",
     "timeout": {
       "connection": 30000
     }
   }
   ```

### "Cannot connect to server" / Connection Refused

**Symptom:** Debug Console shows:

```
[sp-dbg] Cannot connect: ECONNREFUSED
```

**Causes:**

1. Server is not running
2. Port is wrong (C++ extension is listening on a different port)
3. Server crashed after the extension loaded

**Solutions:**

1. **Verify the server is running:**
   ```bash
   ssh user@server "ps aux | grep srcds"
   ```

2. **Verify the extension port matches launch.json:**
   - In `addons/sourcemod/configs/console-debugger.cfg`:
     ```cfg
     "ConsoleDebugger" {
       "bind" "127.0.0.1"
       "port" "8080"
     }
     ```
   - In `.vscode/launch.json`:
     ```json
     "port": 8080
     ```

3. **Connecting from another machine?** The listener is loopback-only by
   default, so a remote `host` in `launch.json` will simply never connect. Either
   tunnel it (`ssh -L 8080:127.0.0.1:8080 user@gameserver` and use
   `"host": "127.0.0.1"`), or set `bind` plus a non-empty `token` in the config
   and the same `token` in `launch.json`. With a non-loopback `bind` and no
   token the server logs *"Refusing to expose the debugger ... without
   authentication"* and never opens the port.

4. **Requests failing with "Authentication required"?** The server has a `token`
   configured and the launch configuration does not carry the same value. Copy it
   from `console-debugger.cfg` into `"token"` in `launch.json`.

5. **Check if the extension loaded successfully:**
   ```
   sm exts list
   ```

6. **Restart the extension:**
   ```
   sm exts reload console-debugger
   ```
   or change map / restart the server.

### "Unexpected close" / Connection Lost During Debug Session

**Symptom:** Debug Console shows:

```
[sp-dbg] Unexpected close
```

And the session terminates.

**Causes:**

1. Network connection dropped (packet loss, timeout)
2. Server crashed or restarted
3. Extension was reloaded on the server (`sm exts reload`)

**Solutions:**

1. **Enable automatic reconnection:**
   ```json
   {
     "type": "sp-debugger",
     "request": "launch",
     "name": "Debug with Reconnect",
     "host": "your.server.ip",
     "port": 8080,
     "plugin": "${file}",
     "reconnect": {
       "enabled": true,
       "maxAttempts": 5,
       "baseDelay": 1000,
       "maxDelay": 30000
     }
   }
   ```

2. **Check server stability:**
   - Look for crashes in the error log: `addons/sourcemod/logs/errors_*.log`
   - Monitor server CPU/memory: `top`, `vmstat`
   - Check if the extension is being reloaded automatically

3. **Increase keepalive interval:**
   ```json
   {
     "timeout": {
       "keepalive": 30000
     }
   }
   ```
   A longer keepalive interval reduces false-positive timeouts on slow networks.

## Breakpoint Issues

### "Failed to start debugging the specified plugin" (launch fails, nothing verifies)

**Symptom:** Starting the session shows `launch` failing with *"Failed to start
debugging the specified plugin"*, no `Successfully started debugging` line, and
**every** breakpoint/logpoint comes back unverified. A headless probe shows
`launch.success = false` and `setBreakpoints` returning an empty `breakpoints` array.

**Root cause (in order of likelihood):**

1. **The extension was loaded *late*.** It only enables line debugging in the VM
   when loaded at server **startup** (non-late). `sm exts load` / `sm exts reload`
   load it late, skipping that step, so already-loaded plugins are not debuggable.
   → **Do a full game-server restart** after deploying the `.so` (stop + start, or
   `_restart`). `sm exts reload` is not enough.
2. **`EnableLineDebugging` is off.** In `addons/sourcemod/configs/core.cfg` set
   `"EnableLineDebugging" "yes"`, then restart the server.
3. **The plugin isn't actually loaded.** If the target plugin depends on another
   plugin/extension (e.g. SourceBans) that is missing or errored, the plugin
   never loads and can't be debugged. Confirm it is `[RUNNING]`/loaded in
   `sm plugins list` first.

### Breakpoint Not Breaking (Unverified Breakpoint)

**Symptom:** You set a breakpoint (red dot in the gutter), but execution never pauses. The breakpoint is **unverified** (red circle with an outline).

**Causes:**

1. **Launch failed to bind the plugin** — see the section just above (late-loaded
   extension, `EnableLineDebugging`, or unmet plugin dependency)
2. **Path mapping failure** — The debugger can't find the source file
3. **No debug info** — Plugin was compiled without debug symbols (`-g`)
4. **Line has no code** — The line is empty or only whitespace

**Solutions:**

1. **Ensure debug info is compiled:**
   ```bash
   spcomp -g -o plugin.smx plugin.sp
   ```
   The `-g` flag adds debug symbols.

2. **Check path mapping** (see [Path Mapping](#path-mapping) below)

3. **Set breakpoint on an executable line:**
   - Don't break on blank lines or comment-only lines
   - Don't break on function declarations; break on the first statement inside

### Conditional Breakpoint Never Fires

**Symptom:** You set a conditional breakpoint like `x > 5`, but it never pauses even though `x` should be > 5.

**Causes:**

1. **Variable name is wrong** — The condition refers to a variable that doesn't exist
2. **Variable is out of scope** — The variable doesn't exist at that line
3. **Condition syntax error** — The condition is malformed

**Solutions:**

1. **Check the variable name:**
   - Hover over the variable in the editor to verify its name
   - Use the Debug Console to test: `p x` (while paused)

2. **Verify the variable is in scope:**
   - Set a pausing breakpoint on the same line (without condition)
   - Check the Variables panel to see if the variable is listed
   - If not listed, it's out of scope

3. **Check the condition syntax:**
   - Supported operators: `==`, `!=`, `<`, `<=`, `>`, `>=`
   - Single comparison only; no `&&` or `||`
   - Example: `health < 10` (correct), `health < 10 && armor > 5` (wrong)

### Hit-Count Breakpoint Fires Too Often

**Symptom:** You set a hit-count breakpoint, but it doesn't fire when you expected.

**Cause:** This debugger **only supports a plain positive integer**, not operators. Operator forms like `>= 10`, `== 10`, `% 5` are **not** parsed by the server and will be rejected as invalid.

**Solution:** Use a plain integer only:

- `3` — Break starting from the 3rd hit onward (3rd, 4th, 5th, etc.)
- `10` — Break starting from the 10th hit onward
- `1` — Same as no hit condition (break on every hit)

If the hit condition field shows invalid, the breakpoint will be unverified.

## Variable Inspection Issues

### "Cannot get ... - debugger state: running"

**Symptom:** You hover over a variable while the plugin is running (not paused), and you see:

```
Cannot get ... - debugger state: running
```

**Cause:** Variables can only be inspected when paused.

**Solution:** Set a breakpoint or use a snapshot logpoint to capture state.

### Variable Shows "not in scope"

**Symptom:** A variable in the Variables panel shows:

```
x: (not in scope)
```

**Causes:**

1. The variable's codestart/codeend range doesn't include the current line
2. The variable is a local/argument, and execution is outside the function

**Solution:**

- This is expected behavior. Locals are only in scope during the function's execution.
- If you think the variable should be in scope, check the function's range with `bt` in the Debug Console.

### Cannot Expand Arrays or Structs

**Symptom:** An array or struct variable has no expansion arrow (▶), so you can't see its contents.

**Causes:**

1. **No debug info** — Plugin was compiled without `-g` flag
2. **Variable is a primitive** — Primitives (int, float, bool) can't be expanded

**Solution:**

Compile with `-g`:
```bash
spcomp -g -o plugin.smx plugin.sp
```

### Variable Shows Hex (0x42) Instead of Type Name

**Symptom:**

```
unknown_var: 0x42
```

**Cause:** No debug info for this variable.

**Solution:** Compile with `-g`.

## Transport Anomalies

### "transport: parse error at byte X"

**Symptom:** Debug Console shows:

```
[sp-dbg] transport: parse error at byte 42. Malformed JSON?
```

**Causes:**

1. **UTF-8 encoding error** — A message body contains invalid UTF-8
2. **JSON syntax error** — The message is not valid JSON
3. **Buffer corruption** — Data was corrupted in transit (rare)

**Solutions:**

1. **Check for special characters in plugin output:**
   - If the plugin prints strings with non-ASCII characters (e.g., CS color codes like "»"), ensure the characters are valid UTF-8
   - See [Byte-Accurate UTF-8 Handling](protocol.md#byte-accurate-utf8-handling)

2. **Check the error log for clues:**
   ```
   addons/sourcemod/logs/errors_*.log
   ```

3. **Enable debug logging:**
   ```json
   "env": {
     "DEBUG": "sp-debugger:*"
   }
   ```

### "buffer re-sync: discarded N bytes"

**Symptom:** Debug Console shows:

```
[sp-dbg] transport: buffer re-sync at byte 150. Discarded 42 bytes.
```

**Causes:**

1. A message was corrupted, and the client lost frame synchronization
2. The next message's header was partially read as part of the previous body

**Solutions:**

This usually indicates a timing/threading bug in the C++ extension or a network issue. Check:

1. **Server logs for crashes:**
   ```
   addons/sourcemod/logs/errors_*.log
   ```

2. **Enable TCP keepalive** to detect stale connections:
   ```json
   {
     "timeout": {
       "keepalive": 15000
     }
   }
   ```

3. **Restart the debug session** — This usually clears the issue.

### "orphan response for seq X"

**Symptom:** Debug Console shows:

```
[sp-dbg] transport: orphan response for seq 5. Timed out?
```

**Causes:**

1. **Response timeout** — Request timed out before response arrived, client already gave up
2. **Request was never sent** — Client has a bug
3. **Response arrived after timeout** — Network latency exceeded timeout

**Solutions:**

1. **Increase the request timeout:**
   ```json
   {
     "timeout": {
       "request": 60000
     }
   }
   ```

2. **Check network latency:**
   ```bash
   ping your.server.ip
   ```

3. **Restart the session** — Orphan responses are usually harmless.

## Profiler Issues

### "Profiler unavailable" / "SourcePawn v2 engine unavailable; function profiler disabled"

**Symptom:** "Take Performance Profile" reports the profiler is unavailable, and
the server log (`addons/sourcemod/logs/...`) shows
`SourcePawn v2 engine unavailable; function profiler disabled`, preceded by a
`[profiler-init] ...` line.

**Cause:** the VM's profiling hooks weren't found. They come from the stock VM:
the public `ISourcePawnEngine2` on 1.12, `sp::Environment::{SetProfilingTool,
EnableProfiling, DisableProfiling}` from `sourcemod.logic.so`'s symbol table on
1.13 (see [SourceMod & VM Compatibility](#sourcemod--vm-compatibility)). Look for
a `[debug-init] ...` line in the SourceMod log:

- `could not open VM library at .../sourcepawn.vm.so` on a **32-bit** server —
  the 32-bit VM is `sourcepawn.jit.x86.so`; make sure you deployed the **x86**
  extension build.
- `no live SourcePawn environment` — the library opened but isn't the VM the
  server is running.
- On 1.13: `cannot reach the SourcePawn VM debug hooks` — see above.

**Solutions:** deploy the package for your SourceMod line and architecture, and
**fully restart** the server (not `sm exts reload`) so the extension registers the
profiling tool before plugins run.

Note: regular breakpoints can work even when the profiler can't initialize.

### Profile shows functions from other plugins

**Not a bug.** Profiling is VM-wide — `EnterScope`/`LeaveScope` carry no plugin
context, so the capture includes every plugin that ran. Functions are qualified
(`plugin.smx::Function`) so you can tell them apart. Filter by name in the
flame-chart table if you only care about one plugin.

### Profiling numbers look slower than production

**Expected.** Profiling (and line debugging) add per-call overhead and slow the
VM. Use the results as a **relative ranking** of what's expensive, not as
absolute production latency.

## SourceMod & VM Compatibility

The debugger runs on the **stock, unmodified SourcePawn VM** of SourceMod 1.12
and 1.13. Nothing but `sp-debugger.ext.so` is deployed. Build one package per
SourceMod line: the extension API version is baked in from the SDK headers, so a
1.13 build is refused by 1.12 (*"Extension version is too new to load"*).

| | SourceMod 1.12 | SourceMod 1.13 (SourcePawn 2.0) |
|---|---|---|
| VM | `sourcepawn.jit.x86.so` / `x64/sourcepawn.vm.so`, `dlopen`ed by SourceMod | linked into `sourcemod.logic.so` |
| Debug-break hook | public `SetDebugBreakHandler`; extension calls `EnableDebugBreak` at startup | `sp::Environment::*` resolved from `logic.so`'s `.symtab` |
| `core.cfg` | nothing (no such option) | `"EnableLineDebugging" "yes"` |
| Debuggable plugins | all | all: default `spcomp` (SMX v2) and `oldspcomp` (SMX v1) |
| Platform | Linux (Windows untested) | Linux only |

Startup prints which path was taken:
`SourcePawn debugger attached: SourcePawn 1.x, stock sourcepawn.jit.x86 (public split API)`
or `... SourcePawn 2.0, stock sourcemod.logic (sp::Environment via .symtab)`.

### Every plugin fails with "Unable to load plugin (invalid global variable address)" (SourceMod 1.12)

**Cause:** a bug in the stock 1.12 VM that only shows once line debugging is on.
`spcomp` 1.12 puts one constant-marker symbol (address `0x80000000`) in the
`.dbg.globals` of *every* plugin, and `SmxV1Image::validateDebugVariables()`
(with `validateSymbolAddress()` inlined) rejects it. Nothing in 1.12 turns line
debugging on by itself, so the bug never showed until a debugger did.

**What the extension does:** at startup, before any plugin loads, it overwrites
that validator in memory with `mov eax,1 ; ret` (6 bytes, x86 and x86_64; resolved
from the VM library's `.symtab`, and left alone if the symbol is missing). The VM
never uses these addresses to run code and the extension re-validates them itself.
The log shows `[debug-init] relaxed stock VM debug-symbol validation`.

If you still see the error: the extension loaded *late* (`sm exts load`) — restart
the server; the line is absent (non-Linux, stripped VM library, or the extension
isn't loaded before plugins). Recompiling the plugins does not help.

### "No debug info for <plugin>.smx: ..." (any SourceMod)

The extension reads the plugin's own `.smx`, so it needs debug sections in it
(`spcomp -g`, the default). The text after the colon says which table is bad
(`cannot parse .smx: <reason>`) or that the file has none. The plugin keeps
running; it just can't be stopped in.

### Breakpoint on a v2 plugin doesn't stop (SourceMod 1.13)

SourcePawn 2.0 lowers bytecode lazily, so several source lines can start at the same
low-level instruction and the VM only reports the first one. The extension recovers
the others (`[debug-init] SourcePawn 2.0 line-boundary hook installed` in the
SourceMod log confirms it is active, and `debug_log` `1` prints the affected groups as
`[v2-lines] pc N: ... (hidden -> hooked)`).

If that line is missing, the hook could not be installed -- the log says why (it needs
exactly one call to `SmxImage::IsLineBoundary` in the interpreter, so a different
SourcePawn build is not hooked) and lines whose first operation shares an instruction
with an earlier line may not stop.

### v2 plugin: server slower while debugging (SourceMod 1.13)

The 2.0 VM only calls a debugger from its interpreter. When a client starts
debugging a v2 plugin the extension turns the JIT off for the whole VM and turns it
back on when the last client leaves (it won't re-enable a JIT you disabled yourself).
Legacy plugins don't need this and keep the JIT.

### "cannot reach the SourcePawn VM debug hooks: ..." (SourceMod 1.13)

On 1.13 the hooks are found in `sourcemod.logic.so`'s symbol table. Official
builds are not stripped. The message tells you what is missing:
`has no .symtab (stripped build?)`, or `sp::Environment::{get,...} not found`.
A custom build with stripped symbols is not supported. It also refuses to hook if
`Environment::get()` is not the engine SourceMod handed over.

### "Failed to install debugger in the SourcePawn VM"

Line debugging is off. On 1.13 set `"EnableLineDebugging" "yes"` in `core.cfg`; on
both lines the extension must load at **server start** — a late load can't enable
it because plugins are already compiled.

### "SourcePawn VM API mismatch"

The package doesn't match the SourceMod line (a 1.12 build on 1.13 or the
reverse). Use the `sm1.12` or `sm1.13` package.

### Server crashed in the extension

Run `coredumpctl gdb` (or open the core) on the server binary. Frames in
`SpPluginDebugInfo`/`BreakpointManager` point at debug-info handling — please
report with `debug_log` set to `1` in `console-debugger.cfg`.

## Timeout Issues

### Stepping Command Timeout

**Symptom:** You click Step Over, and after 60 seconds, the debugger shows:

```
[sp-dbg] Stepping timeout after 60000 ms. Debugger state: running.
```

**Causes:**

1. **Stepping through a tight loop** — The loop is executing many iterations
2. **Server is under heavy load** — Slow to respond
3. **Network latency is high** — Responses take too long to arrive

**Solutions:**

1. **Increase the stepping timeout:**
   ```json
   {
     "timeout": {
       "stepping": 120000
     }
   }
   ```

2. **Use a breakpoint instead of stepping:**
   ```
   // Instead of:
   for (int i = 0; i < 1000000; i++) { ... }  // Don't step through this

   // Set a breakpoint after the loop
   ```

3. **Reduce server load:**
   - Kill other plugins
   - Reduce player count
   - Close other debug sessions

### Normal Request Timeout

**Symptom:** A normal DAP request (variables, stackTrace) times out after 30 seconds.

**Causes:**

1. **Server is extremely slow**
2. **Network packet loss**
3. **C++ extension is hanging**

**Solutions:**

1. **Increase the request timeout:**
   ```json
   {
     "timeout": {
       "request": 60000
     }
   }
   ```

2. **Check server health:**
   - CPU usage: `top`
   - Memory usage: `free -h`
   - Disk I/O: `iostat`

3. **Restart the extension:**
   ```
   sm exts reload console-debugger
   ```

## Path Mapping

### Unverified Breakpoints (Can't Find Source File)

**Symptom:** You set a breakpoint, but it stays **unverified** (red circle with outline). The VS Code status bar shows:

```
SourcePawn: Breakpoint verification failed
```

**Root cause:** The debugger can't map the source file path from the compiled binary to your local workspace.

### How Path Mapping Works

When you compile a plugin with `spcomp`, the debug info includes the **absolute file path** used during compilation. For example:

```
/path/to/server/addons/sourcemod/scripting/myplugin.sp
```

When you open the file in VS Code, your local workspace might have a different path:

```
/Users/me/projects/antibhop/antibhop.sp
```

The debugger must map the compiler's path to your local path. It does this by:

1. Extracting the filename from the compiler's path: `antibhop.sp`
2. Searching your workspace for a file with that name: `antibhop.sp`
3. Using the local path for breakpoint resolution

### When Path Mapping Fails

**If multiple files have the same name:** The mapper picks the first match. This can be wrong if you have:

```
plugins/module1/antibhop.sp
plugins/module2/antibhop.sp
```

**Solution:** Rename one file, or use full paths in the workspace.

**If the file name is not unique:** Some files are named generically (e.g., `constants.inc`, `helpers.sp`). If multiple matches exist, the mapper picks the first one, which might not be correct.

**Solution:** Rename files to be unique, or explicitly map in `launch.json`:

```json
{
  "type": "sp-debugger",
  "request": "launch",
  "name": "Debug",
  "host": "your.server.ip",
  "port": 8080,
  "plugin": "${file}",
  "sourceRoot": "${workspaceFolder}"
}
```

(Currently, explicit path mapping is not implemented, but you can open an issue on GitHub to request it.)

### Workaround: Recompile with Correct Paths

If you control the build system, recompile the plugin with paths that match your local workspace:

```bash
# Build on a local machine (not the server)
spcomp -g -o plugin.smx /path/to/local/plugin.sp
# Debug info will use /path/to/local/... paths, matching your workspace
```

## Reconnection Behavior

### How Reconnection Works

If the connection is lost, the client automatically reconnects (if enabled):

```json
{
  "reconnect": {
    "enabled": true,
    "maxAttempts": 5,
    "baseDelay": 1000,
    "maxDelay": 30000
  }
}
```

**Backoff algorithm:**

1. First retry: 1000 ms after disconnect
2. Second retry: ~1500 ms (1000 * 1.5)
3. Third retry: ~2250 ms (1500 * 1.5)
4. ...
5. Capped at 30000 ms (maxDelay)

After 5 failed attempts, the session terminates.

### When Reconnection Fails

If reconnection fails after maxAttempts, the Debug Console shows:

```
[sp-dbg] Reconnection failed after 5 attempts. Terminating session.
```

**Causes:**
1. Server is still down
2. Extension crashed on the server
3. Network is unreachable

**Solution:**
- Check server status
- Restart the extension: `sm exts reload console-debugger`
- Restart the debug session in VS Code

### Disabling Reconnection

If you want to fail fast instead of retrying:

```json
{
  "reconnect": {
    "enabled": false
  }
}
```

## Performance Considerations

### Large Array Expansion

**Issue:** Expanding a large array (e.g., 10,000 elements) in the Variables panel can be slow.

**Reason:** The debugger must fetch the size and render each element, which involves multiple symbol lookups and memory reads.

**Mitigation:**
- Don't expand huge arrays in the UI
- Use the Debug Console to inspect specific indices: `g_PlayerData[500]`
- Use conditional breakpoints to narrow down the problem

### Deeply Nested Structs

**Issue:** Expanding a struct that contains other structs (nested 5+ levels) is slow.

**Reason:** Each expansion requires symbol lookups and memory reads.

**Mitigation:**
- Use the Debug Console: `p my_struct` instead of expanding in the UI
- Break on a more specific condition

### Many Breakpoints

**Issue:** Setting 50+ breakpoints slows down the debugger.

**Reason:** Each time execution pauses, the debugger checks all breakpoints.

**Mitigation:**
- Use conditional breakpoints or hit-count breakpoints
- Clear breakpoints you're not using: `break clear all` in the Debug Console
- Use snapshot logpoints instead

### Frame Iteration Performance

**Issue:** Getting the call stack at a deep frame (10+ levels) is slow.

**Reason:** The debugger must walk the frame iterator, which involves checking code ranges for each frame.

**Mitigation:**
- Usually not a problem in practice (most call stacks are < 5 frames)
- If it is slow, you can reduce the number of frames shown using the Debug Console: `bt` shows only the first few

---

**Still stuck?** Check the [architecture.md](architecture.md) and [protocol.md](protocol.md) for deep technical details, or open an issue on GitHub with a Debug Console log.
