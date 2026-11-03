#include "model.h"

#include <json/writer.h>

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <limits>

namespace
{
// A value's JSON text, as serde_json writes it: integers as they are, other numbers in the
// shortest form that reads back the same (with ".0" when whole), anything else compact.
std::string jsonText(const Json::Value &v)
{
    switch (v.type())
    {
        case Json::intValue:
            return std::to_string(v.asInt64());
        case Json::uintValue:
            return std::to_string(v.asUInt64());
        case Json::realValue:
        {
            double d = v.asDouble();
            if (!std::isfinite(d))
                return "null";
            char buf[32];
            auto end = std::to_chars(buf, buf + sizeof buf, d).ptr;
            std::string out(buf, end);
            if (out.find_first_of(".e") == std::string::npos)
                out += ".0";
            return out;
        }
        case Json::booleanValue:
            return v.asBool() ? "true" : "false";
        case Json::nullValue:
            return "null";
        default:
        {
            Json::StreamWriterBuilder builder;
            builder["indentation"] = "";
            return Json::writeString(builder, v);
        }
    }
}

// A string as is, null as "", anything else as its JSON.
std::string text(const Json::Value &v)
{
    if (v.isString())
        return v.asString();
    if (v.isNull())
        return "";
    return jsonText(v);
}

std::optional<std::string> optText(const Json::Value &v)
{
    if (v.isString())
        return v.asString();
    return std::nullopt;
}

// An integer, or a string that holds one; else 0.
int64_t integer(const Json::Value &v)
{
    if (v.type() == Json::intValue)
        return v.asInt64();
    if (v.type() == Json::uintValue && v.asUInt64() <= uint64_t(std::numeric_limits<int64_t>::max()))
        return int64_t(v.asUInt64());
    if (v.isString())
    {
        auto s = v.asString();
        std::string_view digits = s;
        if (!digits.empty() && digits.front() == '+')
            digits.remove_prefix(1);
        int64_t n = 0;
        auto [end, ec] = std::from_chars(digits.data(), digits.data() + digits.size(), n);
        if (ec == std::errc() && end == digits.data() + digits.size() && !digits.empty())
            return n;
    }
    return 0;
}

// A number as Rust's str::parse::<f64> reads one; NaN when it is not one.
double number(std::string_view s)
{
    if (!s.empty() && s.front() == '+')
        s.remove_prefix(1);
    double d = 0;
    auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), d);
    if (s.empty() || ec != std::errc() || end != s.data() + s.size())
        return std::numeric_limits<double>::quiet_NaN();
    return d;
}

std::optional<std::string> scalar(const Json::Value &v)
{
    if (v.isNull())
        return std::nullopt;
    return text(v);
}

std::optional<std::string> money(const Json::Value &amount, const Json::Value &code)
{
    auto a = scalar(amount);
    auto c = scalar(code);
    if (!a || !c)
        return std::nullopt;
    return *c == "USD" ? "$" + *a : *a + " " + *c;
}

const Json::Value &list(const Json::Value &v, const char *key)
{
    static const Json::Value empty(Json::arrayValue);
    const auto &found = v.isObject() ? v[key] : empty;
    return found.isArray() ? found : empty;
}

ContentLine line(const Json::Value &c, const char *idKey, const char *itemKey)
{
    ContentLine out;
    out.id = text(c["line_id"]);
    out.itemId = text(c[idKey]);
    const auto &item = c[itemKey];
    auto title = item.isObject() ? optText(item["title"]) : std::nullopt;
    out.title = title ? *title : out.itemId;
    out.quantity = c["quantity"].type() == Json::intValue ? c["quantity"].asInt64() : 1;
    return out;
}

Json::Value nullable(const std::optional<std::string> &s)
{
    return s ? Json::Value(*s) : Json::Value();
}

Json::Value strings(const std::vector<std::string> &items)
{
    Json::Value out(Json::arrayValue);
    for (const auto &s : items)
        out.append(s);
    return out;
}

