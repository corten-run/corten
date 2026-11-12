#include "alerts.h"
#include <cassert>
#include <thread>
#include <vector>

int main() {
 marketplace::Alerts alerts;
 auto fresh = drogon::HttpRequest::newHttpRequest();
 assert(alerts.read(fresh).isArray() && alerts.read(fresh).empty());
 auto response = drogon::HttpResponse::newHttpResponse();
 Json::Value row(Json::objectValue);
 row["item_id"] = "item_1"; row["email"] = "person@example.test"; row["target_minor"] = 1234;
 assert(alerts.append(fresh, response, row));
 const auto &cookie = response->getCookie("marketplace_session");
 assert(cookie.value().size() == 64 && cookie.isHttpOnly() && cookie.path() == "/" && cookie.domain().empty());
 assert(cookie.sameSite() == drogon::Cookie::SameSite::kLax && !cookie.isSecure());
 auto request = drogon::HttpRequest::newHttpRequest();
 request->addCookie("marketplace_session", cookie.value());
 assert(alerts.read(request).size() == 1 && alerts.read(request)[0] == row);
 std::vector<std::thread> threads;
 for (int i = 0; i < 16; ++i) threads.emplace_back([&, i] {
  auto next = row; next["email"] = "concurrent" + std::to_string(i) + "@example.test";
  assert(alerts.append(request, drogon::HttpResponse::newHttpResponse(), std::move(next)));
 });
 for (auto &thread : threads) thread.join();
 assert(alerts.read(request).size() == 17);
 assert(alerts.read(fresh).empty());
 auto forged = drogon::HttpRequest::newHttpRequest(); forged->addCookie("marketplace_session", "chosen");
 auto output = drogon::HttpResponse::newHttpResponse();
 assert(alerts.read(forged).empty() && alerts.append(forged, output, row));
 assert(output->getCookie("marketplace_session").value() != "chosen");
 for (int i = 17; i < 1024; ++i) assert(alerts.append(request, response, row));
 assert(!alerts.append(request, response, row) && alerts.read(request).size() == 1024);
}
