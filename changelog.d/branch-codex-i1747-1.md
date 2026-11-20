- Card-market's push smoke checks Chromium's display, the plain-data destination, and a
  pending `waitUntil` promise that later fulfills, without listing notifications or retrying.
  ([#1747 card-market's push smoke misses both sends of a message on CI runners far more often than its 1-in-500 estimate, failing the required browser job](https://github.com/corten-run/corten/issues/1747))
