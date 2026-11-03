/**
 * breakpoint-eval.cpp -- conditional-breakpoint and logpoint evaluation.
 *
 * Lifted out of sp-console-debugger/breakpoints.cpp (where they were private
 * BreakpointManager methods) so the upstream breakpoint code stays close to
 * peace-maker/sp-console-debugger. The logic is unchanged; the owning Debugger
 * is now passed in (parameter named debugger_ so the moved bodies are verbatim)
 * instead of being a member. Only invoked from CheckBreakpoint when a breakpoint
 * actually matches the current instruction.
 */

// debugger.h pulls in the SourcePawn VM headers (and dap-seam.h) -- include it
// first so cell_t / the SP types are in scope when dap-seam.h is parsed.
#include "debugger.h"
#include "symbols.h"
#include "symbol-render.h"
#include "dap-seam.h"
#include <map>
#include <utility>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <cstdio>

using namespace SourcePawn;

namespace {

void TrimWhitespace(std::string& s)
{
  size_t begin = s.find_first_not_of(" \t");
  if (begin == std::string::npos) {
    s.clear();
    return;
  }
  size_t end = s.find_last_not_of(" \t");
  s = s.substr(begin, end - begin + 1);
}

// Values of every symbol in scope at one stop, captured in a single pass.
//
// Conditions and logpoints are evaluated on the VM thread every time the
// breakpoint's address is reached, and each named operand used to walk the
// whole symbol list on its own. One pass per evaluation is both cheaper and
// consistent: all operands then see the same instant.
struct ScopeSnapshot {
  bool built = false;
  std::map<std::string, std::pair<cell_t, bool>> values;  // name -> (cell, is_float)
};

static void BuildScopeSnapshot(Debugger* debugger_, cell_t cip, cell_t frm, ScopeSnapshot* snapshot)
{
  snapshot->built = true;
  if (!debugger_)
    return;
  SourcePawn::IPluginContext* ctx = debugger_->basectx();
  if (!ctx)
    return;
  SpPluginDebugInfo* debuginfo = SpDebugInfo(ctx->GetRuntime());
  if (!debuginfo)
    return;

  IDebugSymbolIterator* it = debuginfo->CreateSymbolIterator(cip);
  if (!it)
    return;
  while (!it->Done()) {
    const SourcePawn::IDebugSymbol* sym = it->Next();
    if (!sym || !sym->name())
      continue;
    cell_t address;
    if (!sp::ResolveSymbolAddress(ctx, frm, sym, &address))
      continue;
    cell_t* phys = nullptr;
    if (SpLocalToPhys(ctx, address, sizeof(cell_t), &phys) != SP_ERROR_NONE || !phys)
      continue;
    const bool is_float = sym->type() && sym->type()->isFloat32();
    snapshot->values.emplace(sym->name(), std::make_pair(*phys, is_float));
  }
  debuginfo->DestroySymbolIterator(it);
}

// Resolve a single operand token to a cell value, reporting whether it is a
// float so comparisons can use the right interpretation.
bool ResolveOperand(Debugger* debugger_, const std::string& token, cell_t cip, cell_t frm,
                    cell_t* out_value, bool* out_is_float, ScopeSnapshot* snapshot)
{
  *out_is_float = false;
  if (token.empty())
    return false;

  // Numeric literal (integer or float, optional sign)?
  char first = token[0];
  if (std::isdigit(static_cast<unsigned char>(first)) ||
      ((first == '-' || first == '+' || first == '.') && token.size() > 1)) {
    char* end = nullptr;
    if (token.find('.') != std::string::npos) {
      float f = std::strtof(token.c_str(), &end);
      if (end && *end == '\0') {
        *out_value = sp_ftoc(f);
        *out_is_float = true;
        return true;
      }
    }
    end = nullptr;
    long v = std::strtol(token.c_str(), &end, 0);
    if (end && *end == '\0') {
      *out_value = static_cast<cell_t>(v);
      return true;
    }
    // Not a clean number; fall through and try as a name.
  }

  // Variable name: resolve in the scope of the breaking instruction, from the
  // one snapshot taken for this evaluation (built on demand when a caller has
  // no snapshot of its own).
  ScopeSnapshot local;
  if (!snapshot)
    snapshot = &local;
  if (!snapshot->built)
    BuildScopeSnapshot(debugger_, cip, frm, snapshot);

  auto found = snapshot->values.find(token);
  if (found == snapshot->values.end())
    return false;

  *out_value = found->second.first;
  *out_is_float = found->second.second;
  return true;
}

// Render a single logpoint "{expr}" placeholder. Supports a bare variable
// (scalar shows its value; array/string/enum-struct show a {..}/"text" summary),
// an indexed element "name[idx]" (idx = literal or variable), and numeric
// literals. Returns true and fills *out on success.
bool FormatLogExpression(Debugger* debugger_, const std::string& expr, cell_t cip,
                         cell_t frm, std::string* out)
{
  // Split an optional "[index]" suffix: "g_arr[client]" -> base "g_arr",
  // index "client". The index may itself be a literal or a variable.
  std::string base = expr;
  std::string index_expr;
  bool has_index = false;
  size_t lb = expr.find('[');
  if (lb != std::string::npos && expr.back() == ']') {
    base = expr.substr(0, lb);
    index_expr = expr.substr(lb + 1, expr.size() - lb - 2);
    TrimWhitespace(base);
    TrimWhitespace(index_expr);
    has_index = true;
  }

  // A bare numeric literal (or simple arithmetic operand) with no index: keep
  // the existing ResolveOperand behaviour so "{42}" / "{cip}"-style tokens work.
  if (!has_index) {
    char first = base.empty() ? '\0' : base[0];
    if (std::isdigit(static_cast<unsigned char>(first)) ||
        ((first == '-' || first == '+' || first == '.') && base.size() > 1)) {
      cell_t value;
      bool is_float;
      if (ResolveOperand(debugger_, base, cip, frm, &value, &is_float, nullptr)) {
        char buffer[64];
        if (is_float) snprintf(buffer, sizeof(buffer), "%f", sp_ctof(value));
        else          snprintf(buffer, sizeof(buffer), "%d", (int)value);
        *out = buffer;
        return true;
      }
    }
  }

  if (!debugger_)
    return false;
  SourcePawn::IPluginContext* ctx = debugger_->basectx();
  if (!ctx)
    return false;
  SpPluginDebugInfo* debuginfo = SpDebugInfo(ctx->GetRuntime());
  if (!debuginfo)
    return false;

  // Resolve the index (if any) BEFORE we retarget the debugger's eval frame --
  // it must be resolved in the logpoint's own cip/frm.
  cell_t idx_val = 0;
  bool index_ok = false;
  if (has_index) {
    bool idx_is_float;
    index_ok = ResolveOperand(debugger_, index_expr, cip, frm, &idx_val, &idx_is_float, nullptr) &&
               !idx_is_float && idx_val >= 0;
  }

  // Find the named symbol in scope at the breaking instruction.
  IDebugSymbolIterator* it = debuginfo->CreateSymbolIterator(cip);
  if (!it)
    return false;
  const SourcePawn::IDebugSymbol* sym = nullptr;
  while (!it->Done()) {
    const SourcePawn::IDebugSymbol* s = it->Next();
    if (s && s->name() && base == s->name()) { sym = s; break; }
  }

  bool ok = false;
  if (sym) {
    // SymbolWrapper reads the debugger's CURRENT cip/frm (for the in-scope
    // check and for frame-relative local addresses). A logpoint does NOT pause,
    // so those are stale. Point the debugger at the logpoint's (cip, frm) for
    // the duration of the read, then restore -- this makes locals resolve
    // correctly (was showing "(not in scope)") and keeps globals working.
    SourcePawn::IPluginContext* saved_ctx = debugger_->ctx();
    cell_t saved_cip = debugger_->cip();
    cell_t saved_frm = debugger_->frm();
    uint32_t saved_frame = debugger_->selectedframe();
    debugger_->UpdateSelectedContext(debugger_->basectx(), 0, cip, frm);

    SymbolWrapper wrapper(debugger_, sym);
    if (!has_index) {
      // Whole variable: scalar value, or {a, b, ...} / "text" / {field: ..}
      // summary for arrays / strings / enum-structs.
      *out = dap::GetSummaryValue(wrapper);
      ok = true;
    } else if (index_ok) {
      cell_t elem;
      if (wrapper.GetSymbolValue(static_cast<uint32_t>(idx_val), &elem)) {
        // Format the element by the (array's) element type, mirroring how the
        // array preview formats each cell.
        *out = wrapper.FormatScalar(sym->type(), elem);
        ok = true;
      }
    }

    debugger_->UpdateSelectedContext(saved_ctx, saved_frame, saved_cip, saved_frm);
  }
  debuginfo->DestroySymbolIterator(it);
  return ok;
}

// Non-pausing scope snapshot: dump "name=value" for every in-scope variable
// (filtered by want_locals/want_args) at the breaking instruction.
std::string FormatScopeSnapshot(Debugger* debugger_, cell_t cip, cell_t frm,
                                bool want_locals, bool want_args)
{
  if (!debugger_)
    return std::string();
  SourcePawn::IPluginContext* ctx = debugger_->basectx();
  if (!ctx)
    return std::string();
  SpPluginDebugInfo* debuginfo = SpDebugInfo(ctx->GetRuntime());
  if (!debuginfo)
    return std::string();

  IDebugSymbolIterator* it = debuginfo->CreateSymbolIterator(cip);
  if (!it)
    return std::string();

  std::string out;
  while (!it->Done()) {
    const SourcePawn::IDebugSymbol* sym = it->Next();
    if (!sym || !sym->name())
      continue;

    const SourcePawn::SymbolScope scope = sym->scope();
    const bool is_local = (scope == SourcePawn::Local);
    const bool is_arg = (scope == SourcePawn::Argument);
    if (!((is_local && want_locals) || (is_arg && want_args)))
      continue;

    if (!out.empty())
      out += " ";
    out += sym->name();
    out += "=";

    // Read the scalar value at the symbol's frame-relative address. Arrays,
    // strings and other aggregates are reported by kind rather than expanded,
    // keeping the snapshot a single fast, allocation-light line.
    const SourcePawn::ISymbolType* type = sym->type();
    if (type && (type->isArray() || type->isReference())) {
      out += type->isArray() ? "<array>" : "<ref>";
      continue;
    }

    cell_t address = (is_local || is_arg) ? (frm + sym->address()) : sym->address();
    cell_t* phys = nullptr;
    char buffer[64];
    if (SpLocalToPhys(ctx, address, sizeof(cell_t), &phys) == SP_ERROR_NONE && phys) {
      if (type && type->isFloat32())
        snprintf(buffer, sizeof(buffer), "%g", sp_ctof(*phys));
      else
        snprintf(buffer, sizeof(buffer), "%d", (int)*phys);
      out += buffer;
    } else {
      out += "<?>";
    }
  }
  debuginfo->DestroySymbolIterator(it);
  return out;
}

} // namespace

