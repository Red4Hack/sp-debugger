// vim: set sts=2 ts=8 sw=2 tw=99 et:
// =============================================================================
// SourcePawn
// Copyright (C) 2004-2018 AlliedModders LLC.  All rights RESERVED.
// =============================================================================
//
// This program is free software; you can redistribute it and/or modify it under
// the terms of the GNU General Public License, version 3.0, as published by the
// Free Software Foundation.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more
// details.
//
// You should have received a copy of the GNU General Public License along with
// this program.  If not, see <http://www.gnu.org/licenses/>.
//
// As a special exception, AlliedModders LLC gives you permission to link the
// code of this program (as well as its derivative works) to "Half-Life 2," the
// "Source Engine," the "SourcePawn JIT," and any Game MODs that run on software
// by the Valve Corporation.  You must obey the GNU General Public License in
// all respects for all other code used.  Additionally, AlliedModders LLC grants
// this exception to all derivative works.  AlliedModders LLC defines further
// exceptions, found in LICENSE.txt (as of this writing, version JULY-31-2007),
// or <http://www.sourcemod.net/license.php>.

#ifndef SPDBG_SMX_TYPEINFO_H
#define SPDBG_SMX_TYPEINFO_H

#include <assert.h>
#include <stdint.h>

namespace spdbg {

#pragma pack(push)
#pragma pack(1)

// SourcePawn stores run-time type information in a set of additional sections
// defined in the SMX header.
//
// The most important of these is "rtti.data", which is an arbitrary-length
// blob encoding information about complex types, such as arrays and function
// signatures.
//
// Other types, such as enums, have more complex encodings in fixed-length
// tables.

// All row-based RTTI tables have the following layout:
struct smx_rtti_table_header {
    // Size of the header; row data is immediately after.
    uint32_t header_size;

    // Size of each row in the table.
    uint32_t row_size;

    // Number of elements in the table.
    uint32_t row_count;
};

// In some cases, a row will index another table, but that index may be
// optional. Rather than define all tables as 1-indexed, we declare a sentinel
// value kNoTableIndex for optional entries. No index may be equal to or larger
// than this value.
static const uint32_t kNoTableIndex = 0x7fffffff;

// The rtti.enums table has the following row structure:
struct smx_rtti_enum {
    // Index into the names table.
    uint32_t name;

    // Reserved - must be 0.
    uint32_t reserved0;
    uint32_t reserved1;
    uint32_t reserved2;
};

// The rtti.methods table has the following row structure:
struct smx_rtti_method {
    // Index into the name table.
    uint32_t name;

    // Function location, range is [pcode_start, pcode_end).
    uint32_t pcode_start;
    uint32_t pcode_end;

    // Method signature; offset into rtti.data. The encoding at this offset is:
    //    FormalArgs      uint8
    //    LegacyVariadic? uint8
    //    ReturnType      <return-type>
    //    Params*         <param>
    //
    // <return-type> must be kVoid or a <type>.
    // <param> must be: kByRef? <type>
    uint32_t signature;

    // Only present when rtti.methods row_size >= 20 (codeversion 14, typed
    // stack): offset into rtti.data of this method's kLocalSlots list.
    uint32_t locals;
};

// The rtti.natives table has the following row structure. The rows must be
// identical to the native table mapping.
struct smx_rtti_native {
    // Index into the name table.
    uint32_t name;

    // Method signature; see smx_rtti_method::signature.
    uint32_t signature;
};

// The rtti.typedefs table has the following row structure:
struct smx_rtti_typedef {
    // Index into the name table.
    uint32_t name;

    // Type identifier. The type must be a concrete type, not an entry in the
    // typedef table.
    uint32_t type_id;
};

// The rtti.typesets table has the following row structure:
struct smx_rtti_typeset {
    // Index into the name table.
    uint32_t name;

