#include "feed.h"
#include <drogon/version.h>
#include <algorithm>
#include <fstream>
#include <memory>
#include <set>
#include <sys/resource.h>
#include <unistd.h>

namespace live {
namespace {
constexpr int64_t safe = 9007199254740991LL;
bool number(const Json::Value &v) { return v.isIntegral() && v.isInt64() && v.asInt64() >= 0 && v.asInt64() <= safe; }
bool text(const Json::Value &v) {
    if (!v.isString() || v.asString().empty() || v.asString().size() > 128) return false;
    for (unsigned char c : v.asString()) if (c < 32 || c == 127) return false;
    return true;
}
bool row(const Json::Value &v) {
    return v.isObject() && v.size() == 4 && text(v["id"]) && number(v["version"])
        && number(v["priceCents"]) && number(v["quantity"]);
}
bool event(const Json::Value &v) {
    if (!v.isObject() || !number(v["seq"]) || !text(v["key"]) || !text(v["effectId"])) return false;
    if (v["op"] == "remove") return v.size() == 4;
    return v["op"] == "upsert" && v.size() == 5 && row(v["row"]) && v["row"]["id"] == v["key"];
}
void require(bool ok, const char *why) { if (!ok) throw Error(400, why); }
Json::Value envelope(const char *kind) {
    Json::Value v(Json::objectValue); v["protocol"] = "drogon-live/v1"; v["kind"] = kind; return v;
}
}
std::string encode(const Json::Value &value) {
    Json::StreamWriterBuilder writer; writer["indentation"] = ""; return Json::writeString(writer, value);
}
Json::Value decode(const std::string &text) {
    Json::CharReaderBuilder builder; builder["rejectDupKeys"] = true; builder["failIfExtra"] = true;
    std::unique_ptr<Json::CharReader> parser(builder.newCharReader());
    Json::Value value; std::string errors;
    require(parser->parse(text.data(), text.data() + text.size(), &value, &errors), "invalid JSON");
    require(value.isObject(), "object required"); return value;
}
Json::Value Feed::counters() {
    Json::Value r(Json::objectValue);
    size_t queued = 0, replay = 0, inFlight = 0, overflow = 0;
    for (const auto &[id, reader] : readers_) {
        (void)id; queued += reader.queue.size(); replay += reader.replay.size();
        inFlight += reader.inFlight; overflow += !reader.overflow.isNull();
    }
    r["subscriptions"] = Json::UInt64(readers_.size());
    r["connections"] = Json::UInt64(readers_.size());
    r["pendingTasks"] = Json::UInt64(readers_.size());
    r["queueLimit"] = Json::UInt64(queueLimit_); r["queueEvents"] = Json::UInt64(queued); r["queuePeak"] = Json::UInt64(queuePeak_);
    r["historyLimit"] = Json::UInt64(historyLimit_); r["historyEvents"] = Json::UInt64(history_.size()); r["historyPeak"] = Json::UInt64(historyPeak_);
    struct rusage usage{}; getrusage(RUSAGE_SELF, &usage);
    long total = 0, resident = 0; std::ifstream("/proc/self/statm") >> total >> resident;
    auto &p = r["process"]; p["pid"] = getpid(); p["version"] = DROGON_VERSION;
    p["rssBytes"] = Json::Int64(resident * sysconf(_SC_PAGESIZE)); p["rssPeakKiB"] = Json::Int64(usage.ru_maxrss);
    p["userCpuUs"] = Json::Int64(usage.ru_utime.tv_sec * 1000000 + usage.ru_utime.tv_usec);
    p["systemCpuUs"] = Json::Int64(usage.ru_stime.tv_sec * 1000000 + usage.ru_stime.tv_usec);
    auto &i = r["inventory"]; i["applicationQueues"] = Json::UInt64(readers_.size());
    i["replayEvents"] = Json::UInt64(replay); i["replayCopyLimitEventsPerReader"] = Json::UInt64(historyLimit_);
    i["inFlight"] = Json::UInt64(inFlight); i["inFlightLimitPerReader"] = 1;
    i["overflowSlots"] = Json::UInt64(overflow); i["overflowSlotsLimitPerReader"] = 1;
    i["sourceRows"] = Json::UInt64(rows_.size()); i["sourceRowsLimit"] = 1000;
    i["snapshotReads"] = Json::UInt64(reads_); i["transportPayloadBytes"] = Json::UInt64(bytes_);
    i["consumerStateMachines"] = Json::UInt64(readers_.size()); i["backgroundPublishers"] = 0;
    i["nativeWriter"] = "Drogon WebSocketConnection::send; next event waits for browser DOM acknowledgement";
    i["nativeTransportBufferedBytes"] = Json::nullValue; i["kernelSocketBytes"] = Json::nullValue;
    return r;
}
Json::Value Feed::resources() { std::lock_guard lock(mutex_); return counters(); }
Json::Value Feed::configure(const Json::Value &v) {
    std::lock_guard lock(mutex_);
    if (!readers_.empty()) throw Error(409, "readers still connected");
    require(v.isObject() && number(v["queueLimit"]) && number(v["historyLimit"]), "limits required");
    auto q = v["queueLimit"].asInt64(), h = v["historyLimit"].asInt64();
    require((q == 2 && h == 4) || (q == 1024 && h == 1025), "unsupported bounds");
    require(v["initial"].isArray() && v["initial"].size() <= 1000, "invalid initial rows");
    std::map<std::string, Json::Value> rows;
    for (const auto &value : v["initial"]) { require(row(value), "invalid row"); require(rows.emplace(value["id"].asString(), value).second, "duplicate key"); }
    rows_ = std::move(rows); history_.clear(); through_ = drop_ = 0; bytes_ = reads_ = 0;
    queuePeak_ = historyPeak_ = 0; queueLimit_ = q; historyLimit_ = h;
    Json::Value result; result["configured"] = true; result["framework"] = "drogon"; result["version"] = DROGON_VERSION; return result;
}
Json::Value Feed::snapshot() {
    std::lock_guard lock(mutex_); ++reads_;
    Json::Value result; result["through"] = Json::Int64(through_); result["rows"] = Json::Value(Json::arrayValue);
    for (const auto &[id, value] : rows_) { (void)id; result["rows"].append(value); }
    result["work"]["reads"] = 1; result["work"]["rows"] = Json::UInt64(rows_.size()); return result;
}
void Feed::send(Reader &r, Json::Value message) { bytes_ += encode(message).size(); r.send(message); }
void Feed::pump(Reader &r) {
    if (!r.started || r.inFlight) return;
    Json::Value message;
    if (!r.overflow.isNull()) { message = envelope("overflow"); message["outcome"] = "resnapshot"; message["resources"] = r.overflow; }
    else if (r.held) return;
    else {
        auto &source = r.replay.empty() ? r.queue : r.replay;
        if (source.empty()) return;
        message = envelope("event"); message["event"] = source.front(); source.pop_front();
        r.deliveredThrough = message["event"]["seq"].asInt64();
    }
    r.inFlight = true; message["delivery"] = Json::UInt64(++r.delivery); send(r, std::move(message));
}
void Feed::enqueue(Reader &r, const Json::Value &e) {
    if (r.queue.size() == queueLimit_) {
        // Capture the actual saturated queue before releasing any payloads.
        r.overflow = counters(); r.lostThrough = e["seq"].asInt64();
        r.queue.clear(); r.replay.clear(); r.held = false;
    } else { r.queue.push_back(e); queuePeak_ = std::max(queuePeak_, r.queue.size()); }
    pump(r);
}
Json::Value Feed::write(const Json::Value &e) {
    through_ = e["seq"].asInt64();
    if (e["op"] == "remove") rows_.erase(e["key"].asString()); else rows_[e["key"].asString()] = e["row"];
    if (history_.size() == historyLimit_) history_.pop_front();
    history_.push_back(e); historyPeak_ = std::max(historyPeak_, history_.size());
    if (through_ != drop_) for (auto &[id, reader] : readers_) { (void)id; enqueue(reader, e); }
    Json::Value ack; ack["seq"] = Json::Int64(through_); ack["resources"] = counters(); return ack;
}
Json::Value Feed::publish(const Json::Value &v) {
    std::lock_guard lock(mutex_);
    require(v.isObject() && v.isMember("event") != v.isMember("events") && v.size() == 1, "one event or events required");
    const bool batch = v.isMember("events"); Json::Value events(Json::arrayValue);
    if (batch) { require(queueLimit_ == 1024 && v["events"].isArray(), "batch requires native-feed"); events = v["events"]; }
    else events.append(v["event"]);
    require(!events.empty() && events.size() <= 1044 && through_ <= safe - static_cast<int64_t>(events.size()), "invalid publication count");
    std::set<std::string> keys; for (const auto &[key, value] : rows_) { (void)value; keys.insert(key); }
    for (Json::ArrayIndex n = 0; n < events.size(); ++n) {
        const auto &e = events[n]; require(event(e) && e["seq"].asInt64() == through_ + n + 1, "invalid/nonconsecutive event");
        if (e["op"] == "remove") keys.erase(e["key"].asString()); else keys.insert(e["key"].asString());
        require(keys.size() <= 1000, "source row limit");
    }
    Json::Value acks(Json::arrayValue); for (const auto &e : events) acks.append(write(e));
    if (!batch) return acks[0];
    Json::Value result; result["acks"] = std::move(acks); return result;
}
Json::Value Feed::control(const Json::Value &v) {
    std::lock_guard lock(mutex_); require(v.isObject() && v["action"].isString(), "action required");
    if (v["action"] == "hold") { for (auto &[id, r] : readers_) { (void)id; r.held = true; } }
    else if (v["action"] == "drop") { require(number(v["seq"]) && v["seq"].asInt64() > through_, "future sequence required"); drop_ = v["seq"].asInt64(); }
    else if (v["action"] == "duplicate") { require(!history_.empty(), "no event to duplicate"); for (auto &[id, r] : readers_) { (void)id; enqueue(r, history_.back()); } }
    else throw Error(400, "unknown control");
    Json::Value result; result["resources"] = counters(); return result;
}
uint64_t Feed::attach(int64_t from, Sink sink) {
    std::lock_guard lock(mutex_);
    if (readers_.size() == 16) throw Error(409, "reader limit");
    require(from >= 0 && from <= through_, "invalid cursor");
    bool expired = from < through_ && (history_.empty() || from < history_.front()["seq"].asInt64() - 1);
    Reader reader; reader.send = std::move(sink); reader.deliveredThrough = from;
    if (!expired) for (const auto &e : history_) if (e["seq"].asInt64() >= from) reader.replay.push_back(e);
    auto id = ++nextReader_; auto &r = readers_.emplace(id, std::move(reader)).first->second;
    auto ready = envelope("ready"); ready["from"] = Json::Int64(from); ready["status"] = expired ? "expired" : "accepted";
    ready["resources"] = counters(); send(r, std::move(ready)); return id;
}
void Feed::message(uint64_t id, const Json::Value &v) {
    std::lock_guard lock(mutex_); auto found = readers_.find(id); require(found != readers_.end(), "unknown reader");
    auto &r = found->second;
    require(v.isObject() && number(v["through"]) && v["through"].asInt64() <= through_
        && (!v.isMember("snapshot") || v["snapshot"].isBool()), "invalid acknowledgement cursor");
    auto through = v["through"].asInt64();
    if (v["kind"] == "start") { require(!r.started, "already started"); r.started = true; }
    else {
        require(v["kind"] == "ack" && r.inFlight && number(v["delivery"]) && v["delivery"].asUInt64() == r.delivery, "invalid delivery acknowledgement");
        require(through >= r.deliveredThrough, "acknowledgement regressed"); r.inFlight = false;
    }
    const bool snapshot = v.get("snapshot", false).asBool();
    auto prune = [through, snapshot](auto &queue) { while (!queue.empty() && (queue.front()["seq"].asInt64() < through || (snapshot && queue.front()["seq"].asInt64() == through))) queue.pop_front(); };
    prune(r.queue); prune(r.replay);
    if (snapshot && through >= r.lostThrough) { r.overflow = Json::nullValue; r.lostThrough = 0; }
    pump(r);
}
void Feed::close(uint64_t id) { std::lock_guard lock(mutex_); readers_.erase(id); }
}
