#include "feed.h"
#include <cassert>
#include <iostream>
#include <vector>

using live::decode;
Json::Value config(int queue = 2, int history = 4) {
    auto v = decode(R"({"initial":[{"id":"a","version":0,"priceCents":123,"quantity":2}],"queueLimit":2,"historyLimit":4})");
    v["queueLimit"] = queue; v["historyLimit"] = history; return v;
}
Json::Value change(int seq, bool remove = false) {
    auto e = decode(R"({"seq":1,"key":"a","effectId":"e1","op":"upsert","row":{"id":"a","version":1,"priceCents":456,"quantity":3}})");
    e["seq"] = seq; e["effectId"] = "e" + std::to_string(seq); e["row"]["version"] = seq;
    if (remove) { e["op"] = "remove"; e.removeMember("row"); } return e;
}
Json::Value input(Json::Value e) { Json::Value v; v["event"] = std::move(e); return v; }
template<typename F> void rejected(F action, int status = 400) {
    try { action(); assert(false); } catch (const live::Error &error) { assert(error.status == status); }
}
void ack(live::Feed &f, uint64_t id, const Json::Value &message, int through, bool snapshot = false) {
    Json::Value v; v["kind"] = "ack"; v["delivery"] = message["delivery"]; v["through"] = through; v["snapshot"] = snapshot; f.message(id, v);
}
void start(live::Feed &f, uint64_t id, int through = 0) {
    Json::Value v; v["kind"] = "start"; v["through"] = through; f.message(id, v);
}
int main() {
    live::Feed f;
    f.configure(config());
    assert(f.snapshot()["rows"][0]["priceCents"] == 123);
    for (auto bad : {decode("{}"), decode(R"({"event":null})"), input(change(2))}) rejected([&] { f.publish(bad); });
    auto badRow = change(1); badRow["row"]["quantity"] = "3"; rejected([&] { f.publish(input(badRow)); });
    rejected([&] { decode(R"({"a":1,"a":2})"); });
    rejected([&] { decode("{} junk"); });
    auto duplicates = config(); duplicates["initial"].append(duplicates["initial"][0]); rejected([&] { f.configure(duplicates); });
    assert(f.snapshot()["through"] == 0);
    std::vector<Json::Value> frames;
    auto id = f.attach(0, [&](const auto &v) { frames.push_back(v); });
    assert(frames.back()["kind"] == "ready" && frames.back()["status"] == "accepted");
    rejected([&] { f.configure(config()); }, 409);
    start(f, id);
    f.publish(input(change(1))); assert(frames.back()["event"] == change(1));
    auto first = frames.back();
    f.publish(input(change(2, true))); f.publish(input(change(3)));
    assert(frames.back() == first); // No native send without an acknowledgement.
    assert(f.resources()["queueEvents"].asInt() == 2 && f.resources()["inventory"]["inFlight"].asInt() == 1);
    ack(f, id, first, 1); assert(frames.back()["event"] == change(2, true));
    ack(f, id, frames.back(), 2); assert(frames.back()["event"] == change(3));
    ack(f, id, frames.back(), 3);
    assert(f.snapshot()["rows"][0]["version"] == 3);
    f.control(decode(R"({"action":"duplicate"})")); assert(frames.back()["event"] == change(3)); ack(f, id, frames.back(), 3);
    f.close(id); assert(f.resources()["pendingTasks"].asInt() == 0);
    frames.clear(); id = f.attach(1, [&](const auto &v) { frames.push_back(v); }); start(f, id, 1);
    assert(frames.back()["event"] == change(1)); ack(f, id, frames.back(), 1);
    assert(frames.back()["event"] == change(2, true)); f.close(id);
    for (int n = 4; n <= 8; ++n) f.publish(input(change(n)));
    frames.clear(); id = f.attach(1, [&](const auto &v) { frames.push_back(v); }); assert(frames.back()["status"] == "expired"); f.close(id);
    rejected([&] { f.attach(-1, [](auto) {}); }); rejected([&] { f.attach(9, [](auto) {}); });

    for (auto bounds : {std::pair{2, 4}, std::pair{1024, 1025}}) {
        f.configure(config(bounds.first, bounds.second));
        std::vector<std::vector<Json::Value>> readers(16); std::vector<uint64_t> ids;
        for (auto &reader : readers) { auto *target = &reader; ids.push_back(f.attach(0, [target](auto v) { target->push_back(v); })); start(f, ids.back()); }
        rejected([&] { f.attach(0, [](auto) {}); }, 409);
        f.control(decode(R"({"action":"hold"})"));
        Json::Value batch; batch["events"] = Json::Value(Json::arrayValue);
        for (int n = 1; n <= bounds.first + 1; ++n) batch["events"].append(change(n));
        if (bounds.first == 1024) {
            auto invalid = batch; invalid["events"][1000]["seq"] = 9999;
            rejected([&] { f.publish(invalid); }); assert(f.snapshot()["through"] == 0);
            auto empty = batch; empty["events"].clear(); rejected([&] { f.publish(empty); });
            auto mixed = batch; mixed["event"] = change(1); rejected([&] { f.publish(mixed); });
            const auto result = f.publish(batch); assert(result["acks"].size() == 1025);
            assert(result["acks"][1023]["resources"]["queueEvents"].asInt() == 16 * 1024);
        } else {
            rejected([&] { f.publish(batch); });
            for (const auto &e : batch["events"]) f.publish(input(e));
        }
        assert(f.resources()["queuePeak"].asInt() == bounds.first);
        for (size_t n = 0; n < readers.size(); ++n) {
            const auto &overflow = readers[n].back(); assert(overflow["kind"] == "overflow");
            assert(overflow["resources"]["queuePeak"].asInt() == bounds.first);
            ack(f, ids[n], overflow, bounds.first + 1, true);
            f.close(ids[n]);
        }
        const auto released = f.resources();
        for (auto name : {"subscriptions", "connections", "pendingTasks", "queueEvents"}) assert(released[name].asInt() == 0);
        assert(released["historyEvents"].asInt() <= bounds.second);
        assert(released["historyPeak"].asInt() <= bounds.second);
    }
    f.configure(config(1024, 1025));
    Json::Value batch; batch["events"] = Json::Value(Json::arrayValue);
    for (int n = 1; n <= 1044; ++n) batch["events"].append(change(n));
    auto result = f.publish(batch); assert(result["acks"].size() == 1044);
    assert(f.snapshot()["through"] == 1044 && f.resources()["historyEvents"].asInt() == 1025);
    auto oversized = batch; oversized["events"].append(change(1045)); rejected([&] { f.publish(oversized); });
    std::cout << "native feed: validation, atomic batch, keyed writes, 16 readers, ack gate, replay/expiry, real 2/1024 saturation and cleanup passed\n";
}