Json::Value lines(const std::vector<ContentLine> &items)
{
    Json::Value out(Json::arrayValue);
    for (const auto &c : items)
    {
        Json::Value v;
        v["id"] = c.id;
        v["item_id"] = c.itemId;
        v["title"] = c.title;
        v["quantity"] = Json::Int64(c.quantity);
        out.append(std::move(v));
    }
    return out;
}
}  // namespace

ItemView ItemView::fromApi(const Json::Value &a)
{
    ItemView item;
    item.id = text(a["catalog_item_id"]);
    item.title = text(a["title"]);
    item.subtitle = optText(a["subtitle"]);
    item.description = text(a["description"]);
    for (const auto &b : list(a, "display_badges"))
        item.badges.push_back(text(b["label"]));
    for (const auto &t : list(a, "tags"))
        item.tags.push_back(text(t));
    for (const auto &c : list(a, "categories"))
        item.categories.push_back({text(c["name"]), text(c["slug"])});
    for (const auto &f : list(a, "field_values"))
    {
        const auto &value = f["value"];
        item.fields.push_back({f["fieldName"].isNull() ? text(f["fieldId"]) : text(f["fieldName"]),
                               value.isString() ? value.asString() : jsonText(value)});
    }
    for (const auto &url : list(a, "image_urls"))
    {
        if (item.images.size() == 2)
            break;
        item.images.push_back(text(url));
    }
    const auto &s = a["market_summary"];
    if (!s.isNull())
        item.summary = Summary{money(s["lowest_price_amount"], s["lowest_price_currency_code"]),
                               integer(s["active_listing_count"]),
                               integer(s["total_visible_quantity"])};
    for (const auto &l : list(a, "market_listings"))
    {
        auto amount = scalar(l["price_amount"]);
        Listing out;
        out.id = text(l["listing_id"]);
        out.seller = optText(l["seller_display_name"]).value_or("Seller");
        out.rating = optText(l["seller_average_rating"]);
        out.reviews = integer(l["seller_review_count"]);
        out.condition = text(l["product_summary"]);
        out.shipsFrom = text(l["ship_from_code"]);
        out.quantity = integer(l["visible_quantity"]);
        out.price = money(l["price_amount"], l["price_currency_code"]).value_or("");
        out.priceValue = amount ? number(*amount) : std::numeric_limits<double>::quiet_NaN();
        item.listings.push_back(std::move(out));
    }
    for (const auto &o : list(a, "offer_demand_matches"))
        item.offers.push_back({text(o["offer_id"]),
                               optText(o["buyer_display_name"]).value_or("Buyer"),
                               text(o["product_summary"]),
                               integer(o["quantity_requested"]),
                               money(o["price_amount"], o["price_currency_code"]).value_or("")});
    for (const auto &c : list(a, "contents"))
        item.contents.push_back(line(c, "contained_catalog_item_id", "contained_item"));
    for (const auto &c : list(a, "included_in"))
        item.includedIn.push_back(line(c, "container_catalog_item_id", "container_item"));
    return item;
}

