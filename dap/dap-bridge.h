/**
 * dap-bridge.h -- the DAP/TCP/profiler "crate" hub.
 *
 * DapBridge owns everything that turns the upstream sp-console-debugger into a
 * VS Code debug adapter: the TCP/DAP server, the DAP session manager and the two
 * function-timing profilers. It used to live inline on ConsoleDebugger; pulling
 * it out keeps the vendored upstream copy close to peace-maker/sp-console-debugger.
 *
 * The DAP request handlers, the TCP server and the session manager all talk to
 * DapBridge (they keep a DapBridge* named debugger_ext_). DapBridge reaches back
 * into the extension only for the handful of upstream accessors below
 * (GetPluginDebugger / StartPluginDebugging / FindPluginByConsoleArg /
 * GetDebuggerMap), via its ConsoleDebugger* back-pointer.
 */

#ifndef _INCLUDE_DAP_BRIDGE_H
#define _INCLUDE_DAP_BRIDGE_H

#include <memory>
#include <string>
#include <vector>
#include <utility>
#include <unordered_map>
#include <atomic>
#include <chrono>

#include "extension.h"   // ConsoleDebugger, DebuggerMap, SDK globals, SPDBG_LOG
#include "dap-seam.h"

class Debugger;
struct ClientConnection;
class TcpServer;
class SessionManager;
class Profiler;

class DapBridge
{
public:
  DapBridge(ConsoleDebugger* ext, SourcePawn::ISourcePawnEngine2* engine2);
  ~DapBridge();

  // Start the TCP/DAP server + profilers (the DAP part of SDK_OnLoad). Stop and
  // tear everything down (the DAP part of SDK_OnUnload).
  void Start();
  void Shutdown();

  // Plugin reload handling.
  void RebindClientsToReloadedPlugin(IPlugin *plugin);   // OnPluginLoaded
  void DetachClientsFromPlugin(IPlugin *plugin);         // OnPluginUnloaded
  int ReapplyCachedBreakpoints(struct ClientConnection *client, Debugger *debugger);

  // DAP event emission.
  void SendDAPOutputEvent(const char *message, const char *category);
  void SendDAPStoppedEvent(Debugger *debugger, const char *reason, bool preserveFocusHint);
  void SendDAPContinuedEvent(int threadId, bool allThreadsContinued = true);
  std::string BuildStoppedEventJSON(Debugger *debugger, const char *reason, bool preserveFocusHint);
  std::string BuildContinuedEventJSON(int threadId, bool allThreadsContinued);
  void HandleDAPMessage(ClientConnection* client, const std::string& message);
  bool HasTCPClients() const;
  TcpServer* GetTCPServer() { return tcp_server_.get(); }

  // Shared secret from configs/console-debugger.cfg ("token"), consulted by the
  // request handlers before serving anything. Empty means authentication is off,
  // which Start() only permits while the listener stays on loopback.
  const std::string& auth_token() const { return auth_token_; }
  void OnLastClientDisconnect();

  // Profiler accessors (see the long note that used to be in extension.h).
  Profiler* GetVMProfiler() { return vm_profiler_.get(); }
  Profiler* GetTracedProfiler() { return traced_profiler_.get(); }
  SourcePawn::ISourcePawnEngine2* GetEngine2() { return spengine2_; }

  // Debug-break tracer driving traced_profiler_.
  void BeginSampling(SourcePawn::IPluginContext* targetCtx);
  void EndSampling();
  void MaybeRecordProfileSample(SourcePawn::IPluginContext* ctx,
                                sp_debug_break_info_t& dbginfo);

  // Wall-clock duration of a profiling capture window.
  void MarkProfilingWindowStart();
  double ProfilingWindowMs() const;

  void SetVmInvokeTracking(bool on) { vm_invoke_tracking_ = on; }

  // Upstream accessors the DAP handlers need, forwarded to the extension.
  Debugger* GetPluginDebugger(IPluginContext* ctx);
  IPlugin* FindPluginByConsoleArg(const char* arg);
  bool StartPluginDebugging(IPluginContext* ctx);
  DebuggerMap& GetDebuggerMap();

private:
  // Map a frame's plugin context to its ".smx" filename, cached (VM thread only).
  const char* PluginNameForContext(SourcePawn::IPluginContext* ctx);

  ConsoleDebugger* ext_ = nullptr;

  // Read once in Start(); const for the lifetime of the listener, so the client
  // threads can compare against it without synchronisation.
  std::string auth_token_;

  std::unique_ptr<TcpServer> tcp_server_;
  std::unique_ptr<SessionManager> session_manager_;
  std::unique_ptr<Profiler> vm_profiler_;      // all plugins (VM IProfilingTool)
  std::unique_ptr<Profiler> traced_profiler_;  // debugged plugin (debug-break tracer)
  SourcePawn::ISourcePawnEngine2* spengine2_ = nullptr;

  // Tracing-profiler state. profiling_active_ + profiling_epoch_ are the only
  // cross-thread bits (TCP writes in Begin/EndSampling, VM reads in the break
  // hook) and are atomic. Everything below is touched ONLY on the VM thread.
  std::atomic<bool> profiling_active_{false};
  std::atomic<uint32_t> profiling_epoch_{0};
  std::atomic<SourcePawn::IPluginContext*> profiling_target_ctx_{nullptr};
  std::chrono::steady_clock::time_point profiling_window_start_{};
  uint32_t traced_epoch_ = 0;
  std::chrono::steady_clock::time_point last_break_time_{};
  bool have_last_break_ = false;
  bool vm_invoke_tracking_ = false;
  uint64_t last_invoke_seq_ = 0;
  SourcePawn::IPluginContext* last_profile_ctx_ = nullptr;
  cell_t last_profile_frm_ = 0;
  // Source line reported at the previous break: the gap that follows is time
  // spent executing THAT line, so that is where it gets credited.
  uint32_t last_profile_line_ = 0;
  std::vector<std::pair<std::string, std::string>> prev_profile_path_;
  std::unordered_map<SourcePawn::IPluginContext*, std::string> plugin_name_cache_;
};

#endif // _INCLUDE_DAP_BRIDGE_H
