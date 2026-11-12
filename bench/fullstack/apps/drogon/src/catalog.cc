#include "catalog.h"
#include "record_http.h"

#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>
#include <json/reader.h>
#include <trantor/net/EventLoop.h>
#include <malloc.h>

#include <cstdlib>
#include <fstream>
#include <stdexcept>
#include <unordered_map>

namespace
{
bool fromFixture = false;
std::unordered_map<std::string, catalog::RecordPtr> fixture;
thread_local std::vector<drogon::HttpClientPtr> idleClients;

std::string env(const char *name, const char *fallback)
{
    const char *value = std::getenv(name);
    return value && *value ? value : fallback;
}

std::string text(const Json::Value &v)
{
    if (!v.isString()) throw std::runtime_error("catalog values must be strings");
    return v.asString();
}

const Json::Value &array(const Json::Value &v)
{
    if (!v.isArray()) throw std::runtime_error("catalog arrays are required");
    return v;
}
}  // namespace

namespace catalog
{
Record Record::fromJson(const Json::Value &a)
{
    if (!a.isObject()) throw std::runtime_error("catalog record must be an object");
    Record r;
    r.id = text(a["id"]);
    r.title = text(a["title"]);
    r.subtitle = text(a["subtitle"]);
    r.description = text(a["description"]);
    for (const auto &t : array(a["tags"])) r.tags.push_back(text(t));
    for (const auto &f : array(a["fields"])) r.fields.push_back({text(f["name"]), text(f["value"])});
    for (const auto &v : array(a["related"])) r.related.push_back({text(v["id"]), text(v["title"])});
    return r;
}

Json::Value Record::toJson() const
{
    Json::Value a(Json::objectValue);
    a["id"] = id;
    a["title"] = title;
    a["subtitle"] = subtitle;
    a["description"] = description;
    a["tags"] = Json::Value(Json::arrayValue);
    a["fields"] = Json::Value(Json::arrayValue);
    a["related"] = Json::Value(Json::arrayValue);
    for (const auto &tag : tags) a["tags"].append(tag);
    for (const auto &field : fields)
    {
        Json::Value f(Json::objectValue);
        f["name"] = field.name;
        f["value"] = field.value;
        a["fields"].append(std::move(f));
    }
    for (const auto &related : related)
    {
        Json::Value r(Json::objectValue);
        r["id"] = related.id;
        r["title"] = related.title;
        a["related"].append(std::move(r));
    }
    return a;
}

void load()
{
    if (env("CATALOG_SOURCE", "") != "fixture") return;
    fromFixture = true;
    {
        std::ifstream file(env("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json"), std::ios::binary);
        if (!file) throw std::runtime_error("cannot open catalog fixture");
        Json::Value all;
        Json::CharReaderBuilder reader;
        Json::CharReaderBuilder::strictMode(&reader.settings_);
        std::string errors;
        if (!Json::parseFromStream(reader, file, &all, &errors) || !all.isObject())
            throw std::runtime_error("catalog fixture JSON: " + errors);
        for (const auto &id : all.getMemberNames())
        {
            auto record = std::make_shared<const Record>(Record::fromJson(all[id]));
            if (record->id != id) throw std::runtime_error("catalog fixture id mismatch");
            fixture.emplace(id, std::move(record));
        }
        for (const auto &entry : fixture) for (const auto &related : entry.second->related)
            if (!fixture.count(related.id)) throw std::runtime_error("unknown catalog related record");
    }
    malloc_trim(0);
}

void get(const std::string &id, std::function<void(RecordPtr record, bool failed)> done)
{
    if (fromFixture)
    {
        const auto it = fixture.find(id);
        done(it == fixture.end() ? nullptr : it->second, false);
        return;
    }
    drogon::HttpClientPtr client;
    if (idleClients.empty())
        client = drogon::HttpClient::newHttpClient(env("API_BASE", "http://localhost:8080"), trantor::EventLoop::getEventLoopOfCurrentThread());
    else
    {
        client = std::move(idleClients.back());
        idleClients.pop_back();
    }
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setPath("/catalog/records/" + drogon::utils::urlEncodeComponent(id));
    client->sendRequest(req, [client, done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr &res) {
        idleClients.push_back(client);
        if (result != drogon::ReqResult::Ok) { done(nullptr, true); return; }
        if (res->statusCode() == drogon::k404NotFound) { done(nullptr, false); return; }
        Json::Value a;
        Json::CharReaderBuilder builder;
        std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
        const auto body = res->body();
        std::string errors;
        if (res->statusCode() != drogon::k200OK || !reader->parse(body.data(), body.data() + body.size(), &a, &errors))
        { done(nullptr, true); return; }
        RecordPtr record;
        try { record = std::make_shared<const Record>(Record::fromJson(a)); }
        catch (const std::exception &) { done(nullptr, true); return; }
        done(std::move(record), false);
    });
}

void json(const drogon::HttpRequestPtr &request, std::function<void(const drogon::HttpResponsePtr &)> callback, const std::string &id)
{
    if (request->method() != drogon::Get && request->method() != drogon::Head)
        return callback(record_http::problem(drogon::k405MethodNotAllowed));
    if (fromFixture)
    {
        auto found = fixture.find(id);
        if (found == fixture.end()) return callback(record_http::problem(drogon::k404NotFound));
        return callback(drogon::HttpResponse::newHttpJsonResponse(found->second->toJson()));
    }
    record_http::get(request, "/catalog/records/", id,
        [id, callback = std::move(callback)](record_http::Result result, const drogon::HttpResponsePtr &response) {
            if (result == record_http::Result::Aborted) return;
            if (result == record_http::Result::Timeout) return callback(record_http::problem(drogon::k504GatewayTimeout));
            if (result != record_http::Result::Ok) return callback(record_http::problem(drogon::k502BadGateway));
            if (response->statusCode() == drogon::k404NotFound) return callback(record_http::problem(drogon::k404NotFound));
            if (response->statusCode() != drogon::k200OK) return callback(record_http::problem(drogon::k502BadGateway));
            drogon::HttpResponsePtr output;
            try
            {
                Json::Value value;
                Json::CharReaderBuilder builder;
                Json::CharReaderBuilder::strictMode(&builder.settings_);
                std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
                const auto body = response->body();
                std::string errors;
                if (!reader->parse(body.data(), body.data() + body.size(), &value, &errors)) throw std::runtime_error("invalid catalog JSON");
                auto record = Record::fromJson(value);
                if (record.id != id) throw std::runtime_error("catalog id mismatch");
                output = drogon::HttpResponse::newHttpJsonResponse(record.toJson());
            }
            catch (const std::exception &) { output = record_http::problem(drogon::k502BadGateway); }
            callback(output);
        });
}
}  // namespace catalog
