- Checking short `Cache-Control` directives on a `Public` response takes fewer instructions.
  The response headers and caching rules are unchanged.
  ([#1825 A Public page costs 3,300 instructions more than the same page for one visitor, before anything is kept](https://github.com/corten-run/corten/issues/1825))
