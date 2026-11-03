// vim: set sts=2 ts=8 sw=2 tw=99 et:
//
// Copyright (C) 2004-2015 AlliedModers LLC
//
// This file is part of SourcePawn. SourcePawn is licensed under the GNU
// General Public License, version 3.0 (GPL). If a copy of the GPL was not
// provided with this file, you can obtain it here:
//   http://www.gnu.org/licenses/gpl.html
//
#include <vector>
#include <utility>

#include <amtl/am-string.h>
#include "smx-v1-image.h"
#include "zlib.h"

using namespace ke;
using namespace spdbg;

SmxV1Image::SmxV1Image(FILE* fp)
 : FileReader(fp)
{
}

SmxV1Image::SmxV1Image(uint8_t* addr, size_t length)
 : FileReader(addr, length)
{
}

SmxV1Image::SmxV1Image(uint8_t* addr, size_t length, void (*dtor)(uint8_t*))
 : FileReader(addr, length, dtor)
{
}

// Validating SMX v1 scripts is fairly expensive. We reserve real validation
// for v2.
bool
SmxV1Image::validate()
{
  if (length_ < sizeof(sp_file_hdr_t))
    return error("bad header");

  hdr_ = (sp_file_hdr_t*)buffer();
  if (hdr_->magic != SmxConsts::FILE_MAGIC)
    return error("bad header");

  switch (hdr_->version) {
    case SmxConsts::SP1_VERSION_1_0:
    case SmxConsts::SP1_VERSION_1_1:
    case SmxConsts::SP1_VERSION_1_7:
      break;
    case SmxConsts::SP2_VERSION_MIN:
      is_v2_ = true;
      break;
    default:
      return error("unsupported version");
  }

  switch (hdr_->compression) {
    case SmxConsts::FILE_COMPRESSION_GZ:
    {
      // We don't support junk in binaries, check that disksize matches the actual file size.
      // (this is to avoid a known crash in inflate() if told that data is bigger than it is)
      if (hdr_->disksize > length_)
        return error("illegal disk size");

      // The start of the compression cannot be larger than the file.
      if (hdr_->dataoffs > length_)
        return error("illegal compressed region");

      // The compressed region must start after the header.
      if (hdr_->dataoffs < sizeof(sp_file_hdr_t))
        return error("illegal compressed region");

      // The full size of the image must be at least as large as the start
      // of the compressed region.
      if (hdr_->imagesize < hdr_->dataoffs)
        return error("illegal image size");

      // Allocate the uncompressed image buffer.
      uint32_t compressedSize = hdr_->disksize - hdr_->dataoffs;
      std::unique_ptr<uint8_t, decltype(&DefaultFree)> uncompressed(
          static_cast<uint8_t*>(malloc(hdr_->imagesize)), DefaultFree);
      if (!uncompressed)
        return error("out of memory");

      // Decompress.
      const uint8_t* src = buffer() + hdr_->dataoffs;
      uint8_t* dest = uncompressed.get() + hdr_->dataoffs;
      uLongf destlen = hdr_->imagesize - hdr_->dataoffs;
      int rv = uncompress(
        (Bytef*)dest,
        &destlen,
        src,
        compressedSize);
      if (rv != Z_OK)
        return error("could not decode compressed region");

      // Copy the initial uncompressed region back in.
      memcpy(uncompressed.get(), buffer(), hdr_->dataoffs);

      // Replace the original buffer.
      length_ = hdr_->imagesize;
      buffer_ = std::move(uncompressed);
      hdr_ = (sp_file_hdr_t*)buffer();
      break;
    }

    case SmxConsts::FILE_COMPRESSION_NONE:
      break;

    default:
      return error("unknown compression type");
  }

  // Validate the string table.
  if (hdr_->stringtab >= length_)
    return error("invalid string table");
  header_strings_ = reinterpret_cast<const char*>(buffer() + hdr_->stringtab);

  // Validate sections header.
  if ((sizeof(sp_file_hdr_t) + hdr_->sections * sizeof(sp_file_section_t)) > length_)
    return error("invalid section table");

  size_t last_header_string = 0;
  const sp_file_section_t* sections =
    reinterpret_cast<const sp_file_section_t*>(buffer() + sizeof(sp_file_hdr_t));
  for (size_t i = 0; i < hdr_->sections; i++) {
    if (sections[i].nameoffs >= (hdr_->dataoffs - hdr_->stringtab))
      return error("invalid section name");

    if (sections[i].nameoffs > last_header_string)
      last_header_string = sections[i].nameoffs;

    sections_.push_back(Section());
    sections_.back().dataoffs = sections[i].dataoffs;
    sections_.back().size = sections[i].size;
    sections_.back().name = header_strings_ + sections[i].nameoffs;
  }

  // Validate sanity of section header strings.
  bool found_terminator = false;
  for (const char* iter = header_strings_ + last_header_string;
       iter < reinterpret_cast<const char*>(buffer() + hdr_->dataoffs);
       iter++)
  {
    if (*iter == '\0') {
      found_terminator = true;
      break;
    }
  }
  if (!found_terminator)
    return error("malformed section names header");

  names_section_ = findSection(".names");
  if (!names_section_)
    return error("could not find .names section");
  if (!validateSection(names_section_))
    return error("invalid names section");
  names_ = reinterpret_cast<const char*>(buffer() + names_section_->dataoffs);

  // The names section must be 0-length or be null-terminated.
  if (names_section_->size != 0 &&
      *(names_ + names_section_->size - 1) != '\0')
  {
    return error("malformed names section");
  }

  if (!validateCode())
    return false;
  if (!validateData())
    return false;
  if (!validatePublics())
    return false;
  if (!validatePubvars())
    return false;
  if (!validateNatives())
    return false;
  if (!validateRtti())
    return false;
  if (!validateDebugInfo())
    return false;
  if (!validateTags())
    return false;

  return true;
}

const SmxV1Image::Section*
SmxV1Image::findSection(const char* name) const
{
  for (size_t i = 0; i < sections_.size(); i++) {
    if (strcmp(sections_[i].name, name) == 0)
      return &sections_[i];
  }
  return nullptr;
}

bool
SmxV1Image::validateSection(const Section* section) const
{
  if (section->dataoffs >= length_)
    return false;
  if (section->size > length_ - section->dataoffs)
    return false;
  return true;
}

bool
SmxV1Image::validateRttiHeader(const Section* section) const
{
  if (!validateSection(section))
    return false;

  const smx_rtti_table_header* header =
    reinterpret_cast<const smx_rtti_table_header*>(buffer() + section->dataoffs);
  if (section->size < sizeof(smx_rtti_table_header))
    return false;
  if (section->size < header->header_size)
    return false;
  if (!IsUint32MultiplySafe(header->row_size, header->row_count))
    return false;

  uint32_t table_size = header->row_size * header->row_count;
  if (!IsUint32AddSafe(table_size, header->header_size))
    return false;
  if (section->size != header->header_size + table_size)
    return false;
  return true;
}

bool
SmxV1Image::validateData()
{
  // .data is required.
  const Section* section = findSection(".data");
  if (!section)
    return error("could not find data");
  if (!validateSection(section))
    return error("invalid data section");

  const sp_file_data_t* data =
    reinterpret_cast<const sp_file_data_t*>(buffer() + section->dataoffs);
  if (data->data > section->size)
    return error("invalid data blob");
  if (data->datasize > (section->size - data->data))
    return error("invalid data blob");

  const uint8_t* blob =
    reinterpret_cast<const uint8_t*>(data) + data->data;
  data_ = Blob<sp_file_data_t>(section, data, blob, data->datasize, 0);
  return true;
}

