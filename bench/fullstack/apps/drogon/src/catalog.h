#pragma once

#include <json/value.h>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace catalog
{
struct Field { std::string name, value; };
struct Related { std::string id, title; };
struct Record
{
    std::string id, title, subtitle, description;
    std::vector<std::string> tags;
    std::vector<Field> fields;
    std::vector<Related> related;
    static Record fromJson(const Json::Value &json);
    Json::Value toJson() const;
};
using RecordPtr = std::shared_ptr<const Record>;
void load();
void get(const std::string &id, std::function<void(RecordPtr record, bool failed)> done);
}  // namespace catalog
