- A `Public` page is kept from the second time its URL is asked for, where it was kept the first:
  a URL asked for once is answered by its handler without the copy into the store and no longer
  takes a kept page's room. A page's handler so runs twice before the page is given again.
  ([#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
