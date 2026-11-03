/**
 * vim: set ts=4 :
 * =============================================================================
 * SourceMod Console Debugger Extension
 * Copyright (C) 2018-2021 Peace-Maker  All rights reserved.
 * =============================================================================
 */

#include "dap-handlers.h"
#include "vm-hooks.h"
#include "json-utils.h"
#include "dap-bridge.h"
#include "debugger.h"
#include "breakpoints.h"
#include "symbols.h"
#include "symbol-render.h"
#include "profiler.h"
#include "perf-stats.h"
#include "smsdk_ext.h"
#include "config.h"
#include <algorithm>
#include <iostream>
#include <cstring>
#include <cstdlib>
#include <chrono>
#include <vector>
#include <cstdint>
#include <atomic>

// Global response sequence counter for DAP responses. Atomic because every
// connected client is served on its own thread and they all stamp responses
// from here.
static std::atomic<int> g_response_seq_counter{1000};

// Ceiling for a single readMemory request. The client picks `count`, and the
// handler reserves that much, so it needs a bound that no legitimate memory
// view exceeds.
static constexpr int kMaxReadMemoryBytes = 64 * 1024;

// Requests answered before a client has authenticated. "initialize" has to be
// first (it carries the token and reveals nothing but our capabilities), and
// "disconnect" must always work so a rejected client can hang up cleanly.
static bool IsPreAuthCommand(const std::string& command)
{
    return command == "initialize" || command == "disconnect";
}

// Pull the shared secret out of a request's arguments. Accepted on initialize,
// launch and attach so a client can present it at whichever point its DAP
// implementation makes custom fields available.
static std::string ExtractToken(DAPRequest* request)
{
    auto args = request->GetArguments();
    if (!args)
        return "";
    for (const char* key : {"token", "authToken", "__authToken"}) {
        if (args->HasMember(key))
            return (*args)[key]->AsString();
    }
    return "";
}

DAPHandlers::DAPHandlers(DapBridge* debugger_ext)
    : debugger_ext_(debugger_ext)
{
}

Debugger* DAPHandlers::BoundDebugger(ClientConnection* client)
{
    if (!client || !client->active_plugin)
        return nullptr;
    Debugger* debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
    return (debugger && debugger->active()) ? debugger : nullptr;
}

Debugger* DAPHandlers::AnyActiveDebugger()
{
    for (DebuggerMap::iterator it = debugger_ext_->GetDebuggerMap().iter(); !it.empty(); it.next()) {
        if (it->value->active())
            return it->value;
    }
    return nullptr;
}

Debugger* DAPHandlers::ActiveDebuggerFor(ClientConnection* client)
{
    if (Debugger* bound = BoundDebugger(client))
        return bound;
    return AnyActiveDebugger();
}

DAPHandlers::~DAPHandlers()
{
}

std::string DAPHandlers::ExtractPluginName(const std::string& program_path)
{
    // Extract just the filename from the full path
    size_t last_slash = program_path.find_last_of("/\\");
    std::string filename = (last_slash != std::string::npos) ? 
                          program_path.substr(last_slash + 1) : 
                          program_path;
    
    // Remove .sp extension if present
    size_t dot_pos = filename.find_last_of('.');
    if (dot_pos != std::string::npos) {
        std::string extension = filename.substr(dot_pos);
        std::transform(extension.begin(), extension.end(), extension.begin(), ::tolower);
        if (extension == ".sp" || extension == ".inc") {
            filename = filename.substr(0, dot_pos);
        }
    }
    
    // SourceMod expects .smx extension for compiled plugins
    return filename;
}

const char* DAPHandlers::path_basename(const char* path)
{
    if (!path) return "unknown";
    
    const char* last_slash = strrchr(path, '/');
    if (!last_slash) {
        last_slash = strrchr(path, '\\');
    }
    
    return last_slash ? (last_slash + 1) : path;
}

std::string DAPHandlers::GetVariableValue(const SourcePawn::IDebugSymbol* symbol, SpPluginDebugInfo* debuginfo, Debugger* debugger)
{
    if (!debugger || !symbol) return "undefined";

    // Render the value using the real debug type information. The caller is
    // expected to have selected the relevant frame first, so SymbolWrapper
    // resolves addresses against debugger->frm()/cip() correctly.
    SymbolWrapper wrapper(debugger, symbol);
    return dap::GetSummaryValue(wrapper);
}

std::string DAPHandlers::GetVariableTypeName(const SourcePawn::IDebugSymbol* symbol, SpPluginDebugInfo* debuginfo, Debugger* debugger)
{
    if (!symbol) return "unknown";
    if (!debugger) return "unknown";

    // Use the actual ISymbolType information instead of guessing from the name.
    SymbolWrapper wrapper(debugger, symbol);
    return dap::GetTypeName(wrapper);
}

void DAPHandlers::HandleRequest(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    if (!client) {
        SPDBG_LOG("[SM] DAP HandleRequest - Invalid client connection");
        return;
    }

    if (!request) {
        SPDBG_LOG("[SM] DAP HandleRequest - Invalid request");
        return;
    }

    const std::string& command = request->GetCommand();
    SPDBG_LOG("[SM] DAP HandleRequest - Command: %s (seq: %u)", command.c_str(), request->GetSeq());

    // Authentication gate. When a token is configured (mandatory whenever the
    // listener is not on loopback -- see DapBridge::Start), nothing that reads
    // or writes the debuggee is served until the client proves it knows the
    // secret. The token may ride on initialize, launch or attach.
    const std::string& expected_token = debugger_ext_->auth_token();
    if (!expected_token.empty() && !client->authenticated) {
        if (command == "initialize" || command == "launch" || command == "attach") {
            const std::string presented = ExtractToken(request.get());
            if (dap::SecretEquals(presented, expected_token)) {
                client->authenticated = true;
                SPDBG_LOG("[SM] DAP client %s:%d authenticated",
                          client->remote_addr.c_str(), client->remote_port);
            }
        }

        if (!client->authenticated && !IsPreAuthCommand(command)) {
            // Deliberately terse and identical for "wrong token" and "no token":
            // a client that cannot authenticate learns nothing about the server.
            std::cerr << "[TCP] Rejected " << command << " from unauthenticated client "
                      << client->remote_addr << ":" << client->remote_port << std::endl;
            SendErrorResponse(client, request->GetSeq(), command,
                              "Authentication required: set \"token\" in the launch configuration "
                              "to the value from configs/console-debugger.cfg");
            return;
        }
    }

    if (command == "initialize") {
        HandleInitialize(client, std::move(request));
    }
    else if (command == "launch") {
        HandleLaunch(client, std::move(request));
    }
    else if (command == "attach") {
        HandleAttach(client, std::move(request));
    }
    else if (command == "setBreakpoints") {
        HandleSetBreakpoints(client, std::move(request));
    }
    else if (command == "setExceptionBreakpoints") {
        HandleSetExceptionBreakpoints(client, std::move(request));
    }
    else if (command == "threads") {
        HandleThreads(client, std::move(request));
    }
    else if (command == "terminate") {
        HandleTerminate(client, std::move(request));
    }
    else if (command == "continue") {
        HandleContinue(client, std::move(request));
    }
    else if (command == "next") {
        HandleNext(client, std::move(request));
    }
    else if (command == "stepIn") {
        HandleStepIn(client, std::move(request));
    }
    else if (command == "stepOut") {
        HandleStepOut(client, std::move(request));
    }
    else if (command == "stackTrace") {
        HandleStackTrace(client, std::move(request));
    }
    else if (command == "scopes") {
        HandleScopes(client, std::move(request));
    }
    else if (command == "variables") {
        HandleVariables(client, std::move(request));
    }
    else if (command == "evaluate") {
        HandleEvaluate(client, std::move(request));
    }
    else if (command == "setVariable") {
        HandleSetVariable(client, std::move(request));
    }
    else if (command == "pause") {
        HandlePause(client, std::move(request));
    }
    else if (command == "configurationDone") {
        HandleConfigurationDone(client, std::move(request));
    }
    else if (command == "disconnect") {
        HandleDisconnect(client, std::move(request));
    }
    else if (command == "setDataBreakpoints") {
        HandleSetDataBreakpoints(client, std::move(request));
    }
    else if (command == "readMemory") {
        HandleReadMemory(client, std::move(request));
    }
    else if (command == "dataBreakpointInfo") {
        HandleDataBreakpointInfo(client, std::move(request));
    }
    else if (command == "exceptionInfo") {
        HandleExceptionInfo(client, std::move(request));
    }
    else if (command == "sp_profileStart") {
        HandleProfileStart(client, std::move(request));
    }
    else if (command == "sp_profileStop") {
        HandleProfileStop(client, std::move(request));
    }
    else if (command == "sp_performance") {
        HandlePerformance(client, std::move(request));
    }
    else {
        SPDBG_LOG("[SM] DAP HandleRequest - Unknown command: %s", command.c_str());
        SendErrorResponse(client, request->GetSeq(), command, "Command not implemented: " + command);
    }
}

