- A kept `Public` page past its lifetime is now given at once within
  `stale-while-revalidate` while its handler makes it again, and in place of a
  `500`, `502`, `503` or `504`, a panic or a passed deadline within `stale-if-error`
  ([#1796 stale-while-revalidate and stale-if-error are not served from the kept page](https://github.com/corten-run/corten/issues/1796)),
  sent `private, no-store` with no CDN caching header for a panic or deadline. An
  answer with a header for its connection (`Connection`, `Upgrade`, a `Proxy-*`)
  is no longer kept.
