# The vendored `sp-console-debugger` (fetched, not committed)

This guide explains how the C++ extension is built from a vendored upstream repository, how to reconstruct the tree, and how to update to newer upstream versions.

The C++ extension is built from two source trees, compiled together into a
single `sp-debugger.ext.so`:

```
sp-debugger/
  sp-console-debugger/   # upstream peace-maker/sp-console-debugger + our patch -- NOT committed,
                         # reconstructed at build time (gitignored)
  dap/                   # our "crate": all DAP/TCP/profiler code + the glue extracted from upstream
  patches/
    sp-console-debugger.commit   # the pinned upstream commit (one line, full SHA)
    sp-console-debugger.patch    # the residual divergence of the vendored copy from upstream
  AMBuildScript / AMBuilder / PackageScript / configure.py   # build, driven from the repo ROOT
```

`dap/` talks to the upstream code through a single seam header, `dap/dap-seam.h`.
The only edits inside `sp-console-debugger/` are the thin hook calls into that
seam (plus the pre-existing feature divergence this fork already carried). Those
edits are captured in `patches/sp-console-debugger.patch`, and the repo carries
only our own code plus that patch -- the upstream tree itself is fetched on
demand.

## Reconstructing the tree

CI and the VS Code build tasks do this automatically (the "Fetch Debugger
Source" task runs before configure and is a no-op when the folder is present).
By hand, from the repo root:

```sh
git init sp-console-debugger
git -C sp-console-debugger fetch --depth 1 https://github.com/peace-maker/sp-console-debugger "$(cat patches/sp-console-debugger.commit)"
git -C sp-console-debugger reset --hard FETCH_HEAD
git -C sp-console-debugger apply --whitespace=nowarn ../patches/sp-console-debugger.patch
```

The result is byte-identical on every machine: pinned upstream commit + patch.
`frame-utils.h` is created by the patch, so its presence is the "fetched AND
patched" sentinel the build guard (AMBuildScript) and the fetch task check.

The folder keeps its own `.git` pointing at upstream -- that is intentional; it
is what makes regenerating the patch a one-liner (below). The root repo ignores
the whole folder.

## What lives where

| Concern | Location |
| --- | --- |
| DAP request handlers, TCP server, JSON, session manager | `dap/` (always was ours) |
| `DapBridge` (TCP/profiler ownership + all `SendDAP*`/profiler methods) | `dap/dap-bridge.{cpp,h}` |
| Break-loop wait / resume (`OnBreak`, `NotifyResume`) | `dap/dap-bridge.cpp` |
| Conditional-breakpoint + logpoint evaluation | `dap/breakpoint-eval.cpp` |
| DAP variables-view value rendering | `dap/symbol-render.cpp` |
| The seam the upstream files call | `dap/dap-seam.h` |

The upstream files include **only** `dap-seam.h` from the crate; the dependency
direction is always `dap/ -> sp-console-debugger/`, never the reverse.

## Changing the vendored code

Edit the files in `sp-console-debugger/` directly, build, test -- then refresh
the patch so a fresh reconstruction reproduces your change. Thanks to the
nested upstream repo the fetch leaves behind:

```sh
git -C sp-console-debugger add -A
git -C sp-console-debugger diff --cached > patches/sp-console-debugger.patch
```

Round-trip check (delete + refetch must rebuild your exact tree):

```sh
mv sp-console-debugger /tmp/spcd-check
# ...run the reconstruction commands above...
diff -r -x .git -x mock /tmp/spcd-check sp-console-debugger   # should print nothing
```

## Updating to a new upstream release

1. Put the new upstream commit SHA in `patches/sp-console-debugger.commit`.
2. Delete `sp-console-debugger/` and re-run the reconstruction. If `git apply`
   fails (upstream changed a line the patch also touches), apply with
   `--3way` instead and resolve the conflict markers by hand -- the seam hooks
   are small and well-commented (search for `dap::`):
   ```sh
   git -C sp-console-debugger apply --3way ../patches/sp-console-debugger.patch
   ```
3. Regenerate the patch (see above) once it applies cleanly.
4. Rebuild and run tests:
   ```sh
   .venv/bin/python configure.py --enable-optimize --targets=x86,x86_64 --sm-path=/path/to/sourcemod
   .venv/bin/ambuild objdir
   (cd vscode && bun test)                          # unit suite
   vscode/tests/dap/run_dap_tests.sh                # DAP integration/regression suite
   ```
5. Commit the updated `patches/sp-console-debugger.commit` + `.patch` pair.

## The mock test environment (also pinned)

`sp-console-debugger/tests/setup.sh` assembles what both regression suites run
against -- hl2sdk-mock, Metamod:Source and SourceMod, the last one built against
the patched SourcePawn VM (peace-maker's `debug_api_symbols` branch). All four
trees are pinned to a commit at the top of that script.

They must be pinned *together*. The patched VM forked from SourcePawn in
Nov 2024 and has not followed upstream since, while SourceMod master has:
master's `core/logic/AMBuilder` now calls `SP.AddVmFlags()` ("Statically link
SourcePawn", #2459, 2026-05-14) and master's core uses VM APIs added after the
fork (`IPluginContext::LocalToArrayPtr`, `GetArrayData`). Neither exists in the
fork, so tracking `master` dies at configure time with:

```
AttributeError: 'SourcePawn' object has no attribute 'AddVmFlags'
```

The mock env therefore follows the SourceMod **1.12** stable line, which is
contemporaneous with the fork and is the line the extension's ext-API-8 code
path targets (the `SMINTERFACE_EXTENSIONAPI_VERSION` guard in
`dap/dap-bridge.cpp`). Moving to a newer SourceMod line requires rebasing the
patched VM onto current SourcePawn first -- and note that master's static
linking also means there is no drop-in `sourcepawn.jit.x86.so` to ship there.

To bump a pin, edit the SHA in `setup.sh` and re-run everything:

```sh
sp-console-debugger/tests/setup.sh          # rebuilds the trees at the new pins
sp-console-debugger/tests/run_tests.sh      # console regression
vscode/tests/dap/run_dap_tests.sh           # DAP regression
```

Then refresh `patches/sp-console-debugger.patch` -- `setup.sh` lives in the
vendored tree, so the pins live in the patch. CI keys its mock-env cache on the
hash of `setup.sh`, so a moved pin invalidates that cache by itself.

## Building (from the repo root)

The build lives at the repo root (it compiles `sp-console-debugger/*.cpp` and
`dap/*.cpp` into one `.ext.so`; the build files inside `sp-console-debugger/`
are upstream-pristine and unused):

```sh
cd sp-debugger
# reconstruct sp-console-debugger/ first if missing (see above)
SOURCEMOD=/path/to/sourcemod .venv/bin/python configure.py \
  --enable-optimize --targets=x86,x86_64 --sm-path=/path/to/sourcemod
.venv/bin/ambuild objdir
# -> objdir/package/addons/sourcemod/extensions/{,x64/}sp-debugger.ext.so
#    (packaged with the matching sp-debugger.autoload)
```

This is the same flow the VS Code tasks "Fetch Debugger Source" / "8. Configure
Extension" / "9. Build Extension" run, with the repo root as the working
directory.

See [Building](README.md#building) section in README.md for the SourceMod /
patched-VM prerequisites; the DAP build is otherwise unchanged.
