#include "marketplace.h"
#include "record_http.h"
#include <drogon/drogon.h>
#include <drogon/HttpMiddleware.h>
#include <drogon/utils/Utilities.h>
#include <json/reader.h>
#include <trantor/net/EventLoop.h>
#include <cstdlib>
#include <fstream>
#include <stdexcept>
#include <unordered_map>

namespace marketplace {
namespace {
bool fromFixture = false;
std::unordered_map<std::string, RecordPtr> fixture;
Json::Value labels;
thread_local std::vector<drogon::HttpClientPtr> idleClients;
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
void error(Callback &callback, drogon::HttpStatusCode status) {
 callback(drogon::HttpResponse::newHttpResponse(status, drogon::CT_TEXT_PLAIN));
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
void get(const std::string &id, std::function<void(RecordPtr, bool)> done) {
 if (fromFixture) {
  auto found = fixture.find(id); done(found == fixture.end() ? nullptr : found->second, false); return;
 }
 drogon::HttpClientPtr client;
 if (idleClients.empty()) client = drogon::HttpClient::newHttpClient(env("API_BASE", "http://localhost:8080"), trantor::EventLoop::getEventLoopOfCurrentThread());
 else { client = std::move(idleClients.back()); idleClients.pop_back(); }
 auto request = drogon::HttpRequest::newHttpRequest();
 request->setPath("/marketplace/records/" + drogon::utils::urlEncodeComponent(id));
 client->sendRequest(request, [client, done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr &response) {
  idleClients.push_back(client);
  if (result != drogon::ReqResult::Ok) { done(nullptr, true); return; }
  if (response->statusCode() == drogon::k404NotFound) { done(nullptr, false); return; }
  if (response->statusCode() != drogon::k200OK) { done(nullptr, true); return; }
  Json::Value value; Json::CharReaderBuilder builder; std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  auto body = response->body(); std::string errors;
  if (!reader->parse(body.data(), body.data()+body.size(), &value, &errors)) { done(nullptr, true); return; }
  RecordPtr record;
  try { record = std::make_shared<const Json::Value>(parseRecord(value)); }
  catch (const std::exception &) { done(nullptr, true); return; }
  done(std::move(record), false);
 });
}
void routes() {
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
    });
  }, {drogon::HttpOptionsMiddleware::classTypeName()});
 drogon::app().registerHandler("/marketplace/{locale}/{id}",
  [](const drogon::HttpRequestPtr &request, Callback &&callback, const std::string &locale, const std::string &id) {
   if (locale != "en-US" && locale != "fr-FR" && locale != "de-DE") return error(callback, drogon::k400BadRequest);
   if (request->method() == drogon::Post) {
    const auto &origin = request->getHeader("origin");
    const std::string scheme = request->isOnSecureConnection() ? "https://" : "http://";
    if (request->getHeader("sec-fetch-site") == "cross-site" || (!origin.empty() && origin != scheme + request->getHeader("host")))
     return error(callback, drogon::k403Forbidden);
   }
   get(id, [request, locale, callback = std::move(callback)](RecordPtr record, bool failed) mutable {
    if (failed) return error(callback, drogon::k502BadGateway);
    if (!record) return error(callback, drogon::k404NotFound);
    auto view = std::make_shared<View>(record, locale, labels[locale], request->getParameter("seller"), request->getParameter("sort"), request->getParameter("offers") == "all");
    view->path = url(locale, (*record)["id"].asString());
    if (view->offersShown < (*record)["offers"].size())
     view->more = view->path + "?seller=" + drogon::utils::urlEncodeComponent(view->seller) + "&sort=" + view->sort + "&offers=all";
    if (request->method() == drogon::Post)
     view->message = view->format.alert((*record)["title"].asString(), request->getParameter("email"), request->getParameter("target_price"), view->words);
    drogon::HttpViewData data; data.insert("marketplace", view);
    auto response = drogon::HttpResponse::newHttpViewResponse("MarketplacePage", data);
    response->addHeader("Cache-Control", "no-store"); callback(response);
   });
  }, {drogon::Get, drogon::Post});
}
}
