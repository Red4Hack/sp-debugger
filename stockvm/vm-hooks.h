/**
 * vm-hooks.h -- debug-break and profiling hooks of the STOCK SourcePawn VM.
 *
 * SourceMod 1.12 (split API): public virtuals on ISourcePawnEngine /
 * ISourcePawnEngine2, the environment taken from sourcepawn.jit.x86.so (or
 * x64/sourcepawn.vm.so), the same library SourceMod already loaded.
 *
 * SourceMod 1.13+ (SourcePawn 2.0, merged API): the VM is statically linked
 * into sourcemod.logic.so and these calls are no longer on the public
 * interface, but sp::Environment still implements them. They are resolved from
 * logic.so's ELF symbol table (official builds are not stripped) and validated
 * against the live environment before use. Linux only.
 *
 * Either way no modified SourcePawn is required.
 */

#ifndef SPDBG_VM_HOOKS_H
#define SPDBG_VM_HOOKS_H

#include <stddef.h>
#include <stdint.h>
#include <vector>
#include <sp_vm_api.h>

class SpPluginDebugInfo;

namespace spdbg {
namespace vm {

// Locate the hooks; enable line debugging when loaded at server start (!late).
// On failure fills |error| and returns false -- nothing has been called yet.
bool Init(bool late, char* error, size_t maxlength);

bool InstallDebugBreakHandler(SPVM_DEBUGBREAK handler);
void RemoveDebugBreakHandler();

bool ProfilingAvailable();
void SetProfilingTool(SourcePawn::IProfilingTool* tool);
void EnableProfiling();
void DisableProfiling();

// SourcePawn 2.0 only calls the debugger from its INTERPRETER, never from JIT
// code, and the JIT switch is VM-wide. While a SourcePawn 2.0 (v2) plugin is
// being debugged, RequireInterpreter(true) turns the JIT off so every invocation
// is interpreted (and can break); RequireInterpreter(false) restores it, but only
// if this call is what turned it off (an admin who disabled the JIT keeps it
// disabled). Legacy plugins must NOT use it: their JIT already breaks, and the
// 2.0 legacy interpreter crashes on typed-stack code. A no-op on SourceMod 1.12.
void RequireInterpreter(bool on);

// SourceMod 1.13+ only, legacy (v1) runtimes only: frm + 2 cells of |rt| as a host
// pointer (what IPluginContext::GetLocalParams() used to be), or null. Lets the
// debugger recover the frame pointer SourcePawn 2.0 no longer reports.
cell_t* LocalParams(SourcePawn::IPluginRuntime* rt);

// SourcePawn 2.0 (SourceMod 1.13+), legacy of "frm = 0": the debug-break hook is
// called from the interpreter, which keeps the frame's virtual registers in the
// plugin heap at local address |frm|. Finds the Interpreter object on the CALLING
// thread's stack (it must be the VM thread, from inside the debug-break handler)
// and returns the local address of the innermost frame's registers; with |all|
// also every caller frame of the same interpreter, innermost first.
// False when it can't be located -- never guesses.
bool InterpreterFrames(SourcePawn::IPluginRuntime* rt, bool all, std::vector<cell_t>* out);

// Where a SourcePawn 2.0 plugin stopped. The 2.0 compiler lowers bytecode to
// low-level code lazily, so several bytecode operations -- and with them several
// source lines -- can start at the same low-level instruction, while the VM only
// ever reports the first one. This reads the method's offset map (LLCode) to
// recover all of them.
struct V2Position
{
  cell_t frm = 0;              // register base of the innermost frame
  bool mapped = false;         // the fields below are valid
  bool exact = false;          // this instruction starts a group of operations
  bool known = false;          // the method was already seen before this stop
  std::vector<uint32_t> lines; // exact: line addresses starting here, in order
};

// VM thread only, from inside the debug-break handler. Also registers, once per
// method, the line starts the VM would otherwise never report (see the
// IsLineBoundary hook). False when the interpreter can't be found.
bool V2CurrentPosition(SourcePawn::IPluginRuntime* rt, SpPluginDebugInfo* info, V2Position* out);

// SourcePawn 2.0 plugin: bytes currently in use in the runtime's own heap (arrays,
// strings, closures, ...), summed from mimalloc's per-page counters -- an
// approximation of live heap, not an exact count. Main thread only, SourceMod 1.13+
// on Linux. False when it can't be measured; it never guesses (the heap object is
// located by its layout inside sp::v2::Runtime and cross-checked against the
// environment's own heap, and anything that doesn't match is refused).
bool V2HeapBytes(SourcePawn::IPluginRuntime* rt, uint64_t* out);

// Legacy (pre-SourcePawn 2.0) plugin: bytes of its stack and of its heap in use
// right now. The VM keeps `stp_, sp_, hp_, frm_` side by side in the plugin's
// context (1.12) / runtime (1.13); they are located by that shape inside the object
// -- stp_ is exactly |mem_bytes| - 4 -- and every read is checked against
// data <= hp <= sp <= frm <= stp. Anything that doesn't fit -> false, never a guess.
// |data_bytes| / |mem_bytes| are the plugin's data size and its whole memory region
// (data + stack/heap). VM thread, from the debug-break handler (sp is only written
// back to the context there, and by native calls).
bool LegacyStackHeapUse(SourcePawn::IPluginContext* ctx, uint32_t data_bytes, uint32_t mem_bytes,
                        int64_t* stack_used, int64_t* heap_used);
// Forget where those fields were found (a different plugin is being tracked).
void LegacyStackHeapReset();

// Drop what V2CurrentPosition learned (a plugin was unloaded: addresses reused).
void ForgetV2Lines();

// Undo every code patch. Must run before the extension is unloaded.
void Shutdown();

// Human-readable description of the path in use, for the startup log.
const char* Backend();

} // namespace vm
} // namespace spdbg

#endif // SPDBG_VM_HOOKS_H
