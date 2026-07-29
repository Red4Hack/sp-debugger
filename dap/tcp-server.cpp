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

#include "tcp-server.h"
#include "dap-bridge.h"
#include <iostream>
#include <sstream>
#include <algorithm>
#include <chrono>
#include <cstring>

#ifndef _WIN32
#include <poll.h>
#endif

// MSG_DONTWAIT is a POSIX per-call non-blocking flag that Winsock/MSVC does not
// define. Client sockets are already switched to non-blocking mode via
// SetSocketNonBlocking() (FIONBIO on Windows), so recv() never blocks regardless
// of this flag; on Windows we compile it out to 0.
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0
#endif

// Gated diagnostic stream: TCPLOG << ... behaves like std::cout when verbose
// logging is enabled (cfg "debug_log" "1"), and discards everything otherwise.
// Genuine errors keep using std::cerr so they always surface.
static std::ostream& sp_nulllog() {
    static std::ostream s(nullptr);
    return s;
}
#define TCPLOG (g_DebugLogging ? std::cout : sp_nulllog())

#ifdef _WIN32
bool TcpServer::winsock_initialized_ = false;
int TcpServer::winsock_ref_count_ = 0;
std::mutex TcpServer::winsock_mutex_;
#endif

TcpServer::TcpServer() 
    : server_socket_(INVALID_SOCKET_VALUE)
    , port_(0)
    , running_(false)
    , extension_(nullptr)
{
#ifdef _WIN32
    InitializeWinsock();
#endif
}

TcpServer::~TcpServer() {
    Stop();
#ifdef _WIN32
    CleanupWinsock();
#endif
}

#ifdef _WIN32
bool TcpServer::InitializeWinsock() {
    std::lock_guard<std::mutex> lock(winsock_mutex_);
    
    if (winsock_ref_count_ == 0) {
        WSADATA wsaData;
        int result = WSAStartup(MAKEWORD(2, 2), &wsaData);
        if (result != 0) {
            std::cerr << "WSAStartup failed: " << result << std::endl;
            return false;
        }
        winsock_initialized_ = true;
    }
    
    winsock_ref_count_++;
    return true;
}

void TcpServer::CleanupWinsock() {
    std::lock_guard<std::mutex> lock(winsock_mutex_);
    
    winsock_ref_count_--;
    if (winsock_ref_count_ == 0 && winsock_initialized_) {
        WSACleanup();
        winsock_initialized_ = false;
    }
}
#endif

bool TcpServer::Start(const std::string& bind_address, uint16_t port, size_t max_clients,
                      bool require_auth) {
    if (running_) {
        return false;
    }

    port_ = port;
    bind_address_ = bind_address;
    max_clients_ = max_clients > 0 ? max_clients : 1;
    require_auth_ = require_auth;

    server_socket_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server_socket_ == INVALID_SOCKET_VALUE) {
        std::cerr << "Failed to create server socket" << std::endl;
        return false;
    }
    
    int reuse = 1;
    if (setsockopt(server_socket_, SOL_SOCKET, SO_REUSEADDR, 
                   reinterpret_cast<const char*>(&reuse), sizeof(reuse)) < 0) {
        std::cerr << "Failed to set SO_REUSEADDR" << std::endl;
        closesocket(server_socket_);
        server_socket_ = INVALID_SOCKET_VALUE;
        return false;
    }
    
    sockaddr_in server_addr = {};
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(port_);
    // Bind exactly where we were told to. A typo must not fall back to
    // INADDR_ANY -- that would silently publish the debugger to the network,
    // which is the one outcome the configuration exists to prevent.
    if (inet_pton(AF_INET, bind_address_.c_str(), &server_addr.sin_addr) != 1) {
        std::cerr << "Invalid bind address '" << bind_address_ << "'" << std::endl;
        closesocket(server_socket_);
        server_socket_ = INVALID_SOCKET_VALUE;
        return false;
    }

    if (bind(server_socket_, reinterpret_cast<sockaddr*>(&server_addr), 
             sizeof(server_addr)) == SOCKET_ERROR_VALUE) {
        std::cerr << "Failed to bind to port " << port_ << std::endl;
        closesocket(server_socket_);
        server_socket_ = INVALID_SOCKET_VALUE;
        return false;
    }
    
    if (listen(server_socket_, 5) == SOCKET_ERROR_VALUE) {
        std::cerr << "Failed to listen on socket" << std::endl;
        closesocket(server_socket_);
        server_socket_ = INVALID_SOCKET_VALUE;
        return false;
    }

    // The listener must be non-blocking, or Stop() cannot end the accept thread:
    // closing a socket does NOT reliably wake another thread parked in accept(),
    // so the join() below it would wait forever -- and Stop() runs on the GAME
    // thread during `sm exts unload/reload`, freezing the whole server. With a
    // non-blocking listener the accept loop polls and notices running_ == false.
    SetSocketNonBlocking(server_socket_);
    
    running_ = true;
    accept_thread_ = std::thread(&TcpServer::AcceptThread, this);
    
    TCPLOG << "TCP Server listening on port " << port_ << std::endl;
    return true;
}

