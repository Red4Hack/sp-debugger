# SourcePawn Debugger for VS Code

A remote debugger for SourcePawn plugins running on a live game server (CS:S, TF2, L4D2 -- any Source 1 game running SourceMod). Debug directly from VS Code — set breakpoints, inspect variables, step through code, and use the Debug Console REPL without modifying your plugin code.

## What It Does

- **Breakpoints** — Normal, conditional, hit-count, logpoints, and snapshot logpoints (non-freezing observation)
- **Variable Inspection** — Locals, arguments, globals, arrays, structs with type-aware rendering
- **Stepping** — Step over, step into, step out, and async pause
- **Debug Console REPL** — Type commands (`bt`, `p`, `x`, `break`, `set`, etc.) while paused
- **Data Breakpoints** — Watchpoints on global/static variables
- **Memory Inspection** — Hex viewer
- **Function Profiler** — Non-pausing capture with flame chart (per-line heat), per-call min/p95/max, and a Perfetto timeline export

**Key feature:** Snapshot logpoints (`{@all}`, `{@locals}`, `{@args}`) capture variable state and continue immediately without freezing the server — ideal for production debugging.

## Quick Start

### Users: Download and Deploy

1. **Download** from GitHub Releases:
   - `sp-debugger.vsix` — VS Code extension
   - `sp-debugger-server-<os>-<sm>.tar.gz` (Linux) or `.zip` (Windows) — Server package (includes the patched SourcePawn VM)

   **Pick the package matching your server's SourceMod line**: `sm1.12` for
   stable SourceMod 1.12, `sm1.13` for 1.13-dev builds. Using the wrong one
   fails at load with *"Extension version is too new to load (9, max is 8)"*
   (or the extension API mismatch in the other direction).

2. **Install VS Code extension:**
   ```
   Extensions → Install from VSIX → select sp-debugger.vsix
   ```

3. **Deploy server package:**
   ```bash
   # Extract into your game server root
   tar xzf sp-debugger-server-linux-sm1.12.tar.gz -C /path/to/server/
   ```

4. **CRITICAL: Full game-server restart required**
   ```bash
   # Stop and restart the process — do NOT use sm exts load/reload
   # The extension only enables line debugging at startup (non-late load)
   ```

5. **Verify it's loaded:**
   ```
   sm exts list
   # Should show: [01] SourceMod Console Debugger [RUNNING]
   ```

6. **Configure** `.vscode/launch.json`:
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

The config file `addons/sourcemod/configs/console-debugger.cfg` is auto-generated on first load (port 8080 default).

> **The debug port listens on `127.0.0.1` only.** A debug session can read and write plugin memory and can freeze the server on a breakpoint, so it is not exposed to the network by default. To debug a remote server, tunnel it — `ssh -L 8080:127.0.0.1:8080 user@gameserver`, then point `host` at `127.0.0.1`. To expose it directly instead, set both `bind` and a non-empty `token` in the config (and the same `token` in `launch.json`); with a non-loopback `bind` and no token the extension refuses to open the port. See [docs/README.md](docs/README.md#configuration).

## Building from Source

The `sp-console-debugger/` source tree is not committed — it is reconstructed at build time from `patches/sp-console-debugger.commit` (pinned upstream commit) plus `patches/sp-console-debugger.patch` (our changes).

1. **Fetch upstream + patch:**
   ```bash
   git init sp-console-debugger
   git -C sp-console-debugger fetch --depth 1 https://github.com/peace-maker/sp-console-debugger "$(cat patches/sp-console-debugger.commit)"
   git -C sp-console-debugger reset --hard FETCH_HEAD
   git -C sp-console-debugger apply --whitespace=nowarn ../patches/sp-console-debugger.patch
   ```
   (Or use the VS Code task "Fetch Debugger Source (upstream + patch)".)

2. **Configure and build:**
   ```bash
   .venv/bin/python configure.py --enable-optimize --targets=x86,x86_64 --sm-path=/path/to/sourcemod
   .venv/bin/ambuild objdir
   ```

See [docs/updating-upstream.md](docs/updating-upstream.md) for detailed build instructions and VM requirements.

## Testing

Run `bun test` from `vscode/` for the unit suite (no setup needed — the DAP integration test skips itself until the mock environment is staged), or `bun run test:integration` for the full regression against the mock server. Everything is documented in [vscode/tests/dap/README.md](vscode/tests/dap/README.md); the headless dev tools live in `vscode/scripts/`.

## Documentation

- **[docs/README.md](docs/README.md)** — Overview and feature reference
- **[docs/usage.md](docs/usage.md)** — How to use every feature (for plugin developers)
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — Known issues and solutions
- **[docs/architecture.md](docs/architecture.md)** — Technical design (for maintainers)
- **[docs/protocol.md](docs/protocol.md)** — DAP wire protocol details
- **[docs/updating-upstream.md](docs/updating-upstream.md)** — Building and vendoring

## Credits

Built on [peace-maker/sp-console-debugger](https://github.com/peace-maker/sp-console-debugger) and the `debug_api_symbols` branch of the SourcePawn VM.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE) for details.
