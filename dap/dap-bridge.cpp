/**
 * dap-bridge.cpp -- implementation of the DAP/TCP/profiler crate hub.
 *
 * The method bodies here were lifted verbatim from the old inline DAP code in
 * sp-console-debugger/extension.cpp; only the owning type changed
 * (ConsoleDebugger:: -> DapBridge::) and the few upstream accessors are now
 * reached through ext_ instead of being members.
 */

#include <memory>
#include <string>
#include <sstream>
#include <iostream>
#include <vector>
#include <utility>
#include <algorithm>
#include <chrono>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#ifdef KE_POSIX
#include <ctype.h>
#endif

#include "dap-bridge.h"
#include "debugger.h"
#include "tcp-server.h"
#include "session-manager.h"
#include "json-utils.h"
#include "profiler.h"
#include "config.h"
#include <amtl/am-platform.h>

using namespace ke;

// Defaults for everything the listener needs. Override in
// addons/sourcemod/configs/console-debugger.cfg.
static constexpr int kDefaultDebuggerPort = 8080;
// Loopback by default: a DAP session can read and write the plugin's memory and
// can hold the game thread on a breakpoint, so it must not be reachable from
// the network unless the owner opts in (and then only with a token).
static constexpr const char* kDefaultBindAddress = "127.0.0.1";
static constexpr int kDefaultMaxClients = 4;

// The self-documenting default config, written to
// addons/sourcemod/configs/console-debugger.cfg the first time the extension
// loads (see EnsureDefaultConfig). Shipping it as generated-on-load rather than
// a file to copy keeps the vendored upstream tree pristine and means a server
// owner only has to drop in the .so -- the config appears on first start, ready
// to edit. The port value here MUST match kDefaultDebuggerPort above.
static const char kDefaultConfigContents[] =
    "// Configuration for the SourcePawn console-debugger extension.\n"
    "// Auto-generated on first load. Safe to edit; it is never overwritten.\n"
    "//\n"
    "// The extension reads this file once at SDK_OnLoad. Changes require a\n"
    "// reload of the extension (sm exts reload console-debugger) or a server\n"
    "// restart to take effect.\n"
    "\n"
    "\"ConsoleDebugger\"\n"
    "{\n"
    "    // Address the DAP server listens on. Default: 127.0.0.1 -- reachable\n"
    "    // only from this machine, because a debug session can read and write\n"
    "    // plugin memory and can freeze the server on a breakpoint.\n"
    "    //\n"
    "    // To debug from another machine, prefer an SSH tunnel and leave this\n"
    "    // alone:  ssh -L 8080:127.0.0.1:8080 user@gameserver\n"
    "    //\n"
    "    // Setting this to 0.0.0.0 (or any non-loopback address) exposes the\n"
    "    // debugger to the network and REQUIRES a non-empty \"token\" below;\n"
    "    // without one the server refuses to start.\n"
    "    \"bind\"  \"127.0.0.1\"\n"
    "\n"
    "    // Shared secret the debugger client must present before any request is\n"
    "    // served. Empty (the default) means no authentication, which is only\n"
    "    // allowed while \"bind\" stays on loopback. Set it to a long random\n"
    "    // string and put the same value in the VS Code launch.json (\"token\").\n"
    "    \"token\"  \"\"\n"
    "\n"
    "    // Maximum debugger clients connected at once. One editor needs one.\n"
    "    // Valid range: 1-64.\n"
    "    \"max_clients\"  \"4\"\n"
    "\n"
    "    // TCP port the DAP server listens on. The VS Code launch.json on the\n"
    "    // developer's machine must use the same port. Default: 8080.\n"
    "    // Valid range: 1-65535. Invalid values fall back to the default.\n"
    "    \"port\"  \"8080\"\n"
    "\n"
    "    // Verbose debug logging to the server console. When off (default), only\n"
    "    // errors, the one-time startup banner, and rare transport-anomaly\n"
    "    // diagnostics are printed. Turn on to see per-message [SM] DAP / [TCP]\n"
    "    // traffic when troubleshooting the debugger itself.\n"
    "    // Accepts: 1/true/yes/on to enable, anything else to disable.\n"
    "    \"debug_log\"  \"0\"\n"
    "}\n";

