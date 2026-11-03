/**
 * perf-stats.h -- raw CPU / memory counters of the game server, for the
 * "Realtime Performance" panel (DAP custom request `sp_performance`).
 *
 * Everything here is CUMULATIVE or instantaneous, never a percentage: the client
 * samples twice and divides, so the server keeps no per-client state.
 *
 *  - CPU: process CPU time and, separately, the main (game) thread's CPU time.
 *    The game loop is one thread, so its share of wall time is the number that
 *    matters ("100%" = the server can't keep up); the process total also counts
 *    engine helper threads.
 *  - Memory: the process resident set, and the estimated memory of all running
 *    plugins (IPluginRuntime::GetMemUsage, plus the live heap of SourcePawn 2.0
 *    plugins, which that call leaves out).
 *  - The debugged plugin: its "Data size" and "Stack/heap size" as the compiler
 *    prints them (legacy plugins), or the bytes in use in its allocator heap
 *    (SourcePawn 2.0 plugins, which have no fixed stack/heap size).
 *
 * Plugin memory is read on the MAIN thread only (game-frame hook, plugin load):
 * walking the plugin list from the TCP thread would race a plugin being
 * unloaded. The TCP thread just reads the cached total and its age.
 */
#ifndef SPDBG_DAP_PERF_STATS_H
#define SPDBG_DAP_PERF_STATS_H

#include <string>

// IPluginContext is a class on SourceMod 1.12 and a typedef of IPluginRuntime on 1.13:
// it can't be forward-declared.
#include <sp_vm_api.h>

namespace dap {
namespace perf {

struct Sample
{
  double wall_ms = 0;          // monotonic clock
  double process_cpu_ms = 0;   // all threads
  double main_cpu_ms = -1;     // game thread; -1 when the platform can't tell
  double rss_bytes = 0;        // resident set; 0 when unknown
  double plugin_bytes = 0;     // sum of GetMemUsage() of running plugins
  double plugin_age_ms = -1;   // how old plugin_bytes is; -1 = never measured
  // The plugin being debugged (its file name as the client launched it), sized the
  // way the compiler reports it. -1 = not available.
  std::string debug_plugin;
  int debug_kind = 0;                  // 0 unknown / not loaded, 1 legacy, 2 SourcePawn 2.0
  double debug_stack_heap_bytes = -1;  // legacy: "Stack/heap size"
  double debug_data_bytes = -1;        // "Data size"
  double debug_heap_live_bytes = -1;   // 2.0: bytes in use in the plugin's allocator heap
  // Legacy plugins, since the plugin was (re)launched or the peaks were reset: the
  // most stack / heap / both together seen in use at any line. -1 = none yet.
  double debug_stack_peak_bytes = -1;
  double debug_heap_peak_bytes = -1;
  double debug_used_peak_bytes = -1;
  double debug_peak_samples = 0;       // how many lines contributed
  int plugins = 0;             // running plugins counted in plugin_bytes
  int cpus = 1;                // logical CPUs
};

// Main thread, from SDK_OnLoad: remembers which thread is "the game thread" and
// starts the periodic plugin-memory refresh.
void Init();
void Shutdown();

// Main thread only. Cheap enough to call on plugin load.
void RefreshPluginMemory();

// The plugin being debugged (StartPluginDebugging): track its peak stack/heap use.
// Resets the peaks. Legacy plugins only; anything else is simply not tracked.
void TrackPlugin(SourcePawn::IPluginContext* ctx);
// VM thread, from every debug break: cheap no-op unless |ctx| is the tracked plugin.
void OnBreak(SourcePawn::IPluginContext* ctx);
// Any thread: forget the peaks seen so far (keep tracking).
void ResetPeaks();

// Any thread. |debug_plugin| is the client's active plugin file name (may be empty),
// |debug_ctx| its context (peaks are only reported if it is the tracked one).
Sample Take(const char* debug_plugin = nullptr, SourcePawn::IPluginContext* debug_ctx = nullptr);

} // namespace perf
} // namespace dap

#endif // SPDBG_DAP_PERF_STATS_H
