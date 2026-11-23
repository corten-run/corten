- A page the runtime draws at a `#fragment` now gets the browser's own scroll to the fragment, as a full load does:
  the element matches `:target` (in Firefox, only for a document's first) and an `<a name>` anchor is scrolled to
  ([#1940 A page the runtime draws at a #fragment never matches :target, and an a name anchor is not scrolled to](https://github.com/corten-run/corten/issues/1940)).
