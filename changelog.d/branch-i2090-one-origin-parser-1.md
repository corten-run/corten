- **Breaking:** `Policy::allow_origin` refuses a bare host, path, `*`, list, `null`; it and
  `Api::allow_origin` a user, `?`, `#`, non-ASCII host, `file`/`ws`; `:443`/`:80` match
  ([#2090 Policy::allow_origin stores any string and compares it to Origin as typed, so a value with no scheme, a path or a default port is a 403 for every write from that site instead of a startup error, while Api::allow_origin checks its value](https://github.com/corten-run/corten/issues/2090)).