// Where the DAP server listens, and on what terms. All of it comes from
// addons/sourcemod/configs/console-debugger.cfg through dap/config.h -- see
// kDefaultConfigContents above for the documented defaults.
struct ListenConfig {
    std::string bind_address;
    std::string token;
    int port;
    int max_clients;
};

static ListenConfig LoadListenConfig()
{
    ListenConfig cfg;
    cfg.bind_address = dap::ConfigString("bind", kDefaultBindAddress);
    cfg.token = dap::ConfigString("token", "");
    cfg.port = dap::ConfigInt("port", kDefaultDebuggerPort, 1, 65535);
    cfg.max_clients = dap::ConfigInt("max_clients", kDefaultMaxClients, 1, 64);
    return cfg;
}

// Write the default config to addons/sourcemod/configs/console-debugger.cfg if
// it doesn't already exist. Called once from dap::Init at load time. Existing
// files are left untouched, so a server owner's edits (custom port, debug_log)
// always survive an extension update. A write failure is non-fatal: the
// extension runs fine on defaults, so we only log it.
static void EnsureDefaultConfig()
{
    char path[PLATFORM_MAX_PATH];
    if (!smutils->BuildPath(Path_SM, path, sizeof(path), "configs/console-debugger.cfg"))
        return;

    // Don't clobber an existing config.
    if (FILE* existing = fopen(path, "r")) {
        fclose(existing);
        return;
    }

    FILE* f = fopen(path, "w");
    if (!f) {
        smutils->LogError(myself, "Could not create default console-debugger.cfg at %s; "
                                  "using built-in defaults (port %d)", path, kDefaultDebuggerPort);
        return;
    }
    fputs(kDefaultConfigContents, f);
    fclose(f);
    smutils->LogMessage(myself, "Wrote default console-debugger.cfg to %s", path);
}

DapBridge::DapBridge(ConsoleDebugger* ext, SourcePawn::ISourcePawnEngine2* engine2)
  : ext_(ext), spengine2_(engine2)
{
}

DapBridge::~DapBridge()
{
}

void
DapBridge::Start()
{
  // Initialize TCP server for DAP protocol
  tcp_server_ = std::make_unique<TcpServer>();
  session_manager_ = std::make_unique<SessionManager>(this);

  // Set message handler for TCP server
  tcp_server_->SetMessageHandler([this](ClientConnection* client, const std::string& message) {
    session_manager_->HandleDAPMessage(client, message);
  });

  tcp_server_->SetExtension(this);

  // Register callback for when last client disconnects (auto-resume paused debuggers)
  tcp_server_->SetLastClientDisconnectCallback([this]() {
    this->OnLastClientDisconnect();
  });
  SPDBG_LOG("[SM] Registered TCP auto-resume callback");

  // Listener settings come from addons/sourcemod/configs/console-debugger.cfg;
  // missing/invalid values fall back to the documented defaults.
  const ListenConfig listen = LoadListenConfig();
  auth_token_ = listen.token;

  // A debug session can read and write plugin memory and can park the game
  // thread on a breakpoint, so an unauthenticated listener must never face the
  // network. Loopback needs no token (only local users can reach it); anything
  // else does, and we refuse to open the port rather than expose the server.
  if (!dap::IsLoopbackAddress(listen.bind_address) && listen.token.empty()) {
    rootconsole->ConsolePrint("[SM] DAP server NOT started: \"bind\" is %s but \"token\" is empty",
                              listen.bind_address.c_str());
    smutils->LogError(myself,
                      "Refusing to expose the debugger on %s without authentication. Set a non-empty "
                      "\"token\" in configs/console-debugger.cfg (and the same value in the VS Code "
                      "launch.json), or leave \"bind\" on 127.0.0.1 and use an SSH tunnel.",
                      listen.bind_address.c_str());
    return;
  }

  if (!tcp_server_->Start(listen.bind_address, static_cast<uint16_t>(listen.port),
                          static_cast<size_t>(listen.max_clients), !listen.token.empty())) {
    rootconsole->ConsolePrint("[SM] Warning: Failed to start TCP debug server on %s:%d",
                              listen.bind_address.c_str(), listen.port);
    smutils->LogError(myself, "Failed to start TCP debug server on %s:%d. DAP debugging will not be available.",
                      listen.bind_address.c_str(), listen.port);
  } else {
    const char* auth = listen.token.empty() ? "no token (loopback only)" : "token required";
    rootconsole->ConsolePrint("[SM] TCP debug server started on %s:%d (%s)",
                              listen.bind_address.c_str(), listen.port, auth);
    smutils->LogMessage(myself, "TCP debug server started on %s:%d for DAP protocol (%s)",
                        listen.bind_address.c_str(), listen.port, auth);
    if (dap::IsLoopbackAddress(listen.bind_address)) {
      smutils->LogMessage(myself, "Debugger is reachable from this machine only. To debug remotely, "
                                  "tunnel it (ssh -L %d:127.0.0.1:%d user@host) or set \"bind\" plus "
                                  "\"token\" in configs/console-debugger.cfg.",
                          listen.port, listen.port);
    }
  }

  // Two profilers (see dap-bridge.h): vm_profiler_ is registered with the VM and
  // covers ALL plugins at top-level (EnableProfiling toggled at capture time);
  // traced_profiler_ is driven by the debug-break tracer for the debugged
  // plugin's full callee tree. Both stay idle until sp_profileStart.
  vm_profiler_ = std::make_unique<Profiler>(Profiler::Timing::kInclusiveSpan);
  // The tracer measures exclusive time per break gap (kSelfGap) so it can drop
  // the idle between server frames; otherwise a top-level forward like
  // OnGameFrame reads ~= the whole capture window instead of its real work.
  traced_profiler_ = std::make_unique<Profiler>(Profiler::Timing::kSelfGap);
  if (spengine2_)
    spengine2_->SetProfilingTool(vm_profiler_.get());
  else
    smutils->LogMessage(myself, "SourcePawn v2 engine unavailable; 'All plugins' profiler disabled");
}

