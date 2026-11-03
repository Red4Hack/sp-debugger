/**
 * plugin-debug-info.h -- debug information for a loaded plugin, read by the
 * extension itself from the plugin's .smx file.
 *
 * The debugger used to get this from the VM (IPluginDebugInfo), which meant
 * shipping a PATCHED SourcePawn: stock 1.12 only has 7 of the 11 methods we
 * need, and SourceMod 1.13 (SourcePawn 2.0) removed the interface entirely.
 * Parsing the .smx here works with the unmodified VM on every SourceMod line.
 *
 * The parser (smx-v1-image.cpp & friends) is SourcePawn's own SMX reader,
 * vendored into namespace spdbg and extended to read both formats: legacy (v1,
 * spcomp 1.12 and 1.13's `oldspcomp`) and SourcePawn 2.0 (header 0x0200, 1.13's
 * default `spcomp`: line tables per method, globals keyed by index, locals and
 * arguments as virtual registers).
 *
 * The method names and SP_ERROR_* return contract mirror the old
 * IPluginDebugInfo so the debugger code didn't have to change shape.
 */

#ifndef SPDBG_PLUGIN_DEBUG_INFO_H
#define SPDBG_PLUGIN_DEBUG_INFO_H

#include <stdint.h>
#include <memory>
#include <string>
#include <sp_vm_api.h>
#include "sp_vm_debug_api.h"

// Max array dimensions a legacy (pre-RTTI) debug symbol can carry. Same value
// as smx/smx-legacy-debuginfo.h; the debugger sizes index buffers with it.
#ifndef MAX_LEGACY_DIMENSIONS
# define MAX_LEGACY_DIMENSIONS 4
#endif

namespace spdbg {
class SmxV1Image;
}

class SpPluginDebugInfo
{
 public:
  ~SpPluginDebugInfo();

  // Parse |path|. Returns null and fills |error| on failure.
  static std::unique_ptr<SpPluginDebugInfo> Load(const char* path, std::string* error);

  // A debug info that knows nothing: every lookup reports SP_ERROR_NOT_FOUND and
  // symbol iterators are empty. Callers that must always hold an object (the
  // breakpoint manager) use it when a plugin has no readable debug info, so a
  // missing/unsupported .smx degrades to "breakpoint not verified" instead of a
  // null dereference inside the server.
  static SpPluginDebugInfo* Empty();

  int LookupFile(ucell_t addr, const char** filename);
  int LookupFunction(ucell_t addr, const char** name);
  int LookupLine(ucell_t addr, uint32_t* line);
  int LookupFunctionAddress(const char* function, const char* file, ucell_t* addr);
  int LookupLineAddress(const uint32_t line, const char* file, ucell_t* addr);
  // SourcePawn 2.0 (SMX 0x200) plugin: virtual-register frames instead of a stack.
  bool IsV2() const;
  // SourcePawn 2.0: a source line starts exactly at |addr|.
  bool IsLineBoundary(ucell_t addr) const;
  // SourcePawn 2.0: local address of the plugin's global buffer, recovered from
  // the runtime addresses of its public globals (cross-checked). Cached.
  bool GlobalBase(SourcePawn::IPluginRuntime* rt, cell_t* base);
  size_t NumFiles();
  const char* GetFileName(size_t index);
  size_t NumFunctions();
  const char* GetFunctionName(size_t index, const char** file);
  SourcePawn::IDebugSymbolIterator* CreateSymbolIterator(ucell_t scope_addr);
  void DestroySymbolIterator(SourcePawn::IDebugSymbolIterator* iter);

 private:
  explicit SpPluginDebugInfo(std::unique_ptr<spdbg::SmxV1Image> image);
  std::unique_ptr<spdbg::SmxV1Image> image_;
  cell_t global_base_ = 0;
  bool global_base_valid_ = false;
};

// Debug info for a running plugin, parsed from its .smx and cached per runtime.
// Null when the plugin has no usable debug info (not compiled with debug
// sections, or a SourcePawn 2.0 binary); the reason is logged once per plugin.
SpPluginDebugInfo* SpDebugInfo(SourcePawn::IPluginRuntime* rt);

// Is [p, p+n) readable memory? SourcePawn 2.0 does not bounds-check local
// addresses (LocalToPhysAddr is heap + offset), and a debugger follows addresses
// read out of plugin memory, so every such dereference goes through this.
// Linux: probes with write() into a pipe, which reports EFAULT instead of crashing.
bool SpReadable(const void* p, size_t n);

// LocalToPhysAddr() that also guarantees |bytes| at the result are readable (on
// SourceMod 1.13+, where the VM itself no longer does). Never returns a pointer
// that would fault.
int SpLocalToPhys(SourcePawn::IPluginContext* ctx, cell_t addr, size_t bytes, cell_t** out);

// What a plugin's .smx declares about its memory. Needs no debug info, only the
// file the VM loaded. Cached per runtime.
struct SpPluginLayout
{
  bool known = false;               // the file was read and parsed
  bool v2 = false;                  // SourcePawn 2.0 binary: its heap is a real allocator heap
  int64_t data_bytes = -1;          // "Data size" the compiler prints
  int64_t stack_heap_bytes = -1;    // legacy: "Stack/heap size" the compiler prints (-1 for 2.0)
};
SpPluginLayout SpLayout(SourcePawn::IPluginRuntime* rt);

// Parse and cache now, silently. Called when a plugin loads, so the snapshot
// matches the binary the VM just loaded even if the .smx is recompiled later.
void SpDebugInfoPreload(SourcePawn::IPluginRuntime* rt);

// Drop the cache entry (plugin unloaded -- the runtime pointer may be reused).
void SpDebugInfoRelease(SourcePawn::IPluginRuntime* rt);
void SpDebugInfoReleaseAll();

#endif // SPDBG_PLUGIN_DEBUG_INFO_H
