#include "record_http.h"

#include <drogon/HttpClient.h>
#include <drogon/utils/Utilities.h>
#include <trantor/net/EventLoop.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdlib>
#include <memory>
#include <utility>
#include <vector>

namespace record_http
{
namespace
{
// Drogon 1.9.14 exposes a full-response timeout, but no HttpClient cancel method. Its public
// socket hook lets an exclusive request shut down its own connection on caller disconnect.
// A duplicate descriptor cannot accidentally refer to a later, unrelated socket after reuse.
struct Socket
{
    int fd = -1;
    bool canceled = false;
    ~Socket() { if (fd >= 0) ::close(fd); }
    void cancel()
    {
        canceled = true;
        if (fd >= 0) ::shutdown(fd, SHUT_RDWR);
    }
    void attach(int source)
    {
        if (fd >= 0) ::close(fd);
        fd = ::fcntl(source, F_DUPFD_CLOEXEC, 0);
        if (fd < 0) { canceled = true; ::shutdown(source, SHUT_RDWR); return; }
        if (canceled) ::shutdown(fd, SHUT_RDWR);
    }
};
struct Client
{
    drogon::HttpClientPtr http;
    std::shared_ptr<Socket> socket;
};
// Bound retained idle connections, not concurrent work. Every in-flight read owns one client;
// no pipelined response or canceled read can become another request's response.
thread_local std::vector<std::shared_ptr<Client>> idle;

struct Read
{
    std::shared_ptr<Client> client;
    drogon::HttpRequestPtr caller;
    Callback done;
    trantor::EventLoop *loop;
    trantor::TimerId watch = 0;
    bool completed = false;

    void finish(Result result, const drogon::HttpResponsePtr &response)
    {
        if (completed) return;
        completed = true;
        loop->invalidateTimer(watch);
        if (result == Result::Ok && response && !response->ifCloseConnection() && idle.size() < 16)
            idle.push_back(std::move(client));
        else
        {
            client->socket->cancel();
            client.reset();
        }
        caller.reset();
        auto callback = std::move(done);
        callback(result, response);
    }
};
}  // namespace

void get(const drogon::HttpRequestPtr &caller, const std::string &prefix, const std::string &id, Callback done)
{
    auto read = std::make_shared<Read>();
    read->caller = caller;
    read->done = std::move(done);
    read->loop = trantor::EventLoop::getEventLoopOfCurrentThread();
    if (idle.empty())
    {
        read->client = std::make_shared<Client>();
        auto &client = *read->client;
        const char *base = std::getenv("API_BASE");
        client.http = drogon::HttpClient::newHttpClient(base && *base ? base : "http://localhost:8080", read->loop);
        client.socket = std::make_shared<Socket>();
        client.http->setSockOptCallback([socket = client.socket](int fd) { socket->attach(fd); });
    }
    else
    {
        read->client = std::move(idle.back());
        idle.pop_back();
    }
    auto request = drogon::HttpRequest::newHttpRequest();
    auto component = drogon::utils::urlEncodeComponent(id);
    // urlEncodeComponent uses form-style '+' for spaces; a path needs percent-encoding.
    for (size_t at = 0; (at = component.find('+', at)) != std::string::npos; at += 3)
        component.replace(at, 1, "%20");
    request->setPath(prefix + component);
    request->setPathEncode(false);
    // The weak timer never keeps the caller or its callback alive after completion.
    read->watch = read->loop->runEvery(0.05, [weak = std::weak_ptr<Read>(read)] {
        if (auto read = weak.lock(); read && !read->completed && !read->caller->connected())
            read->finish(Result::Aborted, nullptr);
    });
    read->client->http->sendRequest(request, [read](drogon::ReqResult result, const drogon::HttpResponsePtr &response) {
        read->finish(result == drogon::ReqResult::Ok ? Result::Ok :
                     result == drogon::ReqResult::Timeout ? Result::Timeout : Result::Failed, response);
    }, 10.0); // Covers connect, response headers and the complete body, not just time to headers.
}

drogon::HttpResponsePtr problem(drogon::HttpStatusCode status)
{
    Json::Value value(Json::objectValue);
    value["status"] = static_cast<int>(status);
    value["title"] = status == drogon::k404NotFound ? "Not Found" :
                     status == drogon::k405MethodNotAllowed ? "Method Not Allowed" :
                     status == drogon::k504GatewayTimeout ? "Gateway Timeout" : "Bad Gateway";
    auto response = drogon::HttpResponse::newHttpJsonResponse(std::move(value));
    response->setStatusCode(status);
    response->setContentTypeString("application/problem+json");
    response->addHeader("Cache-Control", "no-store");
    if (status == drogon::k405MethodNotAllowed) response->addHeader("Allow", "GET, HEAD");
    return response;
}
}  // namespace record_http
