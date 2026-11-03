#include "live.h"

#include <algorithm>

void LivePrices::subscribe(drogon::ResponseStreamPtr stream)
{
    // An event first, so the client sees the stream open before the first price.
    if (!stream->send("event: open\ndata: \n\n"))
        return;
    std::lock_guard lock(mutex_);
    streams_.push_back(std::move(stream));
}

void LivePrices::publish(const std::string &body)
{
    // One data: line per line of the body.
    std::string event;
    size_t start = 0;
    while (true)
    {
        auto end = body.find('\n', start);
        event.append("data: ").append(body, start, end == std::string::npos ? std::string::npos : end - start).append("\n");
        if (end == std::string::npos)
            break;
        start = end + 1;
    }
    event.append("\n");
    // send() queues the bytes on the stream's connection and never waits for a slow client; it
    // is false once the client has gone, and that stream is dropped.
    std::lock_guard lock(mutex_);
    streams_.erase(std::remove_if(streams_.begin(), streams_.end(), [&](const auto &s) { return !s->send(event); }),
                   streams_.end());
}
