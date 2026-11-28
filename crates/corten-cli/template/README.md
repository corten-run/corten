# {{name}}

A [Corten](https://github.com/corten-run/corten) app.

```sh
corten dev      # http://localhost:3000, rebuilds on save and reloads the page
corten check    # format, lint, build, tests, script types (needs TypeScript 6.0 or later: npm install --global typescript)
corten build    # release binary in target/release
docker build -t {{name}} . && docker run -p 8080:8080 {{name}}
```

`corten new` wrote `Cargo.lock`; commit it with the app. After changing dependencies, run
`corten dev` or `cargo build` and commit the updated lock. `corten check` and the image build use
`--locked`: they refuse a missing or stale lock rather than resolve a different dependency graph.
In a workspace, commit its root lockfile.

For a local build, the `compress` feature needs a C compiler for `libdeflate-sys` and normally
for `zstd-sys`.
Remove `features = ["compress"]` from the `corten` dependency in `Cargo.toml` to build
without it and serve responses without Corten's compression.

| Path | What |
|---|---|
| `src/lib.rs` | the app: routes, handlers, `app()` and its tests; declare modules here |
| `src/main.rs` | `main`, which serves `app()`; declares no modules |
| `src/views.rs` | the layout (the whole document), the error page and the pages, in `html!` |
| `src/click_counter.js`, `.css` | the `ClickCounter` component's handlers and stylesheet, next to its component |
| `static/` | the app's own CSS (element defaults, the layout), images; compiled into the program (`views::Static`, a constant per file) and served at versioned URLs |
