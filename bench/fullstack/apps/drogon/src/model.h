// Same view model and rules as topcoat/src/model.rs, so /api/items/{id} answers the JSON every
// benchmark app answers. One difference no fixture item shows: a listing without a price sorts
// last (std::sort needs a strict order, and NaN compares as nothing).
#pragma once

#include <drogon/utils/OStringStream.h>
#include <json/value.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

struct Category
{
    std::string name;
    std::string slug;
};

struct Field
{
    std::string name;
    std::string value;
};

struct Summary
{
    std::optional<std::string> lowest;
    int64_t count = 0;
    int64_t quantity = 0;
};

struct Listing
{
    std::string id;
    std::string seller;
    std::optional<std::string> rating;
    int64_t reviews = 0;
    std::string condition;
    std::string shipsFrom;
    int64_t quantity = 0;
    std::string price;
    double priceValue = 0;
};

struct Offer
{
    std::string id;
    std::string buyer;
    std::string condition;
    int64_t quantity = 0;
    std::string price;
};

struct ContentLine
{
    std::string id;
    std::string itemId;
    std::string title;
    int64_t quantity = 1;
};

struct ItemView
{
    std::string id;
    std::string title;
    std::optional<std::string> subtitle;
    std::string description;
    std::vector<std::string> badges;
    std::vector<std::string> tags;
    std::vector<Category> categories;
    std::vector<Field> fields;
    std::vector<std::string> images;
    std::optional<Summary> summary;
    std::vector<Listing> listings;
    std::vector<Offer> offers;
    std::vector<ContentLine> contents;
    std::vector<ContentLine> includedIn;

    // The item API's response (/api/discovery/items/{id}) as the page shows it.
    static ItemView fromApi(const Json::Value &a);
    Json::Value toJson() const;
};

using ItemPtr = std::shared_ptr<const ItemView>;

// Cheapest first, a stable sort; a listing without a price sorts after every price. "High to
// low" is the same rows reversed (item.js).
std::vector<const Listing *> sortedListings(const ItemView &item);

std::string alertMessage(std::string_view title, std::string_view email, std::string_view target);

// A count as an English page writes it: digits grouped, and the word singular for one.
std::string counted(int64_t n, std::string_view one, std::string_view other);

// Text for HTML, in an element or a double-quoted attribute: `{% esc(x) %}` in a view.
struct Escaped
{
    std::string_view text;
};
inline Escaped esc(std::string_view text)
{
    return Escaped{text};
}
drogon::OStringStream &operator<<(drogon::OStringStream &out, Escaped e);
