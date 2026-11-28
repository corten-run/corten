#include "marketplace.h"
#include "record_http.h"
#include "alerts.h"
#include <drogon/drogon.h>
#include <drogon/HttpMiddleware.h>
#include <drogon/utils/Utilities.h>
#include <json/reader.h>
#include <arpa/inet.h>
#include <strings.h>
#include <algorithm>
#include <charconv>
#include <cstdlib>
#include <fstream>
#include <stdexcept>
#include <string_view>
#include <unordered_map>

namespace marketplace {
namespace {
bool fromFixture = false;
std::unordered_map<std::string, RecordPtr> fixture;
Json::Value labels;
Alerts alerts;
std::string env(const char *name, const char *fallback) {
 const char *value = std::getenv(name); return value && *value ? value : fallback;
}
Json::Value readFile(const std::string &path) {
 std::ifstream file(path, std::ios::binary); if (!file) throw std::runtime_error("cannot open marketplace asset " + path);
 Json::Value value; Json::CharReaderBuilder reader; std::string errors;
 Json::CharReaderBuilder::strictMode(&reader.settings_);
 if (!Json::parseFromStream(reader, file, &value, &errors) || !value.isObject()) throw std::runtime_error("marketplace JSON: " + errors);
 return value;
}
using Callback = std::function<void(const drogon::HttpResponsePtr &)>;
struct Authority {
 std::string_view host;
 std::optional<in6_addr> ipv6;
 unsigned port = 0;

