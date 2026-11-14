#pragma once

#include <drogon/HttpRequest.h>
#include <algorithm>
#include <string>

namespace trace_context
{
// A value owned by one operation, never by a pooled HTTP client or an IO thread.
class Context
{
 public:
    Context() = default;
    Context(const std::string &parent, const std::string &state)
        : parent_(parentValue(parent)), state_(parent_.empty() || !headerValue(state) ? "" : state) {}

    static Context capture(const drogon::HttpRequestPtr &caller)
    {
        // The native parser has already trimmed values and discarded repeated fields.
        // No raw header bytes are available through this request API.
        return Context(caller->getHeader("traceparent"), caller->getHeader("tracestate"));
    }

    void apply(const drogon::HttpRequestPtr &outbound) const
    {
        if (!parent_.empty()) outbound->addHeader("traceparent", parent_);
        if (!state_.empty()) outbound->addHeader("tracestate", state_);
    }

 private:
    static bool headerValue(const std::string &value)
    {
        // HTTP field bytes: HTAB, visible ASCII and obs-text. No CR/LF, NUL or DEL.
        return std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return c == '\t' || (c >= 0x20 && c != 0x7f);
        });
    }

    static std::string parentValue(const std::string &value)
    {
        if (value.size() < 55 || !headerValue(value) || value.find(',') != std::string::npos ||
            value.compare(0, 2, "ff") == 0 ||
            (value.size() > 55 && (value.compare(0, 2, "00") == 0 || value[55] != '-')))
            return {};
        for (size_t i = 0; i < 55; ++i)
        {
            const char c = value[i];
            if (i == 2 || i == 35 || i == 52) { if (c != '-') return {}; }
            else if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return {};
        }
        if (value.compare(3, 32, "00000000000000000000000000000000") == 0 ||
            value.compare(36, 16, "0000000000000000") == 0) return {};
        if (value.compare(0, 2, "00") == 0) return value;
        // W3C 3.2.4: only the sampled bit is known when downgrading a future version.
        const bool sampled = std::string("13579bdf").find(value[54]) != std::string::npos;
        return "00" + value.substr(2, 51) + (sampled ? "01" : "00");
    }

    const std::string parent_;
    const std::string state_;
};
}  // namespace trace_context
