#pragma once

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <functional>
#include <string>

namespace record_http
{
enum class Result { Ok, Failed, Timeout, Aborted };
using Callback = std::function<void(Result, const drogon::HttpResponsePtr &)>;

// Only the two record JSON routes use this bounded request lifetime. Pages and legacy items
// retain their existing source/transport behavior.
void get(const drogon::HttpRequestPtr &caller, const std::string &prefix, const std::string &id, Callback done);
drogon::HttpResponsePtr problem(drogon::HttpStatusCode status);
}  // namespace record_http
