#include "marketplace.h"
#include <json/reader.h>
#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>

Json::Value json(const std::string &text) {
 Json::Value out; Json::CharReaderBuilder reader; std::string errors; std::istringstream input(text);
 if (!Json::parseFromStream(reader, input, &out, &errors)) throw std::runtime_error(errors);
 return out;
}
std::string spaces(std::string text) {
 for (const std::string needle : {"\xc2\xa0", "\xe2\x80\xaf"}) for (size_t pos = 0; (pos = text.find(needle, pos)) != std::string::npos;) text.replace(pos, needle.size(), " ");
 return text;
}
int main() {
 Json::Value labels; std::ifstream input("static/marketplace-labels.json"); input >> labels;
 const int64_t minors[] = {0, 1, 10, 125, 123450, 123456789, -123450};
 const std::vector<std::vector<std::string>> prices = {
 {"$0.00", "$0.01", "$0.10", "$1.25", "$1,234.50", "$1,234,567.89", "-$1,234.50"},
 {"0,00 $US", "0,01 $US", "0,10 $US", "1,25 $US", "1 234,50 $US", "1 234 567,89 $US", "-1 234,50 $US"},
 {"0,00 $", "0,01 $", "0,10 $", "1,25 $", "1.234,50 $", "1.234.567,89 $", "-1.234,50 $"}
 };
 size_t loc = 0;
 for (const std::string locale : {"en-US", "fr-FR", "de-DE"}) {
  marketplace::Format f(locale); const auto &words = labels[locale];
  for (size_t i = 0; i < 7; ++i) assert(spaces(f.money(Json::Value(Json::Int64(minors[i])))) == prices[loc][i]);
  assert(f.money(Json::Value()) == "—");
  const int ratings[] = {0, 400, 425, 475, 499};
  const std::vector<std::string> rating = locale == "en-US" ? std::vector<std::string>{"0", "4", "4.3", "4.8", "5"} : std::vector<std::string>{"0", "4", "4,3", "4,8", "5"};
  for (size_t i = 0; i < 5; ++i) assert(f.rating(ratings[i]) == rating[i]);
  const int counts[] = {0,1,2,1000,1000000};
  for (size_t i = 0; i < 5; ++i) {
   auto key = "listing_other";
   if (counts[i] == 1 || (locale == "fr-FR" && counts[i] == 0)) key = "listing_one";
   if (locale == "fr-FR" && counts[i] == 1000000) key = "listing_many";
   assert(f.listings(counts[i], words) == f.count(counts[i]) + " " + words[key].asString());
  }
  assert(f.alert("T", "bad", "1", words) == words["invalid_email"].asString());
  for (auto invalid : {"", "0", "-1", "Infinity", "NaN", "1e2", "1,2,3", "1.2.3"})
   assert(f.alert("T", "x@y", invalid, words) == words["invalid_price"].asString());
  assert(f.alert("T", "x@y", locale == "en-US" ? "1,25" : "1.25", words) == words["invalid_price"].asString());
  auto result = f.alert("{email} $&", "x@y", locale == "en-US" ? "1234.50" : "1234,50", words);
  assert(result.find("{email} $&") != std::string::npos && result.find(f.money(Json::Value(123450))) != std::string::npos);
  ++loc;
 }
 auto record = marketplace::parseRecord(json(R"({
 "id":"item_1","title":"<&>","subtitle":null,"description":"","categories":[],"badges":[],"tags":[],"images":[],"fields":[],
 "summary":{"lowest_minor":null,"count":1,"quantity":0},
 "listings":[
 {"id":"a","seller":"Alice","rating_hundredths":425,"reviews":0,"condition":"","ships_from":"","quantity":1,"price_minor":125},
 {"id":"b","seller":"alice","rating_hundredths":null,"reviews":0,"condition":"","ships_from":"","quantity":1,"price_minor":null},
 {"id":"c","seller":" Alice","rating_hundredths":0,"reviews":0,"condition":"","ships_from":"","quantity":1,"price_minor":-1},
 {"id":"d","seller":"Alice 2","rating_hundredths":499,"reviews":0,"condition":"","ships_from":"","quantity":1,"price_minor":125}],
 "offers":[],"contents":[],"included_in":[],"upstream_only":"ignored"
 })"));
 assert(!record.isMember("upstream_only") && record["subtitle"].isNull() && record["offers"].isArray());
 assert(record["listings"][2]["price_minor"].asInt64() == -1);
 auto ptr = std::make_shared<const Json::Value>(record);
 marketplace::View asc(ptr, "fr-FR", labels["fr-FR"], "", "asc", false);
 marketplace::View desc(ptr, "de-DE", labels["de-DE"], "", "desc", false);
 assert((*asc.listings[0])["id"] == "c" && (*asc.listings[3])["id"] == "b");
 assert((*desc.listings[0])["id"] == "a" && (*desc.listings[1])["id"] == "d" && (*desc.listings[3])["id"] == "b");
 marketplace::View prefix(ptr, "en-US", labels["en-US"], " Alice", "asc", false);
 assert(prefix.listings.size() == 1 && (*prefix.listings[0])["id"] == "c");
 for (auto key : {"subtitle", "images", "summary", "listings"}) {
  auto invalid = record; invalid.removeMember(key); bool threw = false;
  try { marketplace::parseRecord(invalid); } catch (const std::exception &) { threw = true; }
  assert(threw);
 }
 auto invalid = record; invalid["listings"][0]["price_minor"] = "125"; bool threw = false;
 try { marketplace::parseRecord(invalid); } catch (const std::exception &) { threw = true; } assert(threw);
 auto offers = record; for (int i = 0; i < 12; ++i) offers["offers"].append(Json::Value(Json::objectValue));
 auto offersPtr = std::make_shared<const Json::Value>(offers);
 marketplace::View first(offersPtr, "fr-FR", labels["fr-FR"], "", "asc", false), all(offersPtr, "fr-FR", labels["fr-FR"], "", "asc", true);
 assert(first.offersShown == 5 && all.offersShown == 12);
 std::cout << "marketplace ICU formatting, French million plural, forms, wire schema, stable sort and offer limits passed\n";
}
