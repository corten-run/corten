- Ranked navigation breaks ties by the entry's own URL over an `also` address, then by the order
  passed to `req.nav_of`. Replacing a winning link can mark a surviving entry current, and older
  pages and runtimes still recognize the group and its other addresses
  ([#2212 Two nav entries of equal depth are both marked current, which NavTo::also makes reachable with distinct addresses](https://github.com/corten-run/corten/issues/2212)).