void
DapBridge::Shutdown()
{
  // Stop TCP server
  if (tcp_server_) {
    tcp_server_->Stop();
    SPDBG_LOG("[SM] TCP debug server stopped");
  }
  tcp_server_.reset();
  session_manager_.reset();

  // Stop any in-flight capture and destroy the profilers. Unregister the VM
  // profiling tool first so the VM never calls into a freed object.
  EndSampling();
  if (spengine2_) {
    spengine2_->DisableProfiling();
    spengine2_->SetProfilingTool(nullptr);
  }
  vm_profiler_.reset();
  traced_profiler_.reset();
}

Debugger*
DapBridge::GetPluginDebugger(IPluginContext* ctx)
{
  return ext_->GetPluginDebugger(ctx);
}

IPlugin*
DapBridge::FindPluginByConsoleArg(const char* arg)
{
  return ext_->FindPluginByConsoleArg(arg);
}

bool
DapBridge::StartPluginDebugging(IPluginContext* ctx)
{
  return ext_->StartPluginDebugging(ctx);
}

DebuggerMap&
DapBridge::GetDebuggerMap()
{
  return ext_->GetDebuggerMap();
}

void
DapBridge::DetachClientsFromPlugin(IPlugin *plugin)
{
  if (!tcp_server_)
    return;
  for (ClientConnection *client : tcp_server_->GetClients()) {
    if (client && client->active_plugin == plugin) {
      client->active_plugin = nullptr;  // keep active_plugin_name + bp cache
      if (client->variable_handles)
        client->variable_handles->Clear();
    }
  }
}

