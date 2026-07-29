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

#ifndef _INCLUDE_TCP_SERVER_H
#define _INCLUDE_TCP_SERVER_H

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <thread>
#include <mutex>
#include <atomic>
#include <functional>
#include <chrono>
#include "sp_vm_api.h"
#include "smsdk_ext.h"
#include "variable-handles.h"

// Buffer limits to prevent DoS attacks
constexpr size_t MAX_RECEIVE_BUFFER_SIZE = 10 * 1024 * 1024;  // 10MB max buffer
constexpr size_t MAX_DAP_MESSAGE_SIZE = 5 * 1024 * 1024;       // 5MB max single message

// How long a client may stay connected without authenticating, when the
// listener requires a token. Generous enough for a slow editor handshake,
// short enough that unauthenticated sockets cannot pile up.
constexpr int kAuthGraceSeconds = 15;

// Longest a client thread blocks in select() before re-checking the shutdown
// and auth-timeout conditions. Data wakes it immediately -- this is only the
// idle tick.
constexpr int kClientPollMs = 50;

// Same idea for the accept loop: the bound on how long Stop() waits for the
// accept thread to notice it should exit.
constexpr int kAcceptPollMs = 100;

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET socket_t;
#define INVALID_SOCKET_VALUE INVALID_SOCKET
#define SOCKET_ERROR_VALUE SOCKET_ERROR
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
typedef int socket_t;
#define INVALID_SOCKET_VALUE -1
#define SOCKET_ERROR_VALUE -1
#define closesocket close
#endif

class DebugSession;

// One breakpoint as requested by the client, cached so it can be replayed
// against a freshly recompiled plugin context after `sm plugins refresh` /
// reload. Lines are stored exactly as received over DAP (1-based).
struct CachedBreakpoint {
    int line;
    std::string condition;
    std::string logMessage;
    std::string hitCondition;
};

struct ClientConnection {
    socket_t socket;
    std::string remote_addr;
    uint16_t remote_port;
    std::unique_ptr<DebugSession> session;
    std::atomic<bool> active;
    std::string receive_buffer;
    // Bytes still to discard from an oversized message body. Without this the
    // tail of a rejected body would be re-read as the next message's header and
    // desync the stream for the rest of the connection.
    size_t skip_bytes = 0;
    // Authentication (see DapBridge::Start). When the listener requires a token
    // every request except "initialize"/"disconnect" is refused until the client
    // presents it, and a client that never does is dropped after
    // kAuthGraceSeconds so an idle unauthenticated socket cannot linger.
    std::atomic<bool> authenticated{false};
    std::chrono::steady_clock::time_point connected_at{std::chrono::steady_clock::now()};
    IPlugin* active_plugin;
    // Filename (IPlugin::GetFilename(), e.g. "foo.smx") of the plugin being
    // debugged. Survives a reload so we can rebind active_plugin -- which
    // becomes a dangling pointer the instant the plugin is unloaded -- to the
    // new IPlugin instance once it loads again.
    std::string active_plugin_name;
    bool pending_stopped_event;
    // Last breakpoints set per source path, kept so they can be re-applied to
    // the new plugin context after a reload (the per-context BreakpointManager
    // is destroyed with the old context).
    std::map<std::string, std::vector<CachedBreakpoint>> breakpoint_cache;
    // Maps DAP variablesReference handles to expandable variables for this
    // client. Cleared whenever the debuggee resumes execution.
    std::unique_ptr<VariableHandleRegistry> variable_handles;
    // The thread serving this connection, and the flag its last statement sets.
    // The server OWNS this thread (it used to be detached) because the extension
    // can be unloaded -- at `sm exts unload` or at server shutdown -- and a
    // detached thread still inside ClientThread would then be executing code in
    // a .so that no longer exists. Stop() joins every one of these before it
    // returns; the accept loop reaps the finished ones as it goes.
    std::thread thread;
    std::atomic<bool> finished{false};

    ClientConnection(socket_t sock, const std::string& addr, uint16_t port)
        : socket(sock), remote_addr(addr), remote_port(port), active(true), active_plugin(nullptr), pending_stopped_event(false),
          variable_handles(std::make_unique<VariableHandleRegistry>()) {}
};

