#pragma once
#include <json/json.h>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>

namespace live {
struct Error : std::runtime_error {
    int status;
    Error(int code, const char *message) : std::runtime_error(message), status(code) {}
};
std::string encode(const Json::Value &value);
Json::Value decode(const std::string &text);

// All writes, attachment/replay fences and acknowledgement transitions serialize here.
// Sinks enqueue one native WebSocket frame and never call back into the store.
class Feed {
  public:
    using Sink = std::function<void(const Json::Value &)>;
    Json::Value configure(const Json::Value &input);
    Json::Value snapshot();
    Json::Value resources();
    Json::Value publish(const Json::Value &input);
    Json::Value control(const Json::Value &input);
    uint64_t attach(int64_t from, Sink sink);
    void message(uint64_t id, const Json::Value &input);
    void close(uint64_t id);

  private:
    struct Reader {
        Sink send;
        std::deque<Json::Value> queue, replay;
        Json::Value overflow;
        int64_t lostThrough = 0, deliveredThrough = 0;
        uint64_t delivery = 0;
        bool started = false, inFlight = false, held = false;
    };
    std::mutex mutex_;
    std::map<std::string, Json::Value> rows_;
    std::deque<Json::Value> history_;
    std::map<uint64_t, Reader> readers_;
    int64_t through_ = 0, drop_ = 0;
    uint64_t nextReader_ = 0, bytes_ = 0, reads_ = 0;
    size_t queueLimit_ = 2, historyLimit_ = 4, queuePeak_ = 0, historyPeak_ = 0;
    Json::Value counters();
    void enqueue(Reader &reader, const Json::Value &event);
    void pump(Reader &reader);
    void send(Reader &reader, Json::Value message);
    Json::Value write(const Json::Value &event);
};
}