void
DapBridge::RebindClientsToReloadedPlugin(IPlugin *plugin)
{
  if (!tcp_server_ || !plugin)
    return;
  const char *fname = plugin->GetFilename();
  if (!fname)
    return;

  for (ClientConnection *client : tcp_server_->GetClients()) {
    // Only clients that were detached (active_plugin nulled) and were debugging
    // a plugin with this exact filename should rebind.
    if (!client || client->active_plugin != nullptr)
      continue;
    if (client->active_plugin_name.empty() || client->active_plugin_name != fname)
      continue;

    client->active_plugin = plugin;
    if (!StartPluginDebugging(plugin->GetBaseContext())) {
      // Couldn't reactivate (e.g. line debugging unavailable); leave it bound
      // so handlers don't dangle, but report the situation.
      SendDAPOutputEvent(("Plugin reloaded but could not reattach debugger: "
                          + std::string(fname) + "\n").c_str(), "stderr");
      continue;
    }

    Debugger *debugger = GetPluginDebugger(plugin->GetBaseContext());
    if (!debugger)
      continue;
    debugger->SetOwnerToken(client);
    // Resume; breakpoints will halt it again. STEPPING (from StartPluginDebugging)
    // would pause on the very next line, which isn't what a refresh should do.
    debugger->SetRunmode(RUNNING);

    int reapplied = ReapplyCachedBreakpoints(client, debugger);

    char msg[256];
    snprintf(msg, sizeof(msg),
             "Plugin %s reloaded; debugger reattached, %d breakpoint(s) restored.\n",
             fname, reapplied);
    SendDAPOutputEvent(msg, "console");
  }
}

int
DapBridge::ReapplyCachedBreakpoints(ClientConnection *client, Debugger *debugger)
{
  BreakpointManager &bp = debugger->breakpoints();
  bp.ClearAllBreakpoints();

  int count = 0;
  for (const auto &entry : client->breakpoint_cache) {
    const std::string &file = entry.first;
    for (const CachedBreakpoint &cb : entry.second) {
      // Mirror HandleSetBreakpoints: client lines are 1-based, debug info 0-based.
      Breakpoint *new_bp = bp.AddBreakpoint(file, cb.line - 1, false);
      if (!new_bp)
        continue;
      if (!cb.condition.empty())
        new_bp->SetCondition(cb.condition);
      if (!cb.logMessage.empty())
        new_bp->SetLogMessage(cb.logMessage);
      if (!cb.hitCondition.empty()) {
        bool numeric = true;
        for (char c : cb.hitCondition)
          if (!isdigit(static_cast<unsigned char>(c))) { numeric = false; break; }
        if (numeric)
          new_bp->SetHitCondition(static_cast<uint32_t>(strtoul(cb.hitCondition.c_str(), nullptr, 10)));
      }
      count++;
    }
  }
  return count;
}

const char*
DapBridge::PluginNameForContext(IPluginContext* ctx)
{
  if (!ctx)
    return "<unknown>";
  auto it = plugin_name_cache_.find(ctx);
  if (it != plugin_name_cache_.end())
    return it->second.c_str();

  const char* name = "<unknown>";
  // SM 1.13 (ext API 9) changed FindPluginByContext to take IPluginContext*;
  // 1.12 and older (API <= 8) take the raw sp_context_t. Guard on the ext API
  // version so the same source builds against both SourceMod lines.
#if SMINTERFACE_EXTENSIONAPI_VERSION >= 9
  IPlugin* pl = plsys->FindPluginByContext(ctx);
#else
  IPlugin* pl = plsys->FindPluginByContext(ctx->GetContext());
#endif
  if (pl && pl->GetFilename())
    name = pl->GetFilename();
  auto res = plugin_name_cache_.emplace(ctx, name);
  return res.first->second.c_str();
}

void
DapBridge::BeginSampling(IPluginContext* targetCtx)
{
  if (traced_profiler_)
    traced_profiler_->Reset();
  // Bump the epoch so the VM-thread hook resets its own tracer state (prev path,
  // last frame, name cache) on the next break. Publish the target ctx + active
  // last (release); the hook acquire-loads them.
  profiling_epoch_.fetch_add(1, std::memory_order_acq_rel);
  profiling_target_ctx_.store(targetCtx, std::memory_order_release);
  profiling_active_.store(true, std::memory_order_release);
}

void
DapBridge::EndSampling()
{
  profiling_active_.store(false, std::memory_order_release);
  profiling_target_ctx_.store(nullptr, std::memory_order_release);
  // Finalize any scopes still open so their inclusive time lands in the tree.
  // As at an Invoke boundary, close at the last observed break rather than now:
  // the capture usually stops long after the plugin last ran.
  if (traced_profiler_) {
    if (have_last_break_)
      traced_profiler_->FlushOpenScopesAt(last_break_time_);
    else
      traced_profiler_->FlushOpenScopes();
  }
}

