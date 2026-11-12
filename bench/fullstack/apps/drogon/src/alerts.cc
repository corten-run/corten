#include "alerts.h"
#include <drogon/utils/Utilities.h>
#include <openssl/rand.h>

namespace marketplace {
namespace { constexpr auto cookieName = "marketplace_session"; }
bool Alerts::append(const drogon::HttpRequestPtr &request, const drogon::HttpResponsePtr &response, Json::Value row) {
 std::lock_guard<std::mutex> lock(mutex_);
 auto now = std::chrono::steady_clock::now();
 for (auto it = sessions_.begin(); it != sessions_.end(); ) {
  if (now >= it->second.expires) it = sessions_.erase(it); else ++it;
 }
 auto found = sessions_.find(request->getCookie(cookieName));
 if (found == sessions_.end()) {
  if (sessions_.size() >= 4096) return false;
  unsigned char bytes[32];
  if (RAND_bytes(bytes, sizeof bytes) != 1) return false;
  auto token = drogon::utils::binaryStringToHex(bytes, sizeof bytes);
  found = sessions_.emplace(token, Session{now + std::chrono::hours(1), Json::Value(Json::arrayValue)}).first;
  drogon::Cookie cookie(cookieName, token);
  cookie.setPath("/"); cookie.setHttpOnly(true); cookie.setSameSite(drogon::Cookie::SameSite::kLax);
  cookie.setSecure(request->isOnSecureConnection());
  response->addCookie(cookie);
 }
 if (found->second.rows.size() >= 1024) return false;
 found->second.rows.append(std::move(row));
 return true;
}
Json::Value Alerts::read(const drogon::HttpRequestPtr &request) {
 std::lock_guard<std::mutex> lock(mutex_);
 auto found = sessions_.find(request->getCookie(cookieName));
 if (found == sessions_.end() || std::chrono::steady_clock::now() >= found->second.expires) return Json::Value(Json::arrayValue);
 return found->second.rows;
}
}
