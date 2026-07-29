# SourcePawn Debugger — Wire Protocol

This document describes the DAP (Debug Adapter Protocol) wire protocol as implemented by the SourcePawn debugger. It covers framing, message structure, validation rules, and ordering constraints discovered through testing.

**Audience:** Protocol implementers and transport layer engineers

## Table of Contents

1. [Content-Length Framing](#content-length-framing)
2. [Message Structure](#message-structure)
3. [Validation Rules](#validation-rules)
4. [Request/Response Correlation](#requestresponse-correlation)
5. [Events](#events)
6. [Ordering Constraints](#ordering-constraints)
7. [Custom Commands (Profiler)](#custom-commands-profiler)
8. [Error Handling](#error-handling)
9. [Byte-Accurate UTF-8 Handling](#byte-accurate-utf8-handling)

## Content-Length Framing

DAP uses **Content-Length framing** (RFC 3156). Each message consists of:

1. A header block with key-value pairs, one per line, ending with `\r\n\r\n`
2. A UTF-8 JSON body of exactly N bytes, where N is the `Content-Length` value

**Example:**

```
Content-Length: 123\r\n
\r\n
{"seq":1,"type":"request","command":"initialize","arguments":{}}
```

### Header Parsing Rules

- Lines are separated by `\r\n` (Windows-style) or `\n` (Unix-style, treated as line sep)
- Header parsing is **case-insensitive** for key names
- Key-value pairs use `:` as the separator (optional surrounding whitespace is allowed)
- Empty line (double `\r\n`) marks the end of headers
- `Content-Length` is required and must be a positive integer
- All other headers are ignored (reserved for extension)

### Content-Length Is a BYTE Count

**Critical bug found in testing:** The `Content-Length` header specifies the number of **UTF-8 bytes**, not characters.

Example:

```
Character: "»" (U+00BB, GUILLEMET_RIGHT from CS color codes)
UTF-8 encoding: 0xC2 0xBB (2 bytes)
Content-Length: 2 (not 1)
```

If the client counts *characters* instead of bytes, it will under-read multi-byte sequences:

```cpp
// WRONG (JavaScript):
contentLength = 100
body_chars = buffer.toString("utf8", 0, 100)  // Reads 100 chars
// But if buffer contains multi-byte UTF-8, you only got ~50 bytes!

// CORRECT:
contentLength = 100
body_str = buffer.toString("utf8", 0, 100)    // Reads exactly 100 bytes
```

This bug caused the dominant desync symptom: the next message's header is partially corrupt, leading to "malformed header" errors and buffer re-sync.

### Client-Side Framing (TypeScript)

```typescript
// In TcpConnection.ts
private buffer: Buffer = Buffer.alloc(0);

onSocketData(data: Buffer): void {
  this.buffer = Buffer.concat([this.buffer, data]);
  
  while (true) {
    // Try to parse header
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;  // Incomplete header
    
    // Parse Content-Length from header (0 to headerEnd)
    const headerStr = this.buffer.toString("latin1", 0, headerEnd);
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      this.resyncBuffer();
      break;
    }
    
    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + 4;  // Skip \r\n\r\n
    const messageEnd = messageStart + contentLength;
    
    if (this.buffer.length < messageEnd) break;  // Incomplete body
    
    // Extract exactly contentLength bytes and decode as UTF-8
    const bodyBytes = this.buffer.subarray(messageStart, messageEnd);
    const bodyStr = bodyBytes.toString("utf8");
    
    try {
      const msg = JSON.parse(bodyStr);
      this.handleMessage(msg);
    } catch (err) {
      this.emit("diagnostic", `parse error: ${err.message}`);
    }
    
    // Consume this message
    this.buffer = this.buffer.subarray(messageEnd);
  }
}
```

### Server-Side Framing (C++)

```cpp
// In TcpServer::ReceiveMessage()
bool ReceiveMessage(socket_t sock, std::string& out_body) {
  std::string buffer;
  char temp[4096];
  
  // Receive until we have \r\n\r\n
  while (true) {
    ssize_t n = recv(sock, temp, sizeof(temp), 0);
    if (n <= 0) return false;
    buffer.append(temp, n);
    
    if (buffer.find("\r\n\r\n") != std::string::npos) break;
  }
  
  // Parse Content-Length
  size_t header_end = buffer.find("\r\n\r\n");
  std::string header = buffer.substr(0, header_end);
  
  size_t content_length = 0;
  // Parse "Content-Length: 123"
  if (sscanf(header.c_str(), "Content-Length: %zu", &content_length) != 1) {
    return false;  // Malformed header
  }
  
  // Drain the buffer to ensure we have the full body
  size_t body_start = header_end + 4;  // Skip \r\n\r\n
  size_t needed = body_start + content_length;
  
  while (buffer.size() < needed) {
    ssize_t n = recv(sock, temp, sizeof(temp), 0);
    if (n <= 0) return false;
    buffer.append(temp, n);
  }
  
  // Extract exactly content_length bytes
  out_body = buffer.substr(body_start, content_length);
  return true;
}
```

## Message Structure

All messages are JSON objects with the following structure:

```json
{
  "seq": <integer>,
  "type": "request" | "response" | "event",
  ...type-specific fields...
}
```

### Request Message

```json
{
  "seq": 1,
  "type": "request",
  "command": "initialize",
  "arguments": {
    "clientID": "vscode",
    "clientName": "Visual Studio Code",
    "adapterID": "sp-debugger",
    "locale": "en-us",
    "linesStartAt1": true,
    "columnsStartAt1": true,
    "pathFormat": "path"
  }
}
```

**Fields:**
- `seq` — Unique sequence number (incremented by client)
- `type` — Always "request"
- `command` — The DAP command (initialize, launch, attach, setBreakpoints, continue, ...)
- `arguments` — Command-specific arguments object (optional)

### Response Message

```json
{
  "seq": 5,
  "type": "response",
  "request_seq": 1,
  "command": "initialize",
  "success": true,
  "body": {
    "capabilities": {
      "supportsConfigurationDoneRequest": true,
      "supportsEvaluateForHovers": true,
      "supportsConditionalBreakpoints": true,
      "supportsHitConditionalBreakpoints": true,
      "supportsLogPoints": true,
      "supportsDataBreakpoints": true,
      "supportsSetVariable": true,
      "supportsReadMemoryRequest": true,
      "supportsLoadedSourcesRequest": true,
      "supportsCancelRequest": true,
      "supportTerminateDebuggee": true,
      "supportSuspendDebuggee": true,
      "supportsStepBack": false,
      "supportsRestartFrame": false,
      "supportsSteppingGranularity": false
    }
  }
}
```

**Fields:**
- `seq` — Unique sequence number (generated by server)
- `type` — Always "response"
- `request_seq` — Echoes the `seq` from the request (for correlation)
- `command` — Echoes the `command` from the request
- `success` — Boolean; true if the command succeeded
- `body` — Command-specific response data (if success=true)
- `message` — Human-readable error message (if success=false)

### Event Message

```json
{
  "seq": 6,
  "type": "event",
  "event": "stopped",
  "body": {
    "reason": "breakpoint",
    "threadId": 0,
    "preserveFocusHint": false
  }
}
```

**Fields:**
- `seq` — Unique sequence number (generated by server)
- `type` — Always "event"
- `event` — The event name (stopped, continued, output, threads, ...)
- `body` — Event-specific data

## Validation Rules

### Request Validation (Server-Side)

Upon receiving a request, the server must:

1. Validate `seq` is a positive integer
2. Validate `type` is "request"
3. Validate `command` is a known command
4. Validate `arguments` structure matches the command's schema
5. Return a response with `request_seq` set to the request's `seq`

**Invalid request example (missing seq):**
```json
{
  "type": "request",
  "command": "continue"
}
```
Server should reject with an error response (no request_seq).

### Authentication

When the server has a `token` configured (mandatory whenever its listener is
bound to anything other than loopback -- see
[Configuration](README.md#configuration)), every request except `initialize` and
`disconnect` is refused until the client presents that token. It may ride on
`initialize`, `launch` or `attach`:

```json
{ "seq": 1, "type": "request", "command": "launch",
  "arguments": { "program": "antibhop", "token": "the-shared-secret" } }
```

A request that arrives unauthenticated gets a normal failed response:

```json
{ "type": "response", "request_seq": 2, "command": "threads", "success": false,
  "message": "Authentication required: set \"token\" in the launch configuration to the value from configs/console-debugger.cfg" }
```

The message is identical for a wrong token and for no token at all, and the
comparison is length-independent, so a client that cannot authenticate learns
nothing about the secret. A connection that never authenticates is dropped after
15 seconds.

### Response Validation (Client-Side)

Upon receiving a response, the client must:

1. Validate `seq` and `type` fields
2. Validate `request_seq` is a known request (in the RequestRegistry)
3. Validate `command` matches the original request's command
4. If `success=false`, extract `message` for error display
5. Correlate the response to the pending request promise

**Invalid response example (orphan response):**
```json
{
  "seq": 42,
  "type": "response",
  "request_seq": 999,
  "command": "continue",
  "success": true
}
```
If request 999 doesn't exist (timed out or duplicated), the client logs a diagnostic and discards it.

### Event Validation (Client-Side)

Upon receiving an event, the client must:

1. Validate `type` is "event"
2. Validate `event` field is recognized
3. **Do not require `seq`** — events may be sent without sequence numbers
4. Forward the event to the VS Code debug adapter

**Valid event without seq:**
```json
{
  "type": "event",
  "event": "stopped",
  "body": { "reason": "breakpoint", "threadId": 0 }
}
```

**Important:** Do NOT reject events that lack `seq`. Some servers (including older versions of this one) may send events without sequence numbers.

## Request/Response Correlation

The client uses `seq` and `request_seq` to match responses to requests. Implementation:

```typescript
// In RequestRegistry.ts
private requests = new Map<number, {
  seq: number,
  command: string,
  timer: NodeJS.Timeout,
  resolve: (response: any) => void,
  reject: (error: Error) => void
}>();

sendRequest(command: string, args: any): Promise<any> {
  const seq = this.nextSeq++;
  const msg = {seq, type: "request", command, arguments: args};
  this.socket.write(frame(msg));
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.requests.delete(seq);
      reject(new Error(`${command} timeout after 30000 ms`));
    }, 30000);
    
    this.requests.set(seq, {seq, command, timer, resolve, reject});
  });
}

onMessage(msg: any) {
  if (msg.type === "response") {
    const req = this.requests.get(msg.request_seq);
    if (!req) {
      this.emit("diagnostic", `orphan response for seq ${msg.request_seq}`);
      return;
    }
    
    clearTimeout(req.timer);
    this.requests.delete(msg.request_seq);
    
    if (msg.success) {
      req.resolve(msg.body);
    } else {
      req.reject(new Error(msg.message || `${req.command} failed`));
    }
  } else if (msg.type === "event") {
    this.emit(msg.event, msg.body);
  }
}
```

## Events

Events are sent by the server to signal state changes. They do not require a response.

### stopped

Sent when execution pauses at a breakpoint, exception, etc.

```json
{
  "type": "event",
  "event": "stopped",
  "body": {
    "reason": "breakpoint",
    "threadId": 0,
    "preserveFocusHint": false
  }
}
```

**Body fields:**
- `reason` — "breakpoint", "exception", "pause", "entry", ...
- `threadId` — Always 0 (single-threaded SourcePawn VM)
- `text` — Optional description of the stop reason
- `preserveFocusHint` — If true, don't change UI focus

### continued

Sent when execution resumes.

```json
{
  "type": "event",
  "event": "continued",
  "body": {
    "threadId": 0,
    "allThreadsContinued": true
  }
}
```

### output

Sent to display text in the Debug Console.

```json
{
  "type": "event",
  "event": "output",
  "body": {
    "category": "stdout",
    "output": "Player 5 took 25 damage"
  }
}
```

**Categories:**
- `stdout` — Regular output
- `stderr` — Errors
- `console` — Console output
- `telemetry` — Telemetry data

The Debug Console concatenates `output` bodies verbatim, so every message the
server emits is newline-terminated before it goes out (`SendDAPOutputEvent` adds
one when the caller did not). Without that, consecutive messages run together on
one line.

### threads

Sent when the thread list changes (SourcePawn has only one thread, so this is rarely used).

```json
{
  "type": "event",
  "event": "threads",
  "body": {}
}
```

## Ordering Constraints

### The Continued-Before-SetRunmode Rule

**Critical constraint found through testing:**

When resuming execution, the server must emit the `continued` event **before** signaling the VM thread to wake up. Otherwise, a `stopped` event can overtake the `continued` event on the wire.

**Correct order:**

```cpp
// In DAPHandlers::HandleContinue()
void HandleContinue(ClientConnection* client, DAPRequest* req) {
  // 1. Send continued event (queued on TCP thread)
  SendContinuedEvent(threadId);
  
  // 2. Signal the VM thread to wake
  SetRunmode(RUNNING);
  
  // 3. Return response
  SendResponse(client, req, true);
}
```

**Why this matters:** The VM thread and TCP thread run in parallel. If SetRunmode wakes the VM thread before the continued event is written to the socket, the VM might execute the next breakpoint before the client has processed the continued event. The client would then see:

```
stopped event (line 363)
continued event
stopped event (line 364)
```

And the adapter might get confused about which stopped is current.

By sending continued first, we ensure the order is correct on the wire.

### Initialization Handshake

The VS Code adapter (`debugAdapter.ts`) drives this sequence:

1. VS Code sends `initialize` → adapter replies with capabilities. **It does NOT send `initialized` yet.**
2. VS Code sends `launch` (or `attach`) → the adapter opens the TCP connection, sends the `launch`/`attach` request to the C++ server (binding the plugin context), and replies to the request.
3. **Only then** does the adapter emit the `initialized` event (from `launchRequest`/`attachRequest`).
4. VS Code, on `initialized`, sends `setBreakpoints` then `configurationDone`.
5. Adapter replies to `configurationDone`; execution begins (or stops at entry if `stopOnEntry=true`).

**Important — deliberate deviation from stock DAP.** Standard adapters emit `initialized` from `initializeRequest`. This adapter intentionally defers it to **after** `launch`/`attach` complete (after the plugin is bound on the server). If it were sent earlier, VS Code would fire `setBreakpoints` before the server has an active plugin to bind them to, and every breakpoint would come back **unverified**. The comment in `initializeRequest` documents this; `InitializedEvent` is sent only from `launchRequest` and `attachRequest`.

## Custom Commands (Profiler)

Beyond standard DAP, the server implements two custom requests for the function
profiler. The VS Code commands dispatch them via `session.customRequest(...)`;
the adapter's `customRequest` override forwards them to the server unchanged.

### `sp_profileStart`

Resets the call tree and starts the debug-break tracer for the debugged plugin.
The VM's own profiling tool is enabled at the same time, but only as the
Invoke-boundary signal the tracer needs -- its tree is never reported. Does
**not** pause execution.

```json
{ "seq": 40, "type": "request", "command": "sp_profileStart", "arguments": {} }
```

Response body:

```json
{ "active": true }
```

`active` is `false` when the VM's v2 engine / patched VM is unavailable (the
profiler can't run); the client then shows an error instead of recording.

### `sp_profileStop`

Stops the capture and returns it: the accumulated call tree, the measured
timeline behind it, and the wall-clock length of the window. The tree is a
single root container whose `children` are the top-level call paths.

```json
{ "seq": 41, "type": "request", "command": "sp_profileStop", "arguments": {} }
```

Response body:

```json
{
  "tree": {
    "name": "<root>", "group": "", "id": 0,
    "totalMs": 0, "selfMs": 0, "calls": 0,
    "minSelfMs": 0, "maxSelfMs": 0, "p95SelfMs": 0,
    "children": [
      {
        "name": "antibhop.smx::OnGameFrame", "group": "antibhop.smx", "id": 1,
        "totalMs": 5.021, "selfMs": 4.180, "calls": 137,
        "minSelfMs": 0.011, "maxSelfMs": 0.402, "p95SelfMs": 0.090,
        "lines": [ { "line": 42, "selfMs": 3.100 }, { "line": 43, "selfMs": 1.080 } ],
        "children": []
      }
    ]
  },
  "samples": {
    "id":      [1, 2, 1],
    "dtUs":    [2000.0, 3000.0, 1000.0],
    "startUs": [0.0, 2000.0, 5000.0],
    "truncated": false
  },
  "spans": {
    "items": [ { "id": 1, "tsUs": 0.0, "durUs": 8000.0, "depth": 0 } ],
    "truncated": false
  },
  "windowMs": 1253.2184
}
```

**Tree node fields:** `name` (function, qualified `plugin.smx::Function`),
`group`, `id` (depth-first index, referenced by `samples` and `spans`),
`totalMs` (inclusive), `selfMs` (exclusive), `calls`, the per-call distribution
of self time (`minSelfMs` / `maxSelfMs` / `p95SelfMs`), `lines` (self time per
source line, heaviest first, omitted when unavailable) and `children`.

**`samples`** is the measured timeline as three parallel arrays: sample *i* says
node `id[i]` was executing for `dtUs[i]` microseconds starting at `startUs[i]`
from the capture start. Consecutive samples of the same node are merged
server-side. The client turns these into the `timeDeltas` of a `.cpuprofile`, so
the flame chart's time axis is measured rather than synthesised, and `lines`
becomes its `positionTicks`.

**`spans`** is one entry per completed call, with its real begin (`tsUs`) and
duration (`durUs`); `depth` is its nesting level. The client exports these as a
Chrome Trace Event document for Perfetto, which is the only view that shows
*when* something ran rather than how much it cost in total.

Both carry a `truncated` flag: a capture that exceeded the server-side caps is
reported as such rather than silently shortened.

**Scope: the debugged plugin.** The tracer follows one plugin's context, so the
tree is that plugin's calls and callees. An earlier revision also returned a
whole-VM tree (`treeAll`) from the VM's profiling hook, which the client offered
behind a toggle; the two are measured on different clocks and at different
granularity, so the toggle invited comparing numbers that are not comparable and
was removed. Time is only credited while the plugin executes -- idle between
server frames is deliberately excluded, so percentages are a share of traced
execution, not of wall time. `windowMs` is the real length of the capture window.

## Error Handling

### Malformed JSON

If the body is not valid JSON, the server logs an error and may:
- Send a diagnostic event to the client
- Close the connection
- Re-sync the buffer and continue

**Example:**

```
Content-Length: 50\r\n
\r\n
{"seq":1,"type":"request","command":"continue"
```

(Missing closing `}`)

**Server-side handling:**

```cpp
try {
  JsonValue msg = JsonParser::Parse(body);
  DAPHandlers::HandleRequest(client, msg);
} catch (const std::exception& e) {
  SendDiagnostic(client, "parse error: " + std::string(e.what()));
  // Optionally close connection
}
```

### Malformed Header

If the header doesn't contain `Content-Length`, the server should:
- Log an error
- Attempt to re-sync the buffer (skip bytes until the next valid header is found)
- Continue processing

**Client-side handling:**

```typescript
private resyncBuffer(): void {
  // Find the next \r\n\r\n (potential next message header)
  const nextHeaderEnd = this.buffer.indexOf("\r\n\r\n", 4);
  if (nextHeaderEnd === -1) {
    this.buffer = Buffer.alloc(0);  // Discard entire buffer
  } else {
    this.buffer = this.buffer.subarray(nextHeaderEnd + 4);
  }
  this.emit("diagnostic", "buffer re-sync: discarded bytes");
}
```

### Unknown Command

If the server receives an unknown `command`, it should:

```cpp
SendResponse(client, req, false, "Unknown command: " + command);
```

### Timeout

If a request isn't responded to within the timeout (default 30 seconds), the client:

```typescript
const timer = setTimeout(() => {
  this.requests.delete(seq);
  reject(new Error(`${command} timeout`));
}, 30000);
```

## Byte-Accurate UTF-8 Handling

### EscapeString (Server-Side)

All string values in JSON responses must be valid UTF-8. The C++ extension uses a custom `EscapeString()` function that:

1. Validates each byte as valid UTF-8
2. Escapes control characters as `\uXXXX`
3. Replaces invalid UTF-8 sequences with U+FFFD (replacement character)

**Implementation (json-utils.cpp):**

```cpp
std::string EscapeString(const char* str, size_t len) {
  std::string result;
  for (size_t i = 0; i < len; ++i) {
    unsigned char c = str[i];
    
    if (c < 0x20) {  // Control character
      // \b, \t, \n, \r, \f mapped to escapes; others to \uXXXX
      if (c == '\b') result += "\\b";
      else if (c == '\t') result += "\\t";
      else if (c == '\n') result += "\\n";
      else if (c == '\r') result += "\\r";
      else if (c == '\f') result += "\\f";
      else {
        char buf[7];
        snprintf(buf, sizeof(buf), "\\u%04x", c);
        result += buf;
      }
    } else if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if ((c & 0x80) == 0) {
      // ASCII
      result += c;
    } else {
      // Multi-byte UTF-8 (0x80-0xFF)
      // Validate the sequence; if invalid, output U+FFFD
      if (IsValidUTF8Sequence(str + i, len - i)) {
        int len = GetUTF8SequenceLength(c);
        for (int j = 0; j < len; ++j) {
          result += str[i++];
        }
        i--;
      } else {
        result += "\xef\xbf\xbd";  // U+FFFD in UTF-8
      }
    }
  }
  return result;
}
```

### Problem: Signed char Bug

**Bug found in early testing:** If `char` is signed, reading bytes in the 0x80-0xFF range produced negative values, breaking the validation logic.

**Fix:** Use `unsigned char` for all byte operations.

### Character Encoding in Messages

All JSON strings in messages are UTF-8 encoded. The Content-Length header counts **bytes**, not characters.

Example:

```cpp
// String with multi-byte UTF-8:
std::string str = "Guild » List";  // "»" is U+00BB = 2 bytes (0xC2 0xBB)
std::string json = R"({"output":"Guild » List"})";

// Content-Length is the byte count of the JSON, not character count
int byte_count = json.length();  // e.g., 28 bytes
```

When this is sent:

```
Content-Length: 28\r\n
\r\n
{"output":"Guild » List"}
```

The client must read exactly 28 bytes (not 27 characters).

---

**Summary of key constraints:**

1. **Content-Length is in BYTES** (not characters)
2. **Slice on bytes**, not character count
3. **Decode to UTF-8 after slicing** bytes
4. **Send continued before SetRunmode**
5. **Events don't require seq**
6. **Validate multi-byte UTF-8** on both sides
7. **Use RequestRegistry** to correlate request/response by seq