bool
SmxV1Image::validateCode()
{
  // .code is required.
  const Section* section = findSection(".code");
  if (!section)
    return error("could not find code");
  if (!validateSection(section))
    return error("invalid code section");

  const sp_file_code_t* code =
    reinterpret_cast<const sp_file_code_t*>(buffer() + section->dataoffs);
  if (code->codeversion < SmxConsts::CODE_VERSION_MINIMUM)
    return error("code version is too old, no longer supported");
  // sp-debugger: this copy only READS debug sections; it never executes or
  // verifies bytecode. A newer legacy code version (e.g. SourceMod 1.13's
  // oldspcomp) keeps the same debug-section layout, so don't reject it here --
  // the VM that actually runs the plugin already validated the code.
  if (code->cellsize != 4)
    return error("unsupported cellsize");

  if (code->code > section->size)
    return error("invalid code blob");
  if (code->codesize > (section->size - code->code))
    return error("invalid code blob");

  uint32_t features = 0;
  if (code->codeversion >= SmxConsts::CODE_VERSION_FEATURE_MASK)
    features = code->features;

  const uint8_t* blob =
    reinterpret_cast<const uint8_t*>(code) + code->code;
  code_ = Blob<sp_file_code_t>(section, code, blob, code->codesize, features);
  return true;
}

bool
SmxV1Image::validatePublics()
{
  const Section* section = findSection(".publics");
  if (!section)
    return true;
  if (!validateSection(section))
    return error("invalid .publics section");
  if ((section->size % sizeof(sp_file_publics_t)) != 0)
    return error("invalid .publics section");

  const sp_file_publics_t* publics =
    reinterpret_cast<const sp_file_publics_t*>(buffer() + section->dataoffs);
  size_t length = section->size / sizeof(sp_file_publics_t);

  for (size_t i = 0; i < length; i++) {
    if (!validateName(publics[i].name))
      return error("invalid public name");
  }

  publics_ = List<sp_file_publics_t>(publics, length);
  return true;
}

bool
SmxV1Image::validatePubvars()
{
  const Section* section = findSection(".pubvars");
  if (!section)
    return true;
  if (!validateSection(section))
    return error("invalid .pubvars section");
  if ((section->size % sizeof(sp_file_pubvars_t)) != 0)
    return error("invalid .pubvars section");

  const sp_file_pubvars_t* pubvars =
    reinterpret_cast<const sp_file_pubvars_t*>(buffer() + section->dataoffs);
  size_t length = section->size / sizeof(sp_file_pubvars_t);

  for (size_t i = 0; i < length; i++) {
    if (!validateName(pubvars[i].name))
      return error("invalid pubvar name");
  }

  pubvars_ = List<sp_file_pubvars_t>(pubvars, length);
  return true;
}

bool
SmxV1Image::validateNatives()
{
  const Section* section = findSection(".natives");
  if (!section)
    return true;
  if (!validateSection(section))
    return error("invalid .natives section");
  if ((section->size % sizeof(sp_file_natives_t)) != 0)
    return error("invalid .natives section");

  const sp_file_natives_t* natives =
    reinterpret_cast<const sp_file_natives_t*>(buffer() + section->dataoffs);
  size_t length = section->size / sizeof(sp_file_natives_t);

  for (size_t i = 0; i < length; i++) {
    if (!validateName(natives[i].name))
      return error("invalid native name");
  }

  natives_ = List<sp_file_natives_t>(natives, length);
  return true;
}

bool
SmxV1Image::validateName(size_t offset) const
{
  return offset < names_section_->size;
}

bool
SmxV1Image::validateRtti()
{
  const Section* rtti_data = findSection("rtti.data");
  if (!rtti_data)
    return true;
  if (!validateSection(rtti_data))
    return error("invalid rtti.data section");

  const uint8_t* blob =
    reinterpret_cast<const uint8_t*>(buffer() + rtti_data->dataoffs);
  rtti_data_ = std::make_unique<const RttiData>(blob, rtti_data->size);

  const char* mandatory_tables[] = {
    "rtti.methods",
    "rtti.natives",
  };
  for (size_t i = 0; i < (is_v2_ ? 1 : 2); i++) {
    const char* table_name = mandatory_tables[i];
    const Section* section = findSection(table_name);
    if (!section) {
      error_ = StringPrintf("missing %s section", table_name);
      return false;
    }
    if (!validateRttiHeader(section)) {
      error_ = StringPrintf("could not validate %s section", table_name);
      return false;
    }
  }

  rtti_methods_ = findRttiSection("rtti.methods");
  if (!validateRttiMethods())
    return false;

  rtti_natives_ = findRttiSection("rtti.natives");
  if (rtti_natives_ && !validateRttiNatives())
    return false;

  const char* optional_tables[] = {
    "rtti.classdefs",
    "rtti.enums",
    "rtti.enumstructs",
    "rtti.enumstruct_fields",
    "rtti.fields",
    "rtti.typedefs",
    "rtti.typesets",
    "rtti.globals",
  };
  for (size_t i = 0; i < sizeof(optional_tables) / sizeof(optional_tables[0]); i++) {
    const char* table_name = optional_tables[i];
    const Section* section = findSection(table_name);
    if (!section)
      continue;
    if (!validateRttiHeader(section)) {
      error_ = StringPrintf("could not validate %s section", table_name);
      return false;
    }
  }

  rtti_enums_ = findRttiSection("rtti.enums");
  if (rtti_enums_ && !validateRttiEnums())
    return false;

  rtti_enumstruct_fields_ = findRttiSection("rtti.enumstruct_fields");
  rtti_enumstructs_ = findRttiSection("rtti.enumstructs");
  if (rtti_enumstructs_ && !validateRttiEnumStructs())
    return false;

  rtti_fields_ = findRttiSection("rtti.fields");
  rtti_classdefs_ = findRttiSection("rtti.classdefs");
  if (rtti_classdefs_ && !validateRttiClassdefs())
    return false;

  rtti_typedefs_ = findRttiSection("rtti.typedefs");
  if (rtti_typedefs_ && !validateRttiTypedefs())
    return false;

  rtti_typesets_ = findRttiSection("rtti.typesets");
  if (rtti_typesets_ && !validateRttiTypesets())
    return false;

  rtti_globals_ = findRttiSection("rtti.globals");
  if (rtti_globals_ && !validateRttiGlobals())
    return false;
  if (is_v2_ && !computeGlobalOffsets())
    return false;

  return true;
}

bool
SmxV1Image::validateRttiEnums()
{
  for (uint32_t i = 0; i < rtti_enums_->row_count; i++) {
    const smx_rtti_enum* enumType = getRttiRow<smx_rtti_enum>(rtti_enums_, i);
    if (!validateName(enumType->name))
      return error("invalid enum name");
  }
  return true;
}

bool
SmxV1Image::validateRttiEnumStructs()
{
  if (!rtti_enumstruct_fields_)
    return error("rtti.enumstruct_fields section missing");

  for (uint32_t i = 0; i < rtti_enumstructs_->row_count; i++) {
    const smx_rtti_enumstruct* enumstruct = getRttiRow<smx_rtti_enumstruct>(rtti_enumstructs_, i);
    if (!validateName(enumstruct->name))
      return error("invalid enum struct name");

    // Calculate how many fields this enumstruct has.
    uint32_t stopat = rtti_enumstruct_fields_->row_count;
    if (i != rtti_enumstructs_->row_count - 1) {
      const smx_rtti_enumstruct* next_enumstruct = getRttiRow<smx_rtti_enumstruct>(rtti_enumstructs_, i + 1);
      stopat = next_enumstruct->first_field;
    }
    if (enumstruct->first_field >= stopat)
      return error("invalid enum struct fields boundary");

    for (uint32_t j = enumstruct->first_field; j < stopat; j++) {
      if (!validateRttiEnumStructField(enumstruct, j))
        return false;
    }
  }
  return true;
}

bool
SmxV1Image::validateRttiEnumStructField(const smx_rtti_enumstruct* enumstruct, uint32_t index)
{
  if (index >= rtti_enumstruct_fields_->row_count)
    return error("invalid enum struct field index");

  const smx_rtti_es_field* field = getRttiRow<smx_rtti_es_field>(rtti_enumstruct_fields_, index);
  if (!validateName(field->name))
    return error("invalid enum struct field name");
  if (field->offset >= enumstruct->size * 4)
    return error("invalid enum struct field offset");
  if (!rtti_data_->validateType(field->type_id))
    return error("invalid enum struct field type");
  return true;
}

