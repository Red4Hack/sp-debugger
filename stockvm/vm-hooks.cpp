/**
 * vm-hooks.cpp -- see vm-hooks.h.
 */

#include "vm-hooks.h"
#include "plugin-debug-info.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <atomic>
#include <mutex>
#include <string>
#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "smsdk_ext.h"
#include <amtl/am-string.h>
#include <amtl/os/am-shared-library.h>

#if defined(__linux__)
# include <elf.h>
# include <link.h>
# include <pthread.h>
# include <sys/mman.h>
# include <unistd.h>
#endif
#if defined(_WIN32)
# include <windows.h>
#endif

extern bool g_DebugLogging;

using namespace SourcePawn;

namespace spdbg {
namespace vm {

namespace {

bool g_installed = false;
const char* g_backend = "none";

#if defined(__linux__)
// ===========================================================================
// ELF helpers (Linux): find the module that holds an object's vtable and look
// up local (non-exported) functions in its .symtab. Official SourceMod builds
// are not stripped.
// ===========================================================================
struct ModuleInfo
{
  uintptr_t probe = 0;
  bool found = false;
  uintptr_t base = 0;
  std::string path;
  std::vector<std::pair<uintptr_t, uintptr_t>> exec; // executable PT_LOAD ranges
};

int PhdrCallback(struct dl_phdr_info* info, size_t, void* data)
{
  ModuleInfo* m = static_cast<ModuleInfo*>(data);
  bool contains = false;
  for (ElfW(Half) i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr)& ph = info->dlpi_phdr[i];
    if (ph.p_type != PT_LOAD)
      continue;
    uintptr_t start = info->dlpi_addr + ph.p_vaddr;
    if (m->probe >= start && m->probe < start + ph.p_memsz)
      contains = true;
  }
  if (!contains)
    return 0;

  m->found = true;
  m->base = info->dlpi_addr;
  m->path = info->dlpi_name ? info->dlpi_name : "";
  for (ElfW(Half) i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr)& ph = info->dlpi_phdr[i];
    if (ph.p_type == PT_LOAD && (ph.p_flags & PF_X)) {
      uintptr_t start = info->dlpi_addr + ph.p_vaddr;
      m->exec.emplace_back(start, start + ph.p_memsz);
    }
  }
  return 1;
}

// |object| is a polymorphic object; its vtable lives in the module that
// implements it.
bool LocateModule(const void* object, ModuleInfo* m)
{
  m->probe = reinterpret_cast<uintptr_t>(*reinterpret_cast<void* const*>(object));
  m->found = false;
  dl_iterate_phdr(PhdrCallback, m);
  return m->found && !m->path.empty();
}

bool ReadWholeFile(const char* path, std::vector<uint8_t>* out)
{
  FILE* fp = fopen(path, "rb");
  if (!fp)
    return false;
  bool ok = false;
  if (fseek(fp, 0, SEEK_END) == 0) {
    long size = ftell(fp);
    if (size > 0 && fseek(fp, 0, SEEK_SET) == 0) {
      out->resize(static_cast<size_t>(size));
      ok = fread(out->data(), 1, out->size(), fp) == out->size();
    }
  }
  fclose(fp);
  return ok;
}

bool InExec(const ModuleInfo& m, void* addr)
{
  uintptr_t a = reinterpret_cast<uintptr_t>(addr);
  for (const auto& r : m.exec) {
    if (a >= r.first && a < r.second)
      return true;
  }
  return false;
}

// Exact mangled name, or a prefix for the ones whose parameter types differ
// between i386 and x86_64. Compiler clones (".cold", ".isra") never match.
bool NameIs(const char* name, const char* want, bool prefix)
{
  if (strchr(name, '.'))
    return false;
  return prefix ? strncmp(name, want, strlen(want)) == 0 : strcmp(name, want) == 0;
}

struct SymbolTable
{
  std::vector<uint8_t> file;
  size_t symoff = 0, count = 0, stroff = 0, strsize = 0;
};

struct FuncSym
{
  void* addr = nullptr;
  size_t size = 0;
};

bool LoadSymbolTable(const ModuleInfo& m, SymbolTable* st, std::string* why)
{
  std::vector<uint8_t>& file = st->file;
  if (!ReadWholeFile(m.path.c_str(), &file)) {
    *why = "cannot read " + m.path;
    return false;
  }
  if (file.size() < sizeof(ElfW(Ehdr))) {
    *why = m.path + " is not an ELF file";
    return false;
  }
  const ElfW(Ehdr)* eh = reinterpret_cast<const ElfW(Ehdr)*>(file.data());
# if defined(__LP64__)
  const unsigned char kClass = ELFCLASS64;
# else
  const unsigned char kClass = ELFCLASS32;
# endif
  if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0 || eh->e_ident[EI_CLASS] != kClass) {
    *why = m.path + " is not a native ELF file";
    return false;
  }
  if (eh->e_shoff == 0 || eh->e_shentsize != sizeof(ElfW(Shdr)) ||
      eh->e_shoff + static_cast<uint64_t>(eh->e_shnum) * sizeof(ElfW(Shdr)) > file.size()) {
    *why = m.path + " has no usable section table";
    return false;
  }
  const ElfW(Shdr)* sh = reinterpret_cast<const ElfW(Shdr)*>(file.data() + eh->e_shoff);
  const ElfW(Shdr)* symtab = nullptr;
  for (ElfW(Half) i = 0; i < eh->e_shnum; i++) {
    if (sh[i].sh_type == SHT_SYMTAB) {
      symtab = &sh[i];
      break;
    }
  }
  if (!symtab) {
    *why = m.path + " has no .symtab (stripped build?)";
    return false;
  }
  if (symtab->sh_link >= eh->e_shnum) {
    *why = "bad .symtab link";
    return false;
  }
  const ElfW(Shdr)* strtab = &sh[symtab->sh_link];
  if (symtab->sh_offset + static_cast<uint64_t>(symtab->sh_size) > file.size() ||
      strtab->sh_offset + static_cast<uint64_t>(strtab->sh_size) > file.size()) {
    *why = "truncated .symtab";
    return false;
  }
  st->symoff = symtab->sh_offset;
  st->count = symtab->sh_size / sizeof(ElfW(Sym));
  st->stroff = strtab->sh_offset;
  st->strsize = strtab->sh_size;
  return true;
}

bool FindFunction(const ModuleInfo& m, const SymbolTable& st, const char* want, bool prefix,
                  FuncSym* out)
{
  const ElfW(Sym)* syms = reinterpret_cast<const ElfW(Sym)*>(st.file.data() + st.symoff);
  const char* strs = reinterpret_cast<const char*>(st.file.data() + st.stroff);
  for (size_t i = 0; i < st.count; i++) {
    const ElfW(Sym)& s = syms[i];
    if ((s.st_info & 0xf) != STT_FUNC || s.st_shndx == SHN_UNDEF || s.st_value == 0)
      continue;
    if (s.st_name >= st.strsize || memchr(strs + s.st_name, '\0', st.strsize - s.st_name) == nullptr)
      continue;
    if (!NameIs(strs + s.st_name, want, prefix))
      continue;
    void* addr = reinterpret_cast<void*>(m.base + s.st_value);
    if (!InExec(m, addr))
      continue;
    out->addr = addr;
    out->size = s.st_size;
    return true;
  }
  return false;
}
#endif // __linux__

