#include "feed.h"
#include <drogon/drogon.h>
#include <drogon/WebSocketController.h>
#include <charconv>
#include <cstdlib>
#include <fstream>
#include <iterator>

namespace {
live::Feed feed;
std::string load(const char *path) {
    std::ifstream file(path); if (!file) throw std::runtime_error("missing static asset");
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
std::string escape(const std::string &text) {
    std::string out;
    for (char c : text) switch (c) {
        case '&': out += "&amp;"; break; case '<': out += "&lt;"; break;
        case '>': out += "&gt;"; break; case '"': out += "&quot;"; break;
        case '\'': out += "&#39;"; break; default: out += c;
    }
    return out;
}
using Callback = std::function<void(const drogon::HttpResponsePtr &)>;
void reply(const Callback &callback, const Json::Value &value, int status = 200) {
    auto response = drogon::HttpResponse::newHttpJsonResponse(value);
    response->setStatusCode(static_cast<drogon::HttpStatusCode>(status));
    response->addHeader("Cache-Control", "no-store"); callback(response);
}
template<typename F> auto endpoint(F action) {
    return [action](const drogon::HttpRequestPtr &request, Callback &&callback) {
        try { reply(callback, action(request)); }
        catch (const live::Error &error) { Json::Value result; result["error"] = error.what(); reply(callback, result, error.status); }
    };
}
}

class LiveSocket : public drogon::WebSocketController<LiveSocket> {
  public:
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/parity/socket");
    WS_PATH_LIST_END
    void handleNewConnection(const drogon::HttpRequestPtr &request, const drogon::WebSocketConnectionPtr &connection) override {
        try {
            auto cursor = request->getParameter("from"); int64_t from = -1;
            auto parsed = std::from_chars(cursor.data(), cursor.data() + cursor.size(), from);
            if (cursor.empty() || parsed.ec != std::errc{} || parsed.ptr != cursor.data() + cursor.size()) throw live::Error(400, "invalid cursor");
            std::weak_ptr<drogon::WebSocketConnection> weak = connection;
            auto id = feed.attach(from, [weak](const Json::Value &message) { if (auto socket = weak.lock()) socket->send(live::encode(message)); });
            connection->setContext(std::make_shared<uint64_t>(id));
        } catch (const live::Error &error) { connection->shutdown(drogon::CloseCode::kViolation, error.what()); }
    }
    void handleNewMessage(const drogon::WebSocketConnectionPtr &connection, std::string &&text,
                          const drogon::WebSocketMessageType &type) override {
        if (type == drogon::WebSocketMessageType::Ping || type == drogon::WebSocketMessageType::Pong) return;
        try {
            if (type != drogon::WebSocketMessageType::Text || !connection->hasContext()) throw live::Error(400, "text acknowledgement required");
            feed.message(*connection->getContext<uint64_t>(), live::decode(text));
        } catch (const live::Error &error) { connection->shutdown(drogon::CloseCode::kViolation, error.what()); }
    }
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr &connection) override {
        if (connection->hasContext()) { feed.close(*connection->getContext<uint64_t>()); connection->clearContext(); }
    }
};

int main() {
    const auto html = load("static/index.html"), client = load("static/client.js");
    auto &app = drogon::app();
    app.setThreadNum(1).setClientMaxBodySize(1024 * 1024).setClientMaxMemoryBodySize(1024 * 1024)
       .setClientMaxWebSocketMessageSize(1024).setLogLevel(trantor::Logger::kWarn);
    app.registerHandler("/", [html](const drogon::HttpRequestPtr &, Callback &&callback) {
        auto page = html; std::string rows; const auto snapshot = feed.snapshot();
        for (const auto &row : snapshot["rows"]) {
            rows += "<tr data-key=\"" + escape(row["id"].asString()) + "\"><th scope=\"row\">" + escape(row["id"].asString()) + "</th>";
            for (const char *field : {"version", "priceCents", "quantity"}) rows += "<td>" + row[field].asString() + "</td>";
            rows += "</tr>";
        }
        page.replace(page.find("<!--rows-->"), 11, rows);
        auto response = drogon::HttpResponse::newHttpResponse(); response->setContentTypeCode(drogon::CT_TEXT_HTML);
        response->setBody(std::move(page)); response->addHeader("Cache-Control", "no-store");
        response->addHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        callback(response);
    }, {drogon::Get});
    app.registerHandler("/client.js", [client](const drogon::HttpRequestPtr &, Callback &&callback) {
        auto response = drogon::HttpResponse::newHttpResponse(); response->setContentTypeCode(drogon::CT_TEXT_JAVASCRIPT);
        response->setBody(client); callback(response);
    }, {drogon::Get});
    app.registerHandler("/parity/configure", endpoint([](auto request) { return feed.configure(live::decode(std::string(request->body()))); }), {drogon::Post});
    app.registerHandler("/parity/publish", endpoint([](auto request) { return feed.publish(live::decode(std::string(request->body()))); }), {drogon::Post});
    app.registerHandler("/parity/control", endpoint([](auto request) { return feed.control(live::decode(std::string(request->body()))); }), {drogon::Post});
    app.registerHandler("/parity/snapshot", endpoint([](auto) { return feed.snapshot(); }), {drogon::Get});
    app.registerHandler("/parity/resources", endpoint([](auto request) {
        const auto query = request->getParameter("reader");
        if (query.empty()) return feed.resources();
        uint64_t id = 0; auto parsed = std::from_chars(query.data(), query.data() + query.size(), id);
        if (!id || parsed.ec != std::errc{} || parsed.ptr != query.data() + query.size()) throw live::Error(400, "invalid reader identity");
        return feed.resources(id);
    }), {drogon::Get});
    const char *port = std::getenv("PORT"); app.addListener("0.0.0.0", port ? std::stoi(port) : 8080).run();
}
