/**
 * console-debugger.cfg reader. See config.h for the format.
 */
#include "config.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "smsdk_ext.h"

namespace dap {

namespace {

// A key match must not be part of a longer identifier, or "port" would match
// inside "export" and "max_clients" inside "no_max_clients".
bool IsIdentChar(char c)
{
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
}

// Everything after the key on its line, minus the separator noise
// (spaces, tabs, '=' and the opening quote). Stops at the closing quote,
// whitespace, a comment, or end of line.
std::string ExtractValue(const char* after_key)
{
    const char* p = after_key;
    while (*p == ' ' || *p == '\t' || *p == '=' || *p == '"')
        p++;

    std::string value;
    while (*p && *p != '"' && *p != '\n' && *p != '\r' && *p != '\t' && *p != ' ') {
        if (p[0] == '/' && p[1] == '/')
            break;
        value.push_back(*p++);
    }
    return value;
}

} // namespace

bool ConfigLookup(const char* key, std::string* out)
{
    if (!key || !*key || !out)
        return false;

    char path[PLATFORM_MAX_PATH];
    if (!smutils->BuildPath(Path_SM, path, sizeof(path), "configs/console-debugger.cfg"))
        return false;

    FILE* f = fopen(path, "r");
    if (!f)
        return false;

    const size_t key_len = strlen(key);
    bool found = false;
    char line[512];
    while (!found && fgets(line, sizeof(line), f)) {
        char* p = line;
        while (*p == ' ' || *p == '\t')
            p++;
        if (*p == '\0' || *p == '\n' || *p == '\r')
            continue;
        if (p[0] == '/' && p[1] == '/')
            continue;

        for (char* q = p; *q; q++) {
            if (strncasecmp(q, key, key_len) != 0)
                continue;
            if (q != p && IsIdentChar(q[-1]))
                continue;
            if (IsIdentChar(q[key_len]))
                continue;

            *out = ExtractValue(q + key_len);
            found = true;
            break;
        }
    }
    fclose(f);
    return found;
}

std::string ConfigString(const char* key, const char* fallback)
{
    std::string value;
    if (ConfigLookup(key, &value) && !value.empty())
        return value;
    return fallback ? fallback : "";
}

int ConfigInt(const char* key, int fallback, int min_value, int max_value)
{
    std::string value;
    if (!ConfigLookup(key, &value) || value.empty())
        return fallback;

    // strtol, not std::stoi: the extension builds with -fno-exceptions, so a
    // malformed value would take the whole server down via std::terminate.
    char* end = nullptr;
    long parsed = strtol(value.c_str(), &end, 10);
    if (end == value.c_str() || *end != '\0' || parsed < min_value || parsed > max_value) {
        smutils->LogError(myself, "console-debugger.cfg: invalid \"%s\" value \"%s\"; using %d",
                          key, value.c_str(), fallback);
        return fallback;
    }
    return static_cast<int>(parsed);
}

bool ConfigBool(const char* key, bool fallback)
{
    std::string value;
    if (!ConfigLookup(key, &value) || value.empty())
        return fallback;

    const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(value[0])));
    return c == '1' || c == 't' || c == 'y' || (c == 'o' && value.size() > 1 &&
           std::tolower(static_cast<unsigned char>(value[1])) == 'n');
}

bool ConfigFlag(const char* key, bool fallback)
{
    return ConfigBool(key, fallback);
}

bool IsLoopbackAddress(const std::string& address)
{
    if (address == "localhost")
        return true;
    // 127.0.0.0/8 -- anything the kernel will only route locally.
    return address.compare(0, 4, "127.") == 0;
}

bool SecretEquals(const std::string& a, const std::string& b)
{
    if (a.size() != b.size())
        return false;
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); i++)
        diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
    return diff == 0;
}

} // namespace dap