void DAPHandlers::HandleInitialize(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP Initialize - Client initializing debug session");

    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "initialize",
        true
    );

    auto body = JsonParser::CreateObject();
    // Core DAP capabilities
    JsonParser::AddToObject(*body, "supportsConfigurationDoneRequest", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsBreakpointLocationsRequest", std::make_shared<JsonValue>(false));
    JsonParser::AddToObject(*body, "supportsStepBack", std::make_shared<JsonValue>(false));
    JsonParser::AddToObject(*body, "supportsRestartRequest", std::make_shared<JsonValue>(false));

    // Breakpoint capabilities
    JsonParser::AddToObject(*body, "supportsConditionalBreakpoints", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsHitConditionalBreakpoints", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsFunctionBreakpoints", std::make_shared<JsonValue>(false));
    JsonParser::AddToObject(*body, "supportsLogPointsRequest", std::make_shared<JsonValue>(false));

    // Variable capabilities
    JsonParser::AddToObject(*body, "supportsSetVariable", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsEvaluateForHovers", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsValueFormattingOptions", std::make_shared<JsonValue>(false));
    JsonParser::AddToObject(*body, "supportsExceptionOptions", std::make_shared<JsonValue>(false));

    // Memory and data breakpoint capabilities
    JsonParser::AddToObject(*body, "supportsDataBreakpoints", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsReadMemoryRequest", std::make_shared<JsonValue>(true));

    // Execution capabilities
    JsonParser::AddToObject(*body, "supportTerminateDebuggee", std::make_shared<JsonValue>(true));
    JsonParser::AddToObject(*body, "supportsDelayedStackTraceLoading", std::make_shared<JsonValue>(false));

    // Exception handling
    auto exception_breakpoint_filters = JsonParser::CreateArray();
    JsonParser::AddToObject(*body, "exceptionBreakpointFilters", exception_breakpoint_filters);
    // Lets VS Code request the exception details (message) when stopped on an
    // exception, showing the rich exception widget like the C++ debugger.
    JsonParser::AddToObject(*body, "supportsExceptionInfoRequest", std::make_shared<JsonValue>(true));

    // Add completion trigger characters for completions
    auto completion_trigger_characters = JsonParser::CreateArray();
    JsonParser::AddToObject(*body, "completionTriggerCharacters", completion_trigger_characters);

    response->SetBody(body);

    SPDBG_LOG("[SM] DAP Initialize - Capabilities sent to client");
    SendResponse(client, std::move(response));

    // Send initialized event after response
    auto initialized_event = std::make_unique<DAPEvent>(
        ++g_response_seq_counter,
        "initialized"
    );

    // Convert event to JSON and send
    std::string event_json = initialized_event->ToJson();
    SPDBG_LOG("[SM] DAP Initialize - Sending initialized event");
    if (client->session) {
        client->session->SendEvent(event_json);
    }
}

void DAPHandlers::HandleLaunch(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto args = request->GetArguments();
    if (args && args->HasMember("program")) {
        std::string program_path = (*args)["program"]->AsString();
        SPDBG_LOG("[SM] DAP Launch - Program: %s", program_path.c_str());
        
        // Extract plugin name from full path (get filename without extension)
        std::string plugin_name = ExtractPluginName(program_path);
        SPDBG_LOG("[SM] DAP Launch - Looking for plugin: %s", plugin_name.c_str());
        
        // Find the plugin by name
        IPlugin* plugin = debugger_ext_->FindPluginByConsoleArg(plugin_name.c_str());
        if (plugin) {
            SPDBG_LOG("[SM] DAP Launch - Found plugin: %s", plugin->GetFilename());
            
            // Start debugging the plugin automatically
            if (debugger_ext_->StartPluginDebugging(plugin->GetBaseContext())) {
                SPDBG_LOG("[SM] DAP Launch - Successfully started debugging plugin: %s", plugin_name.c_str());
                debugger_ext_->SendDAPOutputEvent(("Successfully started debugging plugin: " + plugin_name).c_str(), "console");
                
                // Set the client's active plugin for this session. Remember the
                // filename too so we can rebind after a `sm plugins refresh`
                // (which frees this IPlugin and loads a new instance).
                client->active_plugin = plugin;
                client->active_plugin_name = plugin->GetFilename();

                // Set debugger to STEPPING mode (paused) for launch with stopOnEntry
                Debugger* debugger = debugger_ext_->GetPluginDebugger(plugin->GetBaseContext());
                if (debugger) {
                    // Claim ownership so only THIS client's disconnect can tear
                    // the session down -- a stale disconnect from a previous
                    // client must not deactivate the session we just started.
                    debugger->SetOwnerToken(client);
                    bool stopOnEntry = false;
                    if (args->HasMember("stopOnEntry")) {
                        stopOnEntry = (*args)["stopOnEntry"]->AsBool();
                    }

                    if (stopOnEntry) {
                        // Do NOT start stepping yet. If we paused now (before the
                        // client sends configurationDone) the resulting stopped
                        // event arrives mid-handshake and VS Code ignores it --
                        // that's the "first launch doesn't work, have to press
                        // pause" symptom. Arm it instead; configurationDone will
                        // switch to stepping so the pause happens after the client
                        // is fully configured.
                        debugger->SetRunmode(RUNNING);
                        SPDBG_LOG("[SM] DAP Launch - stopOnEntry armed; will pause after configurationDone");
                        client->pending_stopped_event = true;
                    } else {
                        debugger->SetRunmode(RUNNING);
                        SPDBG_LOG("[SM] DAP Launch - Debugger set to running mode");
                        client->pending_stopped_event = false;

                        // Send continued event to indicate execution started
                        auto continued_event = std::make_unique<DAPEvent>(
                            ++g_response_seq_counter,
                            "continued"
                        );
                        auto continued_body = JsonParser::CreateObject();
                        JsonParser::AddToObject(*continued_body, "threadId", std::make_shared<JsonValue>(1));
                        JsonParser::AddToObject(*continued_body, "allThreadsContinued", std::make_shared<JsonValue>(true));
                        continued_event->SetBody(continued_body);

                        std::string continued_json = continued_event->ToJson();
                        if (client->session) {
                            client->session->SendEvent(continued_json);
                        }
                    }
                }
                
                // Success response
                auto response = std::make_unique<DAPResponse>(
                    ++g_response_seq_counter,
                    request->GetSeq(),
                    "launch",
                    true
                );
                SendResponse(client, std::move(response));
            } else {
                SPDBG_LOG("[SM] DAP Launch - Failed to start debugging plugin: %s", plugin_name.c_str());
                SendErrorResponse(client, request->GetSeq(), "launch", "Failed to start debugging the specified plugin");
            }
        } else {
            SPDBG_LOG("[SM] DAP Launch - Plugin not found: %s", plugin_name.c_str());
            SendErrorResponse(client, request->GetSeq(), "launch", "Plugin not found or not loaded: " + plugin_name);
        }
    } else {
        SendErrorResponse(client, request->GetSeq(), "launch", "No program specified in launch arguments");
    }
}

void DAPHandlers::HandleAttach(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP Attach - Client attempting to attach to debugger");

    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "attach",
        true
    );

    // For attach mode, we need to find any currently debugging plugins
    // Note: This is simplified - ideally we'd match based on attach parameters.
    bool found_debugger = AnyActiveDebugger() != nullptr;
    if (found_debugger) {
        SPDBG_LOG("[SM] DAP Attach - Found active debugger, attaching");
        debugger_ext_->SendDAPOutputEvent("Attached to active debugging session", "console");
    }

    if (!found_debugger) {
        SPDBG_LOG("[SM] DAP Attach - No active debuggers found");
        debugger_ext_->SendDAPOutputEvent("No active debugging sessions found to attach to", "console");
    }

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleSetBreakpoints(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "setBreakpoints",
        true
    );

    auto breakpoints_array = JsonParser::CreateArray();

    auto args = request->GetArguments();
    if (args && args->HasMember("source") && args->HasMember("breakpoints")) {
        auto source = (*args)["source"];
        std::string file_path;

        if (source->HasMember("path")) {
            file_path = (*source)["path"]->AsString();
            SPDBG_LOG("[SM] DAP SetBreakpoints - File: %s", file_path.c_str());

            // Cache this file's breakpoints so they can be replayed after a
            // plugin reload (`sm plugins refresh`). Rebuilt from scratch on
            // every setBreakpoints for this file, mirroring the client.
            std::vector<CachedBreakpoint> cache_for_file;
            if (args->HasMember("breakpoints")) {
                for (const auto& bp : (*args)["breakpoints"]->AsArray()) {
                    if (!bp->HasMember("line")) continue;
                    CachedBreakpoint cb;
                    cb.line = (*bp)["line"]->AsInt();
                    if (bp->HasMember("condition")) cb.condition = (*bp)["condition"]->AsString();
                    if (bp->HasMember("logMessage")) cb.logMessage = (*bp)["logMessage"]->AsString();
                    if (bp->HasMember("hitCondition")) cb.hitCondition = (*bp)["hitCondition"]->AsString();
                    cache_for_file.push_back(std::move(cb));
                }
            }
            if (cache_for_file.empty())
                client->breakpoint_cache.erase(file_path);
            else
                client->breakpoint_cache[file_path] = std::move(cache_for_file);

            // Use the active plugin for this client connection
            auto plugin = client->active_plugin;
            if (plugin) {
                auto debugger = debugger_ext_->GetPluginDebugger(plugin->GetBaseContext());

                if (debugger) {
                    BreakpointManager& bp_manager = debugger->breakpoints();

                    // Clear all breakpoints (API doesn't support per-file clearing)
                    bp_manager.ClearAllBreakpoints();

                    auto bps = (*args)["breakpoints"];
                    const auto& bp_array = bps->AsArray();
                    int bp_id = 1;

                    for (const auto& bp : bp_array) {
                        if (bp->HasMember("line")) {
                            int line = (*bp)["line"]->AsInt();
                            SPDBG_LOG("[SM] DAP SetBreakpoints - Adding breakpoint at line %d in %s", line, file_path.c_str());

                            Breakpoint* new_bp = bp_manager.AddBreakpoint(file_path, line - 1, false);

                            auto bp_obj = JsonParser::CreateObject();
                            bool verified = (new_bp != nullptr);

                            if (new_bp) {
                                // Set condition if provided
                                if (bp->HasMember("condition") && !(*bp)["condition"]->AsString().empty()) {
                                    std::string condition = (*bp)["condition"]->AsString();
                                    new_bp->SetCondition(condition);
                                    SPDBG_LOG("[SM] DAP SetBreakpoints - Condition: %s", condition.c_str());
                                }

                                // Set logpoint message if provided. A logpoint
                                // logs the (interpolated) message and continues
                                // instead of stopping -- ideal for watching a
                                // live plugin without freezing the server.
                                if (bp->HasMember("logMessage") && !(*bp)["logMessage"]->AsString().empty()) {
                                    std::string log_message = (*bp)["logMessage"]->AsString();
                                    new_bp->SetLogMessage(log_message);
                                    SPDBG_LOG("[SM] DAP SetBreakpoints - Logpoint: %s", log_message.c_str());
                                }

                                // Set hit condition if provided
                                if (bp->HasMember("hitCondition") && !(*bp)["hitCondition"]->AsString().empty()) {
                                    std::string hit_cond_str = (*bp)["hitCondition"]->AsString();
                                    // Simple validation for numeric string
                                    bool valid_number = true;
                                    for (char c : hit_cond_str) {
                                        if (!std::isdigit(c)) {
                                            valid_number = false;
                                            break;
                                        }
                                    }

                                    if (valid_number && !hit_cond_str.empty()) {
                                        uint32_t hit_condition = static_cast<uint32_t>(std::stoul(hit_cond_str));
                                        new_bp->SetHitCondition(hit_condition);
                                        SPDBG_LOG("[SM] DAP SetBreakpoints - Hit condition: %u", hit_condition);
                                    } else {
                                        SPDBG_LOG("[SM] DAP SetBreakpoints - Invalid hit condition: %s", hit_cond_str.c_str());
                                        verified = false;
                                    }
                                }

                                JsonParser::AddToObject(*bp_obj, "id", std::make_shared<JsonValue>(bp_id++));

                                // Include condition information in response
                                if (!new_bp->GetCondition().empty()) {
                                    JsonParser::AddToObject(*bp_obj, "condition", std::make_shared<JsonValue>(new_bp->GetCondition()));
                                }

                                if (new_bp->GetHitCondition() > 0) {
                                    JsonParser::AddToObject(*bp_obj, "hitCondition", std::make_shared<JsonValue>(std::to_string(new_bp->GetHitCondition())));
                                }

                                // Add source information
                                auto bp_source = JsonParser::CreateObject();
                                JsonParser::AddToObject(*bp_source, "name", std::make_shared<JsonValue>(path_basename(file_path.c_str())));
                                JsonParser::AddToObject(*bp_source, "path", std::make_shared<JsonValue>(file_path));
                                JsonParser::AddToObject(*bp_obj, "source", bp_source);

                                SPDBG_LOG("[SM] DAP SetBreakpoints - Breakpoint verified at line %d", line);
                            } else {
                                SPDBG_LOG("[SM] DAP SetBreakpoints - Failed to add breakpoint at line %d", line);
                            }

                            JsonParser::AddToObject(*bp_obj, "verified", std::make_shared<JsonValue>(verified));
                            JsonParser::AddToObject(*bp_obj, "line", std::make_shared<JsonValue>(line));

                            if (!verified) {
                                JsonParser::AddToObject(*bp_obj, "message", std::make_shared<JsonValue>("Unable to set breakpoint at this location"));
                            }

                            JsonParser::AddToArray(*breakpoints_array, bp_obj);
                        }
                    }

                    SPDBG_LOG("[SM] DAP SetBreakpoints - Total breakpoints set: %zu", bp_manager.GetBreakpointCount());
                } else {
                    SPDBG_LOG("[SM] DAP SetBreakpoints - No debugger found for plugin");
                }
            } else {
                SPDBG_LOG("[SM] DAP SetBreakpoints - No active plugin for client");
            }
        }
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "breakpoints", breakpoints_array);
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::SendContinuedEvent(ClientConnection* client)
{
    if (!client || !client->session)
        return;
    auto continued_event = std::make_unique<DAPEvent>(
        ++g_response_seq_counter,
        "continued"
    );
    auto continued_body = JsonParser::CreateObject();
    JsonParser::AddToObject(*continued_body, "threadId", std::make_shared<JsonValue>(1));
    JsonParser::AddToObject(*continued_body, "allThreadsContinued", std::make_shared<JsonValue>(true));
    continued_event->SetBody(continued_body);
    client->session->SendEvent(continued_event->ToJson());
}

void DAPHandlers::HandleContinue(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "continue",
        true
    );

    // Resuming execution invalidates any aggregate variable handles.
    if (client->variable_handles)
        client->variable_handles->Clear();

    bool execution_continued = false;

    // Resolve the target debugger first so we can emit "continued" BEFORE waking
    // the VM thread (SetRunmode signals it immediately). Sending the event after
    // SetRunmode races the VM's "stopped" event and can leave the adapter stuck
    // in the running state with a paused UI.
    Debugger* target = nullptr;
    if (client->active_plugin) {
        auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->active())
            target = debugger;
    }
    if (target) {
        SendContinuedEvent(client);
        target->SetRunmode(RUNNING);
        SPDBG_LOG("[SM] DAP Continue - Plugin %s continuing execution", client->active_plugin->GetFilename());
        execution_continued = true;
    }

    // Add response body indicating if all threads continued
    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "allThreadsContinued", std::make_shared<JsonValue>(execution_continued));
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleNext(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "next",
        true
    );

    // Resuming execution invalidates any aggregate variable handles.
    if (client->variable_handles)
        client->variable_handles->Clear();

    // Emit "continued" BEFORE SetRunmode wakes the VM thread, so the wire order
    // is deterministically continued-then-stopped (see SendContinuedEvent).
    if (client->active_plugin) {
        auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->active()) {
            SendContinuedEvent(client);
            debugger->SetRunmode(STEPOVER);
            SPDBG_LOG("[SM] DAP Next - Plugin %s stepping over", client->active_plugin->GetFilename());
        }
    }

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleStepIn(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "stepIn",
        true
    );

    // Resuming execution invalidates any aggregate variable handles.
    if (client->variable_handles)
        client->variable_handles->Clear();

    // Resolve the target debugger first, then emit "continued" BEFORE SetRunmode
    // wakes the VM thread (see SendContinuedEvent for why the order matters).
    Debugger* target = client->active_plugin ? BoundDebugger(client) : AnyActiveDebugger();

    if (target) {
        SendContinuedEvent(client);
        target->SetRunmode(STEPPING);
        SPDBG_LOG("[SM] DAP StepIn - stepping into");
    }

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleStepOut(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "stepOut",
        true
    );

    // Resuming execution invalidates any aggregate variable handles.
    if (client->variable_handles)
        client->variable_handles->Clear();

    // Resolve the target debugger first, then emit "continued" BEFORE SetRunmode
    // wakes the VM thread (see SendContinuedEvent for why the order matters).
    Debugger* target = client->active_plugin ? BoundDebugger(client) : AnyActiveDebugger();

    if (target) {
        SendContinuedEvent(client);
        target->SetRunmode(STEPOUT);
        SPDBG_LOG("[SM] DAP StepOut - stepping out");
    }

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleStackTrace(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "stackTrace",
        true
    );

    auto stack_frames = JsonParser::CreateArray();

    // Parse optional startFrame and levels from arguments
    int start_frame = 0;
    int levels = 0; // 0 means return all frames
    auto args = request->GetArguments();
    if (args) {
        if (args->HasMember("startFrame")) {
            start_frame = (*args)["startFrame"]->AsInt();
        }
        if (args->HasMember("levels")) {
            levels = (*args)["levels"]->AsInt();
        }
    }

    // Use the active plugin for this client connection
    if (client->active_plugin) {
        auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->active()) {
            SPDBG_LOG("[SM] DAP StackTrace - Getting stack trace for plugin %s", client->active_plugin->GetFilename());

            // Only return stack trace if debugger is actually stopped
            if (!debugger->IsPaused()) {
                SPDBG_LOG("[SM] DAP StackTrace - Debugger not stopped, returning empty stack");
            } else {
                // Use IFrameIterator to walk all stack frames
                SourcePawn::IPluginContext* ctx = debugger->basectx();
                SourcePawn::IFrameIterator* frames = ctx->CreateFrameIterator();

                int frame_index = 0;
                int frames_added = 0;

                for (; !frames->Done(); frames->Next()) {
                    // Skip internal frames
                    if (frames->IsInternalFrame())
                        continue;

                    // Apply startFrame filter
                    if (frame_index < start_frame) {
                        frame_index++;
                        continue;
                    }

                    // Apply levels limit (0 = unlimited)
                    if (levels > 0 && frames_added >= levels)
                        break;

                    auto frame = JsonParser::CreateObject();

                    // Frame ID encodes the frame index for later reference
                    // Use frame_index as the ID so scopes/variables can reference it
                    JsonParser::AddToObject(*frame, "id", std::make_shared<JsonValue>(frame_index));

                    // Get function name
                    const char* func_name = frames->FunctionName();
                    std::string function_display;
                    if (func_name) {
                        function_display = std::string(func_name) + " [" + client->active_plugin->GetFilename() + "]";
                    } else {
                        function_display = std::string("<unknown> [") + client->active_plugin->GetFilename() + "]";
                    }
                    JsonParser::AddToObject(*frame, "name", std::make_shared<JsonValue>(function_display));

                    if (frames->IsNativeFrame()) {
                        // Native frames don't have source info
                        JsonParser::AddToObject(*frame, "line", std::make_shared<JsonValue>(0));
                        JsonParser::AddToObject(*frame, "column", std::make_shared<JsonValue>(0));
                        JsonParser::AddToObject(*frame, "presentationHint", std::make_shared<JsonValue>("subtle"));
                    } else if (frames->IsScriptedFrame()) {
                        // Get source file and line for scripted frames
                        const char* file_path = frames->FilePath();
                        int line_number = frames->LineNumber();
#if defined(SPDBG_MERGED_ENV_API)
                        // SourcePawn 2.0 can start several source lines at one
                        // instruction; the top frame shows the one we stopped for.
                        if (frame_index == 0) {
                            if (SpPluginDebugInfo* info = SpDebugInfo(ctx->GetRuntime())) {
                                uint32_t stop_line = 0;
                                if (info->IsV2() &&
                                    info->LookupLine(static_cast<ucell_t>(debugger->breakcip()), &stop_line) == SP_ERROR_NONE)
                                    line_number = static_cast<int>(stop_line);
                            }
                        }
#endif

                        if (file_path) {
                            auto source = JsonParser::CreateObject();
                            JsonParser::AddToObject(*source, "name", std::make_shared<JsonValue>(path_basename(file_path)));
                            JsonParser::AddToObject(*source, "path", std::make_shared<JsonValue>(file_path));
                            JsonParser::AddToObject(*source, "sourceReference", std::make_shared<JsonValue>(0));
                            JsonParser::AddToObject(*source, "presentationHint", std::make_shared<JsonValue>("normal"));
                            JsonParser::AddToObject(*frame, "source", source);
                        }

                        // Line numbers in DAP are 1-based
                        JsonParser::AddToObject(*frame, "line", std::make_shared<JsonValue>(line_number));
                        JsonParser::AddToObject(*frame, "column", std::make_shared<JsonValue>(0));
                        JsonParser::AddToObject(*frame, "presentationHint", std::make_shared<JsonValue>("normal"));
                    }

                    JsonParser::AddToArray(*stack_frames, frame);
                    frame_index++;
                    frames_added++;
                }

                ctx->DestroyFrameIterator(frames);
                SPDBG_LOG("[SM] DAP StackTrace - Total frames: %d (returned %d)", frame_index, frames_added);
            }
        } else {
            SPDBG_LOG("[SM] DAP StackTrace - No active debugger for plugin %s",
                                     client->active_plugin->GetFilename());
        }
    } else {
        SPDBG_LOG("[SM] DAP StackTrace - No active plugin for client");
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "stackFrames", stack_frames);
    JsonParser::AddToObject(*body, "totalFrames", std::make_shared<JsonValue>(static_cast<int>(stack_frames->Size())));
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

