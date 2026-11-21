- A kept `Public` page is given again with less work: the request's headers are read in one pass
  to decide whether the kept page can answer it, and the kept head is copied with room for the
  headers the stages add. Which requests a kept page answers is unchanged.
  ([#1798 A kept page still costs 84% of the cycles of the page made by its handler: what the rest is has not been measured](https://github.com/corten-run/corten/issues/1798))
