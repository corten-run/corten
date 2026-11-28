- Ranked navigation marks just one entry current at each address. At equal depth, the entry's own URL
  wins over an `also` address, then the first entry passed to `req.nav_of` wins after navigation or patch
  ([#2212 Two nav entries of equal depth are both marked current, which NavTo::also makes reachable with distinct addresses](https://github.com/corten-run/corten/issues/2212)).
