/**
 * Typed access to addons/sourcemod/configs/console-debugger.cfg.
 *
 * The file is a tiny KeyValues-ish document: `"key" "value"` or `key = value`,
 * one per line, `//` comments, whitespace flexible. Every setting the extension
 * reads goes through here -- the port/bind/token used by the TCP server and the
 * debug_log flag used by the console side -- so there is exactly one parser
 * instead of one bespoke scan per setting.
 */
#ifndef _INCLUDE_SPDBG_DAP_CONFIG_H_
#define _INCLUDE_SPDBG_DAP_CONFIG_H_

#include <string>

namespace dap {

// Raw lookup. Returns false when the config file is missing/unreadable or the
// key is absent; *out is only written on success.
bool ConfigLookup(const char* key, std::string* out);

std::string ConfigString(const char* key, const char* fallback);

// Returns fallback when the key is missing or the value is not an integer
// inside [min_value, max_value].
int ConfigInt(const char* key, int fallback, int min_value, int max_value);

// 1/true/yes/on (case-insensitive) enable; anything else disables.
bool ConfigBool(const char* key, bool fallback);

// True for addresses that only accept connections originating on this machine
// (127.0.0.0/8 and "localhost"). Used to decide whether a token is mandatory.
bool IsLoopbackAddress(const std::string& address);

// Length-independent comparison, so a shared secret cannot be recovered one
// byte at a time by timing the reply.
bool SecretEquals(const std::string& a, const std::string& b);

} // namespace dap

#endif // _INCLUDE_SPDBG_DAP_CONFIG_H_
