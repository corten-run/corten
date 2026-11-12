#include "marketplace.h"
#include <unicode/currunit.h>
#include <unicode/dcfmtsym.h>
#include <unicode/numfmt.h>
#include <algorithm>
#include <cmath>
#include <regex>
#include <stdexcept>
#include <unordered_set>

namespace marketplace {
namespace {
void check(bool valid) { if (!valid) throw std::runtime_error("invalid marketplace record"); }
void integer(const Json::Value &v, bool nonnegative = true) {
 check(v.isInt64() && v.asInt64() >= (nonnegative ? 0 : -1000000000LL) && v.asInt64() <= 1000000000LL);
}
Json::Value strings(const Json::Value &v, std::initializer_list<const char *> keys) {
 check(v.isObject());
 Json::Value out(Json::objectValue);
 for (auto key : keys) { check(v.isMember(key) && v[key].isString()); out[key] = v[key]; }
 return out;
}
void optionalInteger(const Json::Value &v, const char *key, Json::Value &out, bool rating = false) {
 check(v.isMember(key));
 if (!v[key].isNull()) { integer(v[key], rating); if (rating) check(v[key].asInt64() <= 500); }
 out[key] = v[key];
}
std::string utf8(const icu::UnicodeString &value) { std::string out; value.toUTF8String(out); return out; }
std::string formatted(const icu::number::FormattedNumber &value, UErrorCode status) {
 auto text = value.toString(status);
 if (U_FAILURE(status)) throw std::runtime_error("ICU number formatting failed");
 return utf8(text);
}
icu::Locale localeFor(const std::string &locale) {
 UErrorCode status = U_ZERO_ERROR;
 auto result = icu::Locale::forLanguageTag(locale, status);
 if (U_FAILURE(status)) throw std::runtime_error("invalid locale");
 return result;
}
std::string interpolate(const std::string &pattern, const std::string &email, const std::string &title, const std::string &price) {
 std::string out;
 for (size_t i = 0; i < pattern.size();) {
  bool replaced = false;
  for (const auto &entry : std::vector<std::pair<std::string, std::string>>{{"{email}", email}, {"{title}", title}, {"{price}", price}}) {
   if (pattern.compare(i, entry.first.size(), entry.first) == 0) { out += entry.second; i += entry.first.size(); replaced = true; break; }
  }
  if (!replaced) out += pattern[i++];
 }
 return out;
}
}
Json::Value parseRecord(const Json::Value &v) {
 auto out = strings(v, {"id", "title", "description"});
 check(v.isMember("subtitle") && (v["subtitle"].isNull() || v["subtitle"].isString()));
 out["subtitle"] = v["subtitle"];
 for (auto key : {"categories", "badges", "tags", "images", "fields", "listings", "offers", "contents", "included_in"}) {
  check(v.isMember(key) && v[key].isArray()); out[key] = Json::Value(Json::arrayValue);
 }
 for (auto key : {"badges", "tags", "images"}) for (const auto &row : v[key]) {
  check(row.isString()); out[key].append(row);
 }
 for (const auto &row : v["categories"]) out["categories"].append(strings(row, {"name", "slug"}));
 for (const auto &row : v["fields"]) out["fields"].append(strings(row, {"name", "value"}));
 check(v.isMember("summary"));
 out["summary"] = Json::Value();
 if (!v["summary"].isNull()) {
  const auto &s = v["summary"]; check(s.isObject());
  Json::Value summary(Json::objectValue); optionalInteger(s, "lowest_minor", summary);
  for (auto key : {"count", "quantity"}) { check(s.isMember(key)); integer(s[key]); summary[key] = s[key]; }
  out["summary"] = std::move(summary);
 }
 for (const auto &row : v["listings"]) {
  auto listing = strings(row, {"id", "seller", "condition", "ships_from"});
  optionalInteger(row, "rating_hundredths", listing, true); optionalInteger(row, "price_minor", listing);
  for (auto key : {"reviews", "quantity"}) { check(row.isMember(key)); integer(row[key]); listing[key] = row[key]; }
  out["listings"].append(std::move(listing));
 }
 for (const auto &row : v["offers"]) {
  auto offer = strings(row, {"id", "buyer", "condition"}); optionalInteger(row, "price_minor", offer);
  check(row.isMember("quantity")); integer(row["quantity"]); offer["quantity"] = row["quantity"];
  out["offers"].append(std::move(offer));
 }
 for (auto key : {"contents", "included_in"}) for (const auto &row : v[key]) {
  auto line = strings(row, {"id", "item_id", "title"});
  check(row.isMember("quantity")); integer(row["quantity"]); line["quantity"] = row["quantity"];
  out[key].append(std::move(line));
 }
 for (auto key : {"listings", "offers", "contents", "included_in"}) {
  std::unordered_set<std::string> ids;
  for (const auto &row : out[key]) check(ids.insert(row["id"].asString()).second);
 }
 return out;
}
Format::Format(const std::string &locale) : locale_(localeFor(locale)) {
 UErrorCode status = U_ZERO_ERROR;
 money_ = icu::number::NumberFormatter::with().unit(icu::CurrencyUnit("USD", status))
  .precision(icu::number::Precision::fixedFraction(2)).roundingMode(UNUM_ROUND_HALFUP).locale(locale_);
 count_ = icu::number::NumberFormatter::with().precision(icu::number::Precision::integer()).locale(locale_);
 rating_ = icu::number::NumberFormatter::with().precision(icu::number::Precision::maxFraction(1))
  .roundingMode(UNUM_ROUND_HALFUP).locale(locale_);
 plurals_.reset(icu::PluralRules::forLocale(locale_, status));
 if (U_FAILURE(status) || !plurals_) throw std::runtime_error("ICU locale initialization failed");
}
std::string Format::amount(double value) const {
 UErrorCode status = U_ZERO_ERROR; auto number = money_.formatDouble(value, status); return formatted(number, status);
}
std::string Format::money(const Json::Value &minor) const {
 return minor.isNull() ? "—" : amount(static_cast<double>(minor.asInt64()) / 100);
}
std::string Format::count(const Json::Value &value) const {
 UErrorCode status = U_ZERO_ERROR; auto number = count_.formatInt(value.asInt64(), status); return formatted(number, status);
}
std::string Format::rating(const Json::Value &value) const {
 UErrorCode status = U_ZERO_ERROR; auto number = rating_.formatDouble(static_cast<double>(value.asInt64()) / 100, status); return formatted(number, status);
}
std::string Format::listings(const Json::Value &value, const Json::Value &words) const {
 auto key = "listing_" + utf8(plurals_->select(static_cast<double>(value.asInt64())));
 return count(value) + " " + (words.isMember(key) ? words[key] : words["listing_other"]).asString();
}
std::string Format::alert(const std::string &title, const std::string &email, const std::string &target, const Json::Value &words) const {
 if (email.find('@') == std::string::npos) return words["invalid_email"].asString();
 UErrorCode status = U_ZERO_ERROR;
 icu::DecimalFormatSymbols symbols(locale_, status);
 auto separator = symbols.getSymbol(icu::DecimalFormatSymbols::kDecimalSeparatorSymbol);
 static const std::regex dot("^[0-9]+(\\.[0-9]+)?$"), comma("^[0-9]+(,[0-9]+)?$");
 auto first = target.find_first_not_of(" \t\r\n"), last = target.find_last_not_of(" \t\r\n");
 std::string input = first == std::string::npos ? "" : target.substr(first, last - first + 1);
 if (!std::regex_match(input, separator == "." ? dot : comma)) return words["invalid_price"].asString();
 std::unique_ptr<icu::NumberFormat> parser(icu::NumberFormat::createInstance(locale_, status));
 icu::Formattable value; icu::ParsePosition position(0); auto text = icu::UnicodeString::fromUTF8(input);
 parser->parse(text, value, position);
 double number = value.getDouble(status);
 if (U_FAILURE(status) || position.getIndex() != text.length() || !std::isfinite(number) || number <= 0)
  return words["invalid_price"].asString();
 return interpolate(words["alert_set"].asString(), email, title, amount(number));
}
View::View(RecordPtr r, const std::string &l, const Json::Value &w, const std::string &s, const std::string &order, bool allOffers)
 : record(std::move(r)), locale(l), seller(s), sort(order == "desc" ? "desc" : "asc"), words(w), format(l) {
 for (const auto &row : (*record)["listings"]) if (row["seller"].asString().compare(0, seller.size(), seller) == 0) listings.push_back(&row);
 std::stable_sort(listings.begin(), listings.end(), [this](const auto *a, const auto *b) {
  const auto &x = (*a)["price_minor"], &y = (*b)["price_minor"];
  if (x.isNull()) return false;
  if (y.isNull()) return true;
  return sort == "desc" ? x.asInt64() > y.asInt64() : x.asInt64() < y.asInt64();
 });
 const size_t total = (*record)["offers"].size(); offersShown = allOffers ? total : std::min<size_t>(total, 5);
}
}
