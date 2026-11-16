#pragma once
#include "trace_context.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <functional>
#include <string>

namespace record_http
{
enum class Result { Ok, Failed, Timeout, Aborted };
using Callback = std::function<void(Result, const drogon::HttpResponsePtr &)>;

// Record JSON and marketplace pages share this bounded request lifetime.
// Legacy item and catalog pages retain their existing source/transport behavior.
void get(const drogon::HttpRequestPtr &caller, const std::string &prefix, const std::string &id, Callback done,
         const trace_context::Context &trace = {});
drogon::HttpResponsePtr problem(drogon::HttpStatusCode status);
}  // namespace record_http
