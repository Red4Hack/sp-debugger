# SourcePawn Debugger for VS Code

A remote debugger for SourcePawn plugins running on a live game server (CS:S, TF2, L4D2 -- any Source 1 game running SourceMod). Debug directly from VS Code — set breakpoints, inspect variables, step through code, and use the Debug Console REPL without modifying your plugin code or leaving the editor.

**Key Insight:** The debugger works like a traditional C++ debugger — you see source code, see where execution stops, and can inspect the full call stack and variable state at each frame.

This doc covers what the debugger does, how to use it, and how to build it. For detailed usage instructions, see [usage.md](usage.md).

## Quick Start

### For Plugin Developers (Users)

1. **Install** the extension from the VS Code Marketplace (search: "SourcePawn Debugger")
2. **Configure** a launch config in `.vscode/launch.json`:
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
         "plugin": "${file}"
       }
     ]
   }
   ```
3. **Deploy** the C++ extension to your server (copy `.so` files to `addons/sourcemod/extensions/`)
4. **Set breakpoints** by clicking the gutter in the editor
5. **Start debugging** with F5 and interact with the server

See [usage.md](usage.md) for detailed instructions on all debugger features.

### For C++/TypeScript Maintainers

This project consists of two parts:

- **C++ Extension** (`sp-console-debugger/`) — A SourceMod extension that runs on the game server and implements the DAP (Debug Adapter Protocol) server over TCP
- **VS Code Extension** (`vscode/`) — A TypeScript adapter that translates VS Code DAP requests to the protocol and manages the socket connection

See [architecture.md](architecture.md) for the full technical design.

## Critical Threading Model Warning

**The SourcePawn VM is single-threaded and NOT thread-safe. When a breakpoint fires, the entire game server freezes.** This is not a bug—it's inherent to running a debugger in-process on the main game thread. The non-freezing alternative is the **snapshot logpoint** feature (`{@all}`, `{@locals}`, `{@args}`), which captures variable snapshots and continues without pausing.

For production servers, use snapshot logpoints. For development/testing, use normal breakpoints with a dedicated test server.

## Feature Overview

| Feature | Status | Notes |
|---------|--------|-------|
| **Breakpoints** | ✓ Full | Normal, conditional, hit-count, logpoints, snapshot logpoints |
| **Call Stack** | ✓ Full | Multi-frame inspection with clickable source links |
| **Variables** | ✓ Full | Locals, arguments, globals, array expansion, typed rendering |
| **Stepping** | ✓ Full | Step Over/Into/Out + async pause |
| **Evaluation** | ✓ Full | Hover, watch expressions, Debug Console REPL |
| **Variable Edit** | ✓ Full | Inline set (including single array elements) |
| **Data Breakpoints** | ✓ Full | Watchpoints on global/static variables |
| **Memory Inspection** | ✓ Full | Hex viewer via `readMemory` |
| **Debug Console REPL** | ✓ Full | Type commands (`bt`, `p`, `x`, `break`, etc.) while paused |
| **Function Profiler** | ✓ Full | Non-pausing capture of the debugged plugin → flame chart with per-line heat, per-call min/p95/max, and a Perfetto timeline export (needs the VM profiling hooks, found automatically on the stock VM) |

## Architecture at a Glance

```
Developer's Machine (VS Code)
┌──────────────────────────────────────┐
│  VS Code Extension (TypeScript)      │
│  ├─ TcpConnection (socket framing)   │
│  ├─ DebugSessionManager (state)      │
│  └─ debugAdapter.ts (DAP translator) │
└──────────────────┬───────────────────┘
                   │ DAP over TCP
                   │ Content-Length framing
                   │ 10.0.0.5:8080
                   ▼
        Game Server Network
               │
               ▼
┌──────────────────────────────────────┐
│  Game Server (CS:S, TF2, ...)        │
│  ├─ Main Thread (SourcePawn VM)      │
│  │   └─ Plugin executes              │
│  │       OnDebugBreak() → parks      │
│  │       VM thread in condition      │
│  │       variable                    │
│  └─ TCP Thread                       │
│      └─ DAPHandlers (process cmds)   │
│          RequestRegistry (match seq) │
│          VariableHandleRegistry      │
└──────────────────────────────────────┘
```

**Key Insight:** The C++ extension listens on a TCP port (default 8080) and speaks the exact DAP wire protocol that VS Code expects. The VS Code extension just forwards requests and collects responses. No custom protocol translation needed.

## Documentation Map

- **[usage.md](usage.md)** — How to use every debugger feature (for plugin developers)
  - Installation and setup
  - Breakpoints, stepping, variable inspection
  - Snapshot logpoints (the non-freezing way to observe a live server)
  - Debug Console REPL
  - Troubleshooting common issues

- **[architecture.md](architecture.md)** — Deep technical design (for maintainers)
  - Component architecture and responsibilities
  - Threading model and synchronization
  - DAP command flow and state management
  - Symbol resolution and variable rendering
  - Handle registry (scope encoding)

- **[protocol.md](protocol.md)** — Wire protocol and framing (for protocol maintainers)
  - Content-Length framing (byte-accurate, UTF-8 handling)
  - DAP message format and validation
  - Request/response correlation (seq/request_seq)
  - Event ordering constraints (continued before SetRunmode)
  - TCP connection lifecycle

- **[troubleshooting.md](troubleshooting.md)** — Known issues and solutions
  - The freeze model (why it happens, how to avoid it)
  - Transport anomalies (buffer re-sync, parse errors, orphan responses)
  - Path mapping and source discovery
  - Timeout configurations
  - Reconnection behavior

- **[Testing](../vscode/tests/dap/README.md)** — CI regression tests and dev tools
  - Regression test suite and mock environment setup
  - Unit suite (`bun test`) + DAP integration test + headless dev tools
  - Mock mode and remote mode (real server)

## Building

### C++ Extension

Built from the repo root. The `sp-console-debugger/` source tree is **not**
committed — it is reconstructed from the pinned upstream commit plus our patch
(the "Fetch Debugger Source" VS Code task does this automatically; see
[updating-upstream.md](updating-upstream.md) for the manual commands).

```bash
# 1. Reconstruct sp-console-debugger/ if missing (fetch task or manual commands)
# 2. Configure + build:
.venv/bin/python configure.py --enable-optimize --targets=x86,x86_64 \
    --sm-path=../sourcemod
