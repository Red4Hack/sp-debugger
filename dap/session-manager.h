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

#ifndef _INCLUDE_SESSION_MANAGER_H
#define _INCLUDE_SESSION_MANAGER_H

#include <string>
#include <memory>
#include "tcp-server.h"

class DapBridge;
class DAPRequest;
class DAPResponse;

class SessionManager {
public:
    SessionManager(DapBridge* debugger_ext);
    ~SessionManager();
    
    void HandleDAPMessage(ClientConnection* client, const std::string& message);
    void SendDAPResponse(ClientConnection* client, std::unique_ptr<DAPResponse> response);
    void SendDAPError(ClientConnection* client, uint32_t seq, const std::string& command, const std::string& error_message);
    void SendDAPEvent(ClientConnection* client, const std::string& event_type, const std::string& body = "");
    
private:
    bool ValidateMessage(const std::string& message);
    void ProcessRequest(ClientConnection* client, std::unique_ptr<DAPRequest> request);
    
private:
    DapBridge* debugger_ext_;
};

#endif // _INCLUDE_SESSION_MANAGER_H