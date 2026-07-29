#!/bin/bash
# DAP regression STAGER + runner -- the DAP/TCP counterpart of
# sp-console-debugger/tests/run_tests.sh. Reuses the mock environment that
# tests/setup.sh builds (hl2sdk-mock + sourcemod + metamod + gamedir), builds
# this extension from the repo root, stages the gamedir with the test plugin,
# then runs the integration test suite
# (vscode/src/__tests__/integration/dap-regression.test.ts) via `bun test`.
set -eo pipefail

cwd=$(dirname "$(readlink -f "$0")")        # vscode/tests/dap
repo=$(readlink -f "$cwd/../../..")         # repo root
tests=$repo/sp-console-debugger/tests
mock=$tests/mock

if [ ! -d "$mock" ]; then
  echo "::error::mock environment missing ($mock). Run sp-console-debugger/tests/setup.sh first."
  exit 1
fi

# 1. Build the extension from the repo root (upstream sources + dap/ crate).
cd "$repo"
python3 configure.py --sm-path "$mock/sourcemod" --targets x86,x86_64
# configure.py exits 0 even when configuration fails; .ambuild2/vars is the
# generator's success marker, so fail here rather than inside ambuild.
test -f objdir/.ambuild2/vars \
  || { echo "::error::configure failed (see output above)"; exit 1; }
ambuild objdir

# 2. Stage the freshly built package (sp-debugger.ext.so + autoload) into the
#    mock game dir.
cd "$mock/hl2sdk-mock"
bash build_gamedir.sh "$mock/gamedir" "$repo/objdir/package"

# 3. Install the test plugin ENABLED as debugger_test.smx so the DAP launch
#    (program=debugger_test.sp) binds it by basename. The integration test
#    checks for this file to decide it can run (instead of skipping).
plugins="$mock/gamedir/addons/sourcemod/plugins"
mkdir -p "$plugins"
ln -sf "$tests/debugger_test_latest.smx" "$plugins/debugger_test.smx"
# Unstage on the way out even when the suite fails -- an enabled plugin left
# behind changes what the console suite (run_tests.sh) sees on the next run.
trap 'rm -f "$plugins/debugger_test.smx"' EXIT

# 4. Drive the DAP session and assert on the protocol responses.
cd "$repo/vscode"
bun test src/__tests__/integration/