.venv/bin/ambuild objdir
# Output: objdir/package/addons/sourcemod/extensions/{,x64/}sp-debugger.ext.so
```

Requires:
- A stock SourceMod source tree (1.12-dev or master, submodules initialised; no VM patch) at `../sourcemod`
- Python venv with ambuild at `.venv/`

### VS Code Extension

```bash
cd vscode
bun run compile
# Output: out/
```

Requires: bun at `~/.bun/bin/bun`

## Deploying to a Server

1. Copy the `.so` files:
   ```bash
   scp objdir/package/addons/sourcemod/extensions/sp-debugger.ext.so \
       user@server:/home/srcds/csgo/addons/sourcemod/extensions/
   scp objdir/package/addons/sourcemod/extensions/x64/sp-debugger.ext.so \
       user@server:/home/srcds/csgo/addons/sourcemod/extensions/x64/
   ```

   The config file is **not** copied manually — the extension writes a default
   `addons/sourcemod/configs/console-debugger.cfg` on first load. Edit it later
   only if you need a non-default port or verbose logging.

2. **Full game-server restart required** (critical):
   ```bash
   # Option A: Stop and start the process
   pkill -f srcds  # or your server stop command
   # Wait for graceful shutdown, then start the server again
   
   # Option B: In-game command (if available)
   _restart
   ```
   
   **Do NOT use `sm exts load` or `sm exts reload`** — these load the extension "late" (after plugins are already running), which skips the critical VM initialization step. Use only after a full process restart.

3. Verify it's loaded:
   ```
   sm exts list
   ```
   Should show `[01] SourceMod Console Debugger [RUNNING]`

## Configuration

The C++ extension writes a self-documenting `addons/sourcemod/configs/console-debugger.cfg`
the first time it loads and reads it at every startup thereafter. An existing
file is never overwritten, so your edits are preserved across updates:

```cfg
"ConsoleDebugger"
{
    "bind"         "127.0.0.1"
    "token"        ""
    "max_clients"  "4"
    "port"         "8080"
    "debug_log"    "0"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `bind` | `127.0.0.1` | Address the DAP server listens on. |
| `token` | *(empty)* | Shared secret the debugger client must present. |
| `max_clients` | `4` | Concurrent debugger connections allowed (1–64). |
| `port` | `8080` | TCP port (1–65535). |
| `debug_log` | `0` | Verbose transport logging. |

Deleting the file regenerates the documented default on the next load.
The VS Code launch config must use the same port, token and server address.

### Why the listener is loopback-only by default

A debug session is not a read-only view: over that socket a client can read and
write the debugged plugin's memory, and a breakpoint holds the game thread until
the client resumes it. An open, unauthenticated debug port is therefore
equivalent to handing out control of the plugins.

So the defaults are deliberately closed:

* `bind` is `127.0.0.1`, reachable only from the machine itself.
* Exposing it further **requires** a token: with a non-loopback `bind` and an
  empty `token`, the extension logs an error and does not open the port at all.
* With a token set, every request except `initialize`/`disconnect` is refused
  until the client presents it (in `launch`/`attach`/`initialize`), and a client
  that never authenticates is dropped after 15 seconds.

**Debugging a remote server is best done over an SSH tunnel**, which keeps the
port closed to everyone else and needs no token:

```bash
ssh -L 8080:127.0.0.1:8080 user@gameserver
# then point launch.json at "host": "127.0.0.1"
```

If you would rather expose the port directly, set both keys and put the same
secret in `launch.json`:

```cfg
"bind"   "0.0.0.0"
"token"  "a-long-random-string"
```

```jsonc
{ "type": "sp-debugger", "request": "launch", "host": "your.server.ip",
  "port": 8080, "token": "a-long-random-string", "plugin": "${file}" }
```

## License

GNU General Public License v3.0. See [LICENSE](../LICENSE) for details.

Original extension by Peace-Maker. Rewritten for DAP (Debug Adapter Protocol) support.

---

**Questions?** Read the troubleshooting guide or the architecture docs. This is a complex system with multiple threads, TCP framing, and SourcePawn VM internals — some knowledge of each layer helps.