    // Typeset signature; offset into rtti.data. The encoding is:
    //    NumTypes      uint32
    //    Types*        type
    uint32_t signature;
};

// The rtti.enumstructs table has the following row structure:
struct smx_rtti_enumstruct {
    // Index into the name table.
    uint32_t name;

    // First row in the rtti.enumstruct_fields table. Rows up to the next
    // enumstruct's first row, or the end of the enumstruct table, are
    // owned by this entry.
    uint32_t first_field;

    // Size of the enum struct in cells.
    uint32_t size;
};

// The rtti.enumstruct_fields table has the following row structure:
struct smx_rtti_es_field {
    // Index into the name table.
    uint32_t name;

    // Type id.
    uint32_t type_id;

    // Offset from the base address, in bytes.
    uint32_t offset;
};

// The rtti.classdef table has the following row structure:
struct smx_rtti_classdef {
    // Bits 0-1 indicate the definition type.
    uint32_t flags;

    // Index into the name table.
    uint32_t name;

    // First row in the rtti.fields table. Rows up to the next classdef's first
    // row, or the end of the fields table, are owned by this classdef.
    uint32_t first_field;

    // Unused, currently 0.
    uint32_t reserved0;
    uint32_t reserved1;
    uint32_t reserved2;
    uint32_t reserved3;
};

// The rtti.fields table has the following row structure:
struct smx_rtti_field {
    // Currently 0.
    uint16_t flags;

    // Index into the name table.
    uint32_t name;

    // Type id.
    uint32_t type_id;
};

static const uint32_t kClassDefFlags_TypeMask = 0x3;

static const uint32_t kClassDefType_Struct = 0x0;
static const uint32_t kClassDefType_EnumStruct = 0x1;
static const uint32_t kClassDefType_Class = 0x2;

// A type identifier is a 32-bit value encoding a type. It is encoded as
// follows:
//   bits 0-3:  type kind
//   bits 4-31: type payload
//
// The kind is a type signature that can be completely inlined in the
// remaining 28 bits.
static const uint8_t kTypeId_Inline = 0x0;
// The payload is an index into the rtti.data section.
static const uint8_t kTypeId_Complex = 0x1;

static const uint32_t kMaxTypeIdPayload = 0xfffffff;
static const uint32_t kMaxTypeIdKind = 0xf;

static inline uint32_t
MakeTypeId(uint32_t payload, uint8_t kind)
{
    assert(payload <= kMaxTypeIdPayload);
    assert(kind <= kMaxTypeIdKind);
    return (payload << 4) | kind;
}

// These are control bytes for type signatures.
//
// uint32 values are encoded with a variable length encoding:
//   0x00  - 0x7f:    1 byte
//   0x80  - 0x7fff:  2 bytes
//   0x8000 - 0x7fffff: 3 bytes
//   0x800000 - 0x7fffffff: 4 bytes
//   0x80000000 - 0xffffffff: 5 bytes
namespace cb {

// This section encodes raw types.
static const uint8_t kBool = 0x01;
static const uint8_t kInt16 = 0x05;      // SourcePawn 2.0 additions (sp-debugger: read-only)
static const uint8_t kInt32 = 0x06;
static const uint8_t kInt64 = 0x07;
static const uint8_t kIntPtr = 0x08;
static const uint8_t kInt8 = 0x09;
static const uint8_t kFloat32 = 0x0c;
static const uint8_t kFloat64 = 0x0d;
static const uint8_t kChar8 = 0x0e;
static const uint8_t kAny = 0x10;
static const uint8_t kTopFunction = 0x11;
static const uint8_t kTopObject = 0x12;

// This section encodes multi-byte raw types.

// kFixedArray is followed by:
//    Size          uint32
//    Type          <type>
//
// kArray is followed by:
//    Type          <type>
static const uint8_t kFixedArray = 0x30;
static const uint8_t kArray = 0x31;

// kFunction is always followed by the same encoding as in
// smx_rtti_method::signature.
static const uint8_t kFunction = 0x32;
// SourcePawn 2.0: function pointer (followed by an index) and flat array
// (followed by size + type, like kFixedArray).
static const uint8_t kFunctionPtr = 0x33;
static const uint8_t kFlatArray = 0x34;

// Each of these is followed by an index into an appropriate table.
static const uint8_t kEnum = 0x42;       // rtti.enums
static const uint8_t kTypedef = 0x43;    // rtti.typedefs
static const uint8_t kTypeset = 0x44;    // rtti.typesets
static const uint8_t kClassdef = 0x45;   // rtti.classdefs
static const uint8_t kEnumStruct = 0x46; // rtti.enumstructs
static const uint8_t kClass = 0x47;      // SourcePawn 2.0: heap-allocated class

// This section encodes special indicator bytes that can appear within multi-
// byte types.

// For function signatures, indicating no return value.
// Typed-stack methods: kLocalSlots, uint16 count, then one type per slot.
static const uint8_t kLocalSlots = 0x60;
static const uint8_t kVoid = 0x70;
// For functions, indicating the last argument of a function is variadic, and is
// unnamed and untyped.
static const uint8_t kLegacyVariadic = 0x71;
// For parameters, indicating pass-by-ref.
static const uint8_t kByRef = 0x72;
// For reference and compound types, indicating const.
static const uint8_t kConst = 0x73;

} // namespace cb

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// The following tables are extension tables; the VM does not depend on them
// to function correctly.
//
// The new debug tables are:
//    .dbg.methods
//    .dbg.locals
//    .dbg.globals
//
// The methods table only exists to partition the locals table. Each method
// entry owns a contiguous group of rows in the locals table. The locals table
// contains both static and non-static variables.
//
// To find the owner of a global address when in function scope, first static
// methods in debug.methods should be traversed, then the .globals table.

// The ".dbg.methods" describes how to find local variable debug info.
struct smx_rtti_debug_method {
    // Index into the rtti.methods table.
    uint32_t method_index;

