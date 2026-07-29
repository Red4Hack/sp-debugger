/**
 * vim: set ts=4 :
 * =============================================================================
 * SourceMod Console Debugger Extension
 * Copyright (C) 2018-2021 Peace-Maker  All rights reserved.
 * =============================================================================
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License, version 3.0, as published by the
 * Free Software Foundation.
 * 
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * As a special exception, AlliedModders LLC gives you permission to link the
 * code of this program (as well as its derivative works) to "Half-Life 2," the
 * "Source Engine," the "SourcePawn JIT," and any Game MODs that run on software
 * by the Valve Corporation.  You must obey the GNU General Public License in
 * all respects for all other code used.  Additionally, AlliedModders LLC grants
 * this exception to all derivative works.  AlliedModders LLC defines further
 * exceptions, found in LICENSE.txt (as of this writing, version JULY-31-2007),
 * or <http://www.sourcemod.net/license.php>.
 *
 * Version: $Id$
 */

#include "json-utils.h"
#include <sstream>
#include <iomanip>
#include <cmath>
#include <cctype>
#include <climits>
#include <cstdlib>

void JsonValue::Cleanup() {
    switch (type_) {
        case JsonType::String:
            data_.string_val.~basic_string();
            break;
        case JsonType::Object:
            data_.object_val.~map();
            break;
        case JsonType::Array:
            data_.array_val.~vector();
            break;
        default:
            break;
    }
}

void JsonValue::CopyFrom(const JsonValue& other) {
    switch (other.type_) {
        case JsonType::Bool:
            data_.bool_val = other.data_.bool_val;
            break;
        case JsonType::Number:
            data_.number_val = other.data_.number_val;
            break;
        case JsonType::String:
            new(&data_.string_val) std::string(other.data_.string_val);
            break;
        case JsonType::Object:
            new(&data_.object_val) JsonObject(other.data_.object_val);
            break;
        case JsonType::Array:
            new(&data_.array_val) JsonArray(other.data_.array_val);
            break;
        default:
            break;
    }
}

bool JsonValue::AsBool(bool defaultValue) const {
    if (type_ == JsonType::Bool) {
        return data_.bool_val;
    }
    return defaultValue;
}

double JsonValue::AsNumber(double defaultValue) const {
    if (type_ == JsonType::Number) {
        return data_.number_val;
    }
    return defaultValue;
}

int JsonValue::AsInt(int defaultValue) const {
    if (type_ == JsonType::Number) {
        return static_cast<int>(data_.number_val);
    }
    return defaultValue;
}

std::string JsonValue::AsString(const std::string& defaultValue) const {
    if (type_ == JsonType::String) {
        return data_.string_val;
    }
    return defaultValue;
}

const JsonObject& JsonValue::AsObject() const {
    static JsonObject empty_object;
    if (type_ == JsonType::Object) {
        return data_.object_val;
    }
    return empty_object;
}

const JsonArray& JsonValue::AsArray() const {
    static JsonArray empty_array;
    if (type_ == JsonType::Array) {
        return data_.array_val;
    }
    return empty_array;
}

JsonObject& JsonValue::AsObject() {
    static JsonObject empty_object;
    if (type_ == JsonType::Object) {
        return data_.object_val;
    }
    return empty_object;
}

JsonArray& JsonValue::AsArray() {
    static JsonArray empty_array;
    if (type_ == JsonType::Array) {
        return data_.array_val;
    }
    return empty_array;
}

std::shared_ptr<JsonValue> JsonValue::operator[](const std::string& key) const {
    if (type_ == JsonType::Object) {
        const auto& obj = data_.object_val;
        auto it = obj.find(key);
        if (it != obj.end()) {
            return it->second;
        }
    }
    return std::make_shared<JsonValue>();
}

std::shared_ptr<JsonValue> JsonValue::operator[](size_t index) const {
    if (type_ == JsonType::Array) {
        const auto& arr = data_.array_val;
        if (index < arr.size()) {
            return arr[index];
        }
    }
    return std::make_shared<JsonValue>();
}

