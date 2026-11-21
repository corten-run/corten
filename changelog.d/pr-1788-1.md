- `subscribe()` retries a stream answered with an HTTP error after 1, 1, 1, 2, 2, 4, 4 s and on
  up to 30 s, not 1, 2, 4, 8 and 16 s, so a live page is current again within about half the
  outage after the server returns.
  ([#1787 subscribe() waits 1, 2, 4, 8, 16 then 30 s between failed reconnects, with no jitter, so a restart of the only instance can leave live pages waiting about twice the outage](https://github.com/corten-run/corten/issues/1787))