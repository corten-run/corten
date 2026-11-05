# Testing

Test through the app with its test client: `app().test()` sends a request through the finished
app (its middleware, layers and error page) without a socket, and reads the whole answer. No
server or browser is needed:

```rust
#[cfg(test)]
mod tests {
    use corten::{Mode, http::StatusCode};

    use super::*;

    #[tokio::test]
    async fn greeting_is_a_patch_for_the_runtime() {
        let app = app().test();
        let res = app
            .post(&url::Greet)
            .mode(Mode::Action) // what the runtime sends for a data-patch form
            .field(GreetForm::FIELDS.name, "Ada")
            .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.text(), r#"<p id="greeting" aria-live="polite">Hello, Ada!</p>"#);
    }
}
```

1. Cover each mode a handler serves: the default (a browser's page load, the whole document),
   `.mode(Mode::Action)` (the patch) and `.mode(Mode::Data)` (data screens). The address is a
   route, or a `corten::Local` read from an answer (`res.location()`); fields are the form's
   `FIELDS` with values of their types, a forged value goes through `FIELDS.x.untyped()`, and a
   `SubmitKey` field takes `corten::testing::submit_key()`. `.cookie(name, value)`,
   `.header(..)`, `.peer(ip)` (what `ClientIp` and a limit per client read) and, for JSON or an
   upload, `app.call(Method::POST, &route).json(&value)` or `.body(type, bytes)` (a form's body is
   its fields: `.body` refuses a urlencoded one). A form with nothing filled is `.post(&route)`
   alone; the blank an empty number input sends goes through `.untyped()`. A live stream has no
   end to read to: send it with `app().router()` (with `tower`, features `["util"]`, and
   `http-body-util` as dev-dependencies) and read it as it comes.
2. Keep the scripts' declarations current with a test, so `tsc --noEmit` or the editor checks
   the scripts against the Rust types and `#[event]` classes (feature `types`):

   ```rust
   #[test]
   fn script_types_match_the_server() {
       corten::types::Types::new()
           .add::<Stock>()
           .components(&[LivePrices])
           .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
   }
   ```

3. A typed seam that must reject bad input gets a `compile_fail` doctest.
4. Behavior that runs in the browser needs a browser check: load the page and use it, once with
   JavaScript and once without.
   An accessibility audit runs there too: `page.evaluate(axe)` with axe-core's source, never
   `addScriptTag` or a CSP bypass (the page requires Trusted Types), then read `violations` and
   `incomplete` from `axe.run()`. `html!` already refuses a name on an element with no role
   (`aria-label` on a bare `<span>`, or on an `<a>` whose `href` is an `Option`); name those by
   text in a `VisuallyHidden` span instead.
   After a link or form the runtime follows (with the Navigation API), the address changes before
   the new page is drawn: wait for something on the new page, not only `page.waitForURL`.
5. A test that needs a database: code that writes takes the connection (`&mut PgConnection`),
   not the pool, so a test can pass it a transaction. Prefer `#[sqlx::test]` (a fresh database per
   test, made with a role that can create databases, migrations applied); a transaction rolled
   back at the end works against a shared database but cannot test code that commits on its own,
   and tests writing the same rows take `pg_advisory_xact_lock` first (they can deadlock
   otherwise). Mark tests that need a database `#[ignore = "needs DATABASE_URL"]` and run them in
   CI with `cargo test -- --ignored`. The app is a library (`src/lib.rs`), so `tests/db.rs` and
   `examples/` reach it. A fixture recorder that calls a live service is an example or a binary,
   never a test. See the app guide, Testing an app.