void
DapBridge::MarkProfilingWindowStart()
{
  profiling_window_start_ = std::chrono::steady_clock::now();
}

double
DapBridge::ProfilingWindowMs() const
{
  auto elapsed = std::chrono::steady_clock::now() - profiling_window_start_;
  return std::chrono::duration_cast<std::chrono::duration<double, std::milli>>(
             elapsed)
      .count();
}

// Gaps between consecutive debug breaks longer than this are treated as the VM
// being OUTSIDE the plugin (idle between server frames, or a separate Invoke),
// not continuous execution -- so the tracer DROPS them instead of crediting the
// last function. 5 ms cleanly separates intra-frame line execution (microseconds)
// from inter-frame idle (>= 10 ms at <= 100 tick), while still attributing native
// calls up to a few ms to their caller. Heuristic; tune if a server runs >100 tick.
static constexpr uint64_t kMaxContinuousGapNs = 5'000'000;  // 5 ms

void
DapBridge::MaybeRecordProfileSample(IPluginContext* ctx, sp_debug_break_info_t& dbginfo)
{
  // Hot path: every break of every plugin lands here. One atomic load gates it.
  if (!profiling_active_.load(std::memory_order_acquire) || !traced_profiler_)
    return;

  // The "this plugin" tree is scoped to the debugged plugin only. Breaks fire
  // for ALL plugins, so ignore breaks from any other context -- otherwise every
  // plugin would leak into this tree (that was the bug).
  IPluginContext* target = profiling_target_ctx_.load(std::memory_order_acquire);
  if (target == nullptr || ctx != target)
    return;

  // A new capture (epoch bumped on the TCP thread) -> reset our VM-thread state.
  uint32_t epoch = profiling_epoch_.load(std::memory_order_acquire);
  if (epoch != traced_epoch_) {
    traced_epoch_ = epoch;
    prev_profile_path_.clear();
    last_profile_ctx_ = nullptr;
    last_profile_frm_ = 0;
    have_last_break_ = false;
    last_invoke_seq_ = 0;
    last_profile_line_ = 0;
    plugin_name_cache_.clear();
  }

  // Time accounting (kSelfGap): credit the real gap since the previous break to
  // whichever function is currently on top -- the continuous execution of the
  // line(s) that just ran. But ONLY if the VM stayed inside this same call: if
  // it left and re-entered (another Invoke -- the next OnPlayerRunCmd for the
  // next player, the next frame, a nested forward), the gap is outside-plugin
  // time and would massively inflate the last forward, so we DROP it and reset
  // the tracer so the next break re-enters fresh (per-call counts stay sane).
  //
  // Boundary signal: exact when the VM profiler feeds Invoke()s (compare its
  // InvokeSeq); otherwise the kMaxContinuousGapNs time cap as a fallback. Runs
  // before the fast path so straight-line (same-frame) execution is captured.
  uint64_t invoke_seq =
      vm_invoke_tracking_ && vm_profiler_ ? vm_profiler_->InvokeSeq() : 0;
  auto now = std::chrono::steady_clock::now();
  if (have_last_break_) {
    bool boundary;
    if (vm_invoke_tracking_) {
      boundary = (invoke_seq != last_invoke_seq_);
    } else {
      uint64_t gap = std::chrono::duration_cast<std::chrono::nanoseconds>(
                         now - last_break_time_).count();
      boundary = (gap > kMaxContinuousGapNs);
    }
    if (!boundary) {
      uint64_t gap = std::chrono::duration_cast<std::chrono::nanoseconds>(
                         now - last_break_time_).count();
      // Credit the gap to the line that was executing during it -- the line
      // reported at the PREVIOUS break, not this one. This is what makes the
      // per-line breakdown (and therefore the visible cost of a native call,
      // which the VM never reports as its own scope) line up with the source.
      traced_profiler_->CreditSelfToTop(gap, last_profile_line_);
    } else {
      // VM was outside this call: close everything and restart clean so no stale
      // top carries the gap and per-call counts stay sane. Stamp the close at
      // the previous break -- the last moment the plugin was demonstrably
      // running -- so the exported span covers the call, not the idle after it.
      traced_profiler_->FlushOpenScopesAt(last_break_time_);
      prev_profile_path_.clear();
      last_profile_ctx_ = nullptr;
      last_profile_frm_ = 0;
    }
  }
  last_break_time_ = now;
  last_invoke_seq_ = invoke_seq;
  have_last_break_ = true;

  // Remember the line executing from here on, for the next gap's attribution.
  last_profile_line_ = 0;
  if (IPluginDebugInfo* dbg = ctx->GetRuntime()->GetDebugInfo()) {
    uint32_t line = 0;
    if (dbg->LookupLine(dbginfo.cip, &line) == SP_ERROR_NONE)
      last_profile_line_ = line;
  }

  // Fast path: consecutive lines in the same function share a frame pointer, so
  // no call/return happened -- nothing to reconcile.
  if (ctx == last_profile_ctx_ && dbginfo.frm == last_profile_frm_)
    return;
  last_profile_ctx_ = ctx;
  last_profile_frm_ = dbginfo.frm;

  // Build the current scripted call path, outermost->innermost, keeping ONLY the
  // target plugin's frames (cross-plugin callers/callees run in other contexts
  // and belong to the "all plugins" tree, not here). Node name uses the VM's
  // "<plugin>.smx::<fn>" convention so the renderer treats both trees the same.
  std::vector<std::pair<std::string, std::string>> cur;
  SourcePawn::IFrameIterator* frames = ctx->CreateFrameIterator();
  for (; frames && !frames->Done(); frames->Next()) {
    if (frames->IsInternalFrame() || !frames->IsScriptedFrame())
      continue;
    if (frames->Context() != target)
      continue;
    const char* fn = frames->FunctionName();
    std::string pn = PluginNameForContext(frames->Context());
    cur.emplace_back(pn, pn + "::" + (fn ? fn : "<unknown>"));
  }
  if (frames)
    ctx->DestroyFrameIterator(frames);
  std::reverse(cur.begin(), cur.end());

  // Reconcile prev_profile_path_ -> cur by closing scopes that returned and
  // opening scopes that were entered. Drives the Profiler's exact call/time
  // accounting (EnterScope start + LeaveScope elapsed/calls).
  size_t common = 0;
  while (common < prev_profile_path_.size() && common < cur.size() &&
         prev_profile_path_[common] == cur[common])
    common++;
  for (size_t i = prev_profile_path_.size(); i > common; --i)
    traced_profiler_->LeaveScope();
  for (size_t i = common; i < cur.size(); ++i)
    traced_profiler_->EnterScope(cur[i].first.c_str(), cur[i].second.c_str());
  prev_profile_path_.swap(cur);
}

