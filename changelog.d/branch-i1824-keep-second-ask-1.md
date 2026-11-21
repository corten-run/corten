- A `Public` page is kept once its URL was asked for before within the page's lifetime, not the
  first time it is made: a URL asked for once, or less often than its page lasts, is answered by
  its handler without the copy into the store, and a page's handler runs twice before it is kept.
  ([#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