 bool accepts(const Authority &requested) const {
  if (port != 0 && port != requested.port) return false;
  if (ipv6 || requested.ipv6)
   return ipv6 && requested.ipv6 && IN6_ARE_ADDR_EQUAL(&*ipv6, &*requested.ipv6);
  return host.size() == requested.host.size() &&
         strncasecmp(host.data(), requested.host.data(), host.size()) == 0;
 }
};

std::optional<Authority> authority(std::string_view text) {
 Authority value;
 auto colon = text.find(':');
 if (!text.empty() && text.front() == '[') {
  const auto end = text.find(']');
  if (end == text.npos) return std::nullopt;
  const auto literal = std::string(text.substr(1, end - 1));
  if (inet_pton(AF_INET6, literal.c_str(), &value.ipv6.emplace()) != 1) return std::nullopt;
  colon = end + 1 == text.size() ? text.npos : end + 1;
 } else {
  value.host = text.substr(0, colon);
  if (!value.host.empty() && value.host.back() == '.') value.host.remove_suffix(1);
  if (value.host.empty() || value.host.find_first_not_of(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.") != text.npos) return std::nullopt;
 }
 if (colon != text.npos) {
  if (text[colon] != ':') return std::nullopt;
  const auto port = text.substr(colon + 1);
  const auto end = port.data() + port.size();
  const auto parsed = std::from_chars(port.data(), end, value.port);
  if (parsed.ec != std::errc{} || parsed.ptr != end || value.port == 0 || value.port > 65535)
   return std::nullopt;
 }
 return value;
}

class MatchedPolicy : public drogon::HttpMiddleware<MatchedPolicy, false> {
 const std::string hosts_;
 std::vector<Authority> allowed_;
 public:
 explicit MatchedPolicy(std::string hosts) : hosts_(std::move(hosts)) {
  std::string_view rest = hosts_;
  while (true) {
   const auto comma = rest.find(',');
   auto value = rest.substr(0, comma);
   const auto first = value.find_first_not_of(" \t");
   if (first != value.npos) value = value.substr(first, value.find_last_not_of(" \t") - first + 1);
   const auto parsed = authority(value);
   if (!parsed) throw std::runtime_error("HOSTS must list names or IP addresses, with optional ports");
   allowed_.push_back(*parsed);
   if (comma == rest.npos) break;
   rest.remove_prefix(comma + 1);
  }
 }

 void invoke(const drogon::HttpRequestPtr &request, drogon::MiddlewareNextCallback &&next,
             drogon::MiddlewareCallback &&callback) override {
  const auto requested = authority(request->getHeader("host"));
  const bool allowed = requested && std::any_of(allowed_.begin(), allowed_.end(), [&](const Authority &host) {
   return host.accepts(*requested);
  });
  if (!allowed) {
   auto response = drogon::HttpResponse::newHttpResponse(drogon::k421MisdirectedRequest, drogon::CT_TEXT_PLAIN);
   response->addHeader("Cache-Control", "no-store");
   return callback(response);
  }
  next([callback = std::move(callback)](const drogon::HttpResponsePtr &response) {
   response->addHeader("Content-Security-Policy",
                       "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; "
                       "base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
   response->addHeader("X-Content-Type-Options", "nosniff");
   response->addHeader("Referrer-Policy", "strict-origin-when-cross-origin");
   response->addHeader("X-Frame-Options", "DENY");
   response->addHeader("Cross-Origin-Opener-Policy", "same-origin");
   response->addHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
   callback(response);
  });
 }
};

void error(Callback &callback, drogon::HttpStatusCode status) {
 callback(drogon::HttpResponse::newHttpResponse(status, drogon::CT_TEXT_PLAIN));
}
void pageUnavailable(Callback &callback, const std::string &locale, drogon::HttpStatusCode status) {
 drogon::HttpViewData data;
 data.insert("locale", locale);
 auto response = drogon::HttpResponse::newHttpViewResponse("MarketplaceUnavailable", data);
 response->setStatusCode(status);
 response->addHeader("Cache-Control", "no-store");
 callback(response);
}
}
std::string url(const std::string &locale, const std::string &id) {
 return "/marketplace/" + locale + "/" + drogon::utils::urlEncodeComponent(id);
}
void load() {
 labels = readFile("static/marketplace-labels.json");
 if (env("MARKETPLACE_SOURCE", "") != "fixture") return;
 fromFixture = true;
 auto records = readFile(env("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json"));
 for (const auto &id : records.getMemberNames()) {
  auto record = parseRecord(records[id]);
  if (record["id"].asString() != id) throw std::runtime_error("marketplace fixture id mismatch");
  fixture.emplace(id, std::make_shared<const Json::Value>(std::move(record)));
 }
 for (const auto &entry : fixture) for (auto key : {"contents", "included_in"})
  for (const auto &line : (*entry.second)[key])
   if (!fixture.count(line["item_id"].asString())) throw std::runtime_error("unknown marketplace item reference");
}
void get(const drogon::HttpRequestPtr &caller, const std::string &id, const trace_context::Context &trace,
         std::function<void(RecordPtr, record_http::Result)> done, bool completeDocument) {
 using record_http::Result;
 if (fromFixture) {
  auto found = fixture.find(id); done(found == fixture.end() ? nullptr : found->second, Result::Ok); return;
 }
 record_http::get(caller, "/marketplace/records/", id,
 [completeDocument, done = std::move(done)](Result result, const drogon::HttpResponsePtr &response) {
  if (result != Result::Ok) { done(nullptr, result); return; }
  if (response->statusCode() == drogon::k404NotFound) { done(nullptr, Result::Ok); return; }
  if (response->statusCode() != drogon::k200OK) { done(nullptr, Result::Failed); return; }
  Json::Value value; Json::CharReaderBuilder builder;
  if (completeDocument) Json::CharReaderBuilder::strictMode(&builder.settings_);
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  auto body = response->body(); std::string errors;
  if (!reader->parse(body.data(), body.data()+body.size(), &value, &errors)) { done(nullptr, Result::Failed); return; }
  RecordPtr record;
  try { record = std::make_shared<const Json::Value>(parseRecord(value)); }
  catch (const std::exception &) { done(nullptr, Result::Failed); return; }
  done(std::move(record), Result::Ok);
 }, trace);
}
void routes() {
 const bool matched = env("PROFILE", "") == "matched";
 const auto publicOrigin = env("MARKETPLACE_PUBLIC_ORIGIN", "");
 const bool publicHTTPS = publicOrigin.compare(0, 8, "https://") == 0;
 std::string publicAuthority;
 if (!publicOrigin.empty()) {
  const std::string_view origin(publicOrigin);
  const auto schemeLength = publicHTTPS ? 8 : (origin.substr(0, 7) == "http://" ? 7 : 0);
  const auto host = origin.substr(schemeLength);
  const auto parsed = authority(host);
  if (schemeLength == 0 || !parsed || host.find_first_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ") != host.npos ||
      parsed->port == (publicHTTPS ? 443 : 80) ||
      (parsed->port != 0 && host[host.rfind(':') + 1] == '0'))
   throw std::runtime_error("MARKETPLACE_PUBLIC_ORIGIN must be an exact HTTP(S) origin");
  publicAuthority = host;
 }
 std::vector<drogon::internal::HttpConstraint> page{drogon::Get, drogon::Post},
  json{drogon::HttpOptionsMiddleware::classTypeName()}, read{drogon::Get};
 if (matched) {
  const char *hosts = std::getenv("HOSTS");
  drogon::app().registerMiddleware(std::make_shared<MatchedPolicy>(hosts ? hosts : "localhost,127.0.0.1,[::1]"));
  for (auto *route : {&page, &json, &read}) route->emplace_back(MatchedPolicy::classTypeName());
  drogon::app().registerHandler("/health/live", [](const drogon::HttpRequestPtr &, Callback &&callback) {
   auto response = drogon::HttpResponse::newHttpResponse(drogon::k200OK, drogon::CT_TEXT_PLAIN);
   response->setBody("ok\n");
   response->addHeader("Cache-Control", "no-store");
   callback(response);
  }, read);
 }
 drogon::app().registerHandler("/api/alerts", [](const drogon::HttpRequestPtr &request, Callback &&callback) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(alerts.read(request));
  response->addHeader("Cache-Control", "no-store"); callback(response);
 }, read);
 drogon::app().registerHandler("/api/marketplace/{id}",
  [](const drogon::HttpRequestPtr &request, Callback &&callback, const std::string &id) {
   if (request->method() != drogon::Get && request->method() != drogon::Head)
    return callback(record_http::problem(drogon::k405MethodNotAllowed));
   if (fromFixture) {
    auto found = fixture.find(id);
    if (found == fixture.end()) return callback(record_http::problem(drogon::k404NotFound));
    auto response = drogon::HttpResponse::newHttpJsonResponse(*found->second);
    response->addHeader("Cache-Control", "no-store"); return callback(response);
   }
   record_http::get(request, "/marketplace/records/", id,
    [id, callback = std::move(callback)](record_http::Result result, const drogon::HttpResponsePtr &response) {
     if (result == record_http::Result::Aborted) return;
     if (result == record_http::Result::Timeout) return callback(record_http::problem(drogon::k504GatewayTimeout));
     if (result != record_http::Result::Ok) return callback(record_http::problem(drogon::k502BadGateway));
     if (response->statusCode() == drogon::k404NotFound) return callback(record_http::problem(drogon::k404NotFound));
     if (response->statusCode() != drogon::k200OK) return callback(record_http::problem(drogon::k502BadGateway));
     drogon::HttpResponsePtr output;
     try {
      Json::Value value; Json::CharReaderBuilder builder; Json::CharReaderBuilder::strictMode(&builder.settings_);
      std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
      auto body = response->body(); std::string errors;
      if (!reader->parse(body.data(), body.data()+body.size(), &value, &errors)) throw std::runtime_error("invalid marketplace JSON");
      auto record = parseRecord(value);
      if (record["id"].asString() != id) throw std::runtime_error("marketplace id mismatch");
      output = drogon::HttpResponse::newHttpJsonResponse(std::move(record));
      output->addHeader("Cache-Control", "no-store");
     } catch (const std::exception &) { output = record_http::problem(drogon::k502BadGateway); }
     callback(output);
    }, trace_context::Context::capture(request));
  }, json);
 drogon::app().registerHandler("/marketplace/{locale}/{id}",
  [matched, publicOrigin, publicAuthority, publicHTTPS](const drogon::HttpRequestPtr &request, Callback &&callback, const std::string &locale, const std::string &id) {
   if (locale != "en-US" && locale != "fr-FR" && locale != "de-DE") return error(callback, drogon::k400BadRequest);
   bool publicTLS = false;
   if (request->method() == drogon::Post) {
    const auto &host = request->getHeader("host");
    const auto &origin = request->getHeader("origin");
    const bool atPublicHost = !publicAuthority.empty() && host == publicAuthority;
    const auto &site = request->getHeader("sec-fetch-site");
    if ((!site.empty() && site != "same-origin" && site != "none") ||
        (atPublicHost ? origin != publicOrigin
                      : !origin.empty() && origin != (request->isOnSecureConnection() ? "https://" : "http://") + host))
     return error(callback, drogon::k403Forbidden);
    publicTLS = atPublicHost && publicHTTPS;
    if (request->getHeader("content-type").find("application/x-www-form-urlencoded") != 0)
     return error(callback, drogon::k415UnsupportedMediaType);
   }
   const auto trace = trace_context::Context::capture(request);
   get(request, id, trace, [matched, publicTLS, request, locale, id, callback = std::move(callback)](RecordPtr record, record_http::Result result) mutable {
    if (result == record_http::Result::Aborted || !request->connected()) return;
    if (result != record_http::Result::Ok || (record && request->method() == drogon::Post && (*record)["id"].asString() != id)) {
     const auto status = result == record_http::Result::Timeout ? drogon::k504GatewayTimeout : drogon::k502BadGateway;
     return matched ? pageUnavailable(callback, locale, status) : error(callback, status);
    }
    if (!record) return error(callback, drogon::k404NotFound);
    auto view = std::make_shared<View>(record, locale, labels[locale], request->getParameter("seller"), request->getParameter("sort"), request->getParameter("offers") == "all");
    view->path = url(locale, (*record)["id"].asString());
    if (view->offersShown < (*record)["offers"].size())
     view->more = view->path + "?seller=" + drogon::utils::urlEncodeComponent(view->seller) + "&sort=" + view->sort + "&offers=all";
    std::optional<int64_t> minor;
    std::string email;
    if (request->method() == drogon::Post) {
     // A separate native request parser keeps query fields out of the submitted form.
     auto form = drogon::HttpRequest::newHttpRequest();
     form->setMethod(drogon::Post); form->addHeader("content-type", "application/x-www-form-urlencoded");
     form->setBody(std::string(request->body()));
     email = form->getParameter("email");
     view->message = view->format.alert((*record)["title"].asString(), email, form->getParameter("target_price"), view->words, &minor);
    }
    drogon::HttpViewData data; data.insert("marketplace", view);
    auto response = drogon::HttpResponse::newHttpViewResponse("MarketplacePage", data);
    if (response->statusCode() != drogon::k200OK) return callback(response);
    if (minor) {
     Json::Value row(Json::objectValue);
     row["item_id"] = (*record)["id"]; row["email"] = email; row["target_minor"] = Json::Int64(*minor);
     if (!alerts.append(request, response, std::move(row), publicTLS)) return error(callback, drogon::k503ServiceUnavailable);
    }
    response->addHeader("Cache-Control", "no-store"); callback(response);
   }, request->method() == drogon::Post);
  }, page);
}
}