// Variable reference encoding scheme for scopes:
//   variablesReference = frameId * kScopeSlots + scopeType + 1
// where scopeType: 0 = locals, 1 = arguments, 2 = globals.
// The "+ 1" keeps the value >= 1 (0 means "no children" in DAP). A compact
// multiplier (4) keeps scope refs far below kVariableHandleBase (100000) even
// for very deep stacks, so they never collide with aggregate handles. The old
// scheme ((frameId+1)*1000) collided with the handle base at frameId >= 99.
static constexpr int kScopeSlots = 4;   // 3 scope types + spare; power of two
static constexpr int kScopeTypeLocals = 0;
static constexpr int kScopeTypeArguments = 1;
static constexpr int kScopeTypeGlobals = 2;

static int EncodeVariableReference(int frameId, int scopeType) {
    return frameId * kScopeSlots + scopeType + 1;
}

static void DecodeVariableReference(int varRef, int& frameId, int& scopeType) {
    frameId = (varRef - 1) / kScopeSlots;
    scopeType = (varRef - 1) % kScopeSlots;
}

void DAPHandlers::HandleScopes(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "scopes",
        true
    );

    auto scopes = JsonParser::CreateArray();

    // Get frameId from arguments
    int frame_id = 0;
    auto args = request->GetArguments();
    if (args && args->HasMember("frameId")) {
        frame_id = (*args)["frameId"]->AsInt();
    }

    SPDBG_LOG("[SM] DAP Scopes - Requested for frame %d", frame_id);

    // Only provide scopes if debugger is in the right state
    if (client->active_plugin) {
        auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->active() && debugger->IsPaused()) {

            // Add local scope (frame-specific variables)
            auto local_scope = JsonParser::CreateObject();
            JsonParser::AddToObject(*local_scope, "name", std::make_shared<JsonValue>("Locals"));
            JsonParser::AddToObject(*local_scope, "variablesReference",
                std::make_shared<JsonValue>(EncodeVariableReference(frame_id, kScopeTypeLocals)));
            JsonParser::AddToObject(*local_scope, "expensive", std::make_shared<JsonValue>(false));
            JsonParser::AddToObject(*local_scope, "presentationHint", std::make_shared<JsonValue>("locals"));
            JsonParser::AddToArray(*scopes, local_scope);

            // Add arguments scope
            auto args_scope = JsonParser::CreateObject();
            JsonParser::AddToObject(*args_scope, "name", std::make_shared<JsonValue>("Arguments"));
            JsonParser::AddToObject(*args_scope, "variablesReference",
                std::make_shared<JsonValue>(EncodeVariableReference(frame_id, kScopeTypeArguments)));
            JsonParser::AddToObject(*args_scope, "expensive", std::make_shared<JsonValue>(false));
            JsonParser::AddToObject(*args_scope, "presentationHint", std::make_shared<JsonValue>("arguments"));
            JsonParser::AddToArray(*scopes, args_scope);

            // Add global scope (globals are shared across all frames)
            auto global_scope = JsonParser::CreateObject();
            JsonParser::AddToObject(*global_scope, "name", std::make_shared<JsonValue>("Globals"));
            JsonParser::AddToObject(*global_scope, "variablesReference",
                std::make_shared<JsonValue>(EncodeVariableReference(frame_id, kScopeTypeGlobals)));
            JsonParser::AddToObject(*global_scope, "expensive", std::make_shared<JsonValue>(true)); // Globals can be expensive
            JsonParser::AddToObject(*global_scope, "presentationHint", std::make_shared<JsonValue>("globals"));
            JsonParser::AddToArray(*scopes, global_scope);

            SPDBG_LOG("[SM] DAP Scopes - Provided %zu scopes for frame %d", scopes->Size(), frame_id);
        } else {
            SPDBG_LOG("[SM] DAP Scopes - Debugger not in stepping mode, providing empty scopes");
        }
    } else {
        SPDBG_LOG("[SM] DAP Scopes - No active plugin, providing empty scopes");
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "scopes", scopes);
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleVariables(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "variables",
        true
    );

    auto variables = JsonParser::CreateArray();

    auto args = request->GetArguments();
    if (args && args->HasMember("variablesReference")) {
        int var_ref = (*args)["variablesReference"]->AsInt();

        // A reference is either a scope encoding ((frameId+1)*1000 + scopeType)
        // or an aggregate handle (>= kVariableHandleBase) allocated previously.
        bool is_handle = VariableHandleRegistry::IsHandle(var_ref);
        int frame_id = 0, scope_type = 0;
        VariableHandle handle;
        bool handle_ok = false;

        if (is_handle) {
            handle_ok = client->variable_handles &&
                        client->variable_handles->Get(var_ref, handle);
            if (handle_ok) {
                frame_id = handle.frameId;
                scope_type = handle.scopeType;
            }
            SPDBG_LOG("[SM] DAP Variables - handle %d -> frame=%d scope=%d symbol=%s (%s)",
                var_ref, frame_id, scope_type, handle_ok ? handle.rootSymbolName.c_str() : "?",
                handle_ok ? "ok" : "unknown");
        } else {
            DecodeVariableReference(var_ref, frame_id, scope_type);
            SPDBG_LOG("[SM] DAP Variables - varRef=%d decoded to frame=%d, scope=%d", var_ref, frame_id, scope_type);
        }

        // Use the active plugin for this client connection
        if (client->active_plugin) {
            auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
            if (debugger && debugger->active() && debugger->IsPaused() && (!is_handle || handle_ok)) {

                // Select the requested frame so symbol addresses resolve against
                // the right frame pointer. Bail out for native/invalid frames.
                if (!debugger->SelectFrame(frame_id)) {
                    SPDBG_LOG("[SM] DAP Variables - Frame %d not selectable", frame_id);
                } else {
                    SpPluginDebugInfo *debuginfo = debugger->GetDebugInfo();

                    if (is_handle) {
                        // Expanding an aggregate: re-resolve the root symbol by
                        // name and enumerate its immediate children. The symbol
                        // pointer is owned by the iterator, so keep the iterator
                        // alive until we're done reading from the wrapper.
                        IDebugSymbolIterator* symbol_iterator = debuginfo->CreateSymbolIterator(debugger->cip());
                        std::unique_ptr<SymbolWrapper> sym =
                            debugger->symbols().FindDebugSymbol(handle.rootSymbolName, debugger->cip(), symbol_iterator);

                        if (sym) {
                            std::vector<ChildVariable> children = dap::EnumerateChildren(*sym);
                            for (const auto& child : children) {
                                auto var = JsonParser::CreateObject();
                                JsonParser::AddToObject(*var, "name", std::make_shared<JsonValue>(child.name));
                                JsonParser::AddToObject(*var, "value", std::make_shared<JsonValue>(child.value));
                                JsonParser::AddToObject(*var, "type", std::make_shared<JsonValue>(child.type));
                                JsonParser::AddToObject(*var, "variablesReference", std::make_shared<JsonValue>(0));
                                JsonParser::AddToArray(*variables, var);
                            }
                        }
                        debuginfo->DestroySymbolIterator(symbol_iterator);
                        SPDBG_LOG("[SM] DAP Variables - expanded %s into %zu children",
                            handle.rootSymbolName.c_str(), variables->Size());
                    } else {
                        // Listing a scope: walk in-scope symbols of the matching kind.
                        IDebugSymbolIterator* symbol_iterator = debuginfo->CreateSymbolIterator(debugger->cip());

                        int var_count = 0;
                        while (!symbol_iterator->Done()) {
                            const SourcePawn::IDebugSymbol* symbol = symbol_iterator->Next();
                            if (!symbol) continue;

                            bool include_var = false;
                            if (scope_type == kScopeTypeLocals) {
                                include_var = (symbol->scope() == SourcePawn::Local);
                            } else if (scope_type == kScopeTypeArguments) {
                                include_var = (symbol->scope() == SourcePawn::Argument);
                            } else if (scope_type == kScopeTypeGlobals) {
                                include_var = (symbol->scope() == SourcePawn::Global || symbol->scope() == SourcePawn::Static);
                            }

                            if (!include_var || !symbol->name())
                                continue;

                            SymbolWrapper wrapper(debugger, symbol);

                            auto var = JsonParser::CreateObject();
                            JsonParser::AddToObject(*var, "name", std::make_shared<JsonValue>(symbol->name()));
                            JsonParser::AddToObject(*var, "value", std::make_shared<JsonValue>(dap::GetSummaryValue(wrapper)));
                            JsonParser::AddToObject(*var, "type", std::make_shared<JsonValue>(dap::GetTypeName(wrapper)));

                            // Allocate a child handle for aggregates so the
                            // variable can be expanded in the tree.
                            int child_ref = 0;
                            if (dap::IsExpandable(wrapper) && client->variable_handles) {
                                child_ref = client->variable_handles->Allocate(frame_id, scope_type, symbol->name());
                            }
                            JsonParser::AddToObject(*var, "variablesReference", std::make_shared<JsonValue>(child_ref));

                            JsonParser::AddToObject(*var, "evaluateName", std::make_shared<JsonValue>(symbol->name()));

                            JsonParser::AddToArray(*variables, var);
                            var_count++;
                        }
                        debuginfo->DestroySymbolIterator(symbol_iterator);

                        SPDBG_LOG("[SM] DAP Variables - Found %d variables for frame=%d, scope=%d", var_count, frame_id, scope_type);
                    }
                }
            } else if (is_handle && !handle_ok) {
                // The handle was allocated for a previous stop and the registry
                // was cleared when execution resumed (step/continue). VS Code is
                // asking to expand a now-stale reference. Return an empty list
                // instead of a scary error -- the view will refresh on the next
                // stop with fresh handles.
                SPDBG_LOG("[SM] DAP Variables - Stale handle %d (cleared on resume), returning empty", var_ref);
            } else {
                SPDBG_LOG("[SM] DAP Variables - No active debugger for plugin");

                // Add error variable to show the issue
                auto error_var = JsonParser::CreateObject();
                JsonParser::AddToObject(*error_var, "name", std::make_shared<JsonValue>("(Error)"));
                JsonParser::AddToObject(*error_var, "value", std::make_shared<JsonValue>("No active debugger for current plugin"));
                JsonParser::AddToObject(*error_var, "type", std::make_shared<JsonValue>("error"));
                JsonParser::AddToObject(*error_var, "variablesReference", std::make_shared<JsonValue>(0));
                JsonParser::AddToArray(*variables, error_var);
            }
        } else {
            SPDBG_LOG("[SM] DAP Variables - No active plugin for client");

            // Add error variable to show the issue
            auto error_var = JsonParser::CreateObject();
            JsonParser::AddToObject(*error_var, "name", std::make_shared<JsonValue>("(Error)"));
            JsonParser::AddToObject(*error_var, "value", std::make_shared<JsonValue>("No active plugin for client connection"));
            JsonParser::AddToObject(*error_var, "type", std::make_shared<JsonValue>("error"));
            JsonParser::AddToObject(*error_var, "variablesReference", std::make_shared<JsonValue>(0));
            JsonParser::AddToArray(*variables, error_var);
        }
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "variables", variables);
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleEvaluate(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "evaluate",
        true
    );

    std::string result = "undefined";
    std::string expression;
    std::string context = "watch";

    auto args = request->GetArguments();
    if (args && args->HasMember("expression")) {
        expression = (*args)["expression"]->AsString();

        // Check for context
        if (args->HasMember("context")) {
            context = (*args)["context"]->AsString();
        }

        SPDBG_LOG("[SM] DAP Evaluate - Expression: %s, Context: %s", expression.c_str(), context.c_str());

        // Handle internal VS Code evaluate requests
        if (context == "internal") {
            if (expression == "files") {
                result = "[]"; // Empty array for now
            } else if (expression == "pause") {
                result = "false"; // Not paused initially
            } else {
                result = "null";
            }
        } else {
            // Decide how to interpret the input. In the Debug Console (REPL),
            // if the first token is a console debugger command (bt, p, x,
            // files, funcs, watch, break, ?, ...) run it and return its console
            // output. Otherwise (and for hover/watch contexts) evaluate it as an
            // expression so typing a bare variable name still shows its value.
            auto evalOn = [&](Debugger* dbg) -> std::string {
                // Symbols only have meaningful values at a stop: off a break the
                // frame pointer is stale and the game thread is mutating the very
                // data we would read, so report instead of inventing a value.
                if (!dbg->IsPaused())
                    return "<not paused>";
                if (args->HasMember("frameId")) {
                    dbg->SelectFrame((*args)["frameId"]->AsInt());
                }
                if (context == "repl") {
                    std::string first = expression;
                    size_t sp = first.find_first_of(" ");
                    if (sp != std::string::npos) first = first.substr(0, sp);
                    if (dbg->IsConsoleCommandToken(first)) {
                        std::string out = dbg->ExecuteReplCommand(expression);
                        // Trim a single trailing newline so the console doesn't
                        // show a blank line after every command.
                        while (!out.empty() && (out.back() == '\n' || out.back() == '\r'))
                            out.pop_back();
                        return out.empty() ? "(no output)" : out;
                    }
                }
                return EvaluateExpression(expression, dbg);
            };

            // Regular user evaluation
            if (client->active_plugin) {
                auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
                if (debugger && debugger->active()) {
                    result = evalOn(debugger);
                } else {
                    result = "<no active debugger>";
                }
            } else {
                if (Debugger* any = AnyActiveDebugger())
                    result = evalOn(any);
                if (result == "undefined") {
                    result = "<no active plugin>";
                }
            }
        }
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "result", std::make_shared<JsonValue>(result));
    JsonParser::AddToObject(*body, "variablesReference", std::make_shared<JsonValue>(0));
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleSetVariable(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "setVariable",
        true
    );

    std::string name;
    std::string value;
    std::string result_value;
    bool success = false;

    auto args = request->GetArguments();
    if (args && args->HasMember("name") && args->HasMember("value")) {
        name = (*args)["name"]->AsString();
        value = (*args)["value"]->AsString();

        // Use the active plugin for this client connection
        if (client->active_plugin) {
            auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
            // Writes are only safe (and only meaningful) at a stop: mid-run the
            // frame pointer belongs to whatever the VM is executing right now.
            if (debugger && debugger->active() && !debugger->IsPaused()) {
                result_value = "<not paused>";
            } else if (debugger && debugger->active()) {
                int var_ref = 0;
                bool have_ref = args->HasMember("variablesReference");
                if (have_ref) var_ref = (*args)["variablesReference"]->AsInt();

                // Select the frame that owns the variable being edited.
                if (debugger->IsPaused() && have_ref) {
                    int frame_id = 0, scope_type = 0;
                    if (VariableHandleRegistry::IsHandle(var_ref)) {
                        VariableHandle vh;
                        if (client->variable_handles && client->variable_handles->Get(var_ref, vh))
                            frame_id = vh.frameId;
                    } else {
                        DecodeVariableReference(var_ref, frame_id, scope_type);
                    }
                    debugger->SelectFrame(frame_id);
                }

                // Indexed child of an expanded aggregate (e.g. user edits
                // g_iValidBhops[5] in the Variables panel). The child's symbol
                // doesn't exist on its own -- we have to resolve it through the
                // parent handle and write the element directly.
                bool indexed_child = have_ref &&
                                     VariableHandleRegistry::IsHandle(var_ref) &&
                                     name.size() >= 3 && name.front() == '[' && name.back() == ']';
                if (indexed_child) {
                    auto result = SetArrayElement(client, var_ref, name, value, debugger);
                    success = result.first;
                    result_value = result.second;
                } else {
                    auto result = SetVariableValue(name, value, debugger);
                    success = result.first;
                    result_value = result.second;
                }
            } else {
                result_value = "<no active debugger>";
            }
        } else {
            Debugger* any = AnyActiveDebugger();
            if (any && !any->IsPaused()) {
                result_value = "<not paused>";
            } else if (any) {
                auto result = SetVariableValue(name, value, any);
                success = result.first;
                result_value = result.second;
            }
            if (result_value.empty()) {
                result_value = "<no active plugin>";
            }
        }
    } else {
        result_value = "<missing name or value>";
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "value", std::make_shared<JsonValue>(result_value));
    JsonParser::AddToObject(*body, "variablesReference", std::make_shared<JsonValue>(0));
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandlePause(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP Pause request received from client");
    debugger_ext_->SendDAPOutputEvent("Pause request received from client", "console");
    
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "pause",
        true
    );
    
    // Protection against multiple pause commands
    static std::chrono::steady_clock::time_point last_pause_time;
    static int pause_count = 0;
    auto now = std::chrono::steady_clock::now();
    
    if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_pause_time).count() < 1000) {
        pause_count++;
        if (pause_count > 3) {
            SPDBG_LOG("[SM] DAP Pause - Too many pause requests, ignoring to prevent crash");
            SendErrorResponse(client, request->GetSeq(), "pause", "Too many pause requests in short time");
            return;
        }
    } else {
        pause_count = 1;
    }
    last_pause_time = now;
    
    // Find active debugger for this client's plugin
    if (client->active_plugin) {
        Debugger* debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->active()) {
            // Check if already paused/stepping
            if (debugger->runmode() == STEPPING) {
                SPDBG_LOG("[SM] DAP Pause - Debugger already in STEPPING mode");
                SendResponse(client, std::move(response));
                return;
            }
            
            SPDBG_LOG("[SM] DAP Pause - Setting debugger to STEPPING mode");
            debugger_ext_->SendDAPOutputEvent("Pausing - will stop at the next executed line...", "console");
            debugger->SetRunmode(STEPPING);
            debugger->SetManualPause(true);

            // Do NOT send a synthetic stopped event here: the VM hasn't paused
            // yet (it stops at the next executed line). Emitting "stopped" now
            // races the real stop and produces a confusing double-stop. The
            // natural OnDebugBreak stop emits the stopped event when actually paused.
        } else {
            SPDBG_LOG("[SM] DAP Pause - No active debugger found for client's plugin");
        }
    } else {
        // Fallback: Find any active debugger
        SPDBG_LOG("[SM] DAP Pause - No active plugin for client, searching all debuggers");
        Debugger* any = AnyActiveDebugger();
        if (any && any->runmode() != STEPPING) {
            SPDBG_LOG("[SM] DAP Pause - Found active debugger, setting to STEPPING");
            any->SetRunmode(STEPPING);
            any->SetManualPause(true);
            // Natural OnDebugBreak stop emits the stopped event (see above).
        } else if (any) {
            SPDBG_LOG("[SM] DAP Pause - Debugger already in STEPPING mode");
        }

        if (!any) {
            SPDBG_LOG("[SM] DAP Pause - No active debuggers found");
        }
    }
    
    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleDisconnect(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        request->GetCommand(),
        true
    );
    
    // Stop only the debug sessions THIS client owns. Deactivating every active
    // debugger here is a race: a stale/late disconnect from a previous client
    // would tear down a session a newer client just started, leaving its
    // breakpoints verified but never firing (OnDebugBreak bails on !active()).
    for (DebuggerMap::iterator it = debugger_ext_->GetDebuggerMap().iter(); !it.empty(); it.next()) {
        if (it->value->active() && it->value->OwnerToken() == client) {
            it->value->Deactivate();
        }
    }

    SendResponse(client, std::move(response));
    // Mark client for disconnect after response
    client->active = false;
}

