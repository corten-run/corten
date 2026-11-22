- The workspace lock, which the examples build from, moves bytes to 1.12.2 and jiff to 1.0.1. With
  bytes 1.12.2, a body truncated to zero length releases the buffer it shared instead of keeping it
  alive. An app's own lock takes both with `cargo update -p bytes -p jiff`
  ([#1818 Cargo.lock builds bytes 1.12.1 and jiff 1.0.0 while 1.12.2 and 1.0.1 have cleared the 3-day publish age](https://github.com/corten-run/corten/issues/1818)).
