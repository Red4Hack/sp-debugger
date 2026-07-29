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

#ifndef _INCLUDE_JSON_UTILS_H
#define _INCLUDE_JSON_UTILS_H

#include <string>
#include <map>
#include <vector>
#include <memory>
#include <variant>

class JsonValue;
using JsonObject = std::map<std::string, std::shared_ptr<JsonValue>>;
using JsonArray = std::vector<std::shared_ptr<JsonValue>>;

enum class JsonType {
    Null,
    Bool,
    Number,
    String,
    Object,
    Array
};

class JsonValue {
public:
    JsonValue() : type_(JsonType::Null) {}
    JsonValue(bool value) : type_(JsonType::Bool) { data_.bool_val = value; }
    JsonValue(double value) : type_(JsonType::Number) { data_.number_val = value; }
    JsonValue(int value) : type_(JsonType::Number) { data_.number_val = static_cast<double>(value); }
    JsonValue(const std::string& value) : type_(JsonType::String) { new(&data_.string_val) std::string(value); }
    JsonValue(const char* value) : type_(JsonType::String) { new(&data_.string_val) std::string(value); }
    JsonValue(const JsonObject& value) : type_(JsonType::Object) { new(&data_.object_val) JsonObject(value); }
    JsonValue(const JsonArray& value) : type_(JsonType::Array) { new(&data_.array_val) JsonArray(value); }
    
    ~JsonValue() { Cleanup(); }
    
    JsonValue(const JsonValue& other) : type_(other.type_) { CopyFrom(other); }
    JsonValue& operator=(const JsonValue& other) {
        if (this != &other) {
            Cleanup();
            type_ = other.type_;
            CopyFrom(other);
        }
        return *this;
    }
    
    JsonType GetType() const { return type_; }
    
    bool IsNull() const { return type_ == JsonType::Null; }
    bool IsBool() const { return type_ == JsonType::Bool; }
    bool IsNumber() const { return type_ == JsonType::Number; }
    bool IsString() const { return type_ == JsonType::String; }
    bool IsObject() const { return type_ == JsonType::Object; }
    bool IsArray() const { return type_ == JsonType::Array; }
    
    bool AsBool(bool defaultValue = false) const;
    double AsNumber(double defaultValue = 0.0) const;
    int AsInt(int defaultValue = 0) const;
    std::string AsString(const std::string& defaultValue = "") const;
    const JsonObject& AsObject() const;
    const JsonArray& AsArray() const;
    JsonObject& AsObject();
    JsonArray& AsArray();
    
    std::shared_ptr<JsonValue> operator[](const std::string& key) const;
    std::shared_ptr<JsonValue> operator[](size_t index) const;
    
    bool HasMember(const std::string& key) const;
    size_t Size() const;
    
    std::string ToString() const;

private:
    void Cleanup();
    void CopyFrom(const JsonValue& other);

private:
    JsonType type_;
    union Data {
        bool bool_val;
        double number_val;
        std::string string_val;
        JsonObject object_val;
        JsonArray array_val;
        
        Data() {}
        ~Data() {}
    } data_;
};

class JsonParser {
public:
    static std::shared_ptr<JsonValue> Parse(const std::string& json);
    static std::string Stringify(const JsonValue& value, bool pretty = false);
    
    static std::shared_ptr<JsonValue> CreateObject();
    static std::shared_ptr<JsonValue> CreateArray();
    static void AddToObject(JsonValue& object, const std::string& key, std::shared_ptr<JsonValue> value);
    static void AddToArray(JsonValue& array, std::shared_ptr<JsonValue> value);

    // Public so hand-built JSON (stopped/output events in extension.cpp) can
    // use the same UTF-8-validating escaper instead of a weaker local copy.
    static std::string EscapeString(const std::string& str);

private:
    JsonParser(const std::string& json);
    
    std::shared_ptr<JsonValue> ParseValue();
    std::shared_ptr<JsonValue> ParseObject();
    std::shared_ptr<JsonValue> ParseArray();
    std::shared_ptr<JsonValue> ParseString();
    std::shared_ptr<JsonValue> ParseNumber();
    std::shared_ptr<JsonValue> ParseLiteral();
    
    void SkipWhitespace();
    char PeekChar();
    char NextChar();
    bool HasMore();
    std::string ParseStringValue();
    
    static std::string StringifyValue(const JsonValue& value, int indent, bool pretty);
    static std::string UnescapeString(const std::string& str);
    
private:
    std::string json_;
    size_t pos_;
};

class DAPMessage {
public:
    enum class Type {
        Request,
        Response,
        Event
    };
    
    DAPMessage(Type type, int seq) : type_(type), seq_(seq) {}
    virtual ~DAPMessage() = default;
    
    Type GetType() const { return type_; }
    int GetSeq() const { return seq_; }
    
    virtual std::string ToJson() const = 0;
    
    static std::unique_ptr<DAPMessage> FromJson(const std::string& json);

protected:
    Type type_;
    int seq_;
};

class DAPRequest : public DAPMessage {
public:
    DAPRequest(int seq, const std::string& command) 
        : DAPMessage(Type::Request, seq), command_(command) {}
    
    const std::string& GetCommand() const { return command_; }
    std::shared_ptr<JsonValue> GetArguments() const { return arguments_; }
    void SetArguments(std::shared_ptr<JsonValue> args) { arguments_ = args; }
    
    std::string ToJson() const override;

private:
    std::string command_;
    std::shared_ptr<JsonValue> arguments_;
};

class DAPResponse : public DAPMessage {
public:
    DAPResponse(int seq, int request_seq, const std::string& command, bool success)
        : DAPMessage(Type::Response, seq), request_seq_(request_seq), 
          command_(command), success_(success) {}
    
    int GetRequestSeq() const { return request_seq_; }
    const std::string& GetCommand() const { return command_; }
    bool IsSuccess() const { return success_; }
    
    std::shared_ptr<JsonValue> GetBody() const { return body_; }
    void SetBody(std::shared_ptr<JsonValue> body) { body_ = body; }
    
    std::string GetMessage() const { return message_; }
    void SetMessage(const std::string& message) { message_ = message; }
    
    std::string ToJson() const override;

private:
    int request_seq_;
    std::string command_;
    bool success_;
    std::shared_ptr<JsonValue> body_;
    std::string message_;
};

class DAPEvent : public DAPMessage {
public:
    DAPEvent(int seq, const std::string& event) 
        : DAPMessage(Type::Event, seq), event_(event) {}
    
    const std::string& GetEvent() const { return event_; }
    std::shared_ptr<JsonValue> GetBody() const { return body_; }
    void SetBody(std::shared_ptr<JsonValue> body) { body_ = body; }
    
    std::string ToJson() const override;

private:
    std::string event_;
    std::shared_ptr<JsonValue> body_;
};

#endif // _INCLUDE_JSON_UTILS_H