void DAPHandlers::SendResponse(ClientConnection* client, std::unique_ptr<DAPResponse> response)
{
    if (client->session) {
        client->session->SendResponse(response->ToJson());
    }
}

void DAPHandlers::HandleConfigurationDone(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP ConfigurationDone - Client configuration complete");

    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "configurationDone",
        true
    );

    // Send response first
    SendResponse(client, std::move(response));

    // Configuration is done. For stopOnEntry, arm stepping NOW so the VM pauses
    // at the next executed line and HandleInput emits the stopped event itself.
    // We deliberately do NOT send a synthetic stopped event here: doing so would
    // tell VS Code we're paused before the VM has actually stopped, so the
    // following stackTrace/scopes/variables would race an unpaused debugger and
    // come back empty.
    if (client->active_plugin && client->pending_stopped_event) {
        auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->active()) {
            SPDBG_LOG("[SM] DAP ConfigurationDone - Plugin %s ready, arming stepping for entry pause",
                                     client->active_plugin->GetFilename());
            debugger_ext_->SendDAPOutputEvent(("Plugin " + std::string(client->active_plugin->GetFilename()) + " is ready for debugging").c_str(), "console");

            debugger->SetRunmode(STEPPING);
            client->pending_stopped_event = false;
        }
    } else {
        SPDBG_LOG("[SM] DAP ConfigurationDone - No pending stopped event needed");
    }
}

