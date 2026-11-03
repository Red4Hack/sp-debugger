/**
 * plugin-debug-info.cpp -- see plugin-debug-info.h.
 */

#include "plugin-debug-info.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <mutex>
#include <unordered_map>
#include <utility>

#include "smx-v1-image.h"
#include "smsdk_ext.h"

#if defined(__linux__)
# include <fcntl.h>
# include <unistd.h>
#endif

using namespace SourcePawn;

SpPluginDebugInfo::SpPluginDebugInfo(std::unique_ptr<spdbg::SmxV1Image> image)
  : image_(std::move(image))
{
}

SpPluginDebugInfo::~SpPluginDebugInfo()
{
}

std::unique_ptr<SpPluginDebugInfo>
SpPluginDebugInfo::Load(const char* path, std::string* error)
{
  FILE* fp = fopen(path, "rb");
  if (!fp) {
    *error = std::string("cannot open ") + path;
    return nullptr;
  }
  std::unique_ptr<spdbg::SmxV1Image> image(new spdbg::SmxV1Image(fp));
  fclose(fp);

  if (!image->validate()) {
    *error = std::string("cannot parse .smx: ") + image->errorMessage();
    return nullptr;
  }
  if (image->NumFiles() == 0) {
    *error = "plugin has no debug information (.dbg.files is empty)";
    return nullptr;
  }
  return std::unique_ptr<SpPluginDebugInfo>(new SpPluginDebugInfo(std::move(image)));
}

namespace {
class EmptySymbolIterator : public IDebugSymbolIterator
{
 public:
  bool Done() override { return true; }
  const IDebugSymbol* Next() override { return nullptr; }
  void Reset() override {}
};
} // namespace

SpPluginDebugInfo*
SpPluginDebugInfo::Empty()
{
  static SpPluginDebugInfo* empty = new SpPluginDebugInfo(nullptr);
  return empty;
}

int
SpPluginDebugInfo::LookupFile(ucell_t addr, const char** filename)
{
  const char* name = image_ ? image_->LookupFile(addr) : nullptr;
  if (!name)
    return SP_ERROR_NOT_FOUND;
  if (filename)
    *filename = name;
  return SP_ERROR_NONE;
}

int
SpPluginDebugInfo::LookupFunction(ucell_t addr, const char** out)
{
  const char* name = image_ ? image_->LookupFunction(addr) : nullptr;
  if (!name)
    return SP_ERROR_NOT_FOUND;
  if (out)
    *out = name;
  return SP_ERROR_NONE;
}

int
SpPluginDebugInfo::LookupLine(ucell_t addr, uint32_t* line)
{
  return image_ && image_->LookupLine(addr, line) ? SP_ERROR_NONE : SP_ERROR_NOT_FOUND;
}

int
SpPluginDebugInfo::LookupFunctionAddress(const char* function, const char* file, ucell_t* addr)
{
  return image_ && image_->LookupFunctionAddress(function, file, addr) ? SP_ERROR_NONE
                                                                       : SP_ERROR_NOT_FOUND;
}

int
SpPluginDebugInfo::LookupLineAddress(const uint32_t line, const char* file, ucell_t* addr)
{
  return image_ && image_->LookupLineAddress(line, file, addr) ? SP_ERROR_NONE
                                                               : SP_ERROR_NOT_FOUND;
}

bool
SpPluginDebugInfo::IsV2() const
{
  return image_ && image_->IsV2();
}

bool
SpPluginDebugInfo::IsLineBoundary(ucell_t addr) const
{
  return image_ && image_->IsLineBoundaryV2(addr);
}

bool
SpPluginDebugInfo::GlobalBase(IPluginRuntime* rt, cell_t* base)
{
  if (global_base_valid_) {
    *base = global_base_;
    return true;
  }
  if (!image_ || !image_->IsV2() || !rt)
    return false;

  bool have = false;
  cell_t candidate = 0;
  int checked = 0;
  for (uint32_t n = 0; checked < 4; n++) {
    const char* name = nullptr;
    uint32_t offset = 0;
    if (!image_->PublicGlobalAt(n, &name, &offset))
      break;
    uint32_t index;
    cell_t local;
    cell_t* phys;
    if (rt->FindPubvarByName(name, &index) != SP_ERROR_NONE ||
        rt->GetPubvarAddrs(index, &local, &phys) != SP_ERROR_NONE)
    {
      continue;
    }
    cell_t c = local - (cell_t)offset;
    if (!have) {
      candidate = c;
      have = true;
    } else if (c != candidate) {
      smutils->LogError(myself, "global layout mismatch for %s (public %s); globals will not resolve",
                        rt->GetFilename(), name);
      return false;
    }
    checked++;
  }
  if (!have)
    return false;
  global_base_ = candidate;
  global_base_valid_ = true;
  *base = candidate;
  return true;
}

size_t
SpPluginDebugInfo::NumFiles()
{
  return image_ ? image_->NumFiles() : 0;
}

const char*
SpPluginDebugInfo::GetFileName(size_t index)
{
  return image_ ? image_->GetFileName(index) : nullptr;
}

size_t
SpPluginDebugInfo::NumFunctions()
{
  return image_ ? image_->NumFunctions() : 0;
}

const char*
SpPluginDebugInfo::GetFunctionName(size_t index, const char** file)
{
  return image_ ? image_->GetFunctionName(index, file) : nullptr;
}

IDebugSymbolIterator*
SpPluginDebugInfo::CreateSymbolIterator(ucell_t scope_addr)
{
  if (!image_)
    return new EmptySymbolIterator();
  return image_->SymbolIterator(scope_addr);
}

