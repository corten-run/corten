- A GET `data-patch` form marked `data-address` puts the address it asked for in place of the
  history entry's as its answer (a patch, or a page) is drawn, adding no entry, so a filter that redraws one part
  survives a reload
  ([#1406 A GET data-patch form redraws the page's part for a new address but leaves the old address, so a filter is lost on reload and the page's other links keep the old one](https://github.com/corten-run/corten/issues/1406)).
