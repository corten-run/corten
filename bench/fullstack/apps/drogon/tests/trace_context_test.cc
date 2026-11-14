#include "trace_context.h"
#include <cassert>
#include <functional>
#include <iostream>
#include <type_traits>

using trace_context::Context;
const std::string a = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-00";
const std::string b = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bbbbbbbbbbbbbbbb-01";

void check(const Context &context, const std::string &parent, const std::string &state)
{
    auto outbound = drogon::HttpRequest::newHttpRequest();
    context.apply(outbound);
    assert(outbound->getHeader("traceparent") == parent);
    assert(outbound->getHeader("tracestate") == state);
}

int main()
{
    static_assert(!std::is_copy_assignable_v<Context>);
    check(Context(), "", "");
    check(Context(a, "vendor=first"), a, "vendor=first");
    check(Context("01" + a.substr(2) + "-future", "vendor=first"), a, "vendor=first");
    check(Context("fe" + a.substr(2), ""), a, "");
    for (const auto &flags : {"80", "81", "fe", "ff"})
    {
        const std::string current = a.substr(0, 53) + flags;
        const std::string expected = a.substr(0, 53) +
            (std::string(flags) == "81" || std::string(flags) == "ff" ? "01" : "00");
        check(Context("01" + a.substr(2, 51) + flags + "-future", "vendor=first"), expected, "vendor=first");
        check(Context(current, "vendor=first"), current, "vendor=first");
    }
    const std::string zeros32(32, '0'), zeros16(16, '0');
    for (const auto &invalid : {std::string(), std::string("bad"), a.substr(0, 54), a + "-extra",
         "ff" + a.substr(2), "00-" + zeros32 + a.substr(35), a.substr(0, 36) + zeros16 + "-00",
         a + ", " + b, a + "\r\n", std::string("\xe9"), "01" + a.substr(2) + "-\nfuture"})
    {
        check(Context(invalid, "vendor=must-not-leak"), "", "");
        check(Context(), "", "");
    }
    for (size_t i = 0; i < a.size(); ++i)
    {
        auto invalid = a; invalid[i] = i == 2 || i == 35 || i == 52 ? '_' : 'A';
        check(Context(invalid, "vendor=must-not-leak"), "", "");
    }
    for (int byte = 0; byte <= 255; ++byte)
    {
        const auto state = "vendor=" + std::string(1, static_cast<char>(byte));
        check(Context(a, state), a, byte == 9 || (byte >= 32 && byte != 127) ? state : "");
    }
    check(Context(a, "one=1, two=2"), a, "one=1, two=2");
    for (int byte = 0; byte <= 127; ++byte)
    {
        if ((byte >= 32 && byte != 127) || byte == 9) continue;
        const auto control = std::string(1, static_cast<char>(byte));
        // Public setters preserve these bytes. Capture must reject them whenever
        // they reach the adapter, including the VT/FF the wire parser trims away.
        for (const auto &parent : {control + a, a + control, "01" + a.substr(2) + "-" + control})
        {
            auto caller = drogon::HttpRequest::newHttpRequest();
            caller->addHeader("traceparent", parent);
            caller->addHeader("tracestate", "must=not-leak");
            assert(caller->getHeader("traceparent") == parent);
            check(Context::capture(caller), "", "");
        }
    }
    auto caller = drogon::HttpRequest::newHttpRequest();
    caller->addHeader("traceparent", a); caller->addHeader("tracestate", "vendor=first");
    const auto captured = Context::capture(caller);
    std::function<void()> delayed = [captured] { check(captured, a, "vendor=first"); };
    caller->addHeader("traceparent", b); caller->addHeader("tracestate", "vendor=second");
    check(Context::capture(caller), b, "vendor=second");
    caller.reset();
    check(Context(), "", ""); delayed(); check(Context(), "", "");
    std::cout << "PASS: W3C known fields, all 256 state bytes, unsafe parent controls, immutable delayed capture and untraced isolation\n";
}