bool JsonValue::HasMember(const std::string& key) const {
    if (type_ == JsonType::Object) {
        const auto& obj = data_.object_val;
        return obj.find(key) != obj.end();
    }
    return false;
}

size_t JsonValue::Size() const {
    if (type_ == JsonType::Array) {
        return data_.array_val.size();
    }
    if (type_ == JsonType::Object) {
        return data_.object_val.size();
    }
    return 0;
}

std::string JsonValue::ToString() const {
    return JsonParser::Stringify(*this);
}

JsonParser::JsonParser(const std::string& json) : json_(json), pos_(0) {}

std::shared_ptr<JsonValue> JsonParser::Parse(const std::string& json) {
    JsonParser parser(json);
    parser.SkipWhitespace();
    auto result = parser.ParseValue();
    return result; // Will return nullptr on error
}

std::shared_ptr<JsonValue> JsonParser::ParseValue() {
    SkipWhitespace();
    
    if (!HasMore()) {
        return nullptr; // Error: Unexpected end of JSON
    }
    
    char ch = PeekChar();
    
    switch (ch) {
        case '{':
            return ParseObject();
        case '[':
            return ParseArray();
        case '"':
            return ParseString();
        case 't':
        case 'f':
        case 'n':
            return ParseLiteral();
        default:
            if (ch == '-' || std::isdigit(ch)) {
                return ParseNumber();
            }
            return nullptr; // Error: Unexpected character
    }
}

std::shared_ptr<JsonValue> JsonParser::ParseObject() {
    JsonObject obj;
    
    NextChar(); // consume '{'
    SkipWhitespace();
    
    if (PeekChar() == '}') {
        NextChar(); // consume '}'
        return std::make_shared<JsonValue>(obj);
    }
    
    while (HasMore()) {
        SkipWhitespace();
        
        if (PeekChar() != '"') {
            return nullptr;
        }
        
        std::string key = ParseStringValue();
        
        SkipWhitespace();
        if (NextChar() != ':') {
            return nullptr;
        }
        
        auto value = ParseValue();
        obj[key] = value;
        
        SkipWhitespace();
        char ch = NextChar();
        if (ch == '}') {
            break;
        }
        if (ch != ',') {
            return nullptr;
        }
    }
    
    return std::make_shared<JsonValue>(obj);
}

std::shared_ptr<JsonValue> JsonParser::ParseArray() {
    JsonArray arr;
    
    NextChar(); // consume '['
    SkipWhitespace();
    
    if (PeekChar() == ']') {
        NextChar(); // consume ']'
        return std::make_shared<JsonValue>(arr);
    }
    
    while (HasMore()) {
        auto value = ParseValue();
        arr.push_back(value);
        
        SkipWhitespace();
        char ch = NextChar();
        if (ch == ']') {
            break;
        }
        if (ch != ',') {
            return nullptr;
        }
    }
    
    return std::make_shared<JsonValue>(arr);
}

std::shared_ptr<JsonValue> JsonParser::ParseString() {
    return std::make_shared<JsonValue>(ParseStringValue());
}

std::shared_ptr<JsonValue> JsonParser::ParseNumber() {
    std::string num_str;
    
    if (PeekChar() == '-') {
        num_str += NextChar();
    }
    
    if (!std::isdigit(PeekChar())) {
        return nullptr;
    }
    
    if (PeekChar() == '0') {
        num_str += NextChar();
    } else {
        while (HasMore() && std::isdigit(PeekChar())) {
            num_str += NextChar();
        }
    }
    
    if (HasMore() && PeekChar() == '.') {
        num_str += NextChar();
        while (HasMore() && std::isdigit(PeekChar())) {
            num_str += NextChar();
        }
    }
    
    if (HasMore() && (PeekChar() == 'e' || PeekChar() == 'E')) {
        num_str += NextChar();
        if (HasMore() && (PeekChar() == '+' || PeekChar() == '-')) {
            num_str += NextChar();
        }
        while (HasMore() && std::isdigit(PeekChar())) {
            num_str += NextChar();
        }
    }
    
    // Use strtod (not std::stod): this extension is built with -fno-exceptions,
    // so std::stod throwing on malformed input would call std::terminate and
    // crash the game server. strtod never throws; it yields 0 on failure.
    double value = std::strtod(num_str.c_str(), nullptr);
    return std::make_shared<JsonValue>(value);
}

