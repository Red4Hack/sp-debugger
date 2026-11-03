/**
 * perf-stats.cpp -- see perf-stats.h.
 */
#include "perf-stats.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
# ifndef PSAPI_VERSION
#  define PSAPI_VERSION 2
# endif
# include <windows.h>
# include <psapi.h>
#elif defined(__linux__)
# include <pthread.h>
# include <time.h>
# include <unistd.h>
#endif

#include "smsdk_ext.h"
#include "plugin-debug-info.h"
#include "vm-hooks.h"

using namespace SourceMod;
using namespace SourcePawn;

namespace dap {
namespace perf {

namespace {

using Clock = std::chrono::steady_clock;

std::atomic<uint64_t> g_plugin_bytes{0};
std::atomic<int> g_plugin_count{0};

struct PluginMem
{
  int kind = 0;
  double stack_heap_bytes = -1;
  double data_bytes = -1;
  double heap_live_bytes = -1;
};
std::mutex g_mem_lock;

// Peak stack/heap of the tracked (legacy) plugin. Written by the VM thread, reset by
// the TCP thread; a reset racing a sample can at worst keep one stale sample.
std::atomic<IPluginContext*> g_track_ctx{nullptr};
std::atomic<uint32_t> g_track_data{0};
std::atomic<uint32_t> g_track_mem{0};
std::atomic<int64_t> g_peak_stack{0};
std::atomic<int64_t> g_peak_heap{0};
std::atomic<int64_t> g_peak_used{0};
std::atomic<uint64_t> g_peak_samples{0};

void AtomicMax(std::atomic<int64_t>& a, int64_t v)
{
  int64_t cur = a.load(std::memory_order_relaxed);
  while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {
  }
}
std::unordered_map<std::string, PluginMem> g_mem; // by plugin file name
std::atomic<int64_t> g_plugin_stamp_ms{-1}; // wall ms of the last refresh
Clock::time_point g_last_refresh{};
bool g_hooked = false;

double WallMs()
{
  return std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count();
}

#if defined(__linux__)
bool g_have_main_clock = false;
clockid_t g_main_clock = 0;

double ClockMs(clockid_t id)
{
  timespec ts;
  if (clock_gettime(id, &ts) != 0)
    return -1;
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}
#elif defined(_WIN32)
HANDLE g_main_thread = nullptr;

double FileTimeMs(const FILETIME& ft)
{
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return static_cast<double>(u.QuadPart) / 10000.0; // 100 ns units
}
#endif

void OnGameFrame(bool)
{
  // Plugin memory barely moves; once a second is plenty.
  if (Clock::now() - g_last_refresh < std::chrono::seconds(1))
    return;
  RefreshPluginMemory();
}

} // namespace

void Init()
{
#if defined(__linux__)
  g_have_main_clock = pthread_getcpuclockid(pthread_self(), &g_main_clock) == 0;
#elif defined(_WIN32)
  HANDLE proc = GetCurrentProcess();
  if (!DuplicateHandle(proc, GetCurrentThread(), proc, &g_main_thread, 0, FALSE, DUPLICATE_SAME_ACCESS))
    g_main_thread = nullptr;
#endif
  if (smutils && !g_hooked) {
    smutils->AddGameFrameHook(OnGameFrame);
    g_hooked = true;
  }
  RefreshPluginMemory();
}

void Shutdown()
{
  if (smutils && g_hooked) {
    smutils->RemoveGameFrameHook(OnGameFrame);
    g_hooked = false;
  }
#if defined(_WIN32)
  if (g_main_thread) {
    CloseHandle(g_main_thread);
    g_main_thread = nullptr;
  }
#endif
}

void ResetPeaks()
{
  g_peak_samples.store(0, std::memory_order_relaxed);
  g_peak_stack.store(0, std::memory_order_relaxed);
  g_peak_heap.store(0, std::memory_order_relaxed);
  g_peak_used.store(0, std::memory_order_relaxed);
}

void TrackPlugin(IPluginContext* ctx)
{
  g_track_ctx.store(nullptr, std::memory_order_release);
  spdbg::vm::LegacyStackHeapReset();
  ResetPeaks();
  if (!ctx || !ctx->GetRuntime())
    return;
  // The VM sizes a legacy plugin's memory as max(align4(memsize), data + 16384).
  const SpPluginLayout l = SpLayout(ctx->GetRuntime());
  if (!l.known || l.v2 || l.data_bytes < 0 || l.stack_heap_bytes < 0)
    return;
  const uint64_t data = static_cast<uint64_t>(l.data_bytes);
  uint64_t mem = (data + static_cast<uint64_t>(l.stack_heap_bytes) + 3) & ~uint64_t(3);
  if (mem < data + 16384)
    mem = data + 16384;
  if (mem > 0x7fffffffu)
    return;
  g_track_data.store(static_cast<uint32_t>(data), std::memory_order_relaxed);
  g_track_mem.store(static_cast<uint32_t>(mem), std::memory_order_relaxed);
  g_track_ctx.store(ctx, std::memory_order_release);
}

void OnBreak(IPluginContext* ctx)
{
  if (ctx != g_track_ctx.load(std::memory_order_acquire))
    return;
  int64_t stack = 0, heap = 0;
  if (!spdbg::vm::LegacyStackHeapUse(ctx, g_track_data.load(std::memory_order_relaxed),
                                     g_track_mem.load(std::memory_order_relaxed), &stack, &heap))
    return;
  AtomicMax(g_peak_stack, stack);
  AtomicMax(g_peak_heap, heap);
  AtomicMax(g_peak_used, stack + heap);
  g_peak_samples.fetch_add(1, std::memory_order_relaxed);
}

void RefreshPluginMemory()
{
  g_last_refresh = Clock::now();
  if (!plsys)
    return;

  uint64_t total = 0;
  int count = 0;
  std::unordered_map<std::string, PluginMem> mem;
  IPluginIterator* it = plsys->GetPluginIterator();
  for (; it->MorePlugins(); it->NextPlugin()) {
    IPlugin* plugin = it->GetPlugin();
    if (!plugin || plugin->GetStatus() != Plugin_Running)
      continue;
    IPluginRuntime* rt = plugin->GetRuntime();
    if (!rt)
      continue;
    total += rt->GetMemUsage();
    count++;

    PluginMem pm;
    const SpPluginLayout layout = SpLayout(rt);
    if (layout.known) {
      pm.data_bytes = static_cast<double>(layout.data_bytes);
      if (layout.v2) {
        pm.kind = 2;
        // GetMemUsage() of a SourcePawn 2.0 runtime leaves its heap out.
        uint64_t bytes = 0;
        if (spdbg::vm::V2HeapBytes(rt, &bytes)) {
          pm.heap_live_bytes = static_cast<double>(bytes);
          total += bytes;
        }
      } else {
        pm.kind = 1;
        pm.stack_heap_bytes = static_cast<double>(layout.stack_heap_bytes);
      }
    }
    if (const char* file = plugin->GetFilename())
      mem[file] = pm;
  }
  it->Release();

  g_plugin_bytes.store(total, std::memory_order_relaxed);
  g_plugin_count.store(count, std::memory_order_relaxed);
  {
    std::lock_guard<std::mutex> lock(g_mem_lock);
    g_mem.swap(mem);
  }
  g_plugin_stamp_ms.store(static_cast<int64_t>(WallMs()), std::memory_order_relaxed);
}

Sample Take(const char* debug_plugin, IPluginContext* debug_ctx)
{
  Sample s;
  s.wall_ms = WallMs();

#if defined(__linux__)
  double proc = ClockMs(CLOCK_PROCESS_CPUTIME_ID);
  s.process_cpu_ms = proc < 0 ? 0 : proc;
  if (g_have_main_clock)
    s.main_cpu_ms = ClockMs(g_main_clock);

  // /proc/self/statm: size resident shared ... (in pages)
  if (FILE* fp = fopen("/proc/self/statm", "r")) {
    unsigned long size = 0, resident = 0;
    if (fscanf(fp, "%lu %lu", &size, &resident) == 2)
      s.rss_bytes = static_cast<double>(resident) * static_cast<double>(sysconf(_SC_PAGESIZE));
    fclose(fp);
  }
  long cpus = sysconf(_SC_NPROCESSORS_ONLN);
  s.cpus = cpus > 0 ? static_cast<int>(cpus) : 1;
#elif defined(_WIN32)
  FILETIME creation, exit_time, kernel, user;
  if (GetProcessTimes(GetCurrentProcess(), &creation, &exit_time, &kernel, &user))
    s.process_cpu_ms = FileTimeMs(kernel) + FileTimeMs(user);
  if (g_main_thread && GetThreadTimes(g_main_thread, &creation, &exit_time, &kernel, &user))
    s.main_cpu_ms = FileTimeMs(kernel) + FileTimeMs(user);
  PROCESS_MEMORY_COUNTERS pmc;
  if (GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc)))
    s.rss_bytes = static_cast<double>(pmc.WorkingSetSize);
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  s.cpus = si.dwNumberOfProcessors > 0 ? static_cast<int>(si.dwNumberOfProcessors) : 1;
#endif