bool
SmxV1Image::validateRttiClassdefs()
{
  if (!rtti_fields_)
    return error("rtti.fields section missing");

  for (uint32_t i = 0; i < rtti_classdefs_->row_count; i++) {
    const smx_rtti_classdef* classdef = getRttiRow<smx_rtti_classdef>(rtti_classdefs_, i);
    // TODO: Validate flags.
    if (!validateName(classdef->name))
      return error("invalid classdef name");

    // Calculate how many fields this class has.
    uint32_t stopat = rtti_fields_->row_count;
    if (i != rtti_classdefs_->row_count - 1) {
      const smx_rtti_classdef* next_classdef = getRttiRow<smx_rtti_classdef>(rtti_classdefs_, i + 1);
      stopat = next_classdef->first_field;
    }
    if (classdef->first_field > stopat)
      return error("invalid classdef fields boundary");

    for (uint32_t j = classdef->first_field; j < stopat; j++) {
      if (!validateRttiField(j))
        return false;
    }
  }
  return true;
}

bool
SmxV1Image::validateRttiField(uint32_t index)
{
  if (index >= rtti_fields_->row_count)
    return error("invalid classdef field index");

  // TODO: Validate flags.
  const smx_rtti_field* field = getRttiRow<smx_rtti_field>(rtti_fields_, index);
  if (!validateName(field->name))
    return error("invalid classdef field name");
  if (!rtti_data_->validateType(field->type_id))
    return error("invalid classdef field type");
  return true;
}

bool
SmxV1Image::validateRttiMethods()
{
  for (uint32_t i = 0; i < rtti_methods_->row_count; i++) {
    const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, i);
    if (!validateName(method->name))
      return error("invalid method name");
    if (!rtti_data_->validateFunctionOffset(method->signature))
      return error("invalid method signature type offset");
    if (method->pcode_start > method->pcode_end)
      return error("invalid method code range");
    if (method->pcode_start >= code_.header()->size)
      return error("invalid method code start");
    if (method->pcode_end > code_.header()->size)
      return error("invalid method code end");
  }
  return true;
}

bool
SmxV1Image::validateRttiNatives()
{
  for (uint32_t i = 0; i < rtti_natives_->row_count; i++) {
    const smx_rtti_native* native = getRttiRow<smx_rtti_native>(rtti_natives_, i);
    if (!validateName(native->name))
      return error("invalid native name");
    if (!rtti_data_->validateFunctionOffset(native->signature))
      return error("invalid native type offset");
  }
  return true;
}

bool
SmxV1Image::validateRttiTypedefs()
{
  for (uint32_t i = 0; i < rtti_typedefs_->row_count; i++) {
    const smx_rtti_typedef* typedefType = getRttiRow<smx_rtti_typedef>(rtti_typedefs_, i);
    if (!validateName(typedefType->name))
      return error("invalid typedef name");
    if (!rtti_data_->validateType(typedefType->type_id))
      return error("invalid typedef type");
  }
  return true;
}

bool
SmxV1Image::validateRttiTypesets()
{
  for (uint32_t i = 0; i < rtti_typesets_->row_count; i++) {
    const smx_rtti_typeset* typesetType = getRttiRow<smx_rtti_typeset>(rtti_typesets_, i);
    if (!validateName(typesetType->name))
      return error("invalid typeset name");
    if (!rtti_data_->validateTypesetOffset(typesetType->signature))
      return error("invalid typeset signatures");
  }
  return true;
}

bool
SmxV1Image::validateDebugInfo()
{
  const Section* dbginfo = findSection(".dbg.info");
  if (!dbginfo)
    return true;
  if (!validateSection(dbginfo))
    return error("invalid .dbg.info section");

  debug_info_ =
    reinterpret_cast<const sp_fdbg_info_t*>(buffer() + dbginfo->dataoffs);

  // Pre-RTTI, the debug tables used a separate string table. That is no longer
  // the case, but we support both scenarios.
  debug_names_section_ = findSection(".dbg.strings");
  if (debug_names_section_) {
    if (!validateSection(debug_names_section_))
      return error("invalid .dbg.strings section");
    debug_names_ = reinterpret_cast<const char*>(buffer() + debug_names_section_->dataoffs);

    // Name tables must be null-terminated.
    if (debug_names_section_->size != 0 &&
        *(debug_names_ + debug_names_section_->size - 1) != '\0')
    {
      return error("invalid .dbg.strings section");
    }
  } else {
    debug_names_section_ = names_section_;
    debug_names_ = names_;
  }

  const Section* files = findSection(".dbg.files");
  if (!files)
    return error("no debug file table");
  if (!validateSection(files))
    return error("invalid debug file table");
  if (files->size < sizeof(sp_fdbg_file_t) * debug_info_->num_files)
    return error("invalid debug file table size");
  debug_files_ = List<sp_fdbg_file_t>(
    reinterpret_cast<const sp_fdbg_file_t*>(buffer() + files->dataoffs),
    debug_info_->num_files);

  // SourcePawn 2.0 has no flat line table: lines live per method in
  // .dbg.method_lines.
  const Section* lines = findSection(".dbg.lines");
  if (!lines && !is_v2_)
    return error("no debug lines table");
  if (lines) {
    if (!validateSection(lines))
      return error("invalid debug lines table");
    if (lines->size < sizeof(sp_fdbg_line_t) * debug_info_->num_lines)
      return error("invalid debug lines table size");
    debug_lines_ = List<sp_fdbg_line_t>(
      reinterpret_cast<const sp_fdbg_line_t*>(buffer() + lines->dataoffs),
      debug_info_->num_lines);
  }

  debug_symbols_section_ = findSection(".dbg.symbols");
  if (debug_symbols_section_) {
    if (!validateSection(debug_symbols_section_))
      return error("invalid debug symbol table");
  } else {
    // New debug symbol tables are optional, but if present, they need to be
    // coherent.
    if (const Section* globals = findSection(".dbg.globals")) {
      if (!validateRttiHeader(globals))
        return error("invalid debug globals table");
      rtti_dbg_globals_ = toRttiTable(globals);
      if (true && !validateDebugVariables(rtti_dbg_globals_))
        return false;
    }
    if (const Section* locals = findSection(".dbg.locals")) {
      if (!validateRttiHeader(locals))
        return error("invalid debug locals table");
      rtti_dbg_locals_ = toRttiTable(locals);
      if (true && !validateDebugVariables(rtti_dbg_locals_))
        return false;
    }
    if (const Section* method_lines = findSection(".dbg.method_lines")) {
      if (!validateRttiHeader(method_lines))
        return error("invalid debug method lines table");
      rtti_dbg_method_lines_ = toRttiTable(method_lines);
      if (rtti_dbg_method_lines_->row_size < sizeof(smx_rtti_debug_line))
        return error("invalid debug method lines row size");
    }
    if (const Section* methods = findSection(".dbg.methods")) {
      if (!validateRttiHeader(methods))
        return error("invalid debug methods table");
      rtti_dbg_methods_ = toRttiTable(methods);
      if (true && !validateDebugMethods())
        return false;
    }
  }

  if (debug_symbols_section_) {
    // See the note about unpacked debug sections in smx-headers.h.
    if (hdr_->version == SmxConsts::SP1_VERSION_1_0 &&
        !findSection(".dbg.natives"))
    {
      debug_syms_unpacked_ =
        reinterpret_cast<const sp_u_fdbg_symbol_t*>(buffer() + debug_symbols_section_->dataoffs);
      if (true && !validateLegacyDebugSymbols<sp_u_fdbg_symbol_t, sp_u_fdbg_arraydim_s>())
        return false;
    } else {
      debug_syms_ =
        reinterpret_cast<const sp_fdbg_symbol_t*>(buffer() + debug_symbols_section_->dataoffs);
      if (true && !validateLegacyDebugSymbols<sp_fdbg_symbol_t, sp_fdbg_arraydim_s>())
        return false;
    }
  }

  return true;
}

