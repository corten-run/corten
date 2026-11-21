- A `Public` page is kept from the second time its URL is asked for: a URL asked for once is
  answered by its handler without the copy into the store, and a page's handler runs twice
  before the page is kept.
  ([#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