  int64_t stamp = g_plugin_stamp_ms.load(std::memory_order_relaxed);
  s.plugin_bytes = static_cast<double>(g_plugin_bytes.load(std::memory_order_relaxed));
  s.plugins = g_plugin_count.load(std::memory_order_relaxed);
  if (debug_plugin && *debug_plugin) {
    s.debug_plugin = debug_plugin;
    std::lock_guard<std::mutex> lock(g_mem_lock);
    auto it = g_mem.find(s.debug_plugin);
    if (it != g_mem.end()) {
      s.debug_kind = it->second.kind;
      s.debug_stack_heap_bytes = it->second.stack_heap_bytes;
      s.debug_data_bytes = it->second.data_bytes;
      s.debug_heap_live_bytes = it->second.heap_live_bytes;
    }
  }
  if (debug_ctx && debug_ctx == g_track_ctx.load(std::memory_order_acquire)) {
    const uint64_t n = g_peak_samples.load(std::memory_order_relaxed);
    if (n > 0) {
      s.debug_stack_peak_bytes = static_cast<double>(g_peak_stack.load(std::memory_order_relaxed));
      s.debug_heap_peak_bytes = static_cast<double>(g_peak_heap.load(std::memory_order_relaxed));
      s.debug_used_peak_bytes = static_cast<double>(g_peak_used.load(std::memory_order_relaxed));
      s.debug_peak_samples = static_cast<double>(n);
    }
  }
  s.plugin_age_ms = stamp < 0 ? -1 : s.wall_ms - static_cast<double>(stamp);
  return s;
}

} // namespace perf
} // namespace dap