bool
SmxV1Image::validateDebugVariables(const smx_rtti_table_header* rtti_table)
{
  for (uint32_t i = 0; i < rtti_table->row_count; i++) {
    const smx_rtti_debug_var* debug_var = getRttiRow<smx_rtti_debug_var>(rtti_table, i);
    if (debug_var->vclass > kVarClass_Max)
      return error("invalid debug variable class");
    if (!validateName(debug_var->name))
      return error("invalid debug variable name");
    if (debug_var->code_start > debug_var->code_end)
      return error("invalid debug variable code range");
    if (debug_var->code_start >= code_.header()->size)
      return error("invalid debug variable code start");
    if (debug_var->code_end > code_.header()->size)
      return error("invalid debug variable code end");
    if (!rtti_data_->validateType(debug_var->type_id))
      return error("invalid debug variable type");
    const spdbg::debug::Rtti* rtti_type = rtti_data_->typeFromTypeId(debug_var->type_id);
    if (!validateSymbolAddress(debug_var->address, debug_var->vclass, rtti_type))
      return false;
  }
  return true;
}

bool
SmxV1Image::validateSymbolAddress(int32_t address, uint8_t vclass, const spdbg::debug::Rtti* rtti_type)
{
  switch (vclass) {
  case kVarClass_Global:
  case kVarClass_Static:
    if (is_v2_) {
      // 2.0: the address is an index into rtti.globals.
      if (rtti_globals_ && (uint32_t)address >= rtti_globals_->row_count)
        return error(StringPrintf("invalid global variable index %x", address).c_str());
      break;
    }
    if ((uint32_t)address >= HeapSize() && !rtti_type->isConst())
      return error(StringPrintf("invalid global variable address %x >= %zx", address, HeapSize()).c_str());
    break;
  case kVarClass_Local:
    // Code version 14 (typed stack, SourceMod 1.13's oldspcomp) flips the sign
    // convention: locals are >= 0 and arguments <= 0.
    if (code_->codeversion >= 14) {
      if (address < 0 && !rtti_type->isConst())
        return error(StringPrintf("invalid local variable address %x < 0", address).c_str());
    } else if (address > 0 && !rtti_type->isConst()) {
      return error(StringPrintf("invalid local variable address %x > 0", address).c_str());
    }
    break;
  case kVarClass_Arg:
    if (code_->codeversion >= 14) {
      if (address > 0)
        return error(StringPrintf("invalid argument address %x > 0", address).c_str());
    } else if (address <= 0) {
      return error(StringPrintf("invalid argument address %x <= 0", address).c_str());
    }
  }
  return true;
}

bool
SmxV1Image::validateDebugMethods()
{
  for (uint32_t i = 0; i < rtti_dbg_methods_->row_count; i++) {
    const smx_rtti_debug_method* debug_method = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, i);
    if (debug_method->method_index >= rtti_methods_->row_count)
      return error("invalid debug method index");
    if (rtti_dbg_locals_ && debug_method->first_local > rtti_dbg_locals_->row_count)
      return error("invalid first local index");
    if (rtti_dbg_method_lines_) {
      if (rtti_dbg_methods_->row_size < sizeof(smx_rtti_debug_method))
        return error("invalid debug methods row size");
      if (debug_method->first_line > rtti_dbg_method_lines_->row_count)
        return error("invalid first line index");
    }
  }
  return true;
}

bool
SmxV1Image::validateDebugName(size_t offset)
{
  return offset < debug_names_section_->size;
}

template<typename SymbolType, typename DimType>
bool
SmxV1Image::validateLegacyDebugSymbols()
{
  const uint8_t* cursor = buffer() + debug_symbols_section_->dataoffs;
  const uint8_t* cursor_end = cursor + debug_symbols_section_->size;
  uint32_t count = 0;
  while (cursor < cursor_end) {
    if (cursor + sizeof(SymbolType) > cursor_end)
      return error("truncated debug symbol table");
    const SymbolType* sym = reinterpret_cast<const SymbolType*>(cursor);
    if (!validateDebugName(sym->name))
      return error("invalid debug symbol name");
    if (sym->vclass > VCLASS_MAX)
      return error("invalid debug symbol vclass");
    if (sym->ident > IDENT_VARARGS)
      return error("invalid debug symbol ident");
    if (!validateLegacySymbolAddress(sym->addr, sym->vclass, sym->ident))
      return error("invalid debug symbol address");
    //if (sym->codestart > sym->codeend)
    //  return error("invalid debug symbol code range");
    //if (sym->codestart > code_.header()->size)
    //  return error("invalid debug symbol code start");
    if (sym->codeend > code_.header()->size)
      return error("invalid debug symbol code end");
    if (sym->dimcount > MAX_LEGACY_DIMENSIONS)
      return error("invalid debug symbol dimension count");
    if (!validateTag(sym->tagid))
      return error("invalid debug symbol tag");
    cursor += sizeof(SymbolType);
    for (uint32_t j = 0; j < sym->dimcount; j++) {
      if (cursor + sizeof(DimType) > cursor_end)
        return error("truncated debug symbol table");
      const DimType* dim = reinterpret_cast<const DimType*>(cursor);
      if (!validateTag(dim->tagid))
        return error("invalid debug symbol dimension tag");
      cursor += sizeof(DimType);
    }
    count++;
  }
  if (count < debug_info_->num_syms)
    return error("invalid debug symbol table");
  return true;
}

bool
SmxV1Image::validateLegacySymbolAddress(int32_t address, uint8_t vclass, uint8_t ident)
{
  // Function symbol addresses are in the .code section.
  if (ident == IDENT_FUNCTION) {
      if (vclass == VCLASS_GLOBAL && (uint32_t)address < code_.header()->size)
        return true;
      return false;
  }

  // All other symbols must be in the .data section.
  switch (vclass) {
  case VCLASS_GLOBAL:
  case VCLASS_STATIC:
    if ((uint32_t)address >= HeapSize())
      return false;
    break;
  case VCLASS_LOCAL:
    // Can't validate relative stack offsets.
    break;
  }
  return true;
}

bool
SmxV1Image::validateTags()
{
  const Section* section = findSection(".tags");
  if (!section)
    return true;
  if (!validateSection(section))
    return error("invalid .tags section");
  if ((section->size % sizeof(sp_file_tag_t)) != 0)
    return error("invalid .tags section");

  const sp_file_tag_t* tags =
    reinterpret_cast<const sp_file_tag_t*>(buffer() + section->dataoffs);
  size_t length = section->size / sizeof(sp_file_tag_t);

  for (size_t i = 0; i < length; i++) {
    if (!validateName(tags[i].name))
      return error("invalid tag name");
  }

  tags_ = List<sp_file_tag_t>(tags, length);
  return true;
}

bool
SmxV1Image::validateTag(int16_t tagid)
{
  if (!tags_.exists())
    return true;
  if (tagid < 0 || tagid >= (int16_t)tags_.length())
    return false;
  return (tags_[tagid].tag_id & ~0xFF000000) == tagid;
}

auto
SmxV1Image::DescribeCode() const -> Code
{
  Code code;
  code.bytes = code_.blob();
  code.length = code_.length();
  code.version = code_->codeversion;
  code.features = code_.features();
  return code;
}

auto
SmxV1Image::DescribeData() const -> Data
{
  Data data;
  data.bytes = data_.blob();
  data.length = data_.length();
  return data;
}

size_t
SmxV1Image::NumNatives() const
{
  return natives_.length();
}

const char*
SmxV1Image::GetNative(size_t index) const
{
  assert(index < natives_.length());
  return names_ + natives_[index].name;
}

