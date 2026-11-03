// The live benchmark (bench/live): every open GET /live/prices stream, and the publisher that
// writes each POST /live/publish body to all of them.
#pragma once

#include <drogon/HttpResponse.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

class LivePrices
{
  public:
    void subscribe(drogon::ResponseStreamPtr stream);
    void publish(const std::string &body);

  private:
    std::mutex mutex_;
    std::vector<std::shared_ptr<drogon::ResponseStream>> streams_;
};
