- A kept `Public` page is held in the buffer its handler made, cut to the page's length, in place
  of a copy of its body, and its URL is hashed once. The bound counts a kept URL once.
  ([#1824 A Public page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
