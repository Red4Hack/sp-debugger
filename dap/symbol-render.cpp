/**
 * symbol-render.cpp -- DAP variables-view rendering, lifted from the
 * SymbolWrapper methods that used to live in sp-console-debugger/symbols.cpp.
 *
 * The logic is unchanged; the wrapper is now passed in (const SymbolWrapper&)
 * and its private symbol_/debugger_ are reached through the public symbol() /
 * debugger() accessors (aliased locally so the moved bodies stay verbatim).
 * SymbolWrapper::FormatScalar / GetSymbolValue / GetSymbolString / renderType
 * remain on the class and are called as members here.
 */

#include "symbols.h"
#include "debugger.h"
#include "symbol-render.h"
#include <cstdio>
#include <string>

using namespace SourcePawn;

namespace {

// Scalar type label without any array dimensions, used for array element /
// enum-struct field children.
std::string ScalarTypeLabel(const SourcePawn::ISymbolType* type)
{
  if (type->isBoolean()) return "bool";
  if (type->isFloat32()) return "float";
  if (type->isString()) return "char";
  if (type->isInt32()) return "int";
  if (type->isAny()) return "any";
  if (type->isEnum() || type->isEnumStruct() || type->isStruct())
    return type->name() ? type->name() : "enum";
  if (type->isObject()) return "object";
  return "int";
}

} // namespace

namespace dap {

std::string
GetTypeName(const SymbolWrapper& w)
{
  const SourcePawn::IDebugSymbol* symbol_ = w.symbol();
  // renderType with an empty name yields just the type (with array dimensions).
  return w.renderType(symbol_->type(), "");
}

bool
IsExpandable(const SymbolWrapper& w)
{
  const SourcePawn::IDebugSymbol* symbol_ = w.symbol();
  const SourcePawn::ISymbolType* type = symbol_->type();
  // Enum structs always expand into their fields.
  if (type->isEnumStruct())
    return true;
  // One-dimensional, non-string arrays expand into their elements. Strings are
  // shown inline and multi-dimensional arrays are summarised (the legacy VM
  // indexing helpers can't reliably address beyond the first dimension).
  if (type->isArray() && !type->isString() && type->dimcount() == 1 &&
      type->dimension(0) != 1)
    return true;
  return false;
}

std::string
GetSummaryValue(const SymbolWrapper& w)
{
  const SourcePawn::IDebugSymbol* symbol_ = w.symbol();
  Debugger* debugger_ = w.debugger();
  const SourcePawn::ISymbolType* type = symbol_->type();

  // Block-scope visibility check: a Local declared inside a tighter block than
  // the function it lives in goes "(not in scope)" once cip steps past its
  // codeend. This DOES NOT apply to Global/Static: the SourcePawn compiler
  // sets their codestart/codeend to the file's compile range, which does NOT
  // necessarily contain every cip the plugin can execute (callbacks defined
  // later in the file, code in other files, etc.). Without this gate, globals
  // declared in a different file or after the current cip rendered as
  // "(not in scope)" -- the very symptom we hit with g_PlayerPrimary.
  const SourcePawn::SymbolScope scope = symbol_->scope();
  if ((scope == SourcePawn::Local || scope == SourcePawn::Argument) &&
      (debugger_->cip() < symbol_->codestart() ||
       debugger_->cip() > symbol_->codeend())) {
    return "(not in scope)";
  }

  cell_t value;

  // Enum struct: list field name/value pairs.
  if (type->isEnumStruct()) {
    std::string out = "{";
    for (uint32_t i = 0; i < type->esfieldcount(); i++) {
      if (i > 0)
        out += ", ";
      const SourcePawn::IEnumStructField* field = type->esfield(i);
      out += field->name();
      out += ": ";
      if (field->type()->isArray())
        out += "(array)";
      else if (w.GetSymbolValue(field->offset(), &value))
        out += w.FormatScalar(field->type(), value);
      else
        out += "?";
    }
    out += "}";
    return out;
  }

  // One-dimensional string: show the textual contents.
  if (type->isArray() && type->isString() && type->dimcount() == 1) {
    const char* str = w.GetSymbolString();
    if (str == nullptr)
      return "NULL_STRING";
    std::string out = "\"";
    out += str;
    out += "\"";
    return out;
  }

  // One-dimensional array: show the first few elements.
  if (type->isArray() && type->dimcount() == 1) {
    uint32_t total = type->dimension(0);
    uint32_t len = total;
    if (len > 5)
      len = 5;
    else if (len == 0)
      len = 1; // unknown length, assume at least one element

    std::string out = "{";
    for (uint32_t i = 0; i < len; i++) {
      if (i > 0)
        out += ", ";
      if (w.GetSymbolValue(i, &value))
        out += w.FormatScalar(type, value);
      else
        out += "?";
    }
    if (len < total || total == 0)
      out += ", ...";
    out += "}";
    return out;
  }

  // Multi-dimensional array: no reliable inline value, just a marker.
  if (type->isArray())
    return "{...}";

  // Plain scalar.
  if (w.GetSymbolValue(0, &value))
    return w.FormatScalar(type, value);
  return "?";
}

std::vector<ChildVariable>
EnumerateChildren(const SymbolWrapper& w)
{
  const SourcePawn::IDebugSymbol* symbol_ = w.symbol();
  std::vector<ChildVariable> children;
  const SourcePawn::ISymbolType* type = symbol_->type();
  cell_t value;

  // Enum struct -> one child per field.
  if (type->isEnumStruct()) {
    for (uint32_t i = 0; i < type->esfieldcount(); i++) {
      const SourcePawn::IEnumStructField* field = type->esfield(i);
      ChildVariable child;
      child.name = field->name();
      child.type = w.renderType(field->type(), "");
      if (field->type()->isArray())
        child.value = "(array)";
      else if (w.GetSymbolValue(field->offset(), &value))
        child.value = w.FormatScalar(field->type(), value);
      else
        child.value = "?";
      children.push_back(std::move(child));
    }
    return children;
  }

  // One-dimensional non-string array -> one child per element.
  if (type->isArray() && !type->isString() && type->dimcount() == 1) {
    uint32_t total = type->dimension(0);
    // Guard against runaway payloads for very large / unknown-size arrays.
    constexpr uint32_t kMaxElements = 256;
    uint32_t len = total;
    if (len == 0 || len > kMaxElements)
      len = (total == 0) ? 1 : kMaxElements;

    std::string elem_type = ScalarTypeLabel(type);
    for (uint32_t i = 0; i < len; i++) {
      ChildVariable child;
      char namebuf[24];
      snprintf(namebuf, sizeof(namebuf), "[%u]", i);
      child.name = namebuf;
      child.type = elem_type;
      if (w.GetSymbolValue(i, &value))
        child.value = w.FormatScalar(type, value);
      else
        child.value = "?";
      children.push_back(std::move(child));
    }
    if (total > len) {
      ChildVariable more;
      more.name = "[...]";
      more.value = std::to_string(total - len) + " more element(s)";
      more.type = "";
      children.push_back(std::move(more));
    }
    return children;
  }

  return children;
}

} // namespace dap
