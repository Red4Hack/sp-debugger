/**
 * vim: set ts=4 :
 * =============================================================================
 * SourceMod Console Debugger Extension
 * Copyright (C) 2018-2021 Peace-Maker  All rights reserved.
 * =============================================================================
 */

#include "session-manager.h"
#include "dap-handlers.h"
#include "json-utils.h"
#include "dap-bridge.h"
#include "smsdk_ext.h"

SessionManager::SessionManager(DapBridge* debugger_ext)
    : debugger_ext_(debugger_ext)
{
}

SessionManager::~SessionManager()
{
}

void SessionManager::HandleDAPMessage(ClientConnection* client, const std::string& message)
{
    SPDBG_LOG("[SM] Processing DAP message from %s:%d",
                             client->remote_addr.c_str(), client->remote_port);
    SPDBG_LOG("[SM] DAP raw message: %s", message.c_str());
    
    if (!ValidateMessage(message)) {
        return;
    }
    
    auto dap_message = DAPMessage::FromJson(message);
    if (!dap_message) {
        rootconsole->ConsolePrint("[SM] Invalid DAP message received from client");
        return;
    }

    if (dap_message->GetType() == DAPMessage::Type::Request) {
        auto request = std::unique_ptr<DAPRequest>(static_cast<DAPRequest*>(dap_message.release()));
        ProcessRequest(client, std::move(request));
    }
}

void SessionManager::SendDAPResponse(ClientConnection* client, std::unique_ptr<DAPResponse> response)
{
    if (client->session) {
        client->session->SendResponse(response->ToJson());
    }
}

void SessionManager::SendDAPError(ClientConnection* client, uint32_t seq, const std::string& command, const std::string& error_message)
{
    auto response = std::make_unique<DAPResponse>(seq + 1, seq, command, false);
    response->SetMessage(error_message);
    
    SendDAPResponse(client, std::move(response));
    rootconsole->ConsolePrint("[SM] DAP Error sent: %s", error_message.c_str());
}

void SessionManager::SendDAPEvent(ClientConnection* client, const std::string& event_type, const std::string& body)
{
    // TODO: Implement event sending
    if (client->session) {
        // Format and send DAP event
    }
}

bool SessionManager::ValidateMessage(const std::string& message)
{
    // Basic message validation
    if (message.empty()) {
        rootconsole->ConsolePrint("[SM] Empty DAP message received from client");
        return false;
    }
    
    if (message.size() > 65536) { // 64KB limit
        rootconsole->ConsolePrint("[SM] DAP message too large: %zu bytes", message.size());
        return false;
    }
    
    return true;
}

void SessionManager::ProcessRequest(ClientConnection* client, std::unique_ptr<DAPRequest> request)
{
    const std::string& command = request->GetCommand();
    SPDBG_LOG("[SM] DAP Request: %s", command.c_str());
    
    DAPHandlers handlers(debugger_ext_);
    handlers.HandleRequest(client, std::move(request));
}