Json::Value ItemView::toJson() const
{
    Json::Value v;
    v["id"] = id;
    v["title"] = title;
    v["subtitle"] = nullable(subtitle);
    v["description"] = description;
    v["badges"] = strings(badges);
    v["tags"] = strings(tags);
    v["categories"] = Json::Value(Json::arrayValue);
    for (const auto &c : categories)
    {
        Json::Value e;
        e["name"] = c.name;
        e["slug"] = c.slug;
        v["categories"].append(std::move(e));
    }
    v["fields"] = Json::Value(Json::arrayValue);
    for (const auto &f : fields)
    {
        Json::Value e;
        e["name"] = f.name;
        e["value"] = f.value;
        v["fields"].append(std::move(e));
    }
    v["images"] = strings(images);
    if (summary)
    {
        v["summary"]["lowest"] = nullable(summary->lowest);
        v["summary"]["count"] = Json::Int64(summary->count);
        v["summary"]["quantity"] = Json::Int64(summary->quantity);
    }
    else
    {
        v["summary"] = Json::Value();
    }
    v["listings"] = Json::Value(Json::arrayValue);
    for (const auto &l : listings)
    {
        Json::Value e;
        e["id"] = l.id;
        e["seller"] = l.seller;
        e["rating"] = nullable(l.rating);
        e["reviews"] = Json::Int64(l.reviews);
        e["condition"] = l.condition;
        e["ships_from"] = l.shipsFrom;
        e["quantity"] = Json::Int64(l.quantity);
        e["price"] = l.price;
        // NaN has no JSON form; serde_json writes it as null too.
        e["price_value"] = std::isfinite(l.priceValue) ? Json::Value(l.priceValue) : Json::Value();
        v["listings"].append(std::move(e));
    }
    v["offers"] = Json::Value(Json::arrayValue);
    for (const auto &o : offers)
    {
        Json::Value e;
        e["id"] = o.id;
        e["buyer"] = o.buyer;
        e["condition"] = o.condition;
        e["quantity"] = Json::Int64(o.quantity);
        e["price"] = o.price;
        v["offers"].append(std::move(e));
    }
    v["contents"] = lines(contents);
    v["included_in"] = lines(includedIn);
    return v;
}

std::vector<const Listing *> sortedListings(const ItemView &item)
{
    std::vector<const Listing *> rows;
    rows.reserve(item.listings.size());
    for (const auto &l : item.listings)
        rows.push_back(&l);
    std::stable_sort(rows.begin(), rows.end(), [](const Listing *a, const Listing *b) {
        if (std::isnan(a->priceValue))
            return false;
        return std::isnan(b->priceValue) || a->priceValue < b->priceValue;
    });
    return rows;
}

std::string alertMessage(std::string_view title, std::string_view email, std::string_view target)
{
    while (!target.empty() && std::isspace(static_cast<unsigned char>(target.front())))
        target.remove_prefix(1);
    while (!target.empty() && std::isspace(static_cast<unsigned char>(target.back())))
        target.remove_suffix(1);
    double price = number(target);
    if (email.find('@') == std::string_view::npos)
        return "Enter a valid email address.";
    if (!(price > 0))
        return "Enter a target price above zero.";
    char amount[64];
    std::snprintf(amount, sizeof amount, "%.2f", price);
    std::string out = "Alert set: we will email ";
    out.append(email).append(" when ").append(title).append(" drops below $").append(amount).append(".");
    return out;
}

std::string counted(int64_t n, std::string_view one, std::string_view other)
{
    auto digits = std::to_string(n < 0 ? -(n + 1) + uint64_t(1) : uint64_t(n));
    std::string out;
    if (n < 0)
        out += '-';
    for (size_t i = 0; i < digits.size(); ++i)
    {
        if (i > 0 && (digits.size() - i) % 3 == 0)
            out += ',';
        out += digits[i];
    }
    out += ' ';
    out.append(n == 1 ? one : other);
    return out;
}

drogon::OStringStream &operator<<(drogon::OStringStream &out, Escaped e)
{
    auto &buf = out.str();
    size_t start = 0;
    for (size_t i = 0; i < e.text.size(); ++i)
    {
        const char *entity;
        switch (e.text[i])
        {
            case '&':
                entity = "&amp;";
                break;
            case '<':
                entity = "&lt;";
                break;
            case '>':
                entity = "&gt;";
                break;
            case '"':
                entity = "&quot;";
                break;
            case '\'':
                entity = "&#39;";
                break;
            default:
                continue;
        }
        buf.append(e.text.data() + start, i - start).append(entity);
        start = i + 1;
    }
    buf.append(e.text.data() + start, e.text.size() - start);
    return out;
}