void DAPHandlers::HandleTerminate(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    // Same as disconnect for now
    HandleDisconnect(client, std::move(request));
}

void DAPHandlers::HandleSetExceptionBreakpoints(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "setExceptionBreakpoints",
        true
    );
    
    // No exception breakpoints supported for now
    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleThreads(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "threads",
        true
    );
    
    auto threads = JsonParser::CreateArray();
    
    // Single thread model for SourcePawn
    auto thread = JsonParser::CreateObject();
    JsonParser::AddToObject(*thread, "id", std::make_shared<JsonValue>(1));
    JsonParser::AddToObject(*thread, "name", std::make_shared<JsonValue>("Main Thread"));
    JsonParser::AddToArray(*threads, thread);
    
    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "threads", threads);
    response->SetBody(body);
    
    SendResponse(client, std::move(response));
}

void DAPHandlers::SendErrorResponse(ClientConnection* client, uint32_t seq, const std::string& command, const std::string& error)
{
    auto response = std::make_unique<DAPResponse>(++g_response_seq_counter, seq, command, false);
    response->SetMessage(error);

    // DAP protocol requires a body even for error responses
    // Include error details in a structured format
    auto body = JsonParser::CreateObject();
    auto error_obj = JsonParser::CreateObject();
    JsonParser::AddToObject(*error_obj, "id", std::make_shared<JsonValue>(1));
    JsonParser::AddToObject(*error_obj, "format", std::make_shared<JsonValue>(error));
    JsonParser::AddToObject(*body, "error", error_obj);
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

// Extract the identifier the user is really asking about from arbitrary
// hover/watch text. VS Code's hover passes whatever it can grab around the
// cursor, so the expression often arrives as a full declaration with type
// keywords, brackets and comments -- e.g. "static float g_fLastResetTime[MAXPLAYERS + 1]; // ...".
// Returns the last identifier (the variable name) so the simple-name lookup
// path can find it. Strips // and /* */ comments, trailing ';', and ignores
// any [index] tail.
static std::string ExtractIdentifier(std::string s)
{
    size_t lc = s.find("//");
    if (lc != std::string::npos) s.resize(lc);
    size_t bc = s.find("/*");
    if (bc != std::string::npos) {
        size_t bce = s.find("*/", bc);
        if (bce != std::string::npos) s = s.substr(0, bc) + s.substr(bce + 2);
        else s.resize(bc);
    }
    while (!s.empty() && (s.back() == ';' || std::isspace((unsigned char)s.back())))
        s.pop_back();

    // Walk left-to-right; remember the LAST identifier, since "static float NAME[..]"
    // and "NAME" both yield the variable name as the last identifier before [.
    std::string last;
    for (size_t i = 0; i < s.size();) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if (std::isalpha(c) || c == '_') {
            size_t j = i + 1;
            while (j < s.size() &&
                   (std::isalnum(static_cast<unsigned char>(s[j])) || s[j] == '_'))
                j++;
            last = s.substr(i, j - i);
            i = j;
            // Skip a "[...]" suffix so we don't pick up identifiers from inside
            // a subscript expression as the candidate variable.
            while (i < s.size() && std::isspace((unsigned char)s[i])) i++;
            if (i < s.size() && s[i] == '[') {
                int depth = 1;
                size_t p = i + 1;
                while (p < s.size() && depth > 0) {
                    if (s[p] == '[') depth++;
                    else if (s[p] == ']') depth--;
                    p++;
                }
                i = p;
            }
        } else {
            i++;
        }
    }
    return last;
}