    // Index into .dbg.locals of the first local in this method. The number of
    // rows owned by this method can be determined by either:
    //   (1) The next method's first_local value, or
    //   (2) The end of the .locals table if this is the last method.
    uint32_t first_local;

    // SourcePawn 2.0 only (rows are >= 16 bytes there): index into
    // .dbg.method_lines of this method's first line row, and the absolute source
    // line that the method's (relative) line numbers are added to.
    uint32_t first_line;
    uint32_t line_start;
};

// SourcePawn 2.0 ".dbg.method_lines" row: |addr| is relative to the method's
// pcode_start, |line| relative to the debug method's line_start.
struct smx_rtti_debug_line {
    uint16_t addr;
    uint16_t line;
};

// SourcePawn 2.0 "rtti.globals" row. A global's debug address is an index here.
struct smx_rtti_global {
    uint32_t name;
    uint32_t type_id;
    uint32_t flags;
};
static const uint32_t kRttiGlobal_VisibilityMask = 0x3;
static const uint32_t kRttiGlobal_Public = 0x1;

// The ".dbg.locals" and ".dbg.globals" table rows are of the following type:
struct smx_rtti_debug_var {
    // Address, the meaning of which depends on the pcode version and method
    // scope (local, static, global).
    int32_t address;

    // Bits 0-1 encode what kind of variable this is; see kVarClass below.
    uint8_t vclass;

    // Variable name (index into the name table).
    uint32_t name;

    // Scope visibility, [code_start, code_end].
    uint32_t code_start;
    uint32_t code_end;

    // Variable type id.
    uint32_t type_id;
};

// Values for smx_rtti_debug_var::vclass.
static const uint8_t kVarClass_Global = 0x0;
static const uint8_t kVarClass_Local = 0x1;
static const uint8_t kVarClass_Static = 0x2;
static const uint8_t kVarClass_Arg = 0x3;
static const uint8_t kVarClass_Max = kVarClass_Arg;

#pragma pack(pop)

} // namespace spdbg

#endif // SPDBG_SMX_TYPEINFO_H
