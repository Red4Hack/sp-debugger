/**
 * dap-seam.h -- the ONLY crate header the upstream sp-console-debugger files
 * are allowed to include.
 *
 * It exposes a small set of free functions (the "seam") that the upstream
 * extension/debugger code calls at well-defined hook points. Everything DAP-,
 * TCP- and profiler-related lives behind these calls inside the dap/ crate, so
 * the vendored upstream copy stays close to peace-maker/sp-console-debugger and
 * can be updated via patches/.
 *
 * All calls are no-ops when the DAP bridge has not been initialised, so the
 * upstream console debugger keeps working on its own.
 */

#ifndef _INCLUDE_DAP_SEAM_H
#define _INCLUDE_DAP_SEAM_H

#include <string>

// sp_debug_break_info_t and cell_t are SourcePawn typedefs, not forward-
// declarable. Every file that includes this header pulls in the SourcePawn VM
// headers first, so the names are already in scope by the time these signatures
// are parsed.
class ConsoleDebugger;
class Debugger;

namespace SourcePawn {
class IPluginContext;
class ISourcePawnEngine2;
}

namespace SourceMod {
class IPlugin;
}

namespace dap {

// Lifecycle -- called from ConsoleDebugger::SDK_OnLoad / SDK_OnUnload.
// Init spins up the TCP/DAP server and the profilers; engine2 is the v2
// SourcePawn engine captured by the extension (may be null -> "All plugins"
// profiler disabled).
void Init(ConsoleDebugger* ext, SourcePawn::ISourcePawnEngine2* engine2);
void Shutdown();

// Plugin reload handling -- called from ConsoleDebugger::OnPluginLoaded /
// OnPluginUnloaded. Loaded rebinds a debugging client to the reloaded plugin
// instance; Unloaded drops the client's now-dangling pointer. Unloaded must run
// before the debugger map entry is removed.
void OnPluginLoaded(SourceMod::IPlugin* plugin);
void OnPluginUnloaded(SourceMod::IPlugin* plugin);

// Debug-break tracer feed -- called from OnDebugBreak on every break. Cheap
// no-op unless a profiling capture is running for this plugin.
void OnDebugBreakSample(SourcePawn::IPluginContext* ctx, sp_debug_break_info_t& dbginfo);

// DAP event emission used from the VM/break path (exception + logpoint output).
void SendOutput(const char* message, const char* category);

// True when at least one DAP client is connected (VS Code debug mode).
bool HasClients();

// Break loop. Called from Debugger::HandleInput when a DAP client is attached:
// emits the "stopped" event and blocks the VM thread until the client issues a
// continue/step (which wakes it via NotifyResume) or disconnects/times out, in
// which case the debugger is resumed (runmode RUNNING) before returning.
void OnBreak(Debugger* debugger, const char* reason);

// Wake the VM thread blocked in OnBreak. Called from Debugger::SetRunmode so any
// runmode change (continue/step issued on the TCP thread) resumes execution.
void NotifyResume();

// Conditional-breakpoint and logpoint evaluation, called from
// BreakpointManager::CheckBreakpoint only when a breakpoint matches the current
// instruction (not on every line). Implemented in dap/breakpoint-eval.cpp.
//   EvalBreakpointCondition: true if the "lhs OP rhs" condition holds in the
//   given frame (a bad/unresolved condition is false, so it never spuriously
//   stops). FormatLogpointMessage: interpolate "{expr}" placeholders against the
//   in-scope variables for a logpoint message.
bool EvalBreakpointCondition(Debugger* debugger, const std::string& condition,
                             cell_t cip, cell_t frm);
std::string FormatLogpointMessage(Debugger* debugger, const std::string& message,
                                  cell_t cip, cell_t frm);

// Settings from configs/console-debugger.cfg. Exposed through the seam so the
// upstream side reads its one flag with the same parser as everything else
// (dap/config.cpp) instead of carrying a second, subtly different scanner.
// 1/true/yes/on enable; anything else disables.
bool ConfigFlag(const char* key, bool fallback);

} // namespace dap

#endif // _INCLUDE_DAP_SEAM_H
