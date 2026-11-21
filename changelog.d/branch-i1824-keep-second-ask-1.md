- Once the kept `Public` pages fill the bound, a page is kept only from the second request for
  its URL: a URL asked for once is answered by its handler without a copy into the store and
  takes no kept page's room. An app whose pages fit in the bound keeps them as before.
  ([#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