std::shared_ptr<JsonValue> JsonParser::ParseLiteral() {
    if (json_.substr(pos_, 4) == "true") {
        pos_ += 4;
        return std::make_shared<JsonValue>(true);
    }
    if (json_.substr(pos_, 5) == "false") {
        pos_ += 5;
        return std::make_shared<JsonValue>(false);
    }
    if (json_.substr(pos_, 4) == "null") {
        pos_ += 4;
        return std::make_shared<JsonValue>();
    }
    
    return nullptr;
}

void JsonParser::SkipWhitespace() {
    while (HasMore() && std::isspace(PeekChar())) {
        NextChar();
    }
}

char JsonParser::PeekChar() {
    if (HasMore()) {
        return json_[pos_];
    }
    return '\0';
}

char JsonParser::NextChar() {
    if (HasMore()) {
        return json_[pos_++];
    }
    return '\0';
}

bool JsonParser::HasMore() {
    return pos_ < json_.size();
}

std::string JsonParser::ParseStringValue() {
    NextChar(); // consume opening quote
    
    std::string result;
    while (HasMore()) {
        char ch = NextChar();
        if (ch == '"') {
            break;
        }
        if (ch == '\\') {
            if (!HasMore()) {
                return "";
            }
            char escaped = NextChar();
            switch (escaped) {
                case '"': result += '"'; break;
                case '\\': result += '\\'; break;
                case '/': result += '/'; break;
                case 'b': result += '\b'; break;
                case 'f': result += '\f'; break;
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                case 'u': {
                    std::string hex = json_.substr(pos_, 4);
                    if (hex.size() != 4) {
                        return "";
                    }
                    pos_ += 4;
                    int codepoint = std::stoi(hex, nullptr, 16);
                    if (codepoint < 0x80) {
                        result += static_cast<char>(codepoint);
                    } else {
                        result += "?";
                    }
                    break;
                }
                default:
                    return "";
            }
        } else {
            result += ch;
        }
    }
    
    return result;
}

std::string JsonParser::Stringify(const JsonValue& value, bool pretty) {
    return StringifyValue(value, 0, pretty);
}

std::string JsonParser::StringifyValue(const JsonValue& value, int indent, bool pretty) {
    std::ostringstream oss;
    
    switch (value.GetType()) {
        case JsonType::Null:
            oss << "null";
            break;
        case JsonType::Bool:
            oss << (value.AsBool() ? "true" : "false");
            break;
        case JsonType::Number: {
            double num = value.AsNumber();
            if (std::floor(num) == num && num >= -2147483648 && num <= 2147483647) {
                oss << static_cast<int>(num);
            } else {
                oss << std::fixed << std::setprecision(6) << num;
            }
            break;
        }
        case JsonType::String:
            oss << "\"" << EscapeString(value.AsString()) << "\"";
            break;
        case JsonType::Object: {
            const auto& obj = value.AsObject();
            oss << "{";
            if (pretty && !obj.empty()) oss << "\n";
            
            bool first = true;
            for (const auto& pair : obj) {
                if (!first) {
                    oss << ",";
                    if (pretty) oss << "\n";
                }
                first = false;
                
                if (pretty) {
                    for (int i = 0; i <= indent; ++i) oss << "  ";
                }
                
                oss << "\"" << EscapeString(pair.first) << "\":";
                if (pretty) oss << " ";
                oss << StringifyValue(*pair.second, indent + 1, pretty);
            }
            
            if (pretty && !obj.empty()) {
                oss << "\n";
                for (int i = 0; i < indent; ++i) oss << "  ";
            }
            oss << "}";
            break;
        }
        case JsonType::Array: {
            const auto& arr = value.AsArray();
            oss << "[";
            if (pretty && !arr.empty()) oss << "\n";
            
            for (size_t i = 0; i < arr.size(); ++i) {
                if (i > 0) {
                    oss << ",";
                    if (pretty) oss << "\n";
                }
                
                if (pretty) {
                    for (int j = 0; j <= indent; ++j) oss << "  ";
                }
                
                oss << StringifyValue(*arr[i], indent + 1, pretty);
            }
            
            if (pretty && !arr.empty()) {
                oss << "\n";
                for (int i = 0; i < indent; ++i) oss << "  ";
            }
            oss << "]";
            break;
        }
    }
    
    return oss.str();
}

