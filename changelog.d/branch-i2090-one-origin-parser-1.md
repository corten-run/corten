- `Policy::allow_origin` now panics at startup on a value no `Origin` can equal (a path), as
  `Api::allow_origin` does; both drop a default port such as `:443`
  ([#2090 Policy::allow_origin stores any string and compares it to Origin as typed, so a value with no scheme, a path or a default port is a 403 for every write from that site instead of a startup error, while Api::allow_origin checks its value](https://github.com/corten-run/corten/issues/2090)).