std::string DAPHandlers::EvaluateExpression(const std::string& expression, Debugger* debugger)
{
    if (!debugger || !debugger->active()) {
        return "<no active debugger>";
    }

    // Try to canonicalize the expression to the variable name the user pointed
    // at. This rescues common hover cases like declaration lines and indexed
    // accesses ("arr[i]"), which the original "simple variable name" branch
    // bailed on because of the [ and + characters.
    std::string ident = ExtractIdentifier(expression);
    if (!ident.empty()) {
        SpPluginDebugInfo *debuginfo = SpDebugInfo(debugger->ctx()->GetRuntime());
        if (!debuginfo)
            return "<debug info unavailable>";
        IDebugSymbolIterator* symbol_iterator = debuginfo->CreateSymbolIterator(debugger->cip());

        while (!symbol_iterator->Done()) {
            const SourcePawn::IDebugSymbol* symbol = symbol_iterator->Next();
            if (!symbol) continue;

            if (symbol->name() && std::string(symbol->name()) == ident) {
                std::string val = GetVariableValue(symbol, debuginfo, debugger);
                debuginfo->DestroySymbolIterator(symbol_iterator);
                return val;
            }
        }
        debuginfo->DestroySymbolIterator(symbol_iterator);
        // Fall through to the legacy paths below for non-variable expressions.
    }

    // Handle simple expressions
    if (expression.find("cip") != std::string::npos) {
        return std::to_string(debugger->cip());
    }
    if (expression.find("frm") != std::string::npos) {
        return std::to_string(debugger->frm());
    }
    if (expression.find("line") != std::string::npos) {
        return std::to_string(debugger->currentline() + 1);
    }
    if (expression.find("file") != std::string::npos) {
        const char* file = debugger->currentfile();
        return file ? std::string("\"") + file + "\"" : "<no file>";
    }
    if (expression.find("function") != std::string::npos) {
        const char* func = debugger->currentfunction();
        return func ? std::string("\"") + func + "\"" : "<no function>";
    }

    // Simple arithmetic evaluation (very basic)
    if (expression.find_first_of("+-*/") != std::string::npos) {
        // Try to evaluate simple arithmetic - this is a basic implementation
        return "<arithmetic evaluation not fully implemented: " + expression + ">";
    }

    return "<expression evaluation not supported: " + expression + ">";
}

