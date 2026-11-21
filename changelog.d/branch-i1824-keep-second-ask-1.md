- Once the kept `Public` pages are within an eighth of the bound, an answer is kept only when
  its URL was asked for before: a URL asked for once is answered by its handler without a copy
  into the store and seldom takes a kept page's room, and a page's handler runs twice before
  its page is kept. While the kept pages are under seven eighths of the bound nothing changes.
  ([#1824 A `Public` page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
