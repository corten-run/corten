#include "items.h"

#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>
#include <json/reader.h>
#include <trantor/net/EventLoop.h>
#include <trantor/utils/Logger.h>
#include <malloc.h>

#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

using namespace drogon;

namespace
{
bool fromFixture = false;
std::unordered_map<std::string, ItemPtr> fixture;

std::string env(const char *name, const char *fallback)
{
    const char *v = std::getenv(name);
    return v && *v ? v : fallback;
}

// A client holds one connection, so each IO thread keeps the idle ones and opens another when
// all are busy: concurrent requests do not queue behind one another.
thread_local std::vector<HttpClientPtr> idleClients;

HttpClientPtr takeClient()
{
    if (idleClients.empty())
    {
        static const std::string base = env("API_BASE", "http://localhost:8080");
        return HttpClient::newHttpClient(base, trantor::EventLoop::getEventLoopOfCurrentThread());
    }
    auto client = std::move(idleClients.back());
    idleClients.pop_back();
    return client;
}
}  // namespace

namespace items
{
void load()
{
    if (env("ITEM_SOURCE", "") != "fixture")
        return;
    fromFixture = true;
    auto path = env("FIXTURE_PATH", "fixtures/items.json");
    {
        std::ifstream file(path, std::ios::binary);
        if (!file)
            throw std::runtime_error("cannot open fixture " + path);
        Json::Value all;
        Json::CharReaderBuilder reader;
        std::string errors;
        if (!Json::parseFromStream(reader, file, &all, &errors))
            throw std::runtime_error("fixture JSON: " + errors);
        for (const auto &id : all.getMemberNames())
            fixture.emplace(id, std::make_shared<const ItemView>(ItemView::fromApi(all[id])));
    }
    // The whole file's parsed JSON is freed by now; hand glibc's freed pages back to the system
    // so the process's memory is the items, not the loader's peak.
    malloc_trim(0);
    LOG_INFO << "loaded " << fixture.size() << " items from " << path;
}

std::vector<ItemPtr> shelf()
{
    std::vector<ItemPtr> out;
    if (!fromFixture)
        return out;
    for (int n = 1; n <= 50; ++n)
    {
        auto it = fixture.find("item_" + std::to_string(n));
        if (it != fixture.end())
            out.push_back(it->second);
    }
    return out;
}

void get(const std::string &id, std::function<void(ItemPtr item, bool failed)> done)
{
    if (fromFixture)
    {
        auto it = fixture.find(id);
        done(it == fixture.end() ? nullptr : it->second, false);
        return;
    }
    auto client = takeClient();
    auto req = HttpRequest::newHttpRequest();
    req->setPath("/api/discovery/items/" + utils::urlEncodeComponent(id));
    client->sendRequest(req, [client, done = std::move(done)](ReqResult result, const HttpResponsePtr &res) {
        idleClients.push_back(client);
        if (result != ReqResult::Ok)
        {
            LOG_ERROR << "item API: " << result;
            done(nullptr, true);
            return;
        }
        if (res->statusCode() == k404NotFound)
        {
            done(nullptr, false);
            return;
        }
        Json::Value api;
        Json::CharReaderBuilder builder;
        std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
        auto body = res->body();
        std::string errors;
        if (res->statusCode() != k200OK || !reader->parse(body.data(), body.data() + body.size(), &api, &errors))
        {
            LOG_ERROR << "item API returned " << res->statusCode() << " " << errors;
            done(nullptr, true);
            return;
        }
        try
        {
            done(std::make_shared<const ItemView>(ItemView::fromApi(api)), false);
        }
        catch (const std::exception &e)
        {
            LOG_ERROR << "item API response: " << e.what();
            done(nullptr, true);
        }
    });
}
}  // namespace items
