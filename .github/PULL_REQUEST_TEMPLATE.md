<!--
Keep the description short and factual: what changes, and why it is the right
change. The checklists below are the parts of this repo that are easy to break
without noticing.
-->

## What and why

<!-- One or two paragraphs. If it fixes a bug, say what the bug did, not just its name. -->

Fixes #

## How it was verified

<!--
Paste the result lines, not just "tests pass". If a suite was not run, say which
and why -- that is more useful than silence.
-->

- [ ] `cd vscode && bun test` — unit suites
- [ ] `cd vscode && bun tsc -p ./ --noEmit` — the `.vsix` job compiles every file under `src/`, tests included
- [ ] `sp-console-debugger/tests/run_tests.sh` — console regression (needs the mock env)
- [ ] `vscode/tests/dap/run_dap_tests.sh` — DAP regression + extension lifecycle (needs the mock env)
- [ ] Built against **both** SourceMod lines (`--sm-path` at a 1.12 tree and at a 1.13/master tree)

```
<!-- result lines here -->
```

## Checklist

- [ ] **Vendored tree**: if anything under `sp-console-debugger/` changed, `patches/sp-console-debugger.patch` was regenerated and the round-trip verified (delete the folder, refetch, re-apply, `diff -r` clean). See [docs/updating-upstream.md](../docs/updating-upstream.md).
- [ ] **Windows**: no POSIX-only call without a guard, and no bare `std::min`/`std::max` in a file that pulls in `winsock2.h` (the `min` macro rewrites them and MSVC fails to compile).
- [ ] **Teardown**: any new thread, socket or VM callback is released in `Stop()` / `SDK_OnUnload`. The extension is unloaded on `sm exts unload/reload` and on every server restart; anything still running then takes the game server with it.
- [ ] **Debug surface**: if this adds or widens a DAP request, it cannot read or write more than the debugged plugin's own memory, and it is gated on a paused session where that matters.
- [ ] **Docs**: user-visible behaviour is reflected in `docs/usage.md`, protocol changes in `docs/protocol.md`, design decisions in `docs/architecture.md`, new failure modes in `docs/troubleshooting.md`.
- [ ] **Output**: any new Debug Console message is plain text (no decorative glyphs) and ends with a newline.

## Risk

<!--
What breaks if this is wrong, and who notices first? Call out anything that
changes the default configuration, the wire protocol, or the release packaging --
those reach every server owner on the next update.
-->