bool
SmxV1Image::FindNative(const char* name, size_t* indexp) const
{
  for (size_t i = 0; i < natives_.length(); i++) {
    const char* candidate = names_ + natives_[i].name;
    if (strcmp(candidate, name) == 0) {
      if (indexp)
        *indexp = i;
      return true;
    }
  }
  return false;
}

size_t
SmxV1Image::NumPublics() const
{
  return publics_.length();
}

void
SmxV1Image::GetPublic(size_t index, uint32_t* offsetp, const char** namep) const
{
  assert(index < publics_.length());
  if (offsetp)
    *offsetp = publics_[index].address;
  if (namep)
    *namep = names_ + publics_[index].name;
}

bool
SmxV1Image::FindPublic(const char* name, size_t* indexp) const
{
  int high = publics_.length() - 1;
  int low = 0;
  while (low <= high) {
    int mid = (low + high) / 2;
    const char* candidate = names_ + publics_[mid].name;
    int diff = strcmp(candidate, name);
    if (diff == 0) {
      if (indexp) {
        *indexp = mid;
        return true;
      }
    }
    if (diff < 0)
      low = mid + 1;
    else
      high = mid - 1;
  }
  return false;
}

size_t
SmxV1Image::NumPubvars() const
{
  return pubvars_.length();
}

void
SmxV1Image::GetPubvar(size_t index, uint32_t* offsetp, const char** namep) const
{
  assert(index < pubvars_.length());
  if (offsetp)
    *offsetp = pubvars_[index].address;
  if (namep)
    *namep = names_ + pubvars_[index].name;
}

bool
SmxV1Image::FindPubvar(const char* name, size_t* indexp) const
{
  int high = pubvars_.length() - 1;
  int low = 0;
  while (low <= high) {
    int mid = (low + high) / 2;
    const char* candidate = names_ + pubvars_[mid].name;
    int diff = strcmp(candidate, name);
    if (diff == 0) {
      if (indexp) {
        *indexp = mid;
        return true;
      }
    }
    if (diff < 0)
      low = mid + 1;
    else
      high = mid - 1;
  }
  return false;
}

size_t
SmxV1Image::HeapSize() const
{
  return data_->memsize;
}

size_t
SmxV1Image::ImageSize() const
{
  return length_;
}

const char*
SmxV1Image::LookupFile(uint32_t addr) const
{
  int high = debug_files_.length();
  int low = -1;

  while (high - low > 1) {
    int mid = (low + high) / 2;
    if (debug_files_[mid].addr <= addr)
      low = mid;
    else
      high = mid;
  }

  if (low == -1)
    return nullptr;
  if (debug_files_[low].name >= debug_names_section_->size)
    return nullptr;

  return debug_names_ + debug_files_[low].name;
}

template <typename SymbolType, typename DimType>
const char*
SmxV1Image::lookupFunction(const SymbolType* syms, uint32_t addr) const
{
  const uint8_t* cursor = reinterpret_cast<const uint8_t*>(syms);
  const uint8_t* cursor_end = cursor + debug_symbols_section_->size;
  for (uint32_t i = 0; i < debug_info_->num_syms; i++) {
    if (cursor + sizeof(SymbolType) > cursor_end)
      break;

    const SymbolType* sym = reinterpret_cast<const SymbolType*>(cursor);
    if (sym->ident == spdbg::IDENT_FUNCTION &&
        sym->codestart <= addr &&
        sym->codeend > addr)
    {
      if (sym->name >= debug_names_section_->size)
        return nullptr;
      return debug_names_ + sym->name;
    }

    if (sym->dimcount > 0)
      cursor += sizeof(DimType) * sym->dimcount;
    cursor += sizeof(SymbolType);
  }
  return nullptr;
}

const char*
SmxV1Image::LookupFunction(uint32_t code_offset) const
{
  if (auto method = GetMethodRttiByOffset(code_offset))
    return names_ + method->name;

  if (debug_syms_) {
    auto name = lookupFunction<sp_fdbg_symbol_t, sp_fdbg_arraydim_t>(debug_syms_, code_offset);
    if (name)
      return name;
  }
  if (debug_syms_unpacked_) {
    auto name =
      lookupFunction<sp_u_fdbg_symbol_t, sp_u_fdbg_arraydim_t>(debug_syms_unpacked_, code_offset);
    if (name)
      return name;
  }

  for (size_t i = 0; i < publics_.length(); i++) {
    if (code_offset == publics_[i].address)
      return names_ + publics_[i].name;
  }

  return nullptr;
}

int32_t
SmxV1Image::FrameOffsetOf(const smx_rtti_debug_var* var) const
{
  const int32_t address = var->address;
  if (is_v2_)
    return frameOffsetV2(var);
  if (!code_.header() || code_->codeversion < 14)
    return address;

  switch (var->vclass) {
  case kVarClass_Arg:
    // MethodInfo::StackOffset: slot -n -> (n - 1 + 3) cells above the frame.
    if (address < 0)
      return (-address - 1 + 3) * int32_t(sizeof(cell_t));
    return address;
  case kVarClass_Local:
  {
    if (address < 0 || !rtti_methods_ || rtti_methods_->row_size < 20)
      return address;
    const smx_rtti_method* method = GetMethodRttiByOffset(var->code_start);
    if (!method || !rtti_data_)
      return address;
    std::vector<uint8_t> sizes;
    if (!rtti_data_->localSlotSizes(method->locals, &sizes) || size_t(address) >= sizes.size())
      return address;
    int32_t offset = 0;
    for (size_t i = 0; i <= size_t(address); i++)
      offset -= sizes[i];
    return offset;
  }
  }
  return address;
}

bool
SmxV1Image::HasRtti() const
{
  return rtti_data_ != nullptr;
}

const smx_rtti_method*
SmxV1Image::GetMethodRttiByOffset(uint32_t pcode_offset) const
{
  if (!rtti_methods_)
    return nullptr;

  for (uint32_t i = 0; i < rtti_methods_->row_count; i++) {
    const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, i);
    if (method->pcode_start <= pcode_offset && method->pcode_end > pcode_offset)
      return method;
  }
  return nullptr;
}

bool
SmxV1Image::LookupLine(uint32_t addr, uint32_t* line) const
{
  if (rtti_dbg_method_lines_)
    return lookupLineV2(addr, line);

  int high = debug_lines_.length();
  int low = -1;

  while (high - low > 1) {
    int mid = (low + high) / 2;
    if (debug_lines_[mid].addr <= addr)
      low = mid;
    else
      high = mid;
  }

  if (low == -1)
    return false;

  // Lines are zero-indexed for some reason.
  *line = debug_lines_[low].line + 1;
  return true;
}

size_t
SmxV1Image::NumFiles() const
{
  return debug_files_.length();
}

const char*
SmxV1Image::GetFileName(size_t index) const
{
  if (index >= debug_files_.length())
    return nullptr;

  if (debug_files_[index].name >= debug_names_section_->size)
    return nullptr;

  return debug_names_ + debug_files_[index].name;
}

template <typename SymbolType, typename DimType>
uint32_t
SmxV1Image::getFunctionCount(const SymbolType* syms) const {
  const uint8_t* cursor = reinterpret_cast<const uint8_t*>(syms);
  const uint8_t* cursor_end = cursor + debug_symbols_section_->size;
  uint32_t func_count = 0;
  for (uint32_t i = 0; i < debug_info_->num_syms; i++) {
    if (cursor + sizeof(SymbolType) > cursor_end)
      break;

    const SymbolType* sym = reinterpret_cast<const SymbolType*>(cursor);
    if (sym->ident == spdbg::IDENT_FUNCTION)
        func_count++;

    if (sym->dimcount > 0)
      cursor += sizeof(DimType) * sym->dimcount;
    cursor += sizeof(SymbolType);
  }
  return func_count;
}