std::string JsonParser::EscapeString(const std::string& str) {
    // Produces STRICTLY valid JSON/UTF-8 from arbitrary input. SourcePawn char
    // arrays can hold any bytes -- CS chat color control codes (0x01-0x10),
    // and uninitialized buffers full of bytes >= 0x80 that don't form valid
    // UTF-8. Emitting those raw makes the whole DAP message unparseable on the
    // VS Code side (JSON.parse throws), which then desyncs the stream. So we
    // validate every multi-byte UTF-8 sequence and replace anything malformed
    // with U+FFFD, guaranteeing the receiver can always parse the frame.
    static const char* kReplacement = "\xEF\xBF\xBD"; // U+FFFD as UTF-8

    auto emitUnicodeEscape = [](std::string& out, unsigned int cp) {
        char buf[8];
        snprintf(buf, sizeof(buf), "\\u%04x", cp & 0xFFFF);
        out += buf;
    };

    std::string result;
    result.reserve(str.size() + 16);
    const unsigned char* p = reinterpret_cast<const unsigned char*>(str.data());
    const size_t n = str.size();

    for (size_t i = 0; i < n;) {
        unsigned char c = p[i];

        // JSON's mandatory short escapes.
        switch (c) {
            case '"':  result += "\\\""; i++; continue;
            case '\\': result += "\\\\"; i++; continue;
            case '\b': result += "\\b";  i++; continue;
            case '\f': result += "\\f";  i++; continue;
            case '\n': result += "\\n";  i++; continue;
            case '\r': result += "\\r";  i++; continue;
            case '\t': result += "\\t";  i++; continue;
            default: break;
        }

        if (c < 0x20) {                 // other control chars -> \u00XX
            emitUnicodeEscape(result, c);
            i++;
            continue;
        }
        if (c < 0x80) {                 // plain ASCII
            result += static_cast<char>(c);
            i++;
            continue;
        }

        // Multi-byte UTF-8: validate length + continuation bytes. Anything that
        // doesn't form a well-formed, non-overlong, in-range sequence becomes
        // U+FFFD so the output stays valid UTF-8.
        size_t len = 0;
        unsigned int cp = 0;
        if ((c & 0xE0) == 0xC0) { len = 2; cp = c & 0x1F; }
        else if ((c & 0xF0) == 0xE0) { len = 3; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { len = 4; cp = c & 0x07; }
        else { result += kReplacement; i++; continue; } // stray continuation / 0xF8+

        if (i + len > n) { result += kReplacement; i++; continue; }
        bool ok = true;
        for (size_t k = 1; k < len; k++) {
            if ((p[i + k] & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (p[i + k] & 0x3F);
        }
        // Reject overlong encodings and out-of-range / surrogate code points.
        if (ok) {
            if ((len == 2 && cp < 0x80) ||
                (len == 3 && cp < 0x800) ||
                (len == 4 && cp < 0x10000) ||
                (cp >= 0xD800 && cp <= 0xDFFF) ||
                cp > 0x10FFFF) {
                ok = false;
            }
        }
        if (!ok) { result += kReplacement; i++; continue; }

        result.append(reinterpret_cast<const char*>(p + i), len);
        i += len;
    }
    return result;
}

std::shared_ptr<JsonValue> JsonParser::CreateObject() {
    return std::make_shared<JsonValue>(JsonObject());
}

std::shared_ptr<JsonValue> JsonParser::CreateArray() {
    return std::make_shared<JsonValue>(JsonArray());
}

void JsonParser::AddToObject(JsonValue& object, const std::string& key, std::shared_ptr<JsonValue> value) {
    if (object.IsObject()) {
        auto& obj = object.AsObject();
        obj[key] = value;
    }
}

void JsonParser::AddToArray(JsonValue& array, std::shared_ptr<JsonValue> value) {
    if (array.IsArray()) {
        auto& arr = array.AsArray();
        arr.push_back(value);
    }
}

std::unique_ptr<DAPMessage> DAPMessage::FromJson(const std::string& json) {
    auto root = JsonParser::Parse(json);
    if (!root || !root->IsObject()) {
        return nullptr;
    }
    
    auto type = (*root)["type"]->AsString();
    int seq = (*root)["seq"]->AsInt();
    
    if (type == "request") {
        auto command = (*root)["command"]->AsString();
        auto request = std::make_unique<DAPRequest>(seq, command);
        if (root->HasMember("arguments")) {
            request->SetArguments((*root)["arguments"]);
        }
        return std::move(request);
    }
    else if (type == "response") {
        int request_seq = (*root)["request_seq"]->AsInt();
        auto command = (*root)["command"]->AsString();
        bool success = (*root)["success"]->AsBool();
        auto response = std::make_unique<DAPResponse>(seq, request_seq, command, success);
        
        if (root->HasMember("body")) {
            response->SetBody((*root)["body"]);
        }
        if (root->HasMember("message")) {
            response->SetMessage((*root)["message"]->AsString());
        }
        return std::move(response);
    }
    else if (type == "event") {
        auto event = (*root)["event"]->AsString();
        auto dap_event = std::make_unique<DAPEvent>(seq, event);
        if (root->HasMember("body")) {
            dap_event->SetBody((*root)["body"]);
        }
        return std::move(dap_event);
    }
    
    return nullptr;
}

std::string DAPRequest::ToJson() const {
    auto root = JsonParser::CreateObject();
    JsonParser::AddToObject(*root, "seq", std::make_shared<JsonValue>(seq_));
    JsonParser::AddToObject(*root, "type", std::make_shared<JsonValue>("request"));
    JsonParser::AddToObject(*root, "command", std::make_shared<JsonValue>(command_));
    
    if (arguments_) {
        JsonParser::AddToObject(*root, "arguments", arguments_);
    }
    
    return root->ToString();
}

std::string DAPResponse::ToJson() const {
    auto root = JsonParser::CreateObject();
    JsonParser::AddToObject(*root, "seq", std::make_shared<JsonValue>(seq_));
    JsonParser::AddToObject(*root, "type", std::make_shared<JsonValue>("response"));
    JsonParser::AddToObject(*root, "request_seq", std::make_shared<JsonValue>(request_seq_));
    JsonParser::AddToObject(*root, "command", std::make_shared<JsonValue>(command_));
    JsonParser::AddToObject(*root, "success", std::make_shared<JsonValue>(success_));
    
    if (body_) {
        JsonParser::AddToObject(*root, "body", body_);
    }
    
    if (!message_.empty()) {
        JsonParser::AddToObject(*root, "message", std::make_shared<JsonValue>(message_));
    }
    
    return root->ToString();
}

std::string DAPEvent::ToJson() const {
    auto root = JsonParser::CreateObject();
    JsonParser::AddToObject(*root, "seq", std::make_shared<JsonValue>(seq_));
    JsonParser::AddToObject(*root, "type", std::make_shared<JsonValue>("event"));
    JsonParser::AddToObject(*root, "event", std::make_shared<JsonValue>(event_));
    
    if (body_) {
        JsonParser::AddToObject(*root, "body", body_);
    }
    
    return root->ToString();
}