void TcpServer::Stop() {
    if (!running_) {
        return;
    }
    
    running_ = false;
    
    if (server_socket_ != INVALID_SOCKET_VALUE) {
        closesocket(server_socket_);
        server_socket_ = INVALID_SOCKET_VALUE;
    }
    
    if (accept_thread_.joinable()) {
        accept_thread_.join();
    }
    
    // Tell every client thread to stop, then WAIT for them. This is the whole
    // point of owning the threads: Stop() runs while the extension is being
    // unloaded (`sm exts unload`, or SourceMod shutting down on a server
    // restart), and the moment it returns the .so can be gone. A client thread
    // still inside ClientThread would then run code that no longer exists --
    // which is exactly the SIGSEGV seen when restarting a server with an editor
    // still attached.
    std::vector<std::shared_ptr<ClientConnection>> to_join;
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        for (auto& client : clients_) {
            if (client->active) {
                client->active = false;
                closesocket(client->socket);
            }
        }
        to_join.swap(clients_);
        for (auto& client : finished_clients_)
            to_join.push_back(client);
        finished_clients_.clear();
    }
    // Join outside the lock: a client thread finishing right now takes
    // clients_mutex_ in CleanupClient, and holding it here would deadlock.
    for (auto& client : to_join) {
        if (client->thread.joinable())
            client->thread.join();
    }

    TCPLOG << "TCP Server stopped" << std::endl;
}

// Join client threads that have run to completion. Called from the accept loop
// (never from a client thread -- a thread cannot join itself).
void TcpServer::ReapFinishedClients() {
    std::vector<std::shared_ptr<ClientConnection>> done;
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        auto it = std::remove_if(finished_clients_.begin(), finished_clients_.end(),
            [](const std::shared_ptr<ClientConnection>& c) { return c && c->finished; });
        done.assign(std::make_move_iterator(it), std::make_move_iterator(finished_clients_.end()));
        finished_clients_.erase(it, finished_clients_.end());
    }
    for (auto& client : done) {
        if (client->thread.joinable())
            client->thread.join();
    }
}

