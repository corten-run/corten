// Corten's card-market pages in Drogon: the home page, the item page and the 404 page as CSP
// views with the same markup and stylesheets, htmx for the form, "show all" and navigation,
// the item as JSON, and the live benchmark's server-sent events.
#include "items.h"
#include "catalog.h"
#include "marketplace.h"
#include "live.h"
#include "model.h"

#include <drogon/drogon.h>
#include <drogon/HttpMiddleware.h>
#include <sched.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <string>
#include <thread>

using namespace drogon;

namespace
{
using Callback = std::function<void(const HttpResponsePtr &)>;

// The cores this process may run on: the affinity mask, capped by the cgroup's CPU quota
// (`docker run --cpus 1` is a quota: the container still sees every core of the host).
size_t cpuCount()
{
    cpu_set_t set;
    size_t n = sched_getaffinity(0, sizeof set, &set) == 0 ? CPU_COUNT(&set) : std::thread::hardware_concurrency();
    std::ifstream file("/sys/fs/cgroup/cpu.max");
    std::string quota;
    long long period = 0;
    if (file >> quota >> period && quota != "max" && period > 0)
        n = std::min<size_t>(n, (std::stoll(quota) + period - 1) / period);
    return std::max<size_t>(n, 1);
}

HttpResponsePtr failure()
{
    return HttpResponse::newHttpResponse(k502BadGateway, CT_TEXT_PLAIN);
}

LivePrices live;
}  // namespace

int main()
{
    // Drogon logs to stdout; a line at a time, so `docker logs` shows each as it happens.
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    // Load the fixture (if any) before listening, like the other apps.
    items::load();
    try
    {
        catalog::load();
        marketplace::load();
    }
    catch (const std::exception &error)
    {
        std::fprintf(stderr, "record fixture startup: %s\n", error.what());
        return 1;
    }
    marketplace::routes();
    const char *port = std::getenv("PORT");

    // Corten's 404 page, for a missing item and for any address no handler serves.
    HttpViewData missing;
    missing.insert("title", std::string("Not found | Card Market"));
    app().setCustom404Page(HttpResponse::newHttpViewResponse("MissingPage", missing));

    app().registerHandler(
        "/",
        [](const HttpRequestPtr &, Callback &&callback) {
            HttpViewData data;
            data.insert("title", std::string("Popular items | Card Market"));
            data.insert("shelf", items::shelf());
            callback(HttpResponse::newHttpViewResponse("HomePage", data));
        },
        {Get});

    app().registerHandler(
        "/items/{id}",
        [](const HttpRequestPtr &req, Callback &&callback, const std::string &id) {
            items::get(id, [req, callback = std::move(callback)](ItemPtr item, bool failed) {
                if (failed)
                    return callback(failure());
                if (!item)
                    return callback(HttpResponse::newNotFoundResponse(req));
                HttpViewData data;
                std::string message;
                if (req->method() == Post)
                {
                    message = alertMessage(req->getParameter("title"),
                                           req->getParameter("email"),
                                           req->getParameter("target_price"));
                    // htmx swaps only the message; without JavaScript the whole page comes back.
                    if (!req->getHeader("hx-request").empty())
                    {
                        data.insert("message", std::move(message));
                        return callback(HttpResponse::newHttpViewResponse("AlertMessage", data));
                    }
                }
                data.insert("title", item->title + " | Card Market");
                data.insert("item", item);
                data.insert("all_offers", req->getParameter("offers") == "all");
                data.insert("message", std::move(message));
                callback(HttpResponse::newHttpViewResponse("ItemPage", data));
            });
        },
        {Get, Post});

    // The item as JSON for other services: the same data the page renders.
    app().registerHandler(
        "/api/items/{id}",
        [](const HttpRequestPtr &, Callback &&callback, const std::string &id) {
            items::get(id, [callback = std::move(callback)](ItemPtr item, bool failed) {
                if (failed)
                    return callback(failure());
                if (!item)
                    return callback(HttpResponse::newHttpResponse(k404NotFound, CT_TEXT_PLAIN));
                callback(HttpResponse::newHttpJsonResponse(item->toJson()));
            });
        },
        {Get});

    app().registerHandler(
        "/catalog/{id}",
        [](const HttpRequestPtr &req, Callback &&callback, const std::string &id) {
            catalog::get(id, [req, callback = std::move(callback)](catalog::RecordPtr record, bool failed) {
                if (failed) return callback(failure());
                if (!record) return callback(HttpResponse::newNotFoundResponse(req));
                HttpViewData data;
                data.insert("title", record->title);
                data.insert("catalog_page", true);
                data.insert("record", record);
                data.insert("prefix", req->getParameter("field"));
                callback(HttpResponse::newHttpViewResponse("CatalogPage", data));
            });
        }, {Get});
    app().registerHandler(
        "/api/catalog/{id}",
        [](const HttpRequestPtr &request, Callback &&callback, const std::string &id) {
            catalog::json(request, std::move(callback), id);
        }, {drogon::HttpOptionsMiddleware::classTypeName()});

    // The live benchmark (bench/live): server-sent events, and the publisher that feeds them.
    app().registerHandler(
        "/live/prices",
        [](const HttpRequestPtr &, Callback &&callback) {
            // The stream stays open as long as the client does: no idle kickoff.
            auto res = HttpResponse::newAsyncStreamResponse(
                [](ResponseStreamPtr stream) { live.subscribe(std::move(stream)); }, true);
            res->setContentTypeString("text/event-stream");
            res->addHeader("Cache-Control", "no-cache");
            callback(res);
        },
        {Get});
    app().registerHandler(
        "/live/publish",
        [](const HttpRequestPtr &req, Callback &&callback) {
            live.publish(std::string(req->body()));
            callback(HttpResponse::newHttpResponse(k204NoContent, CT_NONE));
        },
        {Post});

    // One IO thread per core, as Drogon's docs advise (the thread count defaults to 1; 0 would
    // count every core of the host).
    app()
        .setThreadNum(cpuCount())
        .setDocumentRoot("static")
        .addListener("0.0.0.0", port && *port ? static_cast<uint16_t>(std::atoi(port)) : 8080)
        .run();
}
