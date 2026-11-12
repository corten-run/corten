#include "catalog.h"
#include "marketplace.h"
#include <json/reader.h>
#include <json/writer.h>
#include <cassert>
#include <functional>
#include <iostream>
#include <sstream>
#include <stdexcept>

Json::Value parse(const std::string &text)
{
    Json::Value value;
    Json::CharReaderBuilder builder;
    Json::CharReaderBuilder::strictMode(&builder.settings_);
    std::string errors;
    std::istringstream input(text);
    if (!Json::parseFromStream(builder, input, &value, &errors)) throw std::runtime_error(errors);
    return value;
}

int main()
{
    auto catalog = parse(R"({"id":"record_1","title":"<&\"\\\n café","subtitle":"","description":"Text",
        "tags":["<&>"],"fields":[{"name":"Name","value":"Value"}],"related":[{"id":"record_2","title":"Other"}]})");
    auto catalogParse = [](const Json::Value &v) { return catalog::Record::fromJson(v).toJson(); };
    assert(catalogParse(catalog) == catalog);
    auto marketplace = parse(R"({"id":"item_1","title":"<&\"\\\n café","subtitle":null,"description":"Text",
        "categories":[{"name":"Cards","slug":"cards"}],"badges":["Rare"],"tags":["foil"],"images":["/one"],
        "fields":[{"name":"Name","value":"Value"}],"summary":{"lowest_minor":-1000000000,"count":1000000000,"quantity":0},
        "listings":[{"id":"listing","seller":"Seller","rating_hundredths":500,"reviews":0,"condition":"NM","ships_from":"US","quantity":1000000000,"price_minor":null}],
        "offers":[{"id":"offer","buyer":"Buyer","condition":"NM","quantity":0,"price_minor":1000000000}],
        "contents":[{"id":"line","item_id":"item_1","title":"Other","quantity":2}],
        "included_in":[{"id":"box","item_id":"item_1","title":"Box","quantity":1}]})");
    assert(marketplace::parseRecord(marketplace) == marketplace);
    auto changed = marketplace;
    changed["upstream_only"] = true;
    assert(marketplace::parseRecord(changed) == marketplace);
    Json::StreamWriterBuilder writer;
    assert(parse(Json::writeString(writer, marketplace::parseRecord(marketplace))) == marketplace);
    size_t rejected = 0;
    auto bad = [&](const Json::Value &value, const std::function<Json::Value(const Json::Value &)> &read) {
        bool threw = false;
        try { read(value); } catch (const std::exception &) { threw = true; }
        assert(threw); ++rejected;
    };
    for (const auto &key : catalog.getMemberNames()) {
        changed = catalog; changed.removeMember(key); bad(changed, catalogParse);
        changed = catalog; changed[key] = Json::Value(); bad(changed, catalogParse);
        changed = catalog; changed[key] = true; bad(changed, catalogParse);
    }
    for (auto key : {"tags", "fields", "related"}) {
        changed = catalog; changed[key][0] = Json::Value(); bad(changed, catalogParse);
    }
    for (auto collection : {"fields", "related"}) for (const auto &key : catalog[collection][0].getMemberNames()) {
        changed = catalog; changed[collection][0].removeMember(key); bad(changed, catalogParse);
        changed = catalog; changed[collection][0][key] = Json::Value(); bad(changed, catalogParse);
    }
    for (const auto &key : marketplace.getMemberNames()) {
        changed = marketplace; changed.removeMember(key); bad(changed, marketplace::parseRecord);
        changed = marketplace; changed[key] = true; bad(changed, marketplace::parseRecord);
        if (key != "subtitle" && key != "summary") {
            changed = marketplace; changed[key] = Json::Value(); bad(changed, marketplace::parseRecord);
        }
    }
    for (auto key : {"categories", "badges", "tags", "images", "fields", "listings", "offers", "contents", "included_in"}) {
        changed = marketplace; changed[key][0] = Json::Value(); bad(changed, marketplace::parseRecord);
    }
    for (auto key : {"listings", "offers", "contents", "included_in"}) {
        changed = marketplace; changed[key].append(changed[key][0]); bad(changed, marketplace::parseRecord);
    }
    for (auto collection : {"categories", "fields", "listings", "offers", "contents", "included_in", "summary"}) {
        const auto &row = std::string(collection) == "summary" ? marketplace[collection] : marketplace[collection][0];
        for (const auto &key : row.getMemberNames()) {
            changed = marketplace;
            auto &target = std::string(collection) == "summary" ? changed[collection] : changed[collection][0];
            target.removeMember(key); bad(changed, marketplace::parseRecord);
            target[key] = false; bad(changed, marketplace::parseRecord);
        }
    }
    auto numeric = [&](const char *collection, const char *key, bool money, bool rating = false) {
        for (const auto &value : {Json::Value(Json::Int64(money ? -1000000001LL : -1)),
                                 Json::Value(Json::Int64(rating ? 501 : 1000000001LL)), Json::Value(0.5), Json::Value("1")}) {
            changed = marketplace;
            auto &row = std::string(collection) == "summary" ? changed[collection] : changed[collection][0];
            row[key] = value; bad(changed, marketplace::parseRecord);
        }
    };
    numeric("summary", "lowest_minor", true); numeric("summary", "count", false); numeric("summary", "quantity", false);
    numeric("listings", "rating_hundredths", false, true); numeric("listings", "reviews", false);
    numeric("listings", "quantity", false); numeric("listings", "price_minor", true);
    numeric("offers", "quantity", false); numeric("offers", "price_minor", true);
    numeric("contents", "quantity", false); numeric("included_in", "quantity", false);
    bool malformed = false;
    try { parse("{} garbage"); } catch (const std::exception &) { malformed = true; }
    assert(malformed);
    std::cout << "PASS native record models: full schema/escaping/numeric/null round trips, unknown-field projection, "
              << rejected << " invalid shapes/bounds/duplicates rejected, trailing JSON rejected\n";
}
