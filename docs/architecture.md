# SourcePawn Debugger — Technical Architecture

This document describes the design and implementation of the SourcePawn debugger for VS Code. It is written for C++/TypeScript engineers who maintain or extend the codebase.

**Audience:** Maintainers and contributors (deep systems knowledge required)

## Table of Contents

1. [Overview](#overview)
2. [Component Architecture](#component-architecture)
3. [Threading Model and Synchronization](#threading-model-and-synchronization)
4. [DAP Protocol Translation](#dap-protocol-translation)
5. [Breakpoint System](#breakpoint-system)
6. [Symbol Resolution and Variable Rendering](#symbol-resolution-and-variable-rendering)
7. [Handle Registry (Scope Encoding)](#handle-registry-scope-encoding)
8. [Frame Navigation (The Hack)](#frame-navigation-the-hack)
9. [Variable Evaluation](#variable-evaluation)
10. [Data Flow Examples](#data-flow-examples)

## Overview

The debugger is a distributed system with two parts:

1. **C++ Extension** (`sp-console-debugger/`) — Runs on the game server (SourceMod extension). Listens on a TCP socket for DAP commands. Hooks `OnDebugBreak` callback from the SourcePawn VM to intercept execution at each debuggable line.

2. **VS Code Extension** (`vscode/`) — Runs on the developer's machine (TypeScript, Node). Connects to the C++ extension via TCP. Translates VS Code's DAP requests into the protocol and manages the session lifecycle.

The two components communicate via the **Debug Adapter Protocol (DAP)** over TCP with **Content-Length framing** (RFC 3156 headers with UTF-8 JSON bodies).

### Why Split This Way?

- The C++ extension must run in-process on the main game thread to hook `OnDebugBreak` (the only way to intercept SourcePawn execution)
- The VS Code extension must run on the developer's machine to integrate with the editor UI
- DAP is the standard protocol that VS Code expects from debuggers, so we just implement it

### Critical Deployment Gotcha: Late Loading

**The extension only enables VM line-debugging when loaded at server startup (non-late mode).** Using `sm exts load` or `sm exts reload` loads it **late**, after plugins are running, which skips the critical `EnableDebugBreak()` call. Already-loaded plugins will then report "not debuggable," and every `launch` will fail with `"Failed to start debugging the specified plugin"` with success=false.

**The only correct deployment is:** Copy the new `.so` files, then do a **full game-server process restart** (stop + start, or `_restart`). `sm exts reload` is not sufficient.

Also required:
- `addons/sourcemod/configs/core.cfg` must have `"EnableLineDebugging" "yes"`
- The target plugin must actually be loaded (its dependencies satisfied; appears in `sm plugins list`)

## Component Architecture

### C++ Extension (Server-Side)

```
Extension (extension.cpp)
├── TcpServer (tcp-server.cpp)
│   ├── Listener thread (accepts connections)
│   ├── ClientConnection (per-client socket + session state)
│   └── ClientThread (per-client TCP read/write thread)
├── DAPHandlers (dap-handlers.cpp)
│   └── Command dispatch (initialize, setBreakpoints, continue, etc.)
├── SessionManager (session-manager.cpp)
│   └── Maps DAP clients to debug sessions
├── Debugger (debugger.cpp) — one per plugin context
│   ├── BreakpointManager
│   ├── SymbolManager
│   └── RunMode / WaitForDAPCommand
└── OnDebugBreak callback (hooked via smutils)
    └── Called by VM thread whenever a debuggable line executes
```

**Key Classes:**

| Class | File | Purpose |
|-------|------|---------|
| `ConsoleDebugger` | extension.h/cpp | Global singleton; SDK_OnLoad/OnUnload; host object for DAPHandlers |
| `TcpServer` | tcp-server.h/cpp | Socket listener; creates ClientConnection per connecting client |
| `ClientConnection` | tcp-server.h | Per-client socket, receive buffer, session pointer, pending events |
| `ClientThread` | tcp-server.h | Worker thread that reads TCP messages and calls DAPHandlers |
| `DebugSession` | tcp-server.h | Coroutine-free state machine (bound client + active plugin context) |
| `DAPHandlers` | dap-handlers.h/cpp | Stateless dispatcher; dispatches DAP commands to implementations |
| `Debugger` | debugger.h/cpp | Per-plugin-context state; breakpoints, symbols, runmode, frame selection |
| `BreakpointManager` | breakpoints.h/cpp | Breakpoint storage, hit count, conditional evaluation, logpoints |
| `SymbolManager` | symbols.h/cpp | Symbol lookup, variable rendering, watch list |
| `VariableHandleRegistry` | variable-handles.h | Maps DAP variable references to symbol names |

### VS Code Extension (Client-Side)

```
Extension (extension.ts)
├── SourcePawnDebugSession (debugAdapter.ts)
│   └── LoggingDebugSession (from @vscode/debugadapter)
├── DebugSessionManager (adapters/DebugSessionManager.ts)
│   ├── ConnectionManager (connections/ConnectionManager.ts)
│   │   ├── TcpConnection (connections/TcpConnection.ts)
│   │   ├── RequestRegistry (connections/RequestRegistry.ts)
│   │   ├── KeepaliveManager (connections/KeepaliveManager.ts)
│   │   └── ReconnectionManager (connections/ReconnectionManager.ts)
│   └── PathMapper (utils/PathMapper.ts)
└── DAPProtocol (protocols/DAPProtocol.ts)
    └── Message format definitions
```

**Key Classes:**

| Class | File | Purpose |
|-------|------|---------|
| `SourcePawnDebugSession` | debugAdapter.ts | DAP adapter; translates VS Code requests to protocol calls |
| `DebugSessionManager` | adapters/DebugSessionManager.ts | Session lifecycle; routes DAP requests to handlers |
| `ConnectionManager` | connections/ConnectionManager.ts | Manages TcpConnection, RequestRegistry, keepalive, reconnect |
| `TcpConnection` | connections/TcpConnection.ts | Socket client; byte-accurate framing; emits diagnostic events |
| `RequestRegistry` | connections/RequestRegistry.ts | Correlates requests by messageSeq; resolves promises |
| `KeepaliveManager` | connections/KeepaliveManager.ts | Sends ping while paused to detect network failures |
| `ReconnectionManager` | connections/ReconnectionManager.ts | Exponential backoff reconnection on socket close |
| `PathMapper` | utils/PathMapper.ts | Remaps compiler file paths to local workspace paths |

## Threading Model and Synchronization

**This is the critical architectural constraint:**

- **SourcePawn VM:** Single-threaded, NOT thread-safe. Runs on the game server's main thread. When a breakpoint fires, `OnDebugBreak` is called on the main thread, and the thread blocks (parks) in a condition variable until DAP commands resume it.
- **TCP Thread:** A separate thread that reads messages from the socket and dispatches them to `DAPHandlers`. Sends responses and events back to the DAP client.

**Thread ownership matters here.** The accept thread and every client thread are
owned and joined by `TcpServer::Stop()`, which runs on the GAME thread whenever
the extension is unloaded (`sm exts unload`/`reload`, or SourceMod shutting down
on a server restart) -- and the moment it returns, the `.so` can be gone. Two
rules follow, both learned from crashes:

- The listening socket is **non-blocking** and the accept loop polls it. Closing
  a socket does not reliably wake a thread parked in `accept()`, so joining one
  that was blocked there hung the game thread and froze the whole server.
- Client threads are **joined, never detached**. A detached thread still inside
  `ClientThread` when the library is unloaded runs code that no longer exists,
  which segfaulted the server on restart with an editor attached.

`src/__tests__/integration/extension-lifecycle.test.ts` covers both.

### The Breakpoint Stop Sequence

```
Main Thread (VM)                              TCP Thread (DAP)
─────────────────────────────────────────────────────────────
Plugin line 363 executes
OnDebugBreak(cip, frm) called
  (on main thread)
    │
    ├─ CheckBreakpoint()
    │   └─ Is this line breakpointed?
    │
    ├─ (if logpoint): format message, emit output event, return
    │   [No freeze]
    │
    ├─ (if normal breakpoint):
    │   └─ Emit stopped event (on main thread, via TcpServer)
    │       └─ write_mutex_ guards socket writes
    │
    └─ Park in WaitForDAPCommand()
       (main thread blocks here)
        │
        └─ Loop until dap_should_continue_ is true
           (condition variable)
                                              ← Client reads "stopped" event
                                              ← Client sends continue request
                                              ← ClientThread reads continue
                                              ← HandleContinue() called
                                              ├─ SetRunmode(RUNNING)
                                              ├─ Emit continued event
                                              └─ Signal dap_should_continue_
                                              
        ← Wake up from condition variable
        ← Return from WaitForDAPCommand()

Resume execution on line 364
```

**Key synchronization primitives:**

- `dap_should_continue_` (atomic<Runmode>) — Shared state between main and TCP threads
- `dap_condition_` (condition_variable) — Main thread waits here; TCP thread signals
- `write_mutex_` (mutex) — Guards socket writes (events from main thread, responses from TCP thread)

### Why Pausing Freezes the Server

Pausing at a breakpoint blocks the main thread. While the main thread is blocked:

- The game loop cannot advance
- Physics doesn't update
- Network packets aren't processed
- Players appear frozen

This is **not a bug**. It's inherent to running a debugger in-process on the main thread. The only non-freezing alternative is the **snapshot logpoint**, which captures state and continues immediately.

### Atomicity and Races

**Owner Token:** A debug session is owned by the DAP client that initiated it. Multiple clients can connect (one per debug session), but only the owning client can send commands. On disconnect, cleanup only happens if the disconnecting client was the owner.

```cpp
// In Debugger::
const void* owner_token_;  // opaque pointer to ClientConnection

void SetOwnerToken(const void* token) { owner_token_ = token; }
const void* OwnerToken() const { return owner_token_; }

// In OnDisconnect:
if (client->this_pointer == debugger->OwnerToken()) {
  debugger->Deactivate();  // Clear breakpoints, resume execution
}
```

This prevents a stale disconnect (from a crashed previous client) from killing a newer session.

## DAP Protocol Translation

### Minimal Wire Protocol

All messages are **Content-Length framed** JSON:

```
Content-Length: 123\r\n
\r\n
{"seq":1,"type":"request","command":"initialize","arguments":{...}}
```

**On the C++ side:** `TcpServer::ReceiveMessage()` parses the header, reads exactly N bytes from the socket, and parses the JSON body. `SendData()` builds the header and writes atomically (mutex-guarded).

**On the TypeScript side:** `TcpConnection` uses a `Buffer` (byte array) to accumulate incoming data. It parses the header as latin1 (ASCII-safe), reads the byte count from Content-Length, slices exactly N bytes, and decodes to UTF-8.

### Sequence Number Correlation

DAP uses `seq` (sequence numbers) to correlate responses to requests:

```
Request (seq=5):
{"seq":5,"type":"request","command":"continue"}

Response (request_seq=5):
{"seq":6,"type":"response","request_seq":5,"command":"continue","success":true}
```

**On the C++ side:** DAPHandlers reads `request_seq` from the request and echoes it in the response.

**On the TypeScript side:** RequestRegistry maps `seq` → Promise. When a response arrives with `request_seq=5`, the promise for request 5 is resolved.

### Events (No Sequence)

Events are sent unsolicited (e.g., when execution stops or output is logged):

```
Event (no seq):
{"type":"event","event":"stopped","body":{"reason":"breakpoint","threadId":0}}
```

Events have no `seq` or `request_seq`. They are forwarded directly to the DAP client (VS Code).

## Breakpoint System

### Breakpoint Storage and Activation

**BreakpointManager** stores breakpoints in a map keyed by **code instruction pointer (cip)**, which is the VM bytecode address:

```cpp
// breakpoints.h
class BreakpointManager {
  ke::HashMap<cell_t, Breakpoint*> breakpoints_;  // keyed by cip
  
  Breakpoint* AddBreakpoint(const std::string& file, cell_t line);
  Breakpoint* CheckBreakpoint(cell_t cip);  // Called from OnDebugBreak
};
```

### Line-to-Address Resolution

When a DAP client calls `setBreakpoints`, the C++ extension must resolve each line number to a code address (cip). This uses **SourcePawn's debug symbols**:

```cpp
// In BreakpointManager::AddBreakpoint(file, line)
SourcePawn::IDebugInfo* info = debugger->GetDebugInfo();
while (info->GetLineAddress(line, &cip) == SP_ERROR_NONE) {
  // Found a cip for this line; create breakpoint
  auto bp = std::make_unique<Breakpoint>(this, cip, ...);
  breakpoints_[cip] = bp.get();
}
```

**Gotchas:**
- A single line can have multiple addresses (e.g., a loop unrolled into multiple instructions)
- Empty lines (whitespace only) are snapped to the next executable line
- Function prologues are skipped, so locals are in scope

### Conditional Breakpoints

A Breakpoint can have a **condition expression**:

```cpp
struct Breakpoint {
  std::string condition_expr;  // "x > 5"
  
  bool EvaluateCondition(const Debugger* debugger);
};
```

**Evaluation** is lazy—only when the breakpoint hits. The condition is evaluated in the context of the current frame (cip, frm) using `EvaluateExpression()`, which looks up the variable in the symbol table and compares it.

**Supported operators:** `==`, `!=`, `<`, `<=`, `>`, `>=` (single comparison; no `&&` or `||`).

### Hit-Count Breakpoints

A Breakpoint tracks `hit_count`:

```cpp
struct Breakpoint {
  int hit_count = 0;
  int hit_condition = 0;  // plain integer (e.g., 3 = trigger from 3rd hit onward)
};

bool CheckHitCount() {
  hit_count++;
  // Only support a plain positive integer: break from Nth hit onward
  if (hit_condition > 0 && hit_count < hit_condition)
    return false;  // Not hit yet
  return true;  // Hit at or past the condition
}
```

**Supported format:** Plain positive integer only (e.g., `3`, `10`). The server validates with `std::isdigit()` and rejects operator forms like `== 10`, `>= 5`, `% 3`. If the hit condition is N, execution pauses starting from the Nth hit and every hit thereafter.

### Logpoints (Non-Pausing)

A breakpoint can have a **log message**:

```cpp
struct Breakpoint {
  std::string log_message;  // "Player {player_id} took {damage} damage"
};
```

When the breakpoint hits, `FormatLogMessage()` interpolates `{expr}` tokens and emits an `output` event, then **continues execution immediately** (does NOT pause). Logpoints never freeze the server.

### Snapshot Logpoints

Special log messages `{@all}`, `{@locals}`, `{@args}` trigger **snapshot mode**:

```cpp
bool FormatLogMessage(std::string& out) {
  if (log_message == "{@all}") {
    // Capture snapshot: all locals + arguments (NOT globals)
    FormatScopeSnapshot(cip, frm, true, true);
    return false;  // Don't pause
  }
  // ... normal logpoint processing
  return false;  // Logpoints NEVER pause
}
```

**Key difference:** All logpoints (including regular ones with `{expr}`) return `false` from `CheckBreakpoint()`, so `OnDebugBreak` returns immediately without calling `SetRunmode()`. No pause, no freeze. The `{@all}` snapshot captures **locals and arguments only** (not globals, which a plugin can have 50+). To log a specific global, name it explicitly: `{g_iValidBhops[client]}`.

## Symbol Resolution and Variable Rendering

### SymbolManager

**SymbolManager** wraps SourcePawn's `IDebugSymbol` and `ISymbolType` APIs and implements value rendering for the DAP variables view.

```cpp
class SymbolManager {
  void LookupSymbol(const std::string& name, int frame_id, SymbolWrapper& out);
  std::string GetSymbolString(const IDebugSymbol* sym);  // LocalToStringNULL
  std::vector<ChildVariable> GetSymbolChildren(const IDebugSymbol* sym, int index);
};
```

### Value Rendering (FormatScalar, GetSummaryValue)

A **scalar cell** (int, float, bool, char) is rendered according to its SourcePawn type:

```cpp
std::string FormatScalar(const ISymbolType* type, cell_t value) {
  if (type->GetTag() == pc_tag_float) {
    return FormatFloat(*(float*)&value);  // 0x41200000 → 10.0
  }
  if (type->GetTag() == pc_tag_bool) {
    return value ? "true" : "false";
  }
  if (type->GetTag() == pc_tag_char) {
    return FormatChar(value);  // 65 → 'A'
  }
  return std::to_string(value);  // int
}
```

### Array Expansion

Arrays are expanded on demand. Each array element becomes a **child variable**:

```cpp
std::vector<ChildVariable> GetArrayChildren(const IDebugSymbol* sym) {
  std::vector<ChildVariable> children;
  for (int i = 0; i < array_size; i++) {
    ChildVariable child;
    child.name = "[" + std::to_string(i) + "]";
    child.value = GetSymbolValue(sym, i);
    child.type = GetElementType(sym);
    children.push_back(child);
  }
  return children;
}
```

The DAP client renders these as children in the Variables panel.

### Scope Visibility (codestart/codeend)

SourcePawn's `IDebugSymbol::GetCodeStart()` and `GetCodeEnd()` define the range of code addresses where the symbol is in scope. The debugger checks this when rendering variables:

```cpp
bool IsInScope(const IDebugSymbol* sym, cell_t cip) {
  if (sym->GetScope() == SCOPE_LOCAL || sym->GetScope() == SCOPE_ARGUMENT) {
    return cip >= sym->GetCodeStart() && cip < sym->GetCodeEnd();
  }
  // Globals/statics are always in scope
  return true;
}
```

**Important:** This check is **only applied to locals and arguments**. Globals and statics don't have meaningful code ranges, so they're always visible.

## Handle Registry (Scope Encoding)

DAP uses integer "references" to represent variables for expansion (e.g., "expand this array"). The debugger uses two encoding schemes:

### Scope Encoding (Simple Variables)

For simple variables in a specific scope (Locals, Arguments, Globals), the reference is computed from frame ID and scope type:

```cpp
int EncodeVariableReference(int frame_id, int scope_type) {
  // scope_type: 0=Locals, 1=Arguments, 2=Globals
  return (frame_id + 1) * 1000 + scope_type;
}

void DecodeVariableReference(int ref, int& frame_id, int& scope_type) {
  frame_id = (ref / 1000) - 1;
  scope_type = ref % 1000;
}
```

A reference < 100000 is a scope encoding.

### Handle Encoding (Aggregate Variables)

For expandable variables (arrays, structs), a handle is allocated by **VariableHandleRegistry**:

```cpp
// In variable-handles.h
constexpr int kVariableHandleBase = 100000;

class VariableHandleRegistry {
  std::unordered_map<int, VariableHandle> handles_;
  int next_handle_ = kVariableHandleBase;
  
  int Allocate(int frame_id, int scope_type, const std::string& symbolName) {
    int handle = next_handle_++;
    handles_[handle] = {frame_id, scope_type, symbolName};
    return handle;
  }
};
```

A reference >= 100000 is a handle. It maps to a `VariableHandle` struct, which stores the original symbol name so it can be re-resolved when expanding.

**Why re-resolve?** `IDebugSymbol` pointers are owned by the debug-info iterator and may be invalidated between requests. We can't cache them. Instead, we store the symbol name and look it up again (just like the console watch list does).

## Frame Navigation (The Hack)

SourcePawn's public debug API doesn't expose frame iteration. The `frame` command (and now DAP frame selection) uses a **fragile hack** in `frame-utils.h` to reach into the VM's internal `FrameIteratorHack` class:

```cpp
// frame-utils.h
namespace sp {
  class FrameIteratorHack {
  public:
    virtual void somefunc() = 0;
    void* ivk_;
    void* runtime_;
    intptr_t* next_exit_fp_;
    std::unique_ptr<InlineFrameIterator> frame_cursor_;
  };
  
  inline cell_t ReadContextFramePointer(SourcePawn::IPluginContext* ctx) {
    return *(cell_t*)(uintptr_t(ctx) + sizeof(void*) * 10 + sizeof(bool) * 4 +
                      sizeof(uint32_t) * 2 + sizeof(cell_t) * 3);
  }
}
```

**How it works:**

1. `IPluginContext` contains a `FrameIteratorHack` pointer
2. We compute the offset into `IPluginContext` (magic offsets based on the SDK version)
3. We cast to `FrameIteratorHack` and access the frame cursor
4. We iterate frames using the non-public `InlineFrameIterator` API

**Fragility:** The offsets depend on the SourcePawn VM version. If the SDK changes (new fields added to IPluginContext), these offsets become invalid and frame selection breaks.

**Workaround:** The offsets are kept in one place (`frame-utils.h`). When VM updates break frame selection, adjust the offsets there.

**Better solution:** Submit a PR to SourceMod to expose frame iteration as a public API.

## Variable Evaluation

### Expression Canonicalization

Users can type hovers like:

```
static float health[10]
```

or

```
coords[0];  // comment
```

`EvaluateExpression()` canonicalizes messy input to extract the last identifier:

```cpp
std::string CanonicalizeExpression(const std::string& expr) {
  // Strip declaration keywords (static, const, etc.)
  // Strip type names (float, int, etc.)
  // Strip trailing comments (after //)
  // Strip trailing whitespace and semicolons
  // Recursively strip `[index]` suffixes
  // Return the last identifier
  return "health" or "coords"
}
```

### Variable Lookup

Once canonicalized, the symbol is looked up in the current frame:

```cpp
bool LookupSymbol(const std::string& name, int frame_id, SymbolWrapper& out) {
  // frame_id selects which stack frame to search in
  // Search locals, arguments, then globals (in order)
  // Use IDebugSymbol::GetSymbol() to find the variable
  // Return SymbolWrapper if found
}
```

### Array Element Access

Users can evaluate `coords[0]` or `g_PlayerData[5].kills`. The DAP adapter:

1. Extracts the root symbol (`coords`, `g_PlayerData`)
2. Extracts the index/key path (`[0]`, `[5].kills`)
3. Calls `GetArrayElement()` to fetch the element value

For single-level arrays:

```cpp
bool GetArrayElement(const IDebugSymbol* sym, cell_t index, cell_t& out) {
  cell_t addr = 0;
  if (!sym->GetEffectiveAddress(0, &addr)) return false;
  
  ISymbolType* elem_type = sym->GetType()->GetArrayType();
  int elem_size = elem_type->GetSize();
  
  cell_t elem_addr = addr + (index * elem_size);
  return ReadMemory(elem_addr, &out, sizeof(cell_t));
}
```

## Data Flow Examples

### Example 1: Setting a Breakpoint

```
DAP Client                              C++ Extension
─────────────────────────────────────────────────────

setBreakpoints request
  (file: "antibhop.sp", lines: [363, 400])
  │
  ├─→ [TCP] Content-Length: ...\r\n\r\n{...}
  │
  │                                     [Read on TCP thread]
  │                                     │
  │                                     ├─ Parse Content-Length
  │                                     ├─ Read N bytes
  │                                     ├─ Parse JSON
  │                                     ├─ DAPHandlers::HandleSetBreakpoints()
  │                                     │   ├─ BreakpointManager::AddBreakpoint()
  │                                     │   │  ├─ GetDebugInfo()
  │                                     │   │  ├─ FindFileByPartialName("antibhop.sp")
  │                                     │   │  ├─ GetLineAddress(363, &cip)
  │                                     │   │  └─ Create Breakpoint(cip=0x1a2b)
  │                                     │   │
  │                                     │   └─ Build response JSON
  │                                     │       {verified: true, line: 363, ...}
  │                                     │
  │  ←─ [TCP] Content-Length: ...\r\n\r\n{...}
  │      (response_seq: 1, success: true, body: {breakpoints: [...]})
  │
  └─ Update Variables panel
     Show "Breakpoint at antibhop.sp:363"
```

### Example 2: Breaking at a Breakpoint

```
Game Server (Main Thread)                 DAP Client (TCP Thread)
─────────────────────────────────────────────────────────────

Plugin executes line 363 (cip=0x1a2b)
│
├─ OnDebugBreak callback invoked
│  (on main thread)
│
├─ BreakpointManager::CheckBreakpoint(0x1a2b)
│  └─ Returns Breakpoint struct
│
├─ Is it a logpoint with {@all}?
│  └─ No, normal breakpoint
│
├─ Emit stopped event
│  {type:"event", event:"stopped", body:{reason:"breakpoint", threadId:0}}
│  ├─ TcpServer::SendEvent() [main thread]
│  │  └─ Acquire write_mutex_
│  │  └─ Write to socket
│  │  └─ Release write_mutex_
│  │
│  └─ [TCP] Sent to client
│      │
│      └─→ [DAP Client reads event]
│          ├─ Handle "stopped" event
│          ├─ Update state: debuggerState = "stopped"
│          ├─ Emit StoppedEvent to VS Code
│          └─ VS Code calls getStackTrace, getScopes, variables, ...
│
├─ Park main thread in WaitForDAPCommand()
│  dap_condition_.wait(lock)
│
│      ← [DAP Client] User clicks "Continue" button
│      ← [DAP Client] Sends continue request
│      ← [DAP Client] [TCP] Content-Length: ...\r\n\r\n{...}
│      ← [TCP Thread reads continue]
│      ← DAPHandlers::HandleContinue()
│      │  ├─ SetRunmode(RUNNING)
│      │  ├─ dap_should_continue_ = true
│      │  ├─ dap_condition_.notify_one()
│      │  └─ Build response (success: true)
│      │
│      └─ [TCP] Sent response to client
│
└─ Wake up from dap_condition_.wait()
   Return from WaitForDAPCommand()
   Resume execution on line 364
```

### Example 3: Inspecting a Variable

```
DAP Client                              C++ Extension
─────────────────────────────────────────────────────

[Paused at breakpoint 363]
│
User hovers over `health` in editor
  │
  ├─ VS Code sends hover request (implicit evaluation)
  │  (or user types in Watch: `health`)
  │
  ├─→ [TCP] evaluate request
  │   {command: "evaluate", arguments: {expression: "health", frameId: 0}}
  │
  │                                     [TCP thread]
  │                                     │
  │                                     ├─ DAPHandlers::HandleEvaluate()
  │                                     │  ├─ CanonicalizeExpression("health")
  │                                     │  ├─ SymbolManager::LookupSymbol("health", frameId=0)
  │                                     │  │  ├─ SelectFrame(0)
  │                                     │  │  ├─ GetDebugInfo()->FindLocalByName("health")
  │                                     │  │  └─ SymbolWrapper(symbol)
  │                                     │  │
  │                                     │  ├─ Read value from memory
  │                                     │  │  health_addr = frame_base + 12
  │                                     │  │  health_value = *(int32*)health_addr = 78
  │                                     │  │
  │                                     │  ├─ Format value
  │                                     │  │  type = int
  │                                     │  │  value_str = "78"
  │                                     │  │
  │                                     │  └─ Build response
  │                                     │      {success: true, result: "78", type: "int"}
  │
  │  ←─ [TCP] evaluate response
  │      (body: {result: "78", type: "int"})
  │
  └─ VS Code displays tooltip: "health: 78 (int)"
```

---

That's the core architecture. The key insights:

1. **Main thread parks in a condition variable** when a breakpoint fires; TCP thread signals to wake it
2. **Socket writes are mutex-guarded** (events from main thread, responses from TCP thread)
3. **Scope references are encoded by frame+scope; aggregate variables use a handle registry**
4. **Frame iteration is a hack** that depends on VM internals
5. **DAP is the standard protocol** — we just implement it faithfully

