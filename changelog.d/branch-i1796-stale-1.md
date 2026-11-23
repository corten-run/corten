- A kept `Public` page past its lifetime is now given at once within
  `stale-while-revalidate` while its handler makes it again, and in place of a
  `500`, `502`, `503` or `504`, a panic or a passed deadline within `stale-if-error`
  ([#1796 stale-while-revalidate and stale-if-error are not served from the kept page](https://github.com/corten-run/corten/issues/1796)).
  The page given in place of a panic or a passed deadline goes out `private, no-store`,
  since your middleware never saw it.