void
SpPluginDebugInfo::DestroySymbolIterator(IDebugSymbolIterator* iter)
{
  delete iter;
}

// --- per-runtime cache -----------------------------------------------------
// Reached from the VM thread (break handler) and the DAP/TCP thread, so it is
// locked. Entries are only dropped on plugin unload, matching the lifetime the
// VM-owned IPluginDebugInfo used to have.

namespace {

struct Entry
{
  std::unique_ptr<SpPluginDebugInfo> info;
  std::string error;
  bool reported = false;
};

std::mutex g_lock;
std::unordered_map<IPluginRuntime*, Entry> g_cache;
std::unordered_map<IPluginRuntime*, SpPluginLayout> g_layouts;

// Caller holds g_lock.
Entry&
Fetch(IPluginRuntime* rt)
{
  auto it = g_cache.find(rt);
  if (it != g_cache.end())
    return it->second;

  Entry& entry = g_cache[rt];
  const char* path = rt->GetFilename();
  if (!path || !*path)
    entry.error = "the VM reports no file name for this plugin";
  else
    entry.info = SpPluginDebugInfo::Load(path, &entry.error);
  return entry;
}

} // namespace

SpPluginDebugInfo*
SpDebugInfo(IPluginRuntime* rt)
{
  if (!rt)
    return nullptr;
  std::lock_guard<std::mutex> lock(g_lock);
  Entry& entry = Fetch(rt);
  if (!entry.info && !entry.reported) {
    entry.reported = true;
    const char* path = rt->GetFilename();
    smutils->LogError(myself, "No debug info for %s: %s", path ? path : "<unknown>",
                      entry.error.c_str());
  }
  return entry.info.get();
}

void
SpDebugInfoPreload(IPluginRuntime* rt)
{
  if (!rt)
    return;
  std::lock_guard<std::mutex> lock(g_lock);
  Fetch(rt);
}

void
SpDebugInfoRelease(IPluginRuntime* rt)
{
  std::lock_guard<std::mutex> lock(g_lock);
  g_cache.erase(rt);
  g_layouts.erase(rt);
}

void
SpDebugInfoReleaseAll()
{
  std::lock_guard<std::mutex> lock(g_lock);
  g_cache.clear();
  g_layouts.clear();
}

SpPluginLayout
SpLayout(IPluginRuntime* rt)
{
  SpPluginLayout out;
  if (!rt)
    return out;
  {
    std::lock_guard<std::mutex> lock(g_lock);
    auto it = g_layouts.find(rt);
    if (it != g_layouts.end())
      return it->second;
  }

  // Read outside the lock: parsing an .smx is the slow part.
  const char* path = rt->GetFilename();
  if (path && *path) {
    if (FILE* fp = fopen(path, "rb")) {
      std::unique_ptr<spdbg::SmxV1Image> image(new spdbg::SmxV1Image(fp));
      fclose(fp);
      if (image->validate()) {
        out.known = true;
        out.v2 = image->IsV2();
        out.data_bytes = static_cast<int64_t>(image->DescribeData().length);
        // Legacy plugins: memory = data + stack/heap, and the compiler prints the
        // second part as "Stack/heap size". A 2.0 VM ignores that header field.
        if (!out.v2 && image->HeapSize() >= image->DescribeData().length)
          out.stack_heap_bytes = static_cast<int64_t>(image->HeapSize() - image->DescribeData().length);
      }
    }
  }

  std::lock_guard<std::mutex> lock(g_lock);
  g_layouts[rt] = out;
  return out;
}

// --- safe memory access ------------------------------------------------------

#if defined(__linux__)
namespace {
std::mutex g_probe_lock;
int g_probe_pipe[2] = {-1, -1};
} // namespace
#endif

bool
SpReadable(const void* p, size_t n)
{
  if (!p)
    return false;
  if (n == 0)
    return true;
#if defined(__linux__)
  std::lock_guard<std::mutex> lock(g_probe_lock);
  if (g_probe_pipe[0] < 0) {
    if (pipe2(g_probe_pipe, O_NONBLOCK | O_CLOEXEC) != 0) {
      g_probe_pipe[0] = g_probe_pipe[1] = -1;
      return true; // can't probe: no worse than before
    }
  }
  static char sink[4096];
  const char* cur = static_cast<const char*>(p);
  while (n > 0) {
    size_t chunk = n < sizeof(sink) ? n : sizeof(sink);
    ssize_t w = write(g_probe_pipe[1], cur, chunk);
    if (w < 0) {
      if (errno == EINTR)
        continue;
      return errno != EFAULT; // only a bad address means "unreadable"
    }
    if (w == 0)
      return true;
    // Drain what we just wrote so the pipe never fills.
    ssize_t left = w;
    while (left > 0) {
      ssize_t r = read(g_probe_pipe[0], sink, static_cast<size_t>(left));
      if (r <= 0)
        break;
      left -= r;
    }
    cur += w;
    n -= static_cast<size_t>(w);
  }
  return true;
#else
  return true;
#endif
}

int
SpLocalToPhys(IPluginContext* ctx, cell_t addr, size_t bytes, cell_t** out)
{
  cell_t* phys = nullptr;
  int err = ctx->LocalToPhysAddr(addr, &phys);
  if (err != SP_ERROR_NONE)
    return err;
  if (!phys)
    return SP_ERROR_MEMACCESS;
#if defined(SPDBG_MERGED_ENV_API)
  if (!SpReadable(phys, bytes))
    return SP_ERROR_MEMACCESS;
#else
  (void)bytes;
#endif
  if (out)
    *out = phys;
  return SP_ERROR_NONE;
}