size_t
SmxV1Image::NumFunctions() const {
	if (rtti_methods_) {
		return rtti_methods_->row_count;
	}

  // Count function symbols once.
  static uint32_t num_debug_functions = 0;
  if (num_debug_functions == 0) {
    if (debug_syms_)
      num_debug_functions = getFunctionCount<sp_fdbg_symbol_t, sp_fdbg_arraydim_t>(debug_syms_);
    else
      num_debug_functions = getFunctionCount<sp_u_fdbg_symbol_t, sp_u_fdbg_arraydim_t>(debug_syms_unpacked_);
  }
  return num_debug_functions;
}

template <typename SymbolType, typename DimType>
const char*
SmxV1Image::getFunctionName(const SymbolType* syms, const char** filename, uint32_t index) const {
  const uint8_t* cursor = reinterpret_cast<const uint8_t*>(syms);
  const uint8_t* cursor_end = cursor + debug_symbols_section_->size;
  uint32_t func_count = 0;
  for (uint32_t i = 0; i < debug_info_->num_syms; i++) {
    if (cursor + sizeof(SymbolType) > cursor_end)
      break;

    const SymbolType* sym = reinterpret_cast<const SymbolType*>(cursor);
    if (sym->ident == spdbg::IDENT_FUNCTION) {
      if (func_count == index) {
        if (filename)
          *filename = LookupFile(sym->addr);
        if (sym->name < debug_names_section_->size)
          return debug_names_ + sym->name;
        return nullptr;
      }
      func_count++;
    }

    if (sym->dimcount > 0)
      cursor += sizeof(DimType) * sym->dimcount;
    cursor += sizeof(SymbolType);
  }
  return nullptr;
}

const char*
SmxV1Image::GetFunctionName(size_t index, const char** filename) const {
  if (rtti_methods_) {
    if (index >= rtti_methods_->row_count)
      return nullptr;

    const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, index);
    if (filename)
      *filename = LookupFile(method->pcode_start);
    return names_ + method->name;
  }

  if (debug_syms_) {
    return getFunctionName<sp_fdbg_symbol_t, sp_fdbg_arraydim_t>(debug_syms_, filename, index);
  } else {
    return getFunctionName<sp_u_fdbg_symbol_t, sp_u_fdbg_arraydim_t>(debug_syms_unpacked_, filename, index);
  }
}

template <typename SymbolType, typename DimType>
bool
SmxV1Image::getFunctionAddress(const SymbolType* syms, const char* function, ucell_t* funcaddr, size_t index) const
{
  const uint8_t* cursor = reinterpret_cast<const uint8_t *>(syms);
  const uint8_t* cursor_end = cursor + debug_symbols_section_->size;
  for (size_t i = index; i < debug_info_->num_syms; i++) {
    if (cursor + sizeof(SymbolType) > cursor_end)
      break;

    const SymbolType *sym = reinterpret_cast<const SymbolType *>(cursor);
    if (sym->ident == spdbg::IDENT_FUNCTION &&
        sym->name < debug_names_section_->size &&
        !strcmp(debug_names_ + sym->name, function))
    {
      *funcaddr = sym->addr;
      return true;
    }

    if (sym->dimcount > 0)
      cursor += sizeof(DimType) * sym->dimcount;
    cursor += sizeof(SymbolType);
  }
  return false;
}

bool
SmxV1Image::LookupFunctionAddress(const char* function, const char* file, ucell_t* funcaddr) const
{
  *funcaddr = 0;
  if (rtti_methods_) {
    for (uint32_t i = 0; i < rtti_methods_->row_count; i++) {
      const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, i);
      const char* name = names_ + method->name;
      if (strcmp(name, function) != 0)
        continue;

      *funcaddr = method->pcode_start;
      // verify that this function is defined in the appropriate file
      const char* tgtfile = LookupFile(*funcaddr);
      if (tgtfile != nullptr && !strcmp(file, tgtfile))
        break;
    }
  } else {
    for (;;) {
      // find (next) matching function
      uint32_t index = 0;
      if (debug_syms_) {
        getFunctionAddress<sp_fdbg_symbol_t, sp_fdbg_arraydim_t>(debug_syms_, function, funcaddr, index);
      } else {
        getFunctionAddress<sp_u_fdbg_symbol_t, sp_u_fdbg_arraydim_t>(debug_syms_unpacked_, function, funcaddr, index);
      }

      if (index >= debug_info_->num_syms)
        return false;

      // verify that this function is defined in the appropriate file
      const char* tgtfile = LookupFile(*funcaddr);
      if (tgtfile != nullptr && strcmp(file, tgtfile) == 0)
        break;
      index++;
      assert(index < debug_info_->num_syms);
    }
  }

  if (rtti_dbg_method_lines_) {
    // 2.0: the first breakable address is the method's first line-table row.
    uint32_t dm_row, line_row;
    if (!findDebugMethodRow(*funcaddr, &dm_row) || !findDebugLineRow(dm_row, 0, &line_row))
      return false;
    const smx_rtti_debug_method* dm = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, dm_row);
    const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, dm->method_index);
    *funcaddr = method->pcode_start +
                getRttiRow<smx_rtti_debug_line>(rtti_dbg_method_lines_, line_row)->addr;
    return true;
  }

  // now find the first line in the function where we can "break" on
  uint32_t index = 0;
  for (; index < debug_info_->num_lines && debug_lines_[index].addr < *funcaddr; index++)
    continue;

  if (index >= debug_info_->num_lines)
    return false;

  *funcaddr = debug_lines_[index].addr;
  return true;
}

bool
SmxV1Image::LookupLineAddress(const uint32_t line, const char* filename, uint32_t* addr) const
{
  // Find a suitable "breakpoint address" close to the indicated line (and in
  // the specified file). The address is moved up to the next "breakable" line
  // if no "breakpoint" is available on the specified line. You can use function
  // LookupLine() to find out at which precise line the breakpoint was set.

  // The filename comparison is strict (case sensitive and path sensitive).
  *addr = 0;
  if (rtti_dbg_method_lines_)
    return lookupLineAddressV2(line, filename, addr);

  uint32_t bottomaddr, topaddr;
  uint32_t file;
  uint32_t index = 0;
  for (file = 0; file < debug_info_->num_files; file++) {
    // find the (next) matching instance of the file
    if (debug_files_[file].name >= debug_names_section_->size ||
        strcmp(debug_names_ + debug_files_[file].name, filename) != 0)
    {
      continue;
    }

    // get address range for the current file
    bottomaddr = debug_files_[file].addr;
    topaddr = (file + 1 < debug_info_->num_files) ? debug_files_[file + 1].addr : (uint32_t)-1;

    // go to the starting address in the line table
    while (index < debug_info_->num_lines && debug_lines_[index].addr < bottomaddr)
      index++;

    // browse until the line is found or until the top address is exceeded
    while (index < debug_info_->num_lines &&
           debug_lines_[index].line < line &&
           debug_lines_[index].addr < topaddr)
    {
      index++;
    }

    if (index >= debug_info_->num_lines)
      return false;
    if (debug_lines_[index].line >= line)
      break;

    // if not found (and the line table is not yet exceeded) try the next
    // instance of the same file (a file may appear twice in the file table)
  }
  if (file >= debug_info_->num_files)
    return false;

  assert(index < debug_info_->num_lines);
  *addr = debug_lines_[index].addr;
  return true;
}

const char*
SmxV1Image::GetName(uint32_t nameoffs) const
{
  if (nameoffs >= names_section_->size)
    return nullptr;
  return names_ + nameoffs;
}

const char*
SmxV1Image::GetDebugName(uint32_t nameoffs) const
{
  if (nameoffs >= debug_names_section_->size)
    return nullptr;
  return debug_names_ + nameoffs;
}

const sp_file_tag_t*
SmxV1Image::GetTagById(uint32_t tag) const
{
  unsigned int index;
  for (index = 0; index < tags_.length() && TAGID(tags_[index].tag_id) != tag; index++)
    continue;
  if (index >= tags_.length())
    return nullptr;

  return &tags_[index];
}

SourcePawn::IDebugSymbolIterator*
SmxV1Image::SymbolIterator(ucell_t addr)
{
  if (debug_symbols_section_)
    return new SmxV1LegacySymbolIterator(this, addr);
  return new SmxV1SymbolIterator(this, addr);
}

