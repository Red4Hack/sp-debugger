/**
 * symbol-render.h -- DAP "variables view" rendering of SourcePawn symbols.
 *
 * These were SymbolWrapper methods in sp-console-debugger/symbols.cpp; every
 * caller is in the DAP crate (the variables/scopes handlers and the logpoint
 * formatter), so they live here as free functions over a SymbolWrapper. The
 * lower-level scalar formatter (SymbolWrapper::FormatScalar) stays on the class
 * because the console value printer uses it too.
 *
 * Crate-internal header: NOT part of the upstream seam (dap-seam.h).
 */

#ifndef _INCLUDE_DAP_SYMBOL_RENDER_H
#define _INCLUDE_DAP_SYMBOL_RENDER_H

#include <string>
#include <vector>

class SymbolWrapper;

// A single child entry produced when expanding an aggregate variable
// (array element or enum-struct field) for the DAP variables view.
struct ChildVariable {
  std::string name;   // "[0]", "[1]", or the field name
  std::string value;  // formatted, human-readable value
  std::string type;   // type name (without the variable name)
};

namespace dap {

// Type name without the variable name (e.g. "int", "float[8]", "MyStruct").
std::string GetTypeName(const SymbolWrapper& w);
// Whether the variable has children worth expanding in the variables tree.
bool IsExpandable(const SymbolWrapper& w);
// Collapsed, one-line value shown next to the variable name.
std::string GetSummaryValue(const SymbolWrapper& w);
// Enumerate the immediate children (array elements / enum-struct fields).
std::vector<ChildVariable> EnumerateChildren(const SymbolWrapper& w);

} // namespace dap

#endif // _INCLUDE_DAP_SYMBOL_RENDER_H
