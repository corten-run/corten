# Native record JSON

Catalog and marketplace endpoints serialize their existing parsed typed records
with axum's native JSON response. GET and HEAD retain native routing; JSON
400/404/405/502 responses use Problem Details, with Allow retained for method
errors. Maud pages, localization and forms are not substituted or removed.

Both record sources refuse HTTP redirects and apply a ten-second complete-read
deadline. Dropping request-owned work cancels its upstream read. This does not
replace the default/matched deployment middleware: the existing matched outer
timeout can still return an empty 503 before the route's JSON error. It is not a
claim of identical production error behavior or enterprise group admission.

Run the native checks from this directory:

```sh
cargo test --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
```

The focused HTTP tests cover complete fixture/API records, native methods/errors,
redirect refusal, stalled body reads, cancellation and healthy recovery. They are
functional checks, not independent source-audit receipts or load measurements.
