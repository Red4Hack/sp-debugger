/**
* vim: set ts=4 :
* =============================================================================
* SourceMod Console Debugger Extension
* Copyright (C) 2018-2021 Peace-Maker  All rights reserved.
* =============================================================================
*
* Per-connection registry that maps DAP variablesReference handles to the
* aggregate variable they expand. Handles are short-lived: they are valid only
* while the debuggee is stopped and are cleared whenever execution resumes.
*
* IMPORTANT: We never cache IDebugSymbol or ISymbolType pointers here -- they
* are owned by the debug-info symbol iterator and may be invalidated between
* requests. Instead we store the root symbol name (plus frame/scope) and
* re-resolve the symbol on demand, exactly like the console watch list does.
*/
#ifndef _INCLUDE_DEBUGGER_VARIABLE_HANDLES_H
#define _INCLUDE_DEBUGGER_VARIABLE_HANDLES_H

#include <string>
#include <unordered_map>

// Variable references below this value are plain scope encodings
// ((frameId+1)*1000 + scopeType); at or above it they are aggregate handles
// allocated by VariableHandleRegistry.
constexpr int kVariableHandleBase = 100000;

struct VariableHandle {
  int frameId = 0;             // DAP frame id the variable belongs to
  int scopeType = 0;          // locals / arguments / globals
  std::string rootSymbolName;  // symbol to re-resolve when expanding
};

class VariableHandleRegistry {
public:
  // Allocate a fresh handle for an expandable variable.
  int Allocate(int frameId, int scopeType, const std::string& symbolName) {
    int handle = next_handle_++;
    handles_[handle] = VariableHandle{frameId, scopeType, symbolName};
    return handle;
  }

  // Look up a previously allocated handle. Returns false if unknown.
  bool Get(int handle, VariableHandle& out) const {
    auto it = handles_.find(handle);
    if (it == handles_.end())
      return false;
    out = it->second;
    return true;
  }

  // True if the reference value denotes a handle (vs. a scope encoding).
  static bool IsHandle(int var_ref) {
    return var_ref >= kVariableHandleBase;
  }

  // Drop every handle. Called whenever the debuggee resumes execution.
  void Clear() {
    handles_.clear();
    next_handle_ = kVariableHandleBase;
  }

private:
  std::unordered_map<int, VariableHandle> handles_;
  int next_handle_ = kVariableHandleBase;
};

#endif // _INCLUDE_DEBUGGER_VARIABLE_HANDLES_H
