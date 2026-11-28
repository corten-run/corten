- When Corten hashes and sends a buffered response with an `ETag`, it keeps the body in its box, saving one allocation on a nonempty response.
  [#2174 A body held whole is taken out of its box and boxed again to hash it for a validator and to compress it, one allocation a request each](https://github.com/corten-run/corten/issues/2174)