#if !defined(SPDBG_MERGED_ENV_API)
// ===========================================================================
// SourceMod 1.12: split ISourcePawnEngine / ISourcePawnEngine2 public API.
// ===========================================================================

// SourceMod's PLATFORM_X86 is not reliably defined here; detect bitness from
// the compiler.
# if defined(__x86_64__) || defined(_M_X64) || defined(__amd64__) || defined(__aarch64__)
#  define SOURCEPAWN_DLL "sourcepawn.vm"
# else
#  define SOURCEPAWN_DLL "sourcepawn.jit.x86"
# endif

ISourcePawnEngine* g_engine = nullptr;
ISourcePawnEngine2* g_engine2 = nullptr;

// Is |addr| inside a mapped, executable region? When the platform can't tell
// us, assume yes -- never block a server that would work.
bool IsExecutableAddress(const void* addr)
{
# if defined(__linux__)
  FILE* fp = fopen("/proc/self/maps", "r");
  if (!fp)
    return true;
  const uintptr_t target = reinterpret_cast<uintptr_t>(addr);
  char line[512];
  bool executable = false;
  while (fgets(line, sizeof(line), fp)) {
    unsigned long long start, end;
    char perms[8];
    if (sscanf(line, "%llx-%llx %7s", &start, &end, perms) != 3)
      continue;
    if (target < static_cast<uintptr_t>(start) || target >= static_cast<uintptr_t>(end))
      continue;
    executable = strchr(perms, 'x') != nullptr;
    break;
  }
  fclose(fp);
  return executable;
# elif defined(_WIN32)
  MEMORY_BASIC_INFORMATION mbi;
  if (VirtualQuery(addr, &mbi, sizeof(mbi)) != sizeof(mbi))
    return false;
  if (mbi.State != MEM_COMMIT)
    return false;
  const DWORD kExec = PAGE_EXECUTE | PAGE_EXECUTE_READ |
                      PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  return (mbi.Protect & kExec) != 0;
# else
  return true;
# endif
}

// Does the live ISourcePawnEngine vtable still have SetDebugBreakHandler where
// the 1.12 headers put it (slot 14, the last one)? A 1.12 build loaded into a
// SourceMod 1.13 (merged, 12-slot interface) would otherwise index past the end
// of the vtable into read-only data and crash the server. Check it before ANY
// virtual call: every slot index comes from the same headers.
bool EngineVtableIsCompatible(ISourcePawnEngine* engine)
{
  if (!engine)
    return false;

  size_t offset;
# if defined(__GNUC__) || defined(__clang__)
  // Itanium C++ ABI: a pointer to a virtual member function stores
  // (vtable byte offset + 1) in its first word.
  int (ISourcePawnEngine::*pmf)(SPVM_DEBUGBREAK) = &ISourcePawnEngine::SetDebugBreakHandler;
  intptr_t raw[2];
  if (sizeof(pmf) != sizeof(raw))
    return true;
  memcpy(raw, &pmf, sizeof(raw));
  if ((raw[0] & 1) == 0)
    return true;
  offset = static_cast<size_t>(raw[0] - 1);
# else
  // MSVC: single-inheritance vtables follow declaration order; it is the 15th
  // and last method.
  offset = 14 * sizeof(void*);
# endif

  void** vtable = *reinterpret_cast<void***>(engine);
  if (!vtable)
    return false;
  void* slot = *reinterpret_cast<void**>(reinterpret_cast<char*>(vtable) + offset);
  return slot != nullptr && IsExecutableAddress(slot);
}