// Raw CPU / memory counters of the server (see perf-stats.h). Cumulative CPU
// times, not percentages: the client samples twice and divides. Answered from
// the TCP thread, so it also works while the VM is paused at a breakpoint.
void DAPHandlers::HandlePerformance(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter, request->GetSeq(), "sp_performance", true);

    // Arguments: { resetPeaks: true } forgets the peak stack/heap seen so far.
    if (auto args = request->GetArguments()) {
        if (args->HasMember("resetPeaks") && (*args)["resetPeaks"]->AsBool())
            dap::perf::ResetPeaks();
    }

    SourcePawn::IPluginContext* active_ctx =
        client->active_plugin ? client->active_plugin->GetBaseContext() : nullptr;
    const dap::perf::Sample s = dap::perf::Take(client->active_plugin_name.c_str(), active_ctx);
    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "wallMs", std::make_shared<JsonValue>(s.wall_ms));
    JsonParser::AddToObject(*body, "processCpuMs", std::make_shared<JsonValue>(s.process_cpu_ms));
    JsonParser::AddToObject(*body, "mainCpuMs", std::make_shared<JsonValue>(s.main_cpu_ms));
    JsonParser::AddToObject(*body, "rssBytes", std::make_shared<JsonValue>(s.rss_bytes));
    JsonParser::AddToObject(*body, "pluginBytes", std::make_shared<JsonValue>(s.plugin_bytes));
    JsonParser::AddToObject(*body, "pluginAgeMs", std::make_shared<JsonValue>(s.plugin_age_ms));
    const std::string kind = s.debug_kind == 1 ? "legacy" : s.debug_kind == 2 ? "v2" : "";
    JsonParser::AddToObject(*body, "debugPlugin", std::make_shared<JsonValue>(s.debug_plugin));
    JsonParser::AddToObject(*body, "debugKind", std::make_shared<JsonValue>(kind));
    JsonParser::AddToObject(*body, "stackHeapBytes", std::make_shared<JsonValue>(s.debug_stack_heap_bytes));
    JsonParser::AddToObject(*body, "dataBytes", std::make_shared<JsonValue>(s.debug_data_bytes));
    JsonParser::AddToObject(*body, "heapLiveBytes", std::make_shared<JsonValue>(s.debug_heap_live_bytes));
    JsonParser::AddToObject(*body, "stackPeakBytes", std::make_shared<JsonValue>(s.debug_stack_peak_bytes));
    JsonParser::AddToObject(*body, "heapPeakBytes", std::make_shared<JsonValue>(s.debug_heap_peak_bytes));
    JsonParser::AddToObject(*body, "usedPeakBytes", std::make_shared<JsonValue>(s.debug_used_peak_bytes));
    JsonParser::AddToObject(*body, "peakSamples", std::make_shared<JsonValue>(s.debug_peak_samples));
    JsonParser::AddToObject(*body, "plugins", std::make_shared<JsonValue>(s.plugins));
    JsonParser::AddToObject(*body, "cpus", std::make_shared<JsonValue>(s.cpus));
    response->SetBody(body);
    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleProfileStart(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter, request->GetSeq(), "sp_profileStart", true);

    // ONE tree is reported: the debugged plugin's, from the debug-break tracer.
    // The VM's IProfilingTool profiler still runs, but purely as instrumentation:
    // its Invoke counter is the exact "the VM left and re-entered the plugin"
    // signal the tracer needs to drop between-frame idle. Its own top-level-only
    // tree used to be shown as an "all plugins" view, which invited comparing two
    // numbers measured on different clocks -- so it is no longer serialized.
    Profiler* vmProf = debugger_ext_->GetVMProfiler();
    Profiler* tracedProf = debugger_ext_->GetTracedProfiler();
    const bool engine2 = debugger_ext_->HasVmProfiling();
    bool started = false;
    // Stamp the real wall-clock start of the capture window up front, so it
    // covers both the traced ("this plugin") and VM ("all plugins") paths --
    // even when there's no active_plugin and only the VM profiler runs.
    debugger_ext_->MarkProfilingWindowStart();
    // Bring the VM profiler up FIRST so its Invoke counter is already feeding
    // before the tracer activates -- the tracer reads it to detect Invoke
    // boundaries. Tell the tracer whether that signal is available.
    bool vmTracking = (vmProf && engine2);
    debugger_ext_->SetVmInvokeTracking(vmTracking);
    if (vmTracking) {
        vmProf->Reset();
        spdbg::vm::EnableProfiling();
        vmProf->Start();
        started = true;
    }
    if (tracedProf && client->active_plugin) {
        // "This plugin" tree is scoped to the debugged plugin's context.
        debugger_ext_->BeginSampling(client->active_plugin->GetBaseContext());
        tracedProf->Start();
        started = true;
    }
    SPDBG_LOG("[SM] DAP ProfileStart - tracer started; VM profiler %s",
              vmTracking ? "feeding Invoke boundaries" : "unavailable (no v2 engine)");

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "active", std::make_shared<JsonValue>(started));
    response->SetBody(body);
    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleProfileStop(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter, request->GetSeq(), "sp_profileStop", true);

    Profiler* vmProf = debugger_ext_->GetVMProfiler();
    Profiler* tracedProf = debugger_ext_->GetTracedProfiler();
    const bool engine2 = debugger_ext_->HasVmProfiling();

    // capture = {"tree":..., "samples":..., "spans":...} -- the measured call
    // tree plus the measured timeline behind it.
    std::string capture = "{}";
    if (tracedProf) {
        debugger_ext_->EndSampling();   // flush open scopes
        tracedProf->Stop(nullptr);
        capture = tracedProf->SerializeJson();
    }
    // The VM profiler only ever existed here to feed Invoke boundaries; stop it
    // without reading its tree.
    if (vmProf) {
        if (engine2)
            spdbg::vm::DisableProfiling();
        vmProf->Stop(nullptr);
    }
    SPDBG_LOG("[SM] DAP ProfileStop - capture=%zuB", capture.size());

    // Real wall-clock duration of the capture window, so the client can show how
    // long the capture ran (and scale the timeline export).
    char windowMs[48];
    snprintf(windowMs, sizeof(windowMs), "%.4f", debugger_ext_->ProfilingWindowMs());

    // capture is already a serialized JSON object; splice the window in beside
    // its members rather than nesting, so the client sees one flat body.
    std::string wrapper = capture;
    if (wrapper.size() >= 2 && wrapper.front() == '{' && wrapper.back() == '}') {
        wrapper.pop_back();
        wrapper += (wrapper.size() > 1 ? "," : "");
        wrapper += "\"windowMs\":";
        wrapper += windowMs;
        wrapper += "}";
    }
    auto body = JsonParser::Parse(wrapper);
    if (body)
        response->SetBody(body);
    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleExceptionInfo(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "exceptionInfo",
        true
    );

    std::string message = "Unknown exception";
    bool fatal = false;
    if (client->active_plugin) {
        auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
        if (debugger && debugger->has_exception()) {
            message = debugger->exception_text();
            fatal = debugger->exception_fatal();
        }
    }

    // DAP exceptionInfo: powers VS Code's exception details widget.
    const std::string esc = JsonParser::EscapeString(message);
    std::string wrapper =
        std::string("{\"exceptionId\":\"") + (fatal ? "FatalException" : "Exception") + "\","
        "\"description\":\"" + esc + "\","
        "\"breakMode\":\"always\","
        "\"details\":{\"message\":\"" + esc + "\"}}";
    auto body = JsonParser::Parse(wrapper);
    if (body)
        response->SetBody(body);
    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleSetDataBreakpoints(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP SetDataBreakpoints - Setting data breakpoints (watchpoints)");

    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "setDataBreakpoints",
        true
    );

    auto breakpoints_array = JsonParser::CreateArray();

    auto args = request->GetArguments();
    if (args && args->HasMember("breakpoints")) {
        auto bps = (*args)["breakpoints"];
        const auto& bp_array = bps->AsArray();

        // Use the active plugin for this client connection
        if (client->active_plugin) {
            auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());

            if (debugger) {
                SymbolManager& symbol_manager = debugger->symbols();

                // Clear existing watches before setting new ones
                symbol_manager.ClearAllWatches();

                int bp_id = 1;
                for (const auto& bp : bp_array) {
                    if (bp->HasMember("dataId")) {
                        std::string data_id = (*bp)["dataId"]->AsString();
                        SPDBG_LOG("[SM] DAP SetDataBreakpoints - Adding watchpoint for: %s", data_id.c_str());

                        // Parse access type (read, write, readWrite)
                        std::string access_type = "write";
                        if (bp->HasMember("accessType")) {
                            access_type = (*bp)["accessType"]->AsString();
                        }

                        // Add watchpoint using symbol manager
                        bool verified = symbol_manager.AddWatch(data_id);

                        auto bp_obj = JsonParser::CreateObject();
                        JsonParser::AddToObject(*bp_obj, "id", std::make_shared<JsonValue>(bp_id++));
                        JsonParser::AddToObject(*bp_obj, "verified", std::make_shared<JsonValue>(verified));

                        if (!verified) {
                            JsonParser::AddToObject(*bp_obj, "message",
                                std::make_shared<JsonValue>("Unable to set watchpoint for: " + data_id));
                        }

                        JsonParser::AddToArray(*breakpoints_array, bp_obj);
                    }
                }

                SPDBG_LOG("[SM] DAP SetDataBreakpoints - Total watchpoints: %zu", symbol_manager.GetWatchCount());
            } else {
                SPDBG_LOG("[SM] DAP SetDataBreakpoints - No debugger found for plugin");
            }
        } else {
            SPDBG_LOG("[SM] DAP SetDataBreakpoints - No active plugin for client");
        }
    }

    auto body = JsonParser::CreateObject();
    JsonParser::AddToObject(*body, "breakpoints", breakpoints_array);
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleDataBreakpointInfo(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP DataBreakpointInfo - Getting data breakpoint info");

    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "dataBreakpointInfo",
        true
    );

    std::string data_id;
    std::string description;
    bool can_persist = false;

    // Get variable info from arguments
    auto args = request->GetArguments();
    if (args) {
        std::string var_name;
        if (args->HasMember("name")) {
            var_name = (*args)["name"]->AsString();
        }
        if (args->HasMember("variablesReference")) {
            int var_ref = (*args)["variablesReference"]->AsInt();
            // If variablesReference is provided, combine with name for full path
            if (var_ref > 0) {
                int frame_id, scope_type;
                DecodeVariableReference(var_ref, frame_id, scope_type);
                // For now, just use the variable name as the dataId
            }
        }

        if (!var_name.empty()) {
            // Check if this variable exists and can be watched
            if (client->active_plugin) {
                auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
                if (debugger && debugger->active()) {
                    SpPluginDebugInfo *debuginfo = SpDebugInfo(debugger->ctx()->GetRuntime());
                    if (!debuginfo)
                        return;
                    IDebugSymbolIterator* symbol_iterator = debuginfo->CreateSymbolIterator(debugger->cip());

                    bool found = false;
                    while (!symbol_iterator->Done()) {
                        const SourcePawn::IDebugSymbol* symbol = symbol_iterator->Next();
                        if (!symbol) continue;

                        if (symbol->name() && std::string(symbol->name()) == var_name) {
                            data_id = var_name;
                            description = "Watch variable: " + var_name;
                            can_persist = true;
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        SPDBG_LOG("[SM] DAP DataBreakpointInfo - Variable not found: %s", var_name.c_str());
                    }
                }
            }
        }
    }

    auto body = JsonParser::CreateObject();
    if (!data_id.empty()) {
        JsonParser::AddToObject(*body, "dataId", std::make_shared<JsonValue>(data_id));
        JsonParser::AddToObject(*body, "description", std::make_shared<JsonValue>(description));

        // Add supported access types
        auto access_types = JsonParser::CreateArray();
        JsonParser::AddToArray(*access_types, std::make_shared<JsonValue>("read"));
        JsonParser::AddToArray(*access_types, std::make_shared<JsonValue>("write"));
        JsonParser::AddToArray(*access_types, std::make_shared<JsonValue>("readWrite"));
        JsonParser::AddToObject(*body, "accessTypes", access_types);

        JsonParser::AddToObject(*body, "canPersist", std::make_shared<JsonValue>(can_persist));
    } else {
        // Variable cannot be watched
        JsonParser::AddToObject(*body, "dataId", std::make_shared<JsonValue>(JsonValue()));
        JsonParser::AddToObject(*body, "description", std::make_shared<JsonValue>("Cannot watch this variable"));
    }
    response->SetBody(body);

    SendResponse(client, std::move(response));
}

void DAPHandlers::HandleReadMemory(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    SPDBG_LOG("[SM] DAP ReadMemory - Reading memory");

    auto response = std::make_unique<DAPResponse>(
        ++g_response_seq_counter,
        request->GetSeq(),
        "readMemory",
        true
    );

    std::string address_str;
    int64_t offset = 0;
    int count = 0;

    auto args = request->GetArguments();
    if (args) {
        if (args->HasMember("memoryReference")) {
            address_str = (*args)["memoryReference"]->AsString();
        }
        if (args->HasMember("offset")) {
            offset = (*args)["offset"]->AsInt();
        }
        if (args->HasMember("count")) {
            count = (*args)["count"]->AsInt();
        }
    }

    auto body = JsonParser::CreateObject();

    if (!address_str.empty() && count > 0) {
        // Parse address (format: "0x..." or decimal). Use strtoul/strtol rather
        // than std::stoul/std::stol: with -fno-exceptions a malformed reference
        // would otherwise throw and crash the server. strto* yields 0 instead.
        cell_t address = 0;
        if (address_str.size() >= 2 && (address_str.substr(0, 2) == "0x" || address_str.substr(0, 2) == "0X")) {
            address = static_cast<cell_t>(strtoul(address_str.c_str() + 2, nullptr, 16));
        } else {
            address = static_cast<cell_t>(strtol(address_str.c_str(), nullptr, 10));
        }

        address += static_cast<cell_t>(offset);

        // Cap what one request can ask for: `count` arrives straight from the
        // client, and reserve() on an unbounded value is an allocation DoS.
        if (count > kMaxReadMemoryBytes)
            count = kMaxReadMemoryBytes;

        // Read memory from the plugin context
        if (client->active_plugin) {
            auto debugger = debugger_ext_->GetPluginDebugger(client->active_plugin->GetBaseContext());
            // Only while stopped: reading the data section as the VM executes it
            // on the game thread races that thread and returns torn values.
            if (debugger && debugger->active() && debugger->IsPaused()) {
                // Read cells from memory
                // Note: SourcePawn VM addresses are in cells (4 bytes each)
                int cells_to_read = (count + sizeof(cell_t) - 1) / sizeof(cell_t);
                std::string base64_data;
                std::vector<uint8_t> memory_data;
                memory_data.reserve(count);

                bool read_success = true;
                int bytes_read = 0;

                for (int i = 0; i < cells_to_read && bytes_read < count; i++) {
                    cell_t* phys_addr;
                    // Addresses are byte offsets into the data section, so each
                    // step is a whole cell. Advancing by 1 read overlapping
                    // cells and shifted every byte after the first.
                    const cell_t cell_addr = address + static_cast<cell_t>(i * sizeof(cell_t));
                    if (SpLocalToPhys(debugger->ctx(), cell_addr, sizeof(cell_t), &phys_addr) == SP_ERROR_NONE) {
                        cell_t value = *phys_addr;

                        // Extract bytes from cell (little-endian)
                        for (int b = 0; b < 4 && bytes_read < count; b++) {
                            memory_data.push_back(static_cast<uint8_t>((value >> (b * 8)) & 0xFF));
                            bytes_read++;
                        }
                    } else {
                        // Memory access error - mark remaining as unreadable
                        read_success = false;
                        break;
                    }
                }

                if (bytes_read > 0) {
                    // Base64 encode the memory data
                    static const char base64_chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                    std::string encoded;
                    encoded.reserve(((memory_data.size() + 2) / 3) * 4);

                    for (size_t i = 0; i < memory_data.size(); i += 3) {
                        uint32_t b = (memory_data[i] << 16);
                        if (i + 1 < memory_data.size()) b |= (memory_data[i + 1] << 8);
                        if (i + 2 < memory_data.size()) b |= memory_data[i + 2];

                        encoded.push_back(base64_chars[(b >> 18) & 0x3F]);
                        encoded.push_back(base64_chars[(b >> 12) & 0x3F]);
                        encoded.push_back((i + 1 < memory_data.size()) ? base64_chars[(b >> 6) & 0x3F] : '=');
                        encoded.push_back((i + 2 < memory_data.size()) ? base64_chars[b & 0x3F] : '=');
                    }

                    // Format address for response
                    char addr_buf[32];
                    snprintf(addr_buf, sizeof(addr_buf), "0x%x", static_cast<unsigned int>(address));

                    JsonParser::AddToObject(*body, "address", std::make_shared<JsonValue>(addr_buf));
                    JsonParser::AddToObject(*body, "data", std::make_shared<JsonValue>(encoded));

                    if (!read_success) {
                        JsonParser::AddToObject(*body, "unreadableBytes", std::make_shared<JsonValue>(count - bytes_read));
                    }

                    SPDBG_LOG("[SM] DAP ReadMemory - Read %d bytes from 0x%x", bytes_read, address);
                } else {
                    // Nothing readable there. The DAP way to say so is a normal
                    // response carrying only unreadableBytes (SourcePawn 2.0 does
                    // not map the low part of the plugin's address space).
                    char addr_buf[32];
                    snprintf(addr_buf, sizeof(addr_buf), "0x%x", static_cast<unsigned int>(address));
                    JsonParser::AddToObject(*body, "address", std::make_shared<JsonValue>(addr_buf));
                    JsonParser::AddToObject(*body, "unreadableBytes", std::make_shared<JsonValue>(count));
                }
            } else {
                SendErrorResponse(client, request->GetSeq(), "readMemory", "No active debugger");
                return;
            }
        } else {
            SendErrorResponse(client, request->GetSeq(), "readMemory", "No active plugin");
            return;
        }
    } else {
        SendErrorResponse(client, request->GetSeq(), "readMemory", "Invalid memory reference or count");
        return;
    }

    response->SetBody(body);
    SendResponse(client, std::move(response));
}