bool
SmxV1Image::validateRttiGlobals()
{
  for (uint32_t i = 0; i < rtti_globals_->row_count; i++) {
    const smx_rtti_global* global = getRttiRow<smx_rtti_global>(rtti_globals_, i);
    if (!validateName(global->name))
      return error("invalid global name");
    if (!rtti_data_ || !rtti_data_->validateType(global->type_id))
      return error("invalid global type");
  }
  return true;
}

// ---- SourcePawn 2.0 type sizes (mirror of TypeDesc::slot_size/element_size) ----

uint32_t
SmxV1Image::ClassdefSize(uint32_t index, int depth) const
{
  const smx_rtti_classdef* classdef = GetRttiClassdef(index);
  if (!classdef || !rtti_fields_ || !rtti_data_ || depth > 8)
    return 0;
  uint32_t stop = GetRttiClassdefLastFieldIndex(index);
  uint32_t size = 0;
  for (uint32_t f = classdef->first_field; f < stop; f++) {
    const smx_rtti_field* field = GetRttiField(f);
    if (!field)
      break;
    std::unique_ptr<const Rtti> type(rtti_data_->typeFromTypeId(field->type_id));
    size += type ? SlotSizeOf(type.get(), depth + 1) : sizeof(cell_t);
    size = (size + 3) & ~3u;
  }
  return size;
}

uint32_t
SmxV1Image::ElementSizeOf(const Rtti* type, int depth) const
{
  switch (type->type()) {
  case cb::kInt64:
  case cb::kFloat64:
    return 8;
  case cb::kIntPtr:
    return sizeof(intptr_t);
  case cb::kChar8:
  case cb::kInt8:
    return 1;
  case cb::kInt16:
    return 2;
  case cb::kEnumStruct:
  case cb::kClassdef:
  case cb::kClass:
  {
    const smx_rtti_classdef* classdef = GetRttiClassdef(type->index());
    if (!classdef || (classdef->flags & kClassDefFlags_TypeMask) == kClassDefType_Class)
      return sizeof(uint32_t);
    return ClassdefSize(type->index(), depth);
  }
  default:
    return sizeof(int32_t);
  }
}

uint32_t
SmxV1Image::SlotSizeOf(const Rtti* type, int depth) const
{
  switch (type->type()) {
  case cb::kInt64:
  case cb::kFloat64:
    return 8;
  case cb::kIntPtr:
    return sizeof(intptr_t);
  case cb::kFlatArray:
  {
    uint32_t elt = type->inner() ? ElementSizeOf(type->inner(), depth) : sizeof(cell_t);
    return (type->index() * elt + 3) & ~3u;
  }
  case cb::kEnumStruct:
  case cb::kClassdef:
  case cb::kClass:
  {
    const smx_rtti_classdef* classdef = GetRttiClassdef(type->index());
    if (!classdef || (classdef->flags & kClassDefFlags_TypeMask) == kClassDefType_Class)
      return sizeof(int32_t);
    return ClassdefSize(type->index(), depth);
  }
  default:
    return sizeof(int32_t);
  }
}

bool
SmxV1Image::computeGlobalOffsets()
{
  global_offsets_.clear();
  globals_bytes_ = 0;
  if (!rtti_globals_ || !rtti_data_)
    return true;

  uint32_t total = 0;
  for (uint32_t i = 0; i < rtti_globals_->row_count; i++) {
    const smx_rtti_global* global = getRttiRow<smx_rtti_global>(rtti_globals_, i);
    std::unique_ptr<const Rtti> type(rtti_data_->typeFromTypeId(global->type_id));
    global_offsets_.push_back(total);
    total += type ? SlotSizeOf(type.get()) : sizeof(cell_t);
  }
  globals_bytes_ = total;
  return true;
}

bool
SmxV1Image::GlobalOffset(uint32_t index, uint32_t* offset) const
{
  if (index >= global_offsets_.size())
    return false;
  *offset = global_offsets_[index];
  return true;
}

bool
SmxV1Image::PublicGlobalAt(uint32_t n, const char** name, uint32_t* offset) const
{
  if (!rtti_globals_)
    return false;
  uint32_t seen = 0;
  for (uint32_t i = 0; i < rtti_globals_->row_count && i < global_offsets_.size(); i++) {
    const smx_rtti_global* global = getRttiRow<smx_rtti_global>(rtti_globals_, i);
    if ((global->flags & kRttiGlobal_VisibilityMask) != kRttiGlobal_Public)
      continue;
    if (seen++ == n) {
      *name = names_ + global->name;
      *offset = global_offsets_[i];
      return true;
    }
  }
  return false;
}

bool
SmxV1Image::FindPublicGlobal(const char** name, uint32_t* index) const
{
  if (!rtti_globals_)
    return false;
  for (uint32_t i = 0; i < rtti_globals_->row_count; i++) {
    const smx_rtti_global* global = getRttiRow<smx_rtti_global>(rtti_globals_, i);
    if ((global->flags & kRttiGlobal_VisibilityMask) == kRttiGlobal_Public) {
      *name = names_ + global->name;
      *index = i;
      return true;
    }
  }
  return false;
}

// ---- SourcePawn 2.0 debug-variable addresses ----
// Arguments and locals live in virtual registers, one cell per register, at the
// start of the frame; reported as the register's byte offset from the frame
// base. Globals are reported as a byte offset into the global buffer.

int32_t
SmxV1Image::frameOffsetV2(const smx_rtti_debug_var* var) const
{
  const int32_t address = var->address;
  switch (var->vclass & 3) {
  case kVarClass_Global:
  case kVarClass_Static:
  {
    uint32_t offset;
    if (address >= 0 && GlobalOffset((uint32_t)address, &offset))
      return (int32_t)offset;
    return address;
  }
  case kVarClass_Arg:
    // Argument -n is register n-1.
    if (address < 0)
      return (-address - 1) * (int32_t)sizeof(cell_t);
    return address;
  case kVarClass_Local:
  {
    if (address < 0 || !rtti_methods_ || !rtti_data_ || rtti_methods_->row_size < 20)
      return address;
    const smx_rtti_method* method = GetMethodRttiByOffset(var->code_start);
    if (!method)
      return address;

    std::unique_ptr<const Rtti> signature(rtti_data_->functionTypeFromOffset(method->signature));
    std::vector<std::unique_ptr<const Rtti>> types;
    if (!signature || !rtti_data_->localSlotTypes(method->locals, &types) ||
        size_t(address) >= types.size())
    {
      return address;
    }

    // Registers: all arguments first (one cell each), then the locals in order.
    uint32_t cells = (uint32_t)signature->argCount();
    for (size_t i = 0; i < size_t(address); i++)
      cells += SlotSizeOf(types[i].get()) / sizeof(cell_t);
    return (int32_t)(cells * sizeof(cell_t));
  }
  }
  return address;
}

// ---- SourcePawn 2.0 line tables ----

bool
SmxV1Image::findDebugMethodRow(uint32_t pcode_offset, uint32_t* row) const
{
  if (!rtti_dbg_methods_ || !rtti_methods_)
    return false;

  int low = 0;
  int high = (int)rtti_dbg_methods_->row_count - 1;
  while (low <= high) {
    int mid = (low + high) / 2;
    const smx_rtti_debug_method* dm = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, mid);
    if (dm->method_index >= rtti_methods_->row_count)
      return false;
    const smx_rtti_method* m = getRttiRow<smx_rtti_method>(rtti_methods_, dm->method_index);
    if (pcode_offset >= m->pcode_start && pcode_offset < m->pcode_end) {
      *row = (uint32_t)mid;
      return true;
    }
    if (pcode_offset < m->pcode_start)
      high = mid - 1;
    else
      low = mid + 1;
  }
  return false;
}