void TcpServer::AcceptThread() {
    while (running_) {
        // Wait for a pending connection rather than blocking in accept(), so
        // this loop re-checks running_ at least every kAcceptPollMs and Stop()
        // can join it promptly.
        if (!WaitForReadable(server_socket_, kAcceptPollMs))
            continue;

        sockaddr_in client_addr = {};
        socklen_t addr_len = sizeof(client_addr);

        socket_t client_socket = accept(server_socket_,
                                      reinterpret_cast<sockaddr*>(&client_addr),
                                      &addr_len);

        if (client_socket == INVALID_SOCKET_VALUE) {
            // "No pending connection" is the normal outcome of a non-blocking
            // accept that raced the poll above; only real errors are worth a line.
#ifdef _WIN32
            const int error = WSAGetLastError();
            const bool would_block = (error == WSAEWOULDBLOCK);
#else
            const int error = errno;
            const bool would_block = (error == EAGAIN || error == EWOULDBLOCK);
#endif
            if (running_ && !would_block) {
                std::cerr << "Failed to accept client connection" << std::endl;
            }
            continue;
        }
        
        if (!running_) {
            closesocket(client_socket);
            break;
        }

        // Cap concurrent sessions: one editor needs one connection, and each
        // accepted socket costs a detached thread plus its buffers. Without a
        // cap, anyone who can reach the port can exhaust both.
        {
            std::lock_guard<std::mutex> lock(clients_mutex_);
            if (clients_.size() >= max_clients_) {
                std::cerr << "[TCP] Refusing connection: already at max_clients ("
                          << max_clients_ << ")" << std::endl;
                closesocket(client_socket);
                continue;
            }
        }

        // Increase socket send buffer size to handle large DAP messages (e.g., variables, stackTrace)
        int send_buffer_size = 256 * 1024; // 256KB
        if (setsockopt(client_socket, SOL_SOCKET, SO_SNDBUF,
                       reinterpret_cast<const char*>(&send_buffer_size), sizeof(send_buffer_size)) < 0) {
            std::cerr << "[TCP] Warning: Failed to set SO_SNDBUF to " << send_buffer_size << std::endl;
        }

        // Disable Nagle's algorithm. DAP is a chatty request/response protocol
        // with many small messages; with Nagle on (and the peer's delayed ACKs)
        // each tiny message can sit buffered for tens of milliseconds, which is
        // what makes a remote debug session feel sluggish. We always send whole
        // framed messages, so Nagle buys us nothing.
        int nodelay = 1;
        if (setsockopt(client_socket, IPPROTO_TCP, TCP_NODELAY,
                       reinterpret_cast<const char*>(&nodelay), sizeof(nodelay)) < 0) {
            std::cerr << "[TCP] Warning: Failed to set TCP_NODELAY" << std::endl;
        }

        char client_ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);
        uint16_t client_port = ntohs(client_addr.sin_port);
        
        auto client = std::make_shared<ClientConnection>(client_socket, client_ip, client_port);
        client->session = std::make_unique<DebugSession>(client.get(), this, extension_);
        
        {
            std::lock_guard<std::mutex> lock(clients_mutex_);
            clients_.push_back(client);
            client->thread = std::thread(&TcpServer::ClientThread, this, client);
        }
        // Join whatever finished since the last connection, so ended threads do
        // not accumulate while the server runs.
        ReapFinishedClients();
        
        // Connection notices stay visible regardless of debug_log: they are
        // low-volume and useful to confirm the debugger client attached.
        std::cout << "Client connected: " << client_ip << ":" << client_port << std::endl;
    }
}

void TcpServer::ClientThread(std::shared_ptr<ClientConnection> client) {
    TCPLOG << "[TCP] Starting client thread for " << client->remote_addr << ":" << client->remote_port << std::endl;
    SetSocketNonBlocking(client->socket);
    
    while (running_ && client->active) {
        std::string message = ReceiveMessage(client);
        
        if (message.empty()) {
            // Check if socket is still connected
            char test_byte;
            int result = recv(client->socket, &test_byte, 1, MSG_PEEK | MSG_DONTWAIT);
            if (result == 0) {
                // Connection closed by client
                TCPLOG << "[TCP] Client " << client->remote_addr << ":" << client->remote_port << " closed connection" << std::endl;
                client->active = false;
                break;
            } else if (result < 0) {
                // Winsock reports errors via WSAGetLastError(), not errno; a
                // non-blocking peek with no data yields WSAEWOULDBLOCK, which is
                // not an error -- treating it as one would disconnect immediately.
#ifdef _WIN32
                int error = WSAGetLastError();
                if (error != WSAEWOULDBLOCK) {
                    TCPLOG << "[TCP] Socket error for client " << client->remote_addr << ":" << client->remote_port << " - " << error << std::endl;
                    client->active = false;
                    break;
                }
#else
                int error = errno;
                if (error != EAGAIN && error != EWOULDBLOCK) {
                    TCPLOG << "[TCP] Socket error for client " << client->remote_addr << ":" << client->remote_port << " - " << strerror(error) << std::endl;
                    client->active = false;
                    break;
                }
#endif
            }

            // A client that never authenticates must not hold the slot.
            if (require_auth_ && !client->authenticated &&
                std::chrono::steady_clock::now() - client->connected_at >
                    std::chrono::seconds(kAuthGraceSeconds)) {
                std::cerr << "[TCP] Dropping " << client->remote_addr << ":" << client->remote_port
                          << ": no authentication within " << kAuthGraceSeconds << "s" << std::endl;
                client->active = false;
                break;
            }

            // Block until the socket has data instead of sleeping a fixed
            // interval: a plain sleep added up to that much latency to every
            // request that arrived just after it started, which is exactly what
            // makes stepping and hovering feel sluggish. The timeout is only
            // there to re-check shutdown and the auth deadline.
            WaitForReadable(client->socket, kClientPollMs);
            continue;
        }

        TCPLOG << "[TCP] Received " << message.size() << " bytes from " << client->remote_addr << ":" << client->remote_port << std::endl;
        TCPLOG << "[TCP] Message content: " << message << std::endl;

        // Process message only through session path (message_handler_ was removed to fix duplication bug)
        if (client->session) {
            client->session->ProcessMessage(message);
        }
    }
    
    TCPLOG << "[TCP] Client thread ending for " << client->remote_addr << ":" << client->remote_port << std::endl;
    CleanupClient(client);
    // Last statement: from here the thread only unwinds, so it is safe to reap.
    client->finished = true;
}