// Callback type for notification when last client disconnects
using ClientDisconnectCallback = std::function<void()>;

class TcpServer {
public:
    TcpServer();
    ~TcpServer();

    // bind_address is an IPv4 literal ("127.0.0.1", "0.0.0.0", ...); anything
    // unparsable is rejected rather than silently widened. require_auth mirrors
    // "a token is configured" and makes the client threads enforce the
    // authentication grace period.
    bool Start(const std::string& bind_address, uint16_t port, size_t max_clients,
               bool require_auth);
    void Stop();
    bool IsRunning() const { return running_; }
    
    void SetMessageHandler(std::function<void(ClientConnection*, const std::string&)> handler) {
        message_handler_ = handler;
    }
    
    void SetExtension(void* ext) {
        extension_ = ext;
    }
    
    void SendMessage(ClientConnection* client, const std::string& message);
    void BroadcastMessage(const std::string& message);
    void DisconnectClient(ClientConnection* client);
    
    size_t GetClientCount() const;
    std::vector<ClientConnection*> GetClients() const;

    // Register callback for when last client disconnects
    void SetLastClientDisconnectCallback(ClientDisconnectCallback callback);

    bool SendDataToSocket(socket_t socket, const std::string& data);

private:
    void AcceptThread();
    void ClientThread(std::shared_ptr<ClientConnection> client);
    bool SetSocketNonBlocking(socket_t socket);
    std::string ReceiveMessage(std::shared_ptr<ClientConnection> client);
    bool SendData(socket_t socket, const std::string& data);
    bool WaitForWritable(socket_t socket, int timeout_ms);
    bool WaitForReadable(socket_t socket, int timeout_ms);
    void CleanupClient(std::shared_ptr<ClientConnection> client);
    void ReapFinishedClients();
    
#ifdef _WIN32
    bool InitializeWinsock();
    void CleanupWinsock();
#endif

private:
    socket_t server_socket_;
    uint16_t port_;
    std::string bind_address_;
    size_t max_clients_ = 4;
    bool require_auth_ = false;
    std::atomic<bool> running_;
    std::thread accept_thread_;
    
    mutable std::mutex clients_mutex_;
    std::vector<std::shared_ptr<ClientConnection>> clients_;
    // Connections whose thread has ended (or is ending) but has not been joined
    // yet. CleanupClient moves the entry here so client counts stay honest while
    // the thread object survives long enough to be joined.
    std::vector<std::shared_ptr<ClientConnection>> finished_clients_;

    // Serialises ALL socket writes (SendData). DAP responses are sent from the
    // TCP thread while stopped/output/continued events are sent from the VM
    // (main) thread; without this, two messages' bytes interleave on the wire
    // and corrupt the framed stream, so the client drops/mismatches responses.
    std::mutex write_mutex_;

    std::function<void(ClientConnection*, const std::string&)> message_handler_;
    void* extension_;

    // Callback and mutex for last client disconnect notification
    ClientDisconnectCallback last_client_disconnect_callback_;
    mutable std::mutex callback_mutex_;
    
#ifdef _WIN32
    static bool winsock_initialized_;
    static int winsock_ref_count_;
    static std::mutex winsock_mutex_;
#endif
};

class DebugSession {
public:
    DebugSession(ClientConnection* connection, TcpServer* server, void* ext);
    ~DebugSession();
    
    void ProcessMessage(const std::string& message);
    void SendResponse(const std::string& response);
    void SendEvent(const std::string& event);
    
    bool IsActive() const { return active_; }
    void SetActive(bool active) { active_ = active; }
    
    ClientConnection* GetConnection() const { return connection_; }

private:
    void HandleDAPMessage(const std::string& message);
    std::string CreateDAPResponse(const std::string& command, bool success, const std::string& body = "");
    std::string CreateDAPEvent(const std::string& event, const std::string& body);

private:
    ClientConnection* connection_;
    TcpServer* server_;
    void* extension_;
    std::atomic<bool> active_;
    uint32_t next_seq_;
    std::mutex send_mutex_;
    SourcePawn::IPluginContext* active_context_;
};

#endif // _INCLUDE_TCP_SERVER_H