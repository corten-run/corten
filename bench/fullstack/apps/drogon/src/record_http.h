#pragma once
#include "trace_context.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <chrono>
#include <functional>
#include <string>

namespace record_http
{
// A pooled upstream connection idle this long is closed rather than reused: every benchmark
// upstream advertises a 5 s keep-alive, and a read written to a connection as the upstream closes
// it is lost (bench/fullstack/README.md). Drogon's HttpClient keeps a connection until it has seen
// the close. Every upstream client here (this file, catalog.cc and items.cc) takes this bound.
constexpr std::chrono::seconds upstreamIdle{4};

enum class Result { Ok, Failed, Timeout, Aborted };
using Callback = std::function<void(Result, const drogon::HttpResponsePtr &)>;

// Record JSON and marketplace pages share this bounded request lifetime.
// Legacy item and catalog pages retain their existing source/transport behavior.
void get(const drogon::HttpRequestPtr &caller, const std::string &prefix, const std::string &id, Callback done,
         const trace_context::Context &trace = {});
drogon::HttpResponsePtr problem(drogon::HttpStatusCode status);
}  // namespace record_http