bool TcpServer::SetSocketNonBlocking(socket_t socket) {
#ifdef _WIN32
    u_long mode = 1;
    return ioctlsocket(socket, FIONBIO, &mode) == 0;
#else
    int flags = fcntl(socket, F_GETFL, 0);
    if (flags == -1) return false;
    return fcntl(socket, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

// Smaller of two sizes. Spelled out rather than std::min because <windows.h>
// (dragged in by winsock2.h in our own header, before this file gets a say)
// defines a `min` MACRO, which rewrites std::min into std::( ... ) and fails to
// compile on MSVC. Defining NOMINMAX project-wide would work too; a local helper
// keeps the fix where the problem is.
static size_t SmallerOf(size_t a, size_t b) { return a < b ? a : b; }

// Try to extract a single complete DAP message from a client's receive_buffer.
// Returns the message body if one is ready, empty string otherwise. Mutates
// receive_buffer to consume the framing + message bytes.
static std::string ExtractFramedMessage(std::shared_ptr<ClientConnection>& client) {
    // Finish discarding a body we already rejected as oversized. Its bytes are
    // not a header, so they must be consumed by count -- clearing the buffer and
    // hoping would leave the tail to be misread as the next frame.
    if (client->skip_bytes > 0) {
        const size_t drop = SmallerOf(client->skip_bytes, client->receive_buffer.size());
        client->receive_buffer.erase(0, drop);
        client->skip_bytes -= drop;
        if (client->skip_bytes > 0)
            return "";
    }

    size_t header_end = client->receive_buffer.find("\r\n\r\n");
    if (header_end == std::string::npos) return "";

    size_t content_length_pos = client->receive_buffer.find("Content-Length: ");
    if (content_length_pos == std::string::npos || content_length_pos >= header_end) return "";

    content_length_pos += 16; // strlen("Content-Length: ")
    size_t line_end = client->receive_buffer.find("\r\n", content_length_pos);
    if (line_end == std::string::npos) return "";

    std::string length_str = client->receive_buffer.substr(content_length_pos, line_end - content_length_pos);
    // strtoul instead of std::stoul: with -fno-exceptions, a malformed header
    // would otherwise crash the server via std::terminate.
    char* endp = nullptr;
    unsigned long parsed = strtoul(length_str.c_str(), &endp, 10);
    if (endp == length_str.c_str()) return "";
    size_t content_length = static_cast<size_t>(parsed);

    const size_t content_start = header_end + 4;

    if (content_length > MAX_DAP_MESSAGE_SIZE) {
        std::cerr << "[TCP] Message too large: " << content_length
                  << " bytes exceeds max " << MAX_DAP_MESSAGE_SIZE << " bytes. Skipping." << std::endl;
        // Drop the header now and remember how much body is still owed, so the
        // remainder is discarded as it arrives instead of desyncing the stream.
        client->receive_buffer.erase(0, content_start);
        const size_t available = SmallerOf(content_length, client->receive_buffer.size());
        client->receive_buffer.erase(0, available);
        client->skip_bytes = content_length - available;
        return "";
    }

    if (client->receive_buffer.size() < content_start + content_length) return "";

    std::string message = client->receive_buffer.substr(content_start, content_length);
    // erase(), not `buffer = buffer.substr(...)`: the latter copies everything
    // that is left on every single message, which turns a burst of requests
    // (hover storms, setBreakpoints floods) into quadratic work.
    client->receive_buffer.erase(0, content_start + content_length);
    return message;
}

std::string TcpServer::ReceiveMessage(std::shared_ptr<ClientConnection> client) {
    // FIRST drain anything already buffered: a previous recv may have brought
    // in multiple messages in one burst, but only one was returned to the read
    // loop. Without this check the loop falls into its 50ms sleep waiting for
    // more kernel data while the next request sits in receive_buffer -- so a
    // VS Code "hover storm" or rapid setBreakpoints/threads burst gets parceled
    // out one-per-packet instead of being drained immediately.
    {
        std::string pending = ExtractFramedMessage(client);
        if (!pending.empty()) return pending;
    }

    char recv_buffer[4096];
    int bytes_received = recv(client->socket, recv_buffer, sizeof(recv_buffer), MSG_DONTWAIT);

    if (bytes_received > 0) {
        // Check buffer size limit to prevent DoS
        if (client->receive_buffer.size() + bytes_received > MAX_RECEIVE_BUFFER_SIZE) {
            std::cerr << "[TCP] Buffer overflow protection: client " << client->remote_addr
                      << ":" << client->remote_port << " exceeded max buffer size ("
                      << MAX_RECEIVE_BUFFER_SIZE << " bytes). Disconnecting." << std::endl;
            client->active = false;
            client->receive_buffer.clear();
            return "";
        }

        // Append raw bytes by length. The previous `+= std::string(c_str)`
        // truncated at any 0x00 byte in wire data -- DAP JSON shouldn't have
        // embedded nulls, but framing the append by length is unconditionally
        // correct and removes one source of silent data loss.
        client->receive_buffer.append(recv_buffer, bytes_received);

        return ExtractFramedMessage(client);
    }
    
    if (bytes_received == 0) {
        // Connection closed by peer
        TCPLOG << "[TCP] Connection closed by peer " << client->remote_addr << ":" << client->remote_port << std::endl;
        client->active = false;
        return "";
    }
    
#ifdef _WIN32
    if (WSAGetLastError() == WSAEWOULDBLOCK) {
        return "";
    }
#else
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return "";
    }
    
    // Any other error means connection problem
    TCPLOG << "[TCP] Socket error for " << client->remote_addr << ":" << client->remote_port << " - " << strerror(errno) << std::endl;
    client->active = false;
#endif
    
    return "";
}

bool TcpServer::WaitForWritable(socket_t socket, int timeout_ms) {
#ifdef _WIN32
    fd_set write_fds;
    FD_ZERO(&write_fds);
    FD_SET(socket, &write_fds);

    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;

    int result = select(0, nullptr, &write_fds, nullptr, &tv);
    return result > 0;
#else
    struct pollfd pfd;
    pfd.fd = socket;
    pfd.events = POLLOUT;
    pfd.revents = 0;

    int result = poll(&pfd, 1, timeout_ms);
    return result > 0 && (pfd.revents & POLLOUT);
#endif
}

bool TcpServer::WaitForReadable(socket_t socket, int timeout_ms) {
    // Mirror of WaitForWritable: select() on Windows, poll() elsewhere.
#ifdef _WIN32
    fd_set read_fds;
    FD_ZERO(&read_fds);
    FD_SET(socket, &read_fds);

    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;

    int result = select(0, &read_fds, nullptr, nullptr, &tv);
    return result > 0;
#else
    struct pollfd pfd;
    pfd.fd = socket;
    pfd.events = POLLIN;
    pfd.revents = 0;

    int result = poll(&pfd, 1, timeout_ms);
    return result > 0 && (pfd.revents & (POLLIN | POLLHUP | POLLERR));
#endif
}

bool TcpServer::SendData(socket_t socket, const std::string& data) {
    // Serialise the entire write so a message is put on the wire atomically.
    // Responses (TCP thread) and events (VM thread) both reach here; without
    // this lock their bytes interleave and corrupt the DAP framing.
    std::lock_guard<std::mutex> lock(write_mutex_);

    // Format message with DAP headers
    std::string header = "Content-Length: " + std::to_string(data.size()) + "\r\n\r\n";
    std::string full_message = header + data;

    const char* buffer = full_message.c_str();
    size_t total_sent = 0;
    size_t data_size = full_message.size();

    TCPLOG << "[TCP] Sending " << data_size << " bytes (with DAP headers)" << std::endl;
    // Truncate log output for large messages to avoid flooding the console
    if (data.size() > 500) {
        TCPLOG << "[TCP] Send data: " << data.substr(0, 500) << "... (truncated, " << data.size() << " bytes total)" << std::endl;
    } else {
        TCPLOG << "[TCP] Send data: " << data << std::endl;
    }

    const int max_retries = 100;      // Maximum retries for EAGAIN
    const int retry_wait_ms = 50;     // Wait time between retries
    int retry_count = 0;

    while (total_sent < data_size) {
        int bytes_sent = send(socket, buffer + total_sent,
                            static_cast<int>(data_size - total_sent), 0);

        if (bytes_sent == SOCKET_ERROR_VALUE) {
#ifdef _WIN32
            int error = WSAGetLastError();
            if (error == WSAEWOULDBLOCK) {
#else
            int error = errno;
            if (error == EAGAIN || error == EWOULDBLOCK) {
#endif
                // Socket buffer is full, wait for it to become writable
                retry_count++;
                if (retry_count > max_retries) {
                    TCPLOG << "[TCP] Send failed: exceeded max retries (" << max_retries << ") waiting for socket" << std::endl;
                    return false;
                }

                if (!WaitForWritable(socket, retry_wait_ms)) {
                    // Timeout waiting for writability, but not fatal - just retry
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
                continue;
            }

            // Other error - actual failure
#ifdef _WIN32
            TCPLOG << "[TCP] Send failed with error code: " << error << std::endl;
#else
            TCPLOG << "[TCP] Send failed: " << strerror(error) << std::endl;
#endif
            return false;
        }

        // Successfully sent some bytes, reset retry counter
        retry_count = 0;
        total_sent += bytes_sent;

        if (total_sent < data_size) {
            TCPLOG << "[TCP] Partial send: " << bytes_sent << " bytes, "
                      << total_sent << "/" << data_size << " total" << std::endl;
        }
    }

    TCPLOG << "[TCP] Successfully sent " << total_sent << " bytes" << std::endl;
    return true;
}

void TcpServer::SendMessage(ClientConnection* client, const std::string& message) {
    if (!client || !client->active) {
        return;
    }
    
    if (!SendData(client->socket, message)) {
        DisconnectClient(client);
    }
}

void TcpServer::BroadcastMessage(const std::string& message) {
    std::lock_guard<std::mutex> lock(clients_mutex_);
    
    for (auto& client : clients_) {
        if (client->active) {
            SendMessage(client.get(), message);
        }
    }
}

void TcpServer::DisconnectClient(ClientConnection* client) {
    if (!client) {
        TCPLOG << "[TCP] DisconnectClient called with null client" << std::endl;
        return;
    }
    
    if (!client->active) {
        TCPLOG << "[TCP] Client " << client->remote_addr << ":" << client->remote_port << " already inactive" << std::endl;
        return;
    }
    
    TCPLOG << "[TCP] Disconnecting client " << client->remote_addr << ":" << client->remote_port << std::endl;
    client->active = false;
    closesocket(client->socket);
    
    // Counterpart to the "Client connected" notice above; always visible.
    std::cout << "Client disconnected: " << client->remote_addr
              << ":" << client->remote_port << std::endl;
}

void TcpServer::CleanupClient(std::shared_ptr<ClientConnection> client) {
    TCPLOG << "[TCP] Cleaning up client " << client->remote_addr << ":" << client->remote_port << std::endl;

    DisconnectClient(client.get());

    // Phase 1: Remove client and check if was last one (inside mutex)
    bool was_last_client = false;
    {
        std::lock_guard<std::mutex> lock(clients_mutex_);
        size_t initial_size = clients_.size();

        clients_.erase(std::remove_if(clients_.begin(), clients_.end(),
            [&](const std::shared_ptr<ClientConnection>& shared_client) {
                return !shared_client || shared_client.get() == client.get();
            }), clients_.end());
        // The connection leaves clients_ (so counts and broadcasts are right
        // immediately) but its thread object has to outlive this call: only
        // another thread can join it.
        finished_clients_.push_back(client);

        size_t final_size = clients_.size();
        TCPLOG << "[TCP] Client list size: " << initial_size
                  << " -> " << final_size << std::endl;

        // Check if this was the last client
        if (initial_size > 0 && final_size == 0) {
            was_last_client = true;
            TCPLOG << "[TCP] Last client disconnected - triggering callback" << std::endl;
        }
    }
    // clients_mutex_ is now unlocked

    // Phase 2: Copy callback (inside callback_mutex_)
    ClientDisconnectCallback callback_to_invoke;
    {
        std::lock_guard<std::mutex> lock(callback_mutex_);
        callback_to_invoke = last_client_disconnect_callback_;
    }
    // callback_mutex_ is now unlocked

    // Phase 3: Invoke callback OUTSIDE all locks to prevent deadlock
    // Note: Callback must not throw - exceptions are disabled (-fno-exceptions)
    if (was_last_client && callback_to_invoke) {
        callback_to_invoke();
        TCPLOG << "[TCP] Last client disconnect callback executed successfully" << std::endl;
    }
}

size_t TcpServer::GetClientCount() const {
    std::lock_guard<std::mutex> lock(clients_mutex_);
    return clients_.size();
}

std::vector<ClientConnection*> TcpServer::GetClients() const {
    std::lock_guard<std::mutex> lock(clients_mutex_);
    std::vector<ClientConnection*> result;

    for (const auto& client : clients_) {
        if (client->active) {
            result.push_back(client.get());
        }
    }

    return result;
}

void TcpServer::SetLastClientDisconnectCallback(ClientDisconnectCallback callback) {
    std::lock_guard<std::mutex> lock(callback_mutex_);
    last_client_disconnect_callback_ = callback;
    TCPLOG << "[TCP] Last client disconnect callback registered" << std::endl;
}

bool TcpServer::SendDataToSocket(socket_t socket, const std::string& data) {
    return SendData(socket, data);
}

DebugSession::DebugSession(ClientConnection* connection, TcpServer* server, void* ext) 
    : connection_(connection)
    , server_(server)
    , extension_(ext)
    , active_(true)
    , next_seq_(1)
    , active_context_(nullptr)
{
}

DebugSession::~DebugSession() {
    active_ = false;
}

void DebugSession::ProcessMessage(const std::string& message) {
    if (!active_ || message.empty()) {
        return;
    }
    
    HandleDAPMessage(message);
}

void DebugSession::SendResponse(const std::string& response) {
    if (!active_ || !connection_ || !connection_->active) {
        return;
    }

    std::lock_guard<std::mutex> lock(send_mutex_);

    // Don't double-serialize! SendDataToSocket already adds headers
    if (!server_->SendDataToSocket(connection_->socket, response)) {
        active_ = false;
        connection_->active = false;
    }
}

void DebugSession::SendEvent(const std::string& event) {
    SendResponse(event);
}

void DebugSession::HandleDAPMessage(const std::string& message) {
    TCPLOG << "Received DAP message: " << message << std::endl;

    // Forward to the main extension DAP handler instead of handling here
    if (extension_) {
        DapBridge* debugger_ext = static_cast<DapBridge*>(extension_);
        debugger_ext->HandleDAPMessage(connection_, message);
    }
}

std::string DebugSession::CreateDAPResponse(const std::string& command, bool success, const std::string& body) {
    std::ostringstream oss;
    oss << R"({"seq":)" << next_seq_++ 
        << R"(,"type":"response","command":")" << command << R"(")"
        << R"(,"success":)" << (success ? "true" : "false");
    
    if (!body.empty()) {
        oss << R"(,"body":)" << body;
    }
    
    oss << "}";
    return oss.str();
}

std::string DebugSession::CreateDAPEvent(const std::string& event, const std::string& body) {
    std::ostringstream oss;
    oss << R"({"seq":)" << next_seq_++
        << R"(,"type":"event","event":")" << event << R"(")";
    
    if (!body.empty()) {
        oss << R"(,"body":)" << body;
    }
    
    oss << "}";
    return oss.str();
}