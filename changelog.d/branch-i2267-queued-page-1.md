- A waiting form submit is dropped if a visit draws another page before it goes out, rather than sending that page's form with the same `id`.
  A component connecting during the visit can still queue a write on a form the new page keeps.
  [#2267 A write's waiting submit, sent again after a visit drew another page, posts that page's form of the same id](https://github.com/corten-run/corten/issues/2267)