void
DapBridge::SendDAPOutputEvent(const char *message, const char *category)
{
  if (!tcp_server_ || !tcp_server_->IsRunning() || !message) {
    return;
  }

  // The Debug Console concatenates output events verbatim, so a message without
  // a trailing newline runs into whichever line comes next ("Pause request
  // received from clientPausing - will stop..."). Terminate here, once, instead
  // of relying on every call site to remember.
  std::string text(message);
  if (text.empty() || text.back() != '\n')
    text.push_back('\n');

  // JSON-escape via the shared, UTF-8-validating escaper. logpoint output and
  // snapshot ({@all}) lines can contain arbitrary bytes from char[] buffers
  // (CS color control codes, invalid UTF-8); the local escaper used to pass
  // bytes >= 0x80 through raw, which produced invalid JSON and desynced the
  // stream -- exactly the failure we hit stepping into CPrintToChat.
  std::ostringstream json;
  json << "{\"type\":\"event\",\"event\":\"output\",\"body\":{"
       << "\"category\":\"" << JsonParser::EscapeString(category ? category : "console") << "\","
       << "\"output\":\"" << JsonParser::EscapeString(text) << "\"}}";

  // Bare JSON -- TcpServer::SendData adds the Content-Length header.
  tcp_server_->BroadcastMessage(json.str());
}

void
DapBridge::SendDAPStoppedEvent(Debugger *debugger, const char *reason, bool preserveFocusHint)
{
  if (!tcp_server_ || !tcp_server_->IsRunning()) {
    return;
  }

  // Build DAP stopped event
  std::string event = BuildStoppedEventJSON(debugger, reason, preserveFocusHint);

  // Broadcast to all connected clients
  tcp_server_->BroadcastMessage(event);
}

