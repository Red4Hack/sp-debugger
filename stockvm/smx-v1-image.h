// vim: set sts=2 ts=8 sw=2 tw=99 et:
//
// Copyright (C) 2004-2015 AlliedModers LLC
//
// This file is part of SourcePawn. SourcePawn is licensed under the GNU
// General Public License, version 3.0 (GPL). If a copy of the GPL was not
// provided with this file, you can obtain it here:
//   http://www.gnu.org/licenses/gpl.html
//
#ifndef SPDBG_SMX_PARSER_H
#define SPDBG_SMX_PARSER_H

#include <stdio.h>
#include "smx/smx-headers.h"
#include "smx/smx-legacy-debuginfo.h"
#include "smx/smx-typeinfo.h"
#include "smx/smx-v1.h"
#include <amtl/am-string.h>
#include <amtl/am-vector.h>
#include <sp_vm_types.h>
#include "file-utils.h"
#include "legacy-image.h"
#include "rtti.h"
#include "smx-v1-debug-symbols.h"

#include <memory>

namespace spdbg {

using namespace debug;

class SmxV1Image
  : public FileReader,
    public LegacyImage
{
 friend SmxV1SymbolIterator;
 friend SmxV1LegacySymbolIterator;
 public:
  SmxV1Image(FILE* fp);
  SmxV1Image(uint8_t* addr, size_t length);
  SmxV1Image(uint8_t* addr, size_t length, void (*dtor)(uint8_t*));

  // This must be called to initialize the reader.
  bool validate();

  const sp_file_hdr_t* hdr() const {
    return hdr_;
  }

  const char* errorMessage() const {
    return error_.c_str();
  }

 public:
  Code DescribeCode() const override;
  Data DescribeData() const override;
  size_t NumNatives() const override;
  const char* GetNative(size_t index) const override;
  bool FindNative(const char* name, size_t* indexp) const override;
  size_t NumPublics() const override;
  void GetPublic(size_t index, uint32_t* offsetp, const char** namep) const override;
  bool FindPublic(const char* name, size_t* indexp) const override;
  size_t NumPubvars() const override;
  void GetPubvar(size_t index, uint32_t* offsetp, const char** namep) const override;
  bool FindPubvar(const char* name, size_t* indexp) const override;
  size_t HeapSize() const override;
  size_t ImageSize() const override;
  const char* LookupFile(uint32_t code_offset) const override;
  const char* LookupFunction(uint32_t code_offset) const override;
  bool LookupLine(uint32_t code_offset, uint32_t* line) const override;
  bool LookupFunctionAddress(const char* function, const char* file, ucell_t* addr) const override;
  bool LookupLineAddress(const uint32_t line, const char* file, ucell_t* addr) const override;
  size_t NumFiles() const override;
  const char* GetFileName(size_t index) const override;
  size_t NumFunctions() const override;
  const char* GetFunctionName(size_t index, const char** filename) const override;
  SourcePawn::IDebugSymbolIterator* SymbolIterator(ucell_t addr) override;
  const sp_file_tag_t* GetTagById(uint32_t tagid) const;
  const char* GetName(uint32_t nameoffs) const;
  const char* GetDebugName(uint32_t nameoffs) const;
  bool HasRtti() const override;
  const smx_rtti_method* GetMethodRttiByOffset(uint32_t pcode_offset) const override;

  const smx_rtti_classdef* GetRttiClassdef(uint32_t index) const;
  const smx_rtti_field* GetRttiField(uint32_t index) const;
  uint32_t GetRttiClassdefLastFieldIndex(uint32_t index) const;

  // SourcePawn 2.0 (SMX 0x200) support. A v2 image has no publics/natives, takes
  // line numbers from .dbg.method_lines and keys global debug symbols by index
  // into rtti.globals.
  bool IsV2() const { return is_v2_; }
  // SourcePawn 2.0: does a source line start exactly at pcode |addr|? Same rule
  // as the VM's SmxImage::IsLineBoundary().
  bool IsLineBoundaryV2(uint32_t addr) const;
  // Bytes a value of |type| takes up in a frame slot / global slot, or as an
  // array element, exactly as the 2.0 VM lays them out (TypeDesc::slot_size()
  // and element_size()).
  uint32_t SlotSizeOf(const Rtti* type, int depth = 0) const;
  uint32_t ElementSizeOf(const Rtti* type, int depth = 0) const;
  uint32_t ClassdefSize(uint32_t index, int depth = 0) const;
  uint32_t NumGlobals() const { return (uint32_t)global_offsets_.size(); }
  // Byte offset of rtti global |index| from the start of the runtime's global
  // buffer, and its total size.
  bool GlobalOffset(uint32_t index, uint32_t* offset) const;
  uint32_t GlobalsByteSize() const { return globals_bytes_; }
  // A global flagged public (its address is queryable through the runtime).
  bool FindPublicGlobal(const char** name, uint32_t* index) const;
  // The |n|th public global: its name and byte offset in the global buffer.
  bool PublicGlobalAt(uint32_t n, const char** name, uint32_t* offset) const;
  const smx_rtti_enum* GetRttiEnum(uint32_t index) const;
  const smx_rtti_enumstruct* GetRttiEnumStruct(uint32_t index) const;
  uint32_t GetRttiEnumStructLastFieldIndex(uint32_t index) const;
  const smx_rtti_es_field* GetRttiEnumStructField(uint32_t index) const;
  const smx_rtti_native* GetRttiNative(uint32_t index) const;
  const smx_rtti_typedef* GetRttiTypedef(uint32_t index) const;
  const smx_rtti_typeset* GetRttiTypeset(uint32_t index) const;

 private:
  SmxV1Image();

  struct Section
  {
    const char* name;
    uint32_t dataoffs;
    uint32_t size;
  };
  const Section* findSection(const char* name) const;

 public:
  template <typename T>
  class Blob
  {
   public:
    Blob()
     : header_(nullptr),
       section_(nullptr),
       blob_(nullptr),
       length_(0),
       features_(0)
    {}
    Blob(const Section* header,
         const T* section,
         const uint8_t* blob,
         size_t length,
         uint32_t features)
     : header_(header),
       section_(section),
       blob_(blob),
       length_(length),
       features_(features)
    {}

    size_t size() const {
      return section_->size;
    }
    const T * operator ->() const {
      return section_;
    }
    const uint8_t* blob() const {
      return blob_;
    }
    size_t length() const {
      return length_;
    }
    bool exists() const {
      return !!header_;
    }
    uint32_t features() const {
      return features_;
    }
    const Section* header() const {
      return header_;
    }

   private:
    const Section* header_;
    const T* section_;
    const uint8_t* blob_;
    size_t length_;
    uint32_t features_;
  };

  template <typename T>
  class List
  {
   public:
    List()
     : section_(nullptr),
       length_(0)
    {}
    List(const T* section, size_t length)
     : section_(section),
       length_(length)
    {}

    size_t length() const {
      return length_;
    }
    const T& operator[](size_t index) const {
      assert(index < length());
      return section_[index];
    }
    bool exists() const {
      return !!section_;
    }

   private:
    const T* section_;
    size_t length_;
  };

 public:
  const Blob<sp_file_code_t>& code() const {
    return code_;
  }
  const Blob<sp_file_data_t>& data() const {
    return data_;
  }
  const List<sp_file_publics_t>& publics() const {
    return publics_;
  }
  const List<sp_file_natives_t>& natives() const {
    return natives_;
  }
  const List<sp_file_pubvars_t>& pubvars() const {
    return pubvars_;
  }
  // Debug-variable address as a frame-relative byte offset, the way the legacy
  // (1.12) debug info reports it. Code version 14 (typed stack, SourceMod
  // 1.13's oldspcomp) stores a SLOT INDEX instead: arguments are -1, -2, ...
  // and locals 0, 1, ... in declaration order. Anything else is returned as is.
  int32_t FrameOffsetOf(const smx_rtti_debug_var* var) const;

  const RttiData* rttidata() const {
    return rtti_data_.get();
  }

 protected:
  bool error(const char* msg) {
    error_ = msg;
    return false;
  }
  bool validateName(size_t offset) const;
  bool validateSection(const Section* section) const;
  bool validateRttiHeader(const Section* section) const;
  bool validateCode();
  bool validateData();
  bool validatePublics();
  bool validatePubvars();
  bool validateNatives();
  bool validateRtti();
  bool validateRttiClassdefs();
  bool validateRttiEnums();
  bool validateRttiEnumStructs();
  bool validateRttiEnumStructField(const smx_rtti_enumstruct* enumstruct, uint32_t index);
  bool validateRttiField(uint32_t index);
  bool validateRttiMethods();
  bool validateRttiNatives();
  bool validateRttiTypedefs();
  bool validateRttiTypesets();
  bool validateDebugInfo();
  bool validateDebugVariables(const smx_rtti_table_header* rtti_table);
  bool validateDebugMethods();
  bool validateSymbolAddress(int32_t address, uint8_t vclass, const spdbg::debug::Rtti* rtti_type);
  bool validateDebugName(size_t offset);
  template<typename SymbolType, typename DimType>
  bool validateLegacyDebugSymbols();
  bool validateLegacySymbolAddress(int32_t address, uint8_t vclass, uint8_t ident);
  bool validateTags();
  bool validateTag(int16_t tagid);

 private:
  template <typename SymbolType, typename DimType>
  const char* lookupFunction(const SymbolType* syms, uint32_t addr) const;
  template <typename SymbolType, typename DimType>
  uint32_t getFunctionCount(const SymbolType* syms) const;
  template <typename SymbolType, typename DimType>
  const char* getFunctionName(const SymbolType* syms, const char** filename, uint32_t index) const;
  template <typename SymbolType, typename DimType>
  bool getFunctionAddress(const SymbolType* syms, const char* function, ucell_t* funcaddr, size_t index) const;


  const smx_rtti_table_header* findRttiSection(const char* name) const {
    const Section* section = findSection(name);
    if (!section)
      return nullptr;
    return reinterpret_cast<const smx_rtti_table_header*>(buffer() + section->dataoffs);
  }

  const smx_rtti_table_header* toRttiTable(const Section* section) const {
    return reinterpret_cast<const smx_rtti_table_header*>(buffer() + section->dataoffs);
  }

  template <typename T>
  const T* getRttiRow(const smx_rtti_table_header* header, size_t index) const {
    assert(index < header->row_count);
    const uint8_t* base = reinterpret_cast<const uint8_t*>(header) + header->header_size;
    return reinterpret_cast<const T*>(base + header->row_size * index);
  }

 private:
  sp_file_hdr_t* hdr_ = nullptr;
  std::string error_;
  const char* header_strings_ = nullptr;
  std::vector<Section> sections_;

  const Section* names_section_ = nullptr;
  const char* names_ = nullptr;

  Blob<sp_file_code_t> code_;
  Blob<sp_file_data_t> data_;
  List<sp_file_publics_t> publics_;
  List<sp_file_natives_t> natives_;
  List<sp_file_pubvars_t> pubvars_;
  List<sp_file_tag_t> tags_;

  const Section* debug_names_section_ = nullptr;
  const char* debug_names_ = nullptr;
  const sp_fdbg_info_t* debug_info_ = nullptr;
  List<sp_fdbg_file_t> debug_files_;
  List<sp_fdbg_line_t> debug_lines_;
  const Section* debug_symbols_section_ = nullptr;
  const sp_fdbg_symbol_t* debug_syms_ = nullptr;
  const sp_u_fdbg_symbol_t* debug_syms_unpacked_ = nullptr;

  std::unique_ptr<const RttiData> rtti_data_ = nullptr;
  const smx_rtti_table_header* rtti_classdefs_ = nullptr;
  const smx_rtti_table_header* rtti_enums_ = nullptr;
  const smx_rtti_table_header* rtti_enumstructs_ = nullptr;
  const smx_rtti_table_header* rtti_enumstruct_fields_ = nullptr;
  const smx_rtti_table_header* rtti_fields_ = nullptr;
  const smx_rtti_table_header* rtti_methods_ = nullptr;
  const smx_rtti_table_header* rtti_natives_ = nullptr;
  const smx_rtti_table_header* rtti_typedefs_ = nullptr;
  const smx_rtti_table_header* rtti_typesets_ = nullptr;
  const smx_rtti_table_header* rtti_dbg_globals_ = nullptr;
  const smx_rtti_table_header* rtti_dbg_methods_ = nullptr;
  const smx_rtti_table_header* rtti_dbg_locals_ = nullptr;

  // SourcePawn 2.0.
  bool is_v2_ = false;
  const smx_rtti_table_header* rtti_dbg_method_lines_ = nullptr;
  const smx_rtti_table_header* rtti_globals_ = nullptr;
  std::vector<uint32_t> global_offsets_;
  uint32_t globals_bytes_ = 0;

  bool validateRttiGlobals();
  bool computeGlobalOffsets();
  bool findDebugMethodRow(uint32_t pcode_offset, uint32_t* row) const;
  void debugLineRange(uint32_t dm_row, uint32_t* first, uint32_t* end) const;
  bool findDebugLineRow(uint32_t dm_row, uint32_t rel_addr, uint32_t* out) const;
  bool lookupLineV2(uint32_t addr, uint32_t* line) const;
  bool lookupLineAddressV2(uint32_t line, const char* filename, uint32_t* addr) const;
  int32_t frameOffsetV2(const smx_rtti_debug_var* var) const;
};

} // namespace spdbg

#endif // SPDBG_SMX_PARSER_H
