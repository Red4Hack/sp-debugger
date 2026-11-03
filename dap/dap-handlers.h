/**
 * vim: set ts=4 :
 * =============================================================================
 * SourceMod Console Debugger Extension
 * Copyright (C) 2018-2021 Peace-Maker  All rights reserved.
 * =============================================================================
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License, version 3.0, as published by the
 * Free Software Foundation.
 * 
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * As a special exception, AlliedModders LLC gives you permission to link the
 * code of this program (as well as its derivative works) to "Half-Life 2," the
 * "Source Engine," the "SourcePawn JIT," and any Game MODs that run on software
 * by the Valve Corporation.  You must obey the GNU General Public License in
 * all respects for all other code used.  Additionally, AlliedModders LLC grants
 * this exception to all derivative works.  AlliedModders LLC defines further
 * exceptions, found in LICENSE.txt (as of this writing, version JULY-31-2007),
 * or <http://www.sourcemod.net/license.php>.
 *
 * Version: $Id$
 */

#ifndef _INCLUDE_DAP_HANDLERS_H
#define _INCLUDE_DAP_HANDLERS_H

#include <string>
#include "plugin-debug-info.h"
#include <memory>
#include "tcp-server.h"

class DapBridge;
class DAPRequest;
class DAPResponse;
class Debugger;

class DAPHandlers {
public:
    DAPHandlers(DapBridge* debugger_ext);
    ~DAPHandlers();
    
    void HandleRequest(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    
private:
    // Core DAP commands
    void HandleInitialize(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleLaunch(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleAttach(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleConfigurationDone(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleDisconnect(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleTerminate(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    
    // Breakpoint commands
    void HandleSetBreakpoints(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleSetExceptionBreakpoints(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    
    // Execution control commands
    void HandleContinue(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleNext(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleStepIn(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleStepOut(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandlePause(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    
    // Stack and variable inspection commands
    void HandleThreads(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleStackTrace(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleScopes(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleVariables(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleSetVariable(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    
    // Expression evaluation
    void HandleEvaluate(ClientConnection* client, std::unique_ptr<DAPRequest> request);

    // Data breakpoints (watchpoints) and memory
    void HandleSetDataBreakpoints(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleDataBreakpointInfo(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleReadMemory(ClientConnection* client, std::unique_ptr<DAPRequest> request);

    // Function-timing profiler (custom DAP commands). Start resets+enables VM
    // profiling; Stop disables it and returns the accumulated call tree.
    void HandleProfileStart(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandleProfileStop(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    void HandlePerformance(ClientConnection* client, std::unique_ptr<DAPRequest> request);

    // Returns details (message) of the exception the debugged plugin is stopped
    // on, for VS Code's exception widget.
    void HandleExceptionInfo(ClientConnection* client, std::unique_ptr<DAPRequest> request);

    // Helper methods
    void SendResponse(ClientConnection* client, std::unique_ptr<DAPResponse> response);
    // Emit a DAP "continued" event to the client. MUST be called before
    // SetRunmode() wakes the VM thread, otherwise the VM can emit "stopped"
    // first and the adapter ends up stuck in the running state with a paused UI.
    void SendContinuedEvent(ClientConnection* client);
    void SendErrorResponse(ClientConnection* client, uint32_t seq, const std::string& command, const std::string& error);
    std::string ExtractPluginName(const std::string& program_path);
    const char* path_basename(const char* path);
    
    // Variable inspection helpers
    // Session lookup, in the three flavours the handlers actually need. They
    // used to be copy-pasted into every handler, which is how they drifted.
    //   BoundDebugger      -- the plugin this client launched/attached to, if
    //                         its session is active; nullptr otherwise.
    //   AnyActiveDebugger  -- the first active session, whatever the plugin.
    //   ActiveDebuggerFor  -- bound first, then any active (the usual fallback).
    Debugger* BoundDebugger(ClientConnection* client);
    Debugger* AnyActiveDebugger();
    Debugger* ActiveDebuggerFor(ClientConnection* client);

    std::string GetVariableValue(const SourcePawn::IDebugSymbol* symbol, SpPluginDebugInfo* debuginfo, Debugger* debugger);
    std::string GetVariableTypeName(const SourcePawn::IDebugSymbol* symbol, SpPluginDebugInfo* debuginfo, Debugger* debugger);
    std::string EvaluateExpression(const std::string& expression, Debugger* debugger);
    std::pair<bool, std::string> SetVariableValue(const std::string& name, const std::string& value, Debugger* debugger);
    // setVariable on an aggregate child named "[N]" -- the VS Code "edit value"
    // path inside an expanded array. Routes name="[N]" + parent handle to a
    // direct element write, since SetVariableValue only knows top-level names.
    std::pair<bool, std::string> SetArrayElement(ClientConnection* client,
                                                 int var_ref,
                                                 const std::string& name,
                                                 const std::string& value,
                                                 Debugger* debugger);
    
private:
    DapBridge* debugger_ext_;
};

#endif // _INCLUDE_DAP_HANDLERS_H