namespace dap {

std::string
FormatLogpointMessage(Debugger* debugger_, const std::string& message, cell_t cip, cell_t frm)
{
  std::string out;
  size_t i = 0;
  while (i < message.size()) {
    if (message[i] == '{') {
      size_t end = message.find('}', i);
      if (end != std::string::npos) {
        std::string expr = message.substr(i + 1, end - i - 1);
        TrimWhitespace(expr);

        // Snapshot tokens dump every in-scope variable in one shot:
        //   {@all}/{@scope} -> arguments + locals
        //   {@args}         -> arguments only
        //   {@locals}       -> locals only
        if (!expr.empty() && expr[0] == '@') {
          std::string kind = expr.substr(1);
          TrimWhitespace(kind);
          const bool args = (kind == "all" || kind == "scope" || kind == "args");
          const bool locals = (kind == "all" || kind == "scope" || kind == "locals");
          if (args || locals)
            out += FormatScopeSnapshot(debugger_, cip, frm, locals, args);
          else
            out += "{" + expr + "}";
          i = end + 1;
          continue;
        }

        std::string rendered;
        if (!expr.empty() && FormatLogExpression(debugger_, expr, cip, frm, &rendered)) {
          out += rendered;
        } else {
          // Unresolved expression: keep it literal so the user sees what failed.
          out += "{" + expr + "}";
        }
        i = end + 1;
        continue;
      }
    }
    out += message[i++];
  }
  return out;
}

bool
EvalBreakpointCondition(Debugger* debugger_, const std::string& condition, cell_t cip, cell_t frm)
{
  // Longest operators first so "<=" wins over "<", etc.
  static const char* kOperators[] = { "==", "!=", "<=", ">=", "<", ">" };

  // One symbol pass for the whole condition, built lazily: a literal-only
  // condition never touches the symbol table at all.
  ScopeSnapshot snapshot;

  for (const char* op : kOperators) {
    size_t pos = condition.find(op);
    if (pos == std::string::npos)
      continue;

    std::string lhs = condition.substr(0, pos);
    std::string rhs = condition.substr(pos + std::strlen(op));
    TrimWhitespace(lhs);
    TrimWhitespace(rhs);

    cell_t lval, rval;
    bool lflt, rflt;
    if (!ResolveOperand(debugger_, lhs, cip, frm, &lval, &lflt, &snapshot))
      return false;
    if (!ResolveOperand(debugger_, rhs, cip, frm, &rval, &rflt, &snapshot))
      return false;

    if (lflt || rflt) {
      float lf = lflt ? sp_ctof(lval) : static_cast<float>(lval);
      float rf = rflt ? sp_ctof(rval) : static_cast<float>(rval);
      if (!std::strcmp(op, "==")) return lf == rf;
      if (!std::strcmp(op, "!=")) return lf != rf;
      if (!std::strcmp(op, "<=")) return lf <= rf;
      if (!std::strcmp(op, ">=")) return lf >= rf;
      if (!std::strcmp(op, "<"))  return lf < rf;
      if (!std::strcmp(op, ">"))  return lf > rf;
    } else {
      if (!std::strcmp(op, "==")) return lval == rval;
      if (!std::strcmp(op, "!=")) return lval != rval;
      if (!std::strcmp(op, "<=")) return lval <= rval;
      if (!std::strcmp(op, ">=")) return lval >= rval;
      if (!std::strcmp(op, "<"))  return lval < rval;
      if (!std::strcmp(op, ">"))  return lval > rval;
    }
    return false;
  }

  // No comparison operator: treat a lone variable/number as truthy.
  cell_t v;
  bool isf;
  if (ResolveOperand(debugger_, condition, cip, frm, &v, &isf, &snapshot))
    return isf ? (sp_ctof(v) != 0.0f) : (v != 0);

  return false;
}

} // namespace dap