std::pair<bool, std::string> DAPHandlers::SetVariableValue(const std::string& name, const std::string& value, Debugger* debugger)
{
    if (!debugger || !debugger->active()) {
        return std::make_pair(false, "<no active debugger>");
    }

    SpPluginDebugInfo *debuginfo = SpDebugInfo(debugger->ctx()->GetRuntime());
    if (!debuginfo)
        return {false, "<debug info unavailable>"};
    IDebugSymbolIterator* symbol_iterator = debuginfo->CreateSymbolIterator(debugger->cip());

    while (!symbol_iterator->Done()) {
        const SourcePawn::IDebugSymbol* symbol = symbol_iterator->Next();
        if (!symbol) continue;

        if (symbol->name() && std::string(symbol->name()) == name) {
            // Shared resolver (see sp::ResolveSymbolAddress): frame-relative for
            // locals/arguments, plus the dereference a by-reference symbol
            // needs. Doing the arithmetic inline here skipped that dereference,
            // so editing a by-ref argument overwrote the reference cell rather
            // than the value it points at.
            cell_t address;
            if (!sp::ResolveSymbolAddress(debugger, symbol, &address)) {
                debuginfo->DestroySymbolIterator(symbol_iterator);
                return std::make_pair(false, "<address resolution failed: " + name + ">");
            }

            // Convert string value to cell_t
            cell_t new_value;
            // Handle different value types
            if (value == "true" || value == "1") {
                new_value = 1;
            } else if (value == "false" || value == "0") {
                new_value = 0;
            } else if (value.find('.') != std::string::npos) {
                // Float value - convert float to cell_t representation
                char* endptr;
                float float_val = strtof(value.c_str(), &endptr);
                if (endptr == value.c_str() || *endptr != '\0') {
                    return std::make_pair(false, "<invalid float value: " + value + ">");
                }
                // Use memcpy to reinterpret float bits as cell_t
                static_assert(sizeof(float) == sizeof(cell_t), "Float and cell_t size mismatch");
                memcpy(&new_value, &float_val, sizeof(cell_t));
            } else {
                // Integer value
                char* endptr;
                long long_val = strtol(value.c_str(), &endptr, 10);
                if (endptr == value.c_str() || *endptr != '\0') {
                    return std::make_pair(false, "<invalid integer value: " + value + ">");
                }
                new_value = static_cast<cell_t>(long_val);
            }

            // Write the value to memory
            cell_t* phys_addr;
            if (debugger->ctx() && SpLocalToPhys(debugger->ctx(), address, sizeof(cell_t), &phys_addr) == SP_ERROR_NONE) {
                *phys_addr = new_value;

                // Verify the write by reading back
                std::string result_value = GetVariableValue(symbol, debuginfo, debugger);
                return std::make_pair(true, result_value);
            } else {
                return std::make_pair(false, "<error writing to memory>");
            }
        }
    }

    return std::make_pair(false, "<variable not found: " + name + ">");
}

std::pair<bool, std::string>
DAPHandlers::SetArrayElement(ClientConnection* client, int var_ref,
                             const std::string& name, const std::string& value,
                             Debugger* debugger)
{
    if (!debugger || !debugger->active() || !client->variable_handles)
        return {false, "<no active session>"};

    VariableHandle vh;
    if (!client->variable_handles->Get(var_ref, vh))
        return {false, "<stale variablesReference>"};

    // name is already validated as "[N]" by the caller.
    std::string idx_str = name.substr(1, name.size() - 2);
    char* endp = nullptr;
    long idx_l = strtol(idx_str.c_str(), &endp, 10);
    if (endp == idx_str.c_str() || *endp != '\0' || idx_l < 0)
        return {false, "<invalid index: " + name + ">"};
    const cell_t index = static_cast<cell_t>(idx_l);

    SpPluginDebugInfo* debuginfo = SpDebugInfo(debugger->ctx()->GetRuntime());
    if (!debuginfo)
        return {false, "<debug info unavailable>"};
    IDebugSymbolIterator* it = debuginfo->CreateSymbolIterator(debugger->cip());
    const SourcePawn::IDebugSymbol* parent = nullptr;
    while (!it->Done()) {
        const SourcePawn::IDebugSymbol* sym = it->Next();
        if (sym && sym->name() && std::string(sym->name()) == vh.rootSymbolName) {
            parent = sym;
            break;
        }
    }
    if (!parent) {
        debuginfo->DestroySymbolIterator(it);
        return {false, "<parent symbol not found: " + vh.rootSymbolName + ">"};
    }

    const SourcePawn::ISymbolType* ptype = parent->type();
    const bool is_float = ptype && ptype->isFloat32();

    // Parse the value string to a cell, mirroring SetVariableValue's logic.
    cell_t new_value;
    if (value == "true") {
        new_value = 1;
    } else if (value == "false") {
        new_value = 0;
    } else if (value.find('.') != std::string::npos) {
        char* ep;
        float fv = strtof(value.c_str(), &ep);
        if (ep == value.c_str() || *ep != '\0') {
            debuginfo->DestroySymbolIterator(it);
            return {false, "<invalid float: " + value + ">"};
        }
        memcpy(&new_value, &fv, sizeof(cell_t));
    } else {
        char* ep;
        long lv = strtol(value.c_str(), &ep, 10);
        if (ep == value.c_str() || *ep != '\0') {
            debuginfo->DestroySymbolIterator(it);
            return {false, "<invalid int: " + value + ">"};
        }
        // If the element is a float-typed array, fold the integer to a float
        // so VS Code's typed-edit ("42" on a float[]) doesn't write garbage.
        if (is_float) {
            float fv = static_cast<float>(lv);
            memcpy(&new_value, &fv, sizeof(cell_t));
        } else {
            new_value = static_cast<cell_t>(lv);
        }
    }

    // The index must be inside the array the client asked about. Without this
    // check the only limit is "somewhere in the plugin's data section", which
    // turns an edit in the Variables panel into a write-anywhere primitive over
    // the wire. dimension(0) is the declared element count.
    const uint32_t declared_length = (ptype && ptype->isArray()) ? ptype->dimension(0) : 0;
    if (declared_length > 0 && static_cast<uint32_t>(index) >= declared_length) {
        debuginfo->DestroySymbolIterator(it);
        return {false, "<index " + std::to_string(index) + " out of bounds (length " +
                           std::to_string(declared_length) + ")>"};
    }

    // Effective base address (the FIRST element), via the one shared resolver.
    cell_t base = 0;
    if (!sp::ResolveSymbolAddress(debugger, parent, &base)) {
        debuginfo->DestroySymbolIterator(it);
        return {false, "<reference resolution failed>"};
    }

    // Element addressing is byte-stride (matches GetSymbolValue): cell_t arrays
    // use sizeof(cell_t), char arrays / strings use sizeof(char).
    const uint32_t element_size = (ptype && ptype->isString()) ? sizeof(char) : sizeof(cell_t);
    const cell_t addr = base + static_cast<cell_t>(index * element_size);

    char buf[64];
    if (element_size == sizeof(char)) {
        // One character. Writing a whole cell here would clobber the three
        // neighbouring characters of the string, so patch the byte inside the
        // cell that contains it (little-endian data section, as everywhere else).
        const cell_t cell_addr = addr - (addr % static_cast<cell_t>(sizeof(cell_t)));
        const int byte_in_cell = static_cast<int>(addr % static_cast<cell_t>(sizeof(cell_t)));
        cell_t* cell = nullptr;
        if (SpLocalToPhys(debugger->ctx(), cell_addr, sizeof(cell_t), &cell) != SP_ERROR_NONE || !cell) {
            debuginfo->DestroySymbolIterator(it);
            return {false, "<element address out of range>"};
        }
        uint8_t* bytes = reinterpret_cast<uint8_t*>(cell);
        bytes[byte_in_cell] = static_cast<uint8_t>(new_value & 0xFF);
        snprintf(buf, sizeof(buf), "%d", (int)bytes[byte_in_cell]);
        debuginfo->DestroySymbolIterator(it);
        return {true, std::string(buf)};
    }

    cell_t* phys = nullptr;
    if (SpLocalToPhys(debugger->ctx(), addr, sizeof(cell_t), &phys) != SP_ERROR_NONE || !phys) {
        debuginfo->DestroySymbolIterator(it);
        return {false, "<element address out of range>"};
    }
    *phys = new_value;

    if (is_float) {
        float fv;
        memcpy(&fv, phys, sizeof(float));
        snprintf(buf, sizeof(buf), "%g", fv);
    } else {
        snprintf(buf, sizeof(buf), "%d", (int)*phys);
    }
    debuginfo->DestroySymbolIterator(it);
    return {true, std::string(buf)};
}