void
SmxV1Image::debugLineRange(uint32_t dm_row, uint32_t* first, uint32_t* end) const
{
  const smx_rtti_debug_method* dm = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, dm_row);
  *first = dm->first_line;
  *end = rtti_dbg_method_lines_->row_count;
  if (dm_row + 1 < rtti_dbg_methods_->row_count) {
    uint32_t next = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, dm_row + 1)->first_line;
    if (next < *end)
      *end = next;
  }
}

// Last row of the method whose (relative) address is <= rel_addr.
bool
SmxV1Image::findDebugLineRow(uint32_t dm_row, uint32_t rel_addr, uint32_t* out) const
{
  uint32_t first, end;
  debugLineRange(dm_row, &first, &end);
  if (first >= end)
    return false;

  int low = (int)first - 1;
  int high = (int)end;
  while (high - low > 1) {
    int mid = (low + high) / 2;
    const smx_rtti_debug_line* row = getRttiRow<smx_rtti_debug_line>(rtti_dbg_method_lines_, mid);
    if (row->addr <= rel_addr)
      low = mid;
    else
      high = mid;
  }
  if (low < (int)first)
    return false;
  *out = (uint32_t)low;
  return true;
}

bool
SmxV1Image::IsLineBoundaryV2(uint32_t addr) const
{
  if (!rtti_dbg_method_lines_)
    return false;
  uint32_t dm_row, line_row;
  if (!findDebugMethodRow(addr, &dm_row))
    return false;
  const smx_rtti_debug_method* dm = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, dm_row);
  const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, dm->method_index);
  uint32_t rel = addr - method->pcode_start;
  if (!findDebugLineRow(dm_row, rel, &line_row))
    return false;
  return getRttiRow<smx_rtti_debug_line>(rtti_dbg_method_lines_, line_row)->addr == rel;
}

bool
SmxV1Image::lookupLineV2(uint32_t addr, uint32_t* line) const
{
  uint32_t dm_row, line_row;
  if (!findDebugMethodRow(addr, &dm_row))
    return false;
  const smx_rtti_debug_method* dm = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, dm_row);
  const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, dm->method_index);
  if (!findDebugLineRow(dm_row, addr - method->pcode_start, &line_row))
    return false;
  *line = dm->line_start + getRttiRow<smx_rtti_debug_line>(rtti_dbg_method_lines_, line_row)->line;
  return true;
}

// The lowest line >= |line| that has code in |filename|, and the address of that
// line. Rows that share an address with a later row never win a LookupLine(), so
// they are not breakpoint candidates.
bool
SmxV1Image::lookupLineAddressV2(uint32_t line, const char* filename, uint32_t* addr) const
{
  *addr = 0;
  if (!rtti_dbg_methods_ || !rtti_methods_)
    return false;

  bool found = false;
  uint32_t best_line = 0, best_addr = 0;
  for (uint32_t file = 0; file < debug_files_.length(); file++) {
    if (debug_files_[file].name >= debug_names_section_->size ||
        strcmp(debug_names_ + debug_files_[file].name, filename) != 0)
    {
      continue;
    }
    uint32_t bottom = debug_files_[file].addr;
    uint32_t top = (file + 1 < debug_files_.length()) ? debug_files_[file + 1].addr : (uint32_t)-1;

    for (uint32_t i = 0; i < rtti_dbg_methods_->row_count; i++) {
      const smx_rtti_debug_method* dm = getRttiRow<smx_rtti_debug_method>(rtti_dbg_methods_, i);
      if (dm->method_index >= rtti_methods_->row_count)
        continue;
      const smx_rtti_method* method = getRttiRow<smx_rtti_method>(rtti_methods_, dm->method_index);
      if (method->pcode_start < bottom || method->pcode_start >= top)
        continue;

      uint32_t first, end;
      debugLineRange(i, &first, &end);
      for (uint32_t r = first; r < end; r++) {
        const smx_rtti_debug_line* row = getRttiRow<smx_rtti_debug_line>(rtti_dbg_method_lines_, r);
        if (r + 1 < end &&
            getRttiRow<smx_rtti_debug_line>(rtti_dbg_method_lines_, r + 1)->addr == row->addr)
        {
          continue;
        }
        // |line| is 0-based (callers pass line - 1, as for 1.x debug info);
        // the 2.0 tables hold 1-based source lines.
        uint32_t abs_line = dm->line_start + row->line;
        if (abs_line < line + 1)
          continue;
        uint32_t abs_addr = method->pcode_start + row->addr;
        if (!found || abs_line < best_line || (abs_line == best_line && abs_addr < best_addr)) {
          found = true;
          best_line = abs_line;
          best_addr = abs_addr;
        }
      }
    }
  }
  if (!found)
    return false;
  *addr = best_addr;
  return true;
}

const smx_rtti_field*
SmxV1Image::GetRttiField(uint32_t index) const
{
  if (!rtti_fields_ || index >= rtti_fields_->row_count)
    return nullptr;
  return getRttiRow<smx_rtti_field>(rtti_fields_, index);
}

uint32_t
SmxV1Image::GetRttiClassdefLastFieldIndex(uint32_t index) const
{
  if (!rtti_classdefs_ || !rtti_fields_)
    return 0;
  if (index + 1 < rtti_classdefs_->row_count)
    return getRttiRow<smx_rtti_classdef>(rtti_classdefs_, index + 1)->first_field;
  return rtti_fields_->row_count;
}

const smx_rtti_classdef*
SmxV1Image::GetRttiClassdef(uint32_t index) const
{
  if (!rtti_classdefs_)
    return nullptr;
  if (index >= rtti_classdefs_->row_count)
    return nullptr;

  return getRttiRow<smx_rtti_classdef>(rtti_classdefs_, index);
}

const smx_rtti_enum*
SmxV1Image::GetRttiEnum(uint32_t index) const
{
  if (!rtti_enums_)
    return nullptr;
  if (index >= rtti_enums_->row_count)
    return nullptr;

  return getRttiRow<smx_rtti_enum>(rtti_enums_, index);
}

const smx_rtti_enumstruct*
SmxV1Image::GetRttiEnumStruct(uint32_t index) const
{
  if (!rtti_enumstructs_)
    return nullptr;
  if (index >= rtti_enumstructs_->row_count)
    return nullptr;

  return getRttiRow<smx_rtti_enumstruct>(rtti_enumstructs_, index);
}

uint32_t
SmxV1Image::GetRttiEnumStructLastFieldIndex(uint32_t index) const
{
  const smx_rtti_enumstruct* next_enumstruct = GetRttiEnumStruct(index + 1);
  if (next_enumstruct)
    return next_enumstruct->first_field;
  else if (rtti_enumstruct_fields_)
    return rtti_enumstruct_fields_->row_count;
  return 0;
}

const smx_rtti_es_field*
SmxV1Image::GetRttiEnumStructField(uint32_t index) const {
    if (!rtti_enumstruct_fields_)
        return nullptr;
    if (index >= rtti_enumstruct_fields_->row_count)
        return nullptr;

    return getRttiRow<smx_rtti_es_field>(rtti_enumstruct_fields_, index);
}

const smx_rtti_native*
SmxV1Image::GetRttiNative(uint32_t index) const
{
  if (!rtti_natives_)
    return nullptr;
  if (index >= rtti_natives_->row_count)
    return nullptr;

  return getRttiRow<smx_rtti_native>(rtti_natives_, index);
}

const smx_rtti_typedef*
SmxV1Image::GetRttiTypedef(uint32_t index) const
{
  if (!rtti_typedefs_)
    return nullptr;
  if (index >= rtti_typedefs_->row_count)
    return nullptr;

  return getRttiRow<smx_rtti_typedef>(rtti_typedefs_, index);
}

const smx_rtti_typeset*
SmxV1Image::GetRttiTypeset(uint32_t index) const
{
  if (!rtti_typesets_)
    return nullptr;
  if (index >= rtti_typesets_->row_count)
    return nullptr;

  return getRttiRow<smx_rtti_typeset>(rtti_typesets_, index);
}