std::string
DapBridge::BuildStoppedEventJSON(Debugger *debugger, const char *reason, bool preserveFocusHint)
{
  // Build stopped event in DAP format
  std::ostringstream json;
  json << "{"
       << "\"type\":\"event\","
       << "\"event\":\"stopped\","
       << "\"body\":{"
       << "\"reason\":\"" << reason << "\","
       << "\"threadId\":1,";

  // For an exception stop, carry the VM error message so VS Code shows it in
  // the stop banner / exception widget (and "description" in the callstack).
  if (debugger && debugger->has_exception()) {
    const std::string &msg = debugger->exception_text();
    json << "\"description\":\"" << JsonParser::EscapeString(
                debugger->exception_fatal() ? "Fatal exception" : "Exception")
         << "\","
         << "\"text\":\"" << JsonParser::EscapeString(msg) << "\",";
  }

  json << "\"preserveFocusHint\":" << (preserveFocusHint ? "true" : "false") << ","
       << "\"allThreadsStopped\":true"
       << "}"
       << "}";

  // Return the bare JSON. The TCP send path (TcpServer::SendData) is the single
  // place that frames messages with the Content-Length header -- adding it here
  // too would double-frame the event and break the client's parser.
  return json.str();
}

void
DapBridge::SendDAPContinuedEvent(int threadId, bool allThreadsContinued)
{
  if (!tcp_server_ || !tcp_server_->IsRunning()) {
    return;
  }

  // Build DAP continued event
  std::string event = BuildContinuedEventJSON(threadId, allThreadsContinued);

  // Broadcast to all connected clients
  tcp_server_->BroadcastMessage(event);
}

std::string
DapBridge::BuildContinuedEventJSON(int threadId, bool allThreadsContinued)
{
  // Build continued event in DAP format
  std::ostringstream json;
  json << "{"
       << "\"type\":\"event\","
       << "\"event\":\"continued\","
       << "\"body\":{"
       << "\"threadId\":" << threadId << ","
       << "\"allThreadsContinued\":" << (allThreadsContinued ? "true" : "false")
       << "}"
       << "}";

  // Bare JSON only -- TcpServer::SendData adds the Content-Length header.
  return json.str();
}

void
DapBridge::HandleDAPMessage(ClientConnection* client, const std::string& message)
{
  if (session_manager_) {
    session_manager_->HandleDAPMessage(client, message);
  }
}

bool
DapBridge::HasTCPClients() const
{
  if (!tcp_server_ || !tcp_server_->IsRunning()) {
    return false;
  }
  return tcp_server_->GetClientCount() > 0;
}

void
DapBridge::OnLastClientDisconnect()
{
  if (g_DebugLogging)
    std::cout << "[Debugger] Last TCP client disconnected - ending debug sessions" << std::endl;

  // When the DAP client goes away we must fully END the debug session, not just
  // resume it. Otherwise the breakpoints set by the client stay installed and
  // the next time the plugin runs it hits them with no client attached and
  // drops into the interactive *console* debugger ("BREAK at line ..." waiting
  // on stdin), which freezes a headless game server. Deactivate() clears all
  // breakpoints/watches and resumes execution.
  int ended_count = 0;
  for (DebuggerMap::iterator it = GetDebuggerMap().iter(); !it.empty(); it.next()) {
    Debugger* debugger = it->value;
    if (!debugger || !debugger->active()) {
      continue;
    }

    if (g_DebugLogging)
      std::cout << "[Debugger] Ending debug session for plugin context "
                << std::hex << it->key << std::dec << std::endl;

    // Wake any thread blocked waiting for a DAP command, then tear down.
    debugger->SetManualPause(false);
    debugger->SetRunmode(RUNNING);
    debugger->Deactivate();
    ended_count++;
  }

  if (g_DebugLogging)
    std::cout << "[Debugger] Ended " << ended_count << " debug session(s)" << std::endl;
}

// ---------------------------------------------------------------------------
// The seam: free functions declared in dap-seam.h, dispatching to the single
// process-wide DapBridge instance owned here.
// ---------------------------------------------------------------------------

