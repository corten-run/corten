- Card-market's push smoke waits for Chromium's display event before reading each notification.
  Both payloads must show on their first send; no app or worker changes are needed.
  ([#1747 card-market's push smoke misses both sends of a message on CI runners far more often than its 1-in-500 estimate, failing the required browser job](https://github.com/corten-run/corten/issues/1747))