// Stock SourcePawn 1.12 has a bug that only shows once debug-break is on:
// SmxV1Image::validateDebugVariables() (which has validateSymbolAddress()
// inlined) rejects the constant-marker debug symbol (address 0x80000000) that
// spcomp 1.12 puts in .dbg.globals of EVERY plugin, so every plugin fails with
// "invalid global variable address". The fix lives in a patched VM; we get the
// same effect without one by making that validator accept the table. The VM
// never uses these addresses to run code -- only debuggers read them, and this
// extension parses and checks them itself (stockvm/) -- so nothing is lost.
// It's a 6-byte `mov eax,1 ; ret` (valid for both x86 cdecl and x86_64 SysV)
// written over the function, and only done when the function exists with that
// exact signature, so a fixed VM is left alone. Linux only.
void RelaxStockSymbolValidation(ISourcePawnEngine* engine)
{
# if defined(__linux__)
  ModuleInfo m;
  if (!LocateModule(engine, &m)) {
    smutils->LogMessage(myself, "[debug-init] cannot locate the VM module; plugin debug symbols left unrelaxed");
    return;
  }
  SymbolTable st;
  std::string why;
  if (!LoadSymbolTable(m, &st, &why)) {
    smutils->LogMessage(myself, "[debug-init] cannot read VM symbols (%s); plugin debug symbols left unrelaxed", why.c_str());
    return;
  }
  FuncSym f;
  if (!FindFunction(m, st, "_ZN2sp10SmxV1Image22validateDebugVariablesEPKNS_21smx_rtti_table_headerE", false, &f)) {
    if (g_DebugLogging)
      smutils->LogMessage(myself, "[debug-init] VM has no validateDebugVariables(); nothing to relax");
    return;
  }

  static const uint8_t kStub[] = {0xB8, 0x01, 0x00, 0x00, 0x00, 0xC3}; // mov eax,1 ; ret
  uint8_t* fn = static_cast<uint8_t*>(f.addr);
  if (f.size < sizeof(kStub))
    return;
  if (memcmp(fn, kStub, sizeof(kStub)) == 0)
    return; // already relaxed (extension reloaded)
  if (fn[0] != 0x55) { // push ebp / push rbp: not the function we expect
    smutils->LogMessage(myself, "[debug-init] validateDebugVariables has an unexpected prologue; left alone");
    return;
  }

  const uintptr_t page = static_cast<uintptr_t>(sysconf(_SC_PAGESIZE));
  const uintptr_t start = reinterpret_cast<uintptr_t>(fn) & ~(page - 1);
  const uintptr_t end = (reinterpret_cast<uintptr_t>(fn) + sizeof(kStub) + page - 1) & ~(page - 1);
  if (mprotect(reinterpret_cast<void*>(start), end - start, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
    smutils->LogMessage(myself, "[debug-init] mprotect failed (%s); plugins with constants will not load", strerror(errno));
    return;
  }
  memcpy(fn, kStub, sizeof(kStub));
  mprotect(reinterpret_cast<void*>(start), end - start, PROT_READ | PROT_EXEC);
  smutils->LogMessage(myself, "[debug-init] relaxed stock VM debug-symbol validation (SourceMod 1.12 spcomp constant symbols)");
# else
  (void)engine;
# endif
}

bool InitImpl(bool late, char* error, size_t maxlength)
{
  g_engine = smutils->GetScriptingEngine();
  if (!EngineVtableIsCompatible(g_engine)) {
    ke::SafeStrcpy(error, maxlength,
                   "SourcePawn VM API mismatch: this build of sp-debugger is for SourceMod 1.12 "
                   "(split VM API); use the sm1.13 package on SourceMod 1.13+");
    return false;
  }
  if (g_engine->GetEngineAPIVersion() < 5) {
    ke::SafeStrcpy(error, maxlength,
                   "This SourcePawn VM doesn't support line debugging. Please update SourceMod.");
    return false;
  }

  // The environment (EnableDebugBreak) and the v2 engine (profiling) are only
  // reachable through the VM library's factory. SourceMod already dlopen'd
  // that file, so opening it again hands back the LIVE copy.
  char file[PLATFORM_MAX_PATH];
  smutils->BuildPath(Path_SM, file, sizeof(file),
                     "bin/" PLATFORM_ARCH_FOLDER SOURCEPAWN_DLL ".%s", PLATFORM_LIB_EXT);
  auto module = ke::SharedLib::Open(file);
  if (!module) {
    smutils->LogMessage(myself, "[debug-init] could not open VM library at %s", file);
  } else {
    GetSourcePawnFactoryFn factoryFn = module->get<GetSourcePawnFactoryFn>("GetSourcePawnFactory");
    ISourcePawnFactory* factory = factoryFn ? factoryFn(0x0207) : nullptr;
    ISourcePawnEnvironment* env = factory ? factory->CurrentEnvironment() : nullptr;
    if (!env) {
      smutils->LogMessage(myself, "[debug-init] no live SourcePawn environment in %s", file);
    } else {
      g_engine2 = env->APIv2();
      // SourceMod 1.12 has no core.cfg switch for this; the extension turns it
      // on. Only possible before any plugin is loaded -- hence "no late load".
      if (!late)
        RelaxStockSymbolValidation(g_engine);
      if (!late && !env->EnableDebugBreak() && g_DebugLogging)
        smutils->LogMessage(myself, "[debug-init] EnableDebugBreak() refused (plugins already loaded)");
    }
  }

  g_backend = "SourcePawn 1.x, stock " SOURCEPAWN_DLL " (public split API)";
  return true;
}

bool InstallImpl(SPVM_DEBUGBREAK handler)
{
  return g_engine && g_engine->SetDebugBreakHandler(handler) == SP_ERROR_NONE;
}

void RemoveImpl()
{
  if (g_engine)
    g_engine->SetDebugBreakHandler(nullptr);
}

bool ProfAvailable()
{
  return g_engine2 != nullptr;
}

void ProfSetTool(IProfilingTool* tool)
{
  if (g_engine2)
    g_engine2->SetProfilingTool(tool);
}

void ProfEnable()
{
  if (g_engine2)
    g_engine2->EnableProfiling();
}

void ProfDisable()
{
  if (g_engine2)
    g_engine2->DisableProfiling();
}

cell_t* LocalParamsImpl(IPluginRuntime*)
{
  return nullptr; // not needed: 1.12 passes the real frame pointer in dbginfo.frm
}

void InterpImpl(bool)
{
  // The 1.x JIT emits OP_BREAK calls itself.
}

bool InterpFramesImpl(IPluginRuntime*, bool, std::vector<cell_t>*)
{
  return false; // 1.x passes the real frame pointer in dbginfo.frm
}

bool V2PositionImpl(IPluginRuntime*, SpPluginDebugInfo*, V2Position*)
{
  return false; // no SourcePawn 2.0 here
}

bool V2HeapImpl(IPluginRuntime*, uint64_t* out)
{
  *out = 0;
  return false; // no SourcePawn 2.0 here
}

void ForgetImpl() {}
void ShutdownImpl() {}

#else // SPDBG_MERGED_ENV_API
// ===========================================================================
// SourceMod 1.13+ / SourcePawn 2.0: merged ISourcePawnEnvironment. The calls we
// need are non-virtual members of sp::Environment inside sourcemod.logic.so.
// ===========================================================================

// Non-static member functions called through their address: with GCC/Clang on
// Linux `this` is simply the first argument (cdecl on i386, %rdi on x86_64).
typedef void* (*EnvGetFn)();
typedef bool (*EnvBoolFn)(void* self);
typedef int (*EnvSetBreakFn)(void* self, SPVM_DEBUGBREAK handler);
typedef void (*EnvSetToolFn)(void* self, IProfilingTool* tool);
typedef void (*EnvVoidFn)(void* self);

void* g_env = nullptr;
EnvGetFn g_get = nullptr;
EnvBoolFn g_enableDebugBreak = nullptr;
EnvSetBreakFn g_setDebugBreakHandler = nullptr;
EnvSetToolFn g_setProfilingTool = nullptr;
EnvVoidFn g_enableProfiling = nullptr;
EnvVoidFn g_disableProfiling = nullptr;

// sp::v1::PluginRuntime::GetLocalParams(): returns frm + 2 cells as a host
// pointer. Optional -- only used to recover the frame pointer of legacy plugins,
// because SourcePawn 2.0 reports dbginfo.frm = 0 and has no public accessor.
typedef cell_t* (*RtLocalParamsFn)(void* self);
RtLocalParamsFn g_localParams = nullptr;

// mimalloc is linked into sourcemod.logic.so. mi_heap_visit_blocks() walks a heap;
// with visit_all_blocks = false the visitor is called once per area (a page) with
// block == null. The first five fields of mi_heap_area_t are public mimalloc API.
struct MirrorMiArea
{
  void* blocks;
  size_t reserved;   // bytes
  size_t committed;  // bytes
  size_t used;       // blocks in use
  size_t block_size; // bytes per block
};
typedef bool (*MiBlockVisitFn)(const void* heap, const MirrorMiArea* area, void* block,
                               size_t block_size, void* arg);
typedef bool (*MiVisitBlocksFn)(const void* heap, bool visit_all_blocks, MiBlockVisitFn visitor,
                                void* arg);
MiVisitBlocksFn g_miVisitBlocks = nullptr;

typedef bool (*EnvSetJitFn)(void* self, bool enabled);
typedef const char* (*EnvEngineNameFn)(void* self);
EnvSetJitFn g_setJitEnabled = nullptr;
EnvEngineNameFn g_engineName = nullptr;
std::mutex g_interp_lock;
bool g_interp_forced = false; // we switched the JIT off and owe it back

void* g_isLineBoundary = nullptr;  // sp::SmxImage::IsLineBoundary(uint32_t) const
void* g_runInternal = nullptr;     // sp::v2::Interpreter::run_internal()
size_t g_runInternalSize = 0;

# if defined(__linux__)
bool ResolveSymbols(const ModuleInfo& m, std::string* why)
{
  SymbolTable st;
  if (!LoadSymbolTable(m, &st, why))
    return false;
  FuncSym f;
  if (FindFunction(m, st, "_ZN2sp11Environment3getEv", false, &f))
    g_get = reinterpret_cast<EnvGetFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment16EnableDebugBreakEv", false, &f))
    g_enableDebugBreak = reinterpret_cast<EnvBoolFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment20SetDebugBreakHandlerE", true, &f))
    g_setDebugBreakHandler = reinterpret_cast<EnvSetBreakFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment16SetProfilingToolE", true, &f))
    g_setProfilingTool = reinterpret_cast<EnvSetToolFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment15EnableProfilingEv", false, &f))
    g_enableProfiling = reinterpret_cast<EnvVoidFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment16DisableProfilingEv", false, &f))
    g_disableProfiling = reinterpret_cast<EnvVoidFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment13SetJitEnabledEb", false, &f))
    g_setJitEnabled = reinterpret_cast<EnvSetJitFn>(f.addr);
  if (FindFunction(m, st, "_ZN2sp11Environment13GetEngineNameEv", false, &f))
    g_engineName = reinterpret_cast<EnvEngineNameFn>(f.addr);
  if (FindFunction(m, st, "_ZNK2sp8SmxImage14IsLineBoundaryEj", false, &f))
    g_isLineBoundary = f.addr;
  if (FindFunction(m, st, "_ZN2sp2v211Interpreter12run_internalEv", false, &f)) {
    g_runInternal = f.addr;
    g_runInternalSize = f.size;
  }
  if (FindFunction(m, st, "_ZN2sp2v113PluginRuntime14GetLocalParamsEv", false, &f))
    g_localParams = reinterpret_cast<RtLocalParamsFn>(f.addr);
  if (FindFunction(m, st, "mi_heap_visit_blocks", false, &f))
    g_miVisitBlocks = reinterpret_cast<MiVisitBlocksFn>(f.addr);

  if (!g_get || !g_enableDebugBreak || !g_setDebugBreakHandler) {
    *why = "sp::Environment::{get,EnableDebugBreak,SetDebugBreakHandler} not found in " + m.path;
    return false;
  }
  return true;
}
# endif // __linux__

# if defined(__linux__)
// ---- SourcePawn 2.0 line boundaries ------------------------------------------
// Before every low-level instruction the 2.0 interpreter asks
// SmxImage::IsLineBoundary(LookupHighOffset(pc)). Bytecode operations that emit
// no code of their own share their pc with the next one, and LookupHighOffset
// returns the FIRST operation of such a group -- so a source line whose first
// operation is not first in its group is never reported. The interpreter's one
// call to IsLineBoundary is redirected here: the VM's answer, plus the group
// starts that hide a line, learned per plugin image by V2PositionImpl().
typedef bool (*LineBoundaryFn)(const void* smx, uint32_t addr);
LineBoundaryFn g_lineBoundary = nullptr;
std::unordered_map<const void*, std::unordered_set<uint32_t>> g_extra_lines;
struct KnownMethod { const void* begin; const void* end; };
std::unordered_map<const void*, KnownMethod> g_known_methods;
uint8_t* g_patch_site = nullptr; // the patched rel32
int32_t g_patch_orig = 0;
void* g_thunk = nullptr;
size_t g_thunk_size = 0;

#  if defined(__i386__)
__attribute__((force_align_arg_pointer))
#  endif
bool LineBoundaryHook(const void* smx, uint32_t addr)
{
  if (!g_extra_lines.empty()) {
    auto it = g_extra_lines.find(smx);
    if (it != g_extra_lines.end() && it->second.count(addr))
      return true;
  }
  return g_lineBoundary(smx, addr);
}

bool WriteRel32(uint8_t* at, int32_t value)
{
  const uintptr_t page = static_cast<uintptr_t>(sysconf(_SC_PAGESIZE));
  const uintptr_t start = reinterpret_cast<uintptr_t>(at) & ~(page - 1);
  const uintptr_t end = (reinterpret_cast<uintptr_t>(at) + sizeof(value) + page - 1) & ~(page - 1);
  if (mprotect(reinterpret_cast<void*>(start), end - start, PROT_READ | PROT_WRITE | PROT_EXEC) != 0)
    return false;
  memcpy(at, &value, sizeof(value));
  mprotect(reinterpret_cast<void*>(start), end - start, PROT_READ | PROT_EXEC);
  return true;
}

#  if defined(__x86_64__)
// A page within rel32 reach of |near| for a jump thunk.
void* AllocNear(uintptr_t near, size_t size)
{
  const uintptr_t page = static_cast<uintptr_t>(sysconf(_SC_PAGESIZE));
  const intptr_t kReach = (intptr_t(1) << 31) - (intptr_t(1) << 24);
  for (uintptr_t d = uintptr_t(1) << 20; d < uintptr_t(kReach); d += uintptr_t(1) << 20) {
    for (int dir = 0; dir < 2; dir++) {
      uintptr_t hint = (dir ? near - d : near + d) & ~(page - 1);
      void* p = mmap(reinterpret_cast<void*>(hint), size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if (p == MAP_FAILED)
        continue;
      intptr_t dist = reinterpret_cast<intptr_t>(p) - static_cast<intptr_t>(near);
      if (dist > -kReach && dist < kReach)
        return p;
      munmap(p, size);
    }
  }
  return nullptr;
}
#  endif

void InstallLineHook()
{
  if (g_patch_site || !g_runInternal || !g_isLineBoundary || g_runInternalSize < 5)
    return;

  uint8_t* fn = static_cast<uint8_t*>(g_runInternal);
  uint8_t* site = nullptr;
  int found = 0;
  for (size_t i = 0; i + 5 <= g_runInternalSize; i++) {
    if (fn[i] != 0xE8)
      continue;
    int32_t rel;
    memcpy(&rel, fn + i + 1, sizeof(rel));
    uintptr_t to = reinterpret_cast<uintptr_t>(fn + i + 5) + static_cast<uintptr_t>(static_cast<intptr_t>(rel));
    if (to == reinterpret_cast<uintptr_t>(g_isLineBoundary)) {
      site = fn + i;
      found++;
    }
  }
  if (found != 1) {
    smutils->LogMessage(myself, "[debug-init] found %d calls to SmxImage::IsLineBoundary in the 2.0 "
                        "interpreter (expected 1); some lines of SourcePawn 2.0 plugins may not stop", found);
    return;
  }

  uintptr_t target = reinterpret_cast<uintptr_t>(&LineBoundaryHook);
  uintptr_t disp = target - reinterpret_cast<uintptr_t>(site + 5);
#  if defined(__x86_64__)
  if (static_cast<intptr_t>(disp) != static_cast<int32_t>(disp)) {
    const size_t size = static_cast<size_t>(sysconf(_SC_PAGESIZE));
    uint8_t* t = static_cast<uint8_t*>(AllocNear(reinterpret_cast<uintptr_t>(site), size));
    if (!t) {
      smutils->LogMessage(myself, "[debug-init] no memory near the 2.0 interpreter for the line-boundary hook");
      return;
    }
    t[0] = 0x48; t[1] = 0xB8;          // movabs rax, target
    memcpy(t + 2, &target, sizeof(target));
    t[10] = 0xFF; t[11] = 0xE0;        // jmp rax
    mprotect(t, size, PROT_READ | PROT_EXEC);
    g_thunk = t;
    g_thunk_size = size;
    disp = reinterpret_cast<uintptr_t>(t) - reinterpret_cast<uintptr_t>(site + 5);
  }
#  endif

  g_lineBoundary = reinterpret_cast<LineBoundaryFn>(g_isLineBoundary);
  memcpy(&g_patch_orig, site + 1, sizeof(g_patch_orig));
  if (!WriteRel32(site + 1, static_cast<int32_t>(static_cast<uint32_t>(disp)))) {
    smutils->LogMessage(myself, "[debug-init] mprotect failed (%s); some lines of SourcePawn 2.0 plugins may not stop",
                        strerror(errno));
    return;
  }
  g_patch_site = site + 1;
  smutils->LogMessage(myself, "[debug-init] SourcePawn 2.0 line-boundary hook installed");
}
# endif // __linux__

bool InitImpl(bool late, char* error, size_t maxlength)
{
  ISourcePawnEnvironment* engine = smutils->GetScriptingEngine();
  if (!engine) {
    ke::SafeStrcpy(error, maxlength, "SourceMod has no scripting engine");
    return false;
  }
# if defined(__linux__)
  // The environment's vtable lives in the module that contains the VM.
  ModuleInfo m;
  if (!LocateModule(engine, &m)) {
    ke::SafeStrcpy(error, maxlength, "cannot locate the module that contains the SourcePawn VM");
    return false;
  }

  std::string why;
  if (!ResolveSymbols(m, &why)) {
    ke::SafeSprintf(error, maxlength, "cannot reach the SourcePawn VM debug hooks: %s", why.c_str());
    return false;
  }

  // Prove the symbols belong to THIS environment before calling a member on
  // it: Environment::get() must return the very object SourceMod handed us
  // (sp::Environment's only base is ISourcePawnEnvironment, so same address).
  void* live = g_get();
  if (live != static_cast<void*>(engine)) {
    ke::SafeSprintf(error, maxlength,
                    "sp::Environment::get() (%p) is not SourceMod's engine (%p); refusing to hook",
                    live, static_cast<void*>(engine));
    return false;
  }
  g_env = live;

  // SourceMod 1.13 turns this on itself with core.cfg "EnableLineDebugging"
  // "yes"; doing it here as well (before plugins load) makes that optional.
  if (!late && !g_enableDebugBreak(g_env) && g_DebugLogging)
    smutils->LogMessage(myself, "[debug-init] EnableDebugBreak() refused (plugins already loaded)");

  InstallLineHook();
  g_backend = "SourcePawn 2.0, stock sourcemod.logic (sp::Environment via .symtab)";
  return true;
# else
  (void)late;
  ke::SafeStrcpy(error, maxlength,
                 "SourceMod 1.13+ is only supported on Linux: its debug hooks are resolved from "
                 "sourcemod.logic.so's symbol table");
  return false;
# endif
}

bool InstallImpl(SPVM_DEBUGBREAK handler)
{
  return g_env && g_setDebugBreakHandler && g_setDebugBreakHandler(g_env, handler) == SP_ERROR_NONE;
}

void RemoveImpl()
{
  if (g_env && g_setDebugBreakHandler)
    g_setDebugBreakHandler(g_env, nullptr);
}

bool ProfAvailable()
{
  return g_env && g_setProfilingTool && g_enableProfiling && g_disableProfiling;
}

void ProfSetTool(IProfilingTool* tool)
{
  if (ProfAvailable())
    g_setProfilingTool(g_env, tool);
}

void ProfEnable()
{
  if (ProfAvailable())
    g_enableProfiling(g_env);
}

void ProfDisable()
{
  if (ProfAvailable())
    g_disableProfiling(g_env);
}

cell_t* LocalParamsImpl(IPluginRuntime* rt)
{
  if (!g_localParams || !rt)
    return nullptr;
  // IPluginRuntime -> sp::BaseRuntime -> sp::v1::PluginRuntime: single
  // inheritance, same address. Callers only pass legacy (v1) runtimes.
  void* self = static_cast<void*>(rt->GetBaseRuntime());
  return self ? g_localParams(self) : nullptr;
}

void InterpImpl(bool on)
{
  if (!g_env || !g_setJitEnabled)
    return;
  std::lock_guard<std::mutex> lock(g_interp_lock);
  if (on) {
    if (g_interp_forced)
      return;
    // "SourcePawn 2.0 (v2-jit-x86, v1-jit-x86)": only touch the JIT if it is on.
    const char* name = g_engineName ? g_engineName(g_env) : nullptr;
    if (name && !strstr(name, "-jit-"))
      return; // already interpreting (admin disabled it, or no JIT here)
    g_setJitEnabled(g_env, false);
    g_interp_forced = true;
  } else if (g_interp_forced) {
    g_setJitEnabled(g_env, true);
    g_interp_forced = false;
  }
}

# if defined(__linux__)
// Mirror of sp::v2::Interpreter's data members (vm/v2/interpreter.h, SourcePawn
// 2.0): everything up to ivk_. Only used to READ a live object found on the stack,
// and only after env_/rt_/frm_ have all been cross-checked against known values.
struct MirrorInterp
{
  void* env_;
  void* rt_;
  void* smx_;
  void* heap_;
  const uint8_t* code_;
  const uint8_t* reader_cursor_;
  const uint8_t* reader_stop_;
  bool has_returned_;
  cell_t return_value_;
  cell_t frm_;
  cell_t* phys_frm_;
  void* ivk_;
};

// sp::v2::InterpFrame flattened (InvokeFrame + InterpInvokeFrame + its own
// fields): only the offset of prev_frame, the caller's frame pointer, is needed.
struct MirrorInterpFrame
{
  void* vptr;
  void* prev_;
  void* cx_;
  void* callee_;
  const uint8_t* const* cip_;
  int native_index_;
  const uint8_t* saved_cip;
  uint32_t dest_reg;
  uint32_t prev_frame;
};

uintptr_t StackHigh()
{
  static __thread uintptr_t high = 0;
  if (high)
    return high;
  pthread_attr_t attr;
  if (pthread_getattr_np(pthread_self(), &attr) != 0)
    return 0;
  void* addr = nullptr;
  size_t size = 0;
  if (pthread_attr_getstack(&attr, &addr, &size) == 0)
    high = reinterpret_cast<uintptr_t>(addr) + size;
  pthread_attr_destroy(&attr);
  return high;
}
# endif // __linux__

bool InterpFramesImpl(IPluginRuntime* rt, bool all, std::vector<cell_t>* out)
{
  out->clear();
# if defined(__linux__)
  if (!g_env || !rt)
    return false;
  uintptr_t high = StackHigh();
  if (!high)
    return false;

  volatile uintptr_t marker = 0;
  uintptr_t cur = (reinterpret_cast<uintptr_t>(&marker) + sizeof(void*) - 1) & ~(sizeof(void*) - 1);
  const uintptr_t kMaxScan = 512 * 1024;
  if (high - cur > kMaxScan)
    high = cur + kMaxScan;

  const void* cand_a = rt;
  const void* cand_b = static_cast<const void*>(rt->GetBaseRuntime());

  for (; cur + sizeof(MirrorInterp) <= high; cur += sizeof(void*)) {
    const MirrorInterp* mi = reinterpret_cast<const MirrorInterp*>(cur);
    if (mi->env_ != g_env)
      continue;
    if (mi->rt_ != cand_a && mi->rt_ != cand_b)
      continue;
    if (mi->frm_ <= 0 || (mi->frm_ & 3) != 0 || mi->phys_frm_ == nullptr)
      continue;

    cell_t* phys = nullptr;
    if (rt->LocalToPhysAddr(mi->frm_, &phys) != SP_ERROR_NONE || !phys)
      continue;

    // frm_ always follows the innermost frame; phys_frm_ stays on the root's.
    out->push_back(mi->frm_);
    if (!all)
      return true;

    cell_t frm = mi->frm_;
    if (phys != mi->phys_frm_) {
      // Nested frame: its InterpFrame sits right below its registers, on the VM
      // stack. ivk_ points at it, which gives the real (aligned) header size.
      intptr_t aligned = reinterpret_cast<uint8_t*>(phys) - reinterpret_cast<uint8_t*>(mi->ivk_);
      if (aligned < 24 || aligned > 128 || (aligned & 3) != 0)
        return true; // keep what we have
      for (int i = 0; i < 4096; i++) {
        cell_t* p = nullptr;
        if (rt->LocalToPhysAddr(frm, &p) != SP_ERROR_NONE || !p || p == mi->phys_frm_)
          break;
        uint32_t prev;
        memcpy(&prev, reinterpret_cast<uint8_t*>(p) - aligned + offsetof(MirrorInterpFrame, prev_frame),
               sizeof(prev));
        if (prev == 0 || (prev & 3) != 0 || prev >= static_cast<uint32_t>(frm))
          break;
        out->push_back(static_cast<cell_t>(prev));
        frm = static_cast<cell_t>(prev);
      }
    }
    return true;
  }
  return false;
# else
  (void)rt; (void)all;
  return false;
# endif
}

# if defined(__linux__)
// Mirrors of the SourcePawn 2.0 objects between an interpreter frame and its
// low-level code. Layouts checked against the official 1.13 binaries
// (MethodInfo::TranslateInterpCip reads llcode_ and mappings_ at these offsets).
struct LLMap { uint32_t low; uint32_t high; };
struct MirrorLLCode
{
  const uint8_t* bytes_;
  size_t size_;
  uint32_t num_regs_;
  uint32_t max_callee_args_;
  const LLMap* begin_; // std::vector<OffsetMapping> mappings_
  const LLMap* end_;
};
static_assert(offsetof(MirrorLLCode, begin_) == (sizeof(void*) == 8 ? 0x18 : 0x10), "LLCode::mappings_");
struct MirrorSpFunction { const void* td; uintptr_t rc; const void* method; };
struct MirrorMethodInfo
{
  const void* vptr;
  uintptr_t refcount;
  const void* rt_;
  uint32_t method_index_;
  const void* jit_;
  const MirrorLLCode* llcode_;
};
static_assert(offsetof(MirrorMethodInfo, llcode_) == 5 * sizeof(void*), "MethodInfo::llcode_");

const MirrorInterp* FindInterp(IPluginRuntime* rt)
{
  if (!g_env || !rt)
    return nullptr;
  uintptr_t high = StackHigh();
  if (!high)
    return nullptr;
  volatile uintptr_t marker = 0;
  uintptr_t cur = (reinterpret_cast<uintptr_t>(&marker) + sizeof(void*) - 1) & ~(sizeof(void*) - 1);
  const uintptr_t kMaxScan = 512 * 1024;
  if (high - cur > kMaxScan)
    high = cur + kMaxScan;
  const void* cand_a = rt;
  const void* cand_b = static_cast<const void*>(rt->GetBaseRuntime());
  for (; cur + sizeof(MirrorInterp) <= high; cur += sizeof(void*)) {
    const MirrorInterp* mi = reinterpret_cast<const MirrorInterp*>(cur);
    if (mi->env_ != g_env || (mi->rt_ != cand_a && mi->rt_ != cand_b))
      continue;
    if (mi->frm_ <= 0 || (mi->frm_ & 3) != 0 || mi->phys_frm_ == nullptr)
      continue;
    cell_t* phys = nullptr;
    if (rt->LocalToPhysAddr(mi->frm_, &phys) != SP_ERROR_NONE || !phys)
      continue;
    return mi;
  }
  return nullptr;
}

// Remember the group starts of |method| that hide a line (see LineBoundaryHook).
void ComputeExtras(const void* smx, SpPluginDebugInfo* info, const LLMap* begin, const LLMap* end)
{
  int logged = 0;
  for (const LLMap* run = begin; run != end;) {
    const LLMap* next = run + 1;
    while (next != end && next->low == run->low)
      ++next;
    const bool first_row = info->IsLineBoundary(run->high);
    bool later_row = false;
    for (const LLMap* p = run + 1; p != next; ++p) {
      if (info->IsLineBoundary(p->high)) {
        later_row = true;
        break;
      }
    }
    if (!first_row && later_row)
      g_extra_lines[smx].insert(run->high);
    if (g_DebugLogging && later_row && logged < 64) {
      std::string highs;
      char buf[32];
      for (const LLMap* p = run; p != next; ++p) {
        snprintf(buf, sizeof(buf), " %u%s", p->high, info->IsLineBoundary(p->high) ? "*" : "");
        highs += buf;
      }
      smutils->LogMessage(myself, "[v2-lines] pc %u:%s%s", run->low, highs.c_str(),
                          first_row ? "" : "  (hidden -> hooked)");
      logged++;
    }
    run = next;
  }
}
# endif // __linux__

# if defined(__linux__)
// ---- SourcePawn 2.0 heap ---------------------------------------------------
// sp::v2::Runtime keeps `Environment* env_; Heap heap_;` side by side, and Heap is
// a RawHeap = { VirtMem& virt_mem_; mi_heap_t* mi_heap_; } with no vtable. The
// environment owns a RawHeap of its own, built from the same VirtMem, so:
//   runtime:     [ env_ == g_env ][ &env->virt_mem_ ][ mi_heap_ ]
//   environment: [ ... &env->virt_mem_ ][ env mi_heap_ ]
// The runtime's mi_heap_ is only trusted when that whole shape is found, the two
// heaps agree on their thread-local data (mi_heap_t starts with `tld`), and every
// pointer is aligned and readable. Anything else -> not measured.
struct HeapLayout
{
  bool known = false;
  int failures = 0;
  size_t index = 0;    // word index of env_ inside the runtime
  uintptr_t virt = 0;  // &env->virt_mem_
  uintptr_t tld = 0;   // first word of every mi_heap_t of this process
};
HeapLayout g_heap;
std::mutex g_heap_lock;

// Copies up to |max_words| words from |src|, stopping at the first unreadable
// chunk. Returns how many words were copied.
size_t CopyWords(const void* src, uintptr_t* dst, size_t max_words)
{
  const uint8_t* p = static_cast<const uint8_t*>(src);
  uint8_t* d = reinterpret_cast<uint8_t*>(dst);
  const size_t max_bytes = max_words * sizeof(uintptr_t);
  size_t done = 0;
  while (done < max_bytes) {
    size_t n = std::min<size_t>(256, max_bytes - done);
    if (!SpReadable(p + done, n))
      break;
    memcpy(d + done, p + done, n);
    done += n;
  }
  return done / sizeof(uintptr_t);
}

bool ReadWord(uintptr_t addr, uintptr_t* out)
{
  return CopyWords(reinterpret_cast<const void*>(addr), out, 1) == 1;
}

bool PlausiblePtr(uintptr_t v)
{
  return v >= 0x10000 && (v & (sizeof(uintptr_t) - 1)) == 0;
}

bool LocateRuntimeHeap(const uint8_t* rt_base, uintptr_t* mi_out)
{
  const size_t W = sizeof(uintptr_t);
  const uintptr_t env = reinterpret_cast<uintptr_t>(g_env);

  if (g_heap.known) {
    uintptr_t w[3];
    if (CopyWords(rt_base + g_heap.index * W, w, 3) != 3)
      return false;
    uintptr_t tld = 0;
    if (w[0] != env || w[1] != g_heap.virt || !PlausiblePtr(w[2]) ||
        !ReadWord(w[2], &tld) || tld != g_heap.tld)
      return false;
    *mi_out = w[2];
    return true;
  }
  if (g_heap.failures >= 3)
    return false; // give up quietly; the panel shows the heap as not measured
  g_heap.failures++;

  std::vector<uintptr_t> rw(512);
  const size_t rn = CopyWords(rt_base, rw.data(), rw.size());
  std::vector<uintptr_t> ew;
  size_t en = 0;
  for (size_t i = 0; i + 2 < rn; i++) {
    if (rw[i] != env)
      continue;
    const uintptr_t virt = rw[i + 1], mi = rw[i + 2];
    if (!PlausiblePtr(virt) || virt <= env || virt - env > 0x10000 || !PlausiblePtr(mi))
      continue;
    if (ew.empty()) {
      ew.resize(4096);
      en = CopyWords(g_env, ew.data(), ew.size());
    }
    for (size_t q = (virt - env) / W + 1; q + 1 < en; q++) {
      if (ew[q] != virt)
        continue;
      const uintptr_t env_mi = ew[q + 1];
      uintptr_t t_rt = 0, t_env = 0;
      if (!PlausiblePtr(env_mi) || env_mi == mi || !ReadWord(mi, &t_rt) ||
          !ReadWord(env_mi, &t_env) || t_rt != t_env || !PlausiblePtr(t_rt))
        break;
      g_heap.known = true;
      g_heap.index = i;
      g_heap.virt = virt;
      g_heap.tld = t_rt;
      if (g_DebugLogging)
        smutils->LogMessage(myself, "[v2-heap] runtime heap found: env_ at word %zu, mi_heap %p",
                            i, reinterpret_cast<void*>(mi));
      *mi_out = mi;
      return true;
    }
  }
  if (g_DebugLogging)
    smutils->LogMessage(myself, "[v2-heap] could not locate the runtime heap (%zu words scanned, attempt %d)",
                        rn, g_heap.failures);
  return false;
}

struct HeapAreaSum
{
  uint64_t bytes = 0;
  bool bad = false;
};

bool HeapAreaVisitor(const void*, const MirrorMiArea* area, void* block, size_t, void* arg)
{
  HeapAreaSum* sum = static_cast<HeapAreaSum*>(arg);
  if (block || !area)
    return true; // only the per-area call carries the counters
  const uint64_t bytes = static_cast<uint64_t>(area->used) * area->block_size;
  // A page can't use more than it reserved; if it claims to, we are not looking at
  // what we think we are.
  if (area->block_size == 0 || bytes > area->reserved || sum->bytes + bytes > (1ull << 36)) {
    sum->bad = true;
    return false;
  }
  sum->bytes += bytes;
  return true;
}
# endif // __linux__

bool V2HeapImpl(IPluginRuntime* rt, uint64_t* out)
{
  *out = 0;
# if defined(__linux__)
  if (!g_env || !g_miVisitBlocks || !rt)
    return false;
  const uint8_t* base = reinterpret_cast<const uint8_t*>(rt->GetBaseRuntime());
  if (!base)
    return false;

  std::lock_guard<std::mutex> lock(g_heap_lock);
  uintptr_t mi = 0;
  if (!LocateRuntimeHeap(base, &mi))
    return false;
  HeapAreaSum sum;
  const bool ok = g_miVisitBlocks(reinterpret_cast<const void*>(mi), false, HeapAreaVisitor, &sum);
  if (!ok || sum.bad)
    return false;
  *out = sum.bytes;
  return true;
# else
  (void)rt;
  return false;
# endif
}

bool V2PositionImpl(IPluginRuntime* rt, SpPluginDebugInfo* info, V2Position* out)
{
  *out = V2Position();
# if defined(__linux__)
  if (!info)
    return false;
  const MirrorInterp* mi = FindInterp(rt);
  if (!mi)
    return false;
  out->frm = mi->frm_;

  // ivk_ (innermost InterpFrame) -> callee SpFunction -> MethodInfo -> LLCode.
  const MirrorInterpFrame* frame = static_cast<const MirrorInterpFrame*>(mi->ivk_);
  if (!SpReadable(frame, sizeof(*frame)))
    return true;
  const MirrorSpFunction* fn = static_cast<const MirrorSpFunction*>(frame->callee_);
  if (!SpReadable(fn, sizeof(*fn)))
    return true;
  const MirrorMethodInfo* method = static_cast<const MirrorMethodInfo*>(fn->method);
  if (!SpReadable(method, sizeof(*method)))
    return true;
  if (method->rt_ != static_cast<const void*>(rt) &&
      method->rt_ != static_cast<const void*>(rt->GetBaseRuntime()))
  {
    return true;
  }
  const MirrorLLCode* code = method->llcode_;
  if (!SpReadable(code, sizeof(*code)) || !code->bytes_ || code->size_ == 0 || code->size_ > (64u << 20))
    return true;
  if (!SpReadable(frame->cip_, sizeof(void*)))
    return true;
  const uint8_t* insn = *frame->cip_;
  if (insn < code->bytes_ || insn >= code->bytes_ + code->size_)
    return true;
  const LLMap* begin = code->begin_;
  const LLMap* end = code->end_;
  if (!begin || end <= begin || size_t(end - begin) > (size_t(1) << 22))
    return true;

  auto known = g_known_methods.find(method);
  const bool was_known = known != g_known_methods.end() &&
                         known->second.begin == begin && known->second.end == end;
  if (!was_known && !SpReadable(begin, size_t(end - begin) * sizeof(LLMap)))
    return true;

  const uint32_t ll = static_cast<uint32_t>(insn - code->bytes_);
  const LLMap* it = std::lower_bound(begin, end, ll,
                                     [](const LLMap& m, uint32_t v) { return m.low < v; });
  out->mapped = true;
  out->known = was_known;
  if (it != end && it->low == ll) {
    out->exact = true;
    for (const LLMap* p = it; p != end && p->low == ll; ++p) {
      if (info->IsLineBoundary(p->high))
        out->lines.push_back(p->high);
    }
  }

  if (!was_known) {
    ComputeExtras(mi->smx_, info, begin, end);
    g_known_methods[method] = KnownMethod{begin, end};
  }
  return true;
# else
  (void)rt; (void)info;
  return false;
# endif
}

void ForgetImpl()
{
# if defined(__linux__)
  g_extra_lines.clear();
  g_known_methods.clear();
# endif
}

void ShutdownImpl()
{
# if defined(__linux__)
  if (g_patch_site) {
    WriteRel32(g_patch_site, g_patch_orig);
    g_patch_site = nullptr;
  }
  if (g_thunk) {
    munmap(g_thunk, g_thunk_size);
    g_thunk = nullptr;
  }
# endif
  ForgetImpl();
}

#endif // SPDBG_MERGED_ENV_API

// ---- legacy plugins: stack and heap in use ----------------------------------
// PluginContext (1.12) / legacy PluginRuntime (1.13) declare, in this order:
//   ... uint8_t* memory_; uint32_t data_size_; uint32_t mem_size_;
//   cell_t* m_pNullVec; cell_t* m_pNullString;
//   cell_t stp_;   // = mem_size_ - 4: the stack top, fixed
//   cell_t sp_;    // stack pointer (offset from the start of plugin memory)
//   cell_t hp_;    // heap pointer
//   cell_t frm_;   // frame pointer
// Four consecutive cells starting with a stp_ of known value.
std::atomic<int> g_legacy_idx{-1};   // word index of stp_ inside the object
std::atomic<int> g_legacy_fail{0};

size_t PeekWords(const void* src, int32_t* dst, size_t max_words)
{
  const uint8_t* p = static_cast<const uint8_t*>(src);
  uint8_t* d = reinterpret_cast<uint8_t*>(dst);
  const size_t max_bytes = max_words * sizeof(int32_t);
  size_t done = 0;
  while (done < max_bytes) {
    size_t n = std::min<size_t>(256, max_bytes - done);
    if (!SpReadable(p + done, n))
      break;
    memcpy(d + done, p + done, n);
    done += n;
  }
  return done / sizeof(int32_t);
}

bool LegacyPlausible(const int32_t* w, int32_t stp, int32_t data)
{
  const int32_t sp = w[1], hp = w[2], frm = w[3];
  return w[0] == stp && (sp & 3) == 0 && (hp & 3) == 0 && hp >= data && hp <= sp && sp <= stp &&
         frm >= sp && frm <= stp;
}

bool LegacyUseImpl(IPluginContext* ctx, uint32_t data_bytes, uint32_t mem_bytes,
                   int64_t* stack_used, int64_t* heap_used)
{
  if (!ctx || mem_bytes < 8)
    return false;
# if defined(SPDBG_MERGED_ENV_API)
  IPluginRuntime* rt = ctx->GetRuntime();
  const uint8_t* base = rt ? reinterpret_cast<const uint8_t*>(rt->GetBaseRuntime()) : nullptr;
# else
  const uint8_t* base = reinterpret_cast<const uint8_t*>(ctx);
# endif
  if (!base)
    return false;

  const int32_t stp = static_cast<int32_t>(mem_bytes) - 4;
  const int32_t data = static_cast<int32_t>(data_bytes);
  int32_t w[4];
  const int idx = g_legacy_idx.load(std::memory_order_relaxed);
  if (idx >= 0) {
    memcpy(w, base + static_cast<size_t>(idx) * sizeof(int32_t), sizeof(w));
    if (!LegacyPlausible(w, stp, data))
      return false; // transient (mid-update) or not what we think: skip this sample
  } else {
    if (g_legacy_fail.load(std::memory_order_relaxed) >= 3)
      return false;
    int32_t buf[512];
    const size_t n = PeekWords(base, buf, 512);
    int found = -1, count = 0;
    for (size_t i = 0; i + 4 <= n; i++) {
      if (LegacyPlausible(buf + i, stp, data)) {
        if (count == 0)
          found = static_cast<int>(i);
        count++;
      }
    }
    if (count != 1) {
      g_legacy_fail.fetch_add(1);
      if (g_DebugLogging)
        smutils->LogMessage(myself, "[stack-heap] %d candidate(s) for stp_=%d in %zu words; not tracking",
                            count, stp, n);
      return false;
    }
    g_legacy_idx.store(found, std::memory_order_relaxed);
    memcpy(w, buf + found, sizeof(w));
    if (g_DebugLogging)
      smutils->LogMessage(myself, "[stack-heap] sp_/hp_ found at word %d of the plugin object", found + 1);
  }
  *stack_used = static_cast<int64_t>(stp) - w[1];
  *heap_used = static_cast<int64_t>(w[2]) - data;
  return true;
}

} // namespace

bool Init(bool late, char* error, size_t maxlength)
{
  return InitImpl(late, error, maxlength);
}

bool InstallDebugBreakHandler(SPVM_DEBUGBREAK handler)
{
  if (!InstallImpl(handler))
    return false;
  g_installed = true;
  return true;
}

void RemoveDebugBreakHandler()
{
  // Only touch the VM if we really installed a handler: on an incompatible VM
  // the call itself is what would crash.
  if (!g_installed)
    return;
  RemoveImpl();
  g_installed = false;
}

bool ProfilingAvailable()
{
  return ProfAvailable();
}

void SetProfilingTool(IProfilingTool* tool)
{
  ProfSetTool(tool);
}

void EnableProfiling()
{
  ProfEnable();
}

void DisableProfiling()
{
  ProfDisable();
}

cell_t* LocalParams(IPluginRuntime* rt)
{
  return LocalParamsImpl(rt);
}

void RequireInterpreter(bool on)
{
  InterpImpl(on);
}

bool InterpreterFrames(IPluginRuntime* rt, bool all, std::vector<cell_t>* out)
{
  return InterpFramesImpl(rt, all, out);
}

bool V2CurrentPosition(IPluginRuntime* rt, SpPluginDebugInfo* info, V2Position* out)
{
  return V2PositionImpl(rt, info, out);
}

bool V2HeapBytes(IPluginRuntime* rt, uint64_t* out)
{
  return V2HeapImpl(rt, out);
}

bool LegacyStackHeapUse(IPluginContext* ctx, uint32_t data_bytes, uint32_t mem_bytes,
                        int64_t* stack_used, int64_t* heap_used)
{
  return LegacyUseImpl(ctx, data_bytes, mem_bytes, stack_used, heap_used);
}

void LegacyStackHeapReset()
{
  g_legacy_idx.store(-1);
  g_legacy_fail.store(0);
}

void ForgetV2Lines()
{
  ForgetImpl();
}

void Shutdown()
{
  ShutdownImpl();
}

const char* Backend()
{
  return g_backend;
}

} // namespace vm
} // namespace spdbg