static std::unique_ptr<DapBridge> g_bridge;

// Break-loop synchronisation. The VM is single-threaded, so at most one Debugger
// is ever paused in OnBreak at a time -- a single process-wide condition var is
// behaviourally identical to the old per-Debugger one. The TCP thread sets
// should_continue + notifies (NotifyResume, from Debugger::SetRunmode); the VM
// thread blocks in OnBreak until then (or the client disconnects).
namespace {
struct BreakSync {
  std::mutex m;
  std::condition_variable cv;
  std::atomic<bool> should_continue{false};
};
BreakSync g_break_sync;

// Poll interval so the wait can notice a client disconnect promptly. There is no
// finite timeout: an interactive debugger stays paused until the user continues
// or the client goes away (matching the old kDefaultDAPTimeoutMs == 0).
constexpr int kPollIntervalMs = 100;

enum class WaitResult { kContinue, kDisconnected };

WaitResult WaitForResume()
{
  std::unique_lock<std::mutex> lock(g_break_sync.m);
  g_break_sync.should_continue = false;

  while (!g_break_sync.should_continue.load()) {
    auto poll_until = std::chrono::steady_clock::now() +
                      std::chrono::milliseconds(kPollIntervalMs);
    g_break_sync.cv.wait_until(lock, poll_until);

    if (g_break_sync.should_continue.load())
      return WaitResult::kContinue;

    if (!dap::HasClients()) {
      if (g_DebugLogging) printf("[DAP] Client disconnected while waiting for command\n");
      return WaitResult::kDisconnected;
    }
  }
  return WaitResult::kContinue;
}
} // namespace

namespace dap {

void Init(ConsoleDebugger* ext, SourcePawn::ISourcePawnEngine2* engine2)
{
  // Materialise the default config before Start() reads the port, so first-ever
  // boot picks up the freshly-written file instead of logging "not found".
  EnsureDefaultConfig();
  g_bridge = std::make_unique<DapBridge>(ext, engine2);
  g_bridge->Start();
}

void Shutdown()
{
  if (g_bridge) {
    g_bridge->Shutdown();
    g_bridge.reset();
  }
}

void OnPluginLoaded(IPlugin* plugin)
{
  if (g_bridge)
    g_bridge->RebindClientsToReloadedPlugin(plugin);
}

void OnPluginUnloaded(IPlugin* plugin)
{
  if (g_bridge)
    g_bridge->DetachClientsFromPlugin(plugin);
}

void OnDebugBreakSample(IPluginContext* ctx, sp_debug_break_info_t& dbginfo)
{
  if (g_bridge)
    g_bridge->MaybeRecordProfileSample(ctx, dbginfo);
}

void SendOutput(const char* message, const char* category)
{
  if (g_bridge)
    g_bridge->SendDAPOutputEvent(message, category);
}

void SendStopped(Debugger* debugger, const char* reason, bool preserveFocusHint)
{
  if (g_bridge)
    g_bridge->SendDAPStoppedEvent(debugger, reason, preserveFocusHint);
}

void SendContinued(int threadId, bool allThreadsContinued)
{
  if (g_bridge)
    g_bridge->SendDAPContinuedEvent(threadId, allThreadsContinued);
}

bool HasClients()
{
  return g_bridge && g_bridge->HasTCPClients();
}

void OnBreak(Debugger* debugger, const char* reason)
{
  if (!g_bridge)
    return;

  // Tell the client we've stopped, then block the VM thread until it resumes us.
  g_bridge->SendDAPStoppedEvent(debugger, reason, false);

  WaitResult result = WaitForResume();

  if (result == WaitResult::kDisconnected) {
    // Client went away while paused: resume execution silently.
    if (g_DebugLogging) printf("[DAP] Client disconnected - auto-resuming execution\n");
    debugger->SetRunmode(RUNNING);
    return;
  }

  // kContinue: the runmode was already set by the DAP command (continue/step)
  // that woke us; nothing else to do.
}

void NotifyResume()
{
  {
    std::lock_guard<std::mutex> lock(g_break_sync.m);
    g_break_sync.should_continue = true;
  }
  g_break_sync.cv.notify_one();
}

} // namespace dap
