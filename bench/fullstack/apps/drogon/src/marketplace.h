#pragma once
#include <json/value.h>
#include <unicode/numberformatter.h>
#include <unicode/plurrule.h>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace marketplace {
using RecordPtr = std::shared_ptr<const Json::Value>;
// Validates and constructs only the numeric wire schema, preserving empty arrays and nulls.
Json::Value parseRecord(const Json::Value &value);
class Format {
 public:
  explicit Format(const std::string &locale);
  std::string money(const Json::Value &minor) const;
  std::string amount(double value) const;
  std::string count(const Json::Value &value) const;
  std::string rating(const Json::Value &hundredths) const;
  std::string listings(const Json::Value &value, const Json::Value &words) const;
  std::string alert(const std::string &title, const std::string &email, const std::string &target, const Json::Value &words) const;
 private:
  icu::Locale locale_;
  icu::number::LocalizedNumberFormatter money_, count_, rating_;
  std::unique_ptr<icu::PluralRules> plurals_;
};
struct View {
 RecordPtr record;
 std::string locale, seller, sort, path, more, message;
 Json::Value words;
 Format format;
 std::vector<const Json::Value *> listings;
 size_t offersShown;
 View(RecordPtr record, const std::string &locale, const Json::Value &words,
      const std::string &seller, const std::string &sort, bool allOffers);
};
using ViewPtr = std::shared_ptr<View>;
std::string url(const std::string &locale, const std::string &id);
void load();
void get(const std::string &id, std::function<void(RecordPtr record, bool failed)> done);
void routes();
}
