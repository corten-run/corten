#pragma once
#include <drogon/drogon.h>
#include <chrono>
#include <mutex>
#include <unordered_map>

namespace marketplace {
class Alerts {
 public:
  bool append(const drogon::HttpRequestPtr &request, const drogon::HttpResponsePtr &response, Json::Value row);
  Json::Value read(const drogon::HttpRequestPtr &request);
 private:
  struct Session {
   std::chrono::steady_clock::time_point expires;
   Json::Value rows{Json::arrayValue};
  };
  std::mutex mutex_;
  std::unordered_map<std::string, Session> sessions_;
};
}
