//! The app: its routes, handlers and `App`. It is a library, so `src/main.rs`, a test target
//! in `tests/` and an example in `examples/` all use the same code (`{{crate}}::app()`).
//! Declare modules here only: one declared in `main.rs` too is a second copy of its components,
//! which fails to build. A module stays private unless a test target needs it, so an unused view
//! is still a warning.

mod views;

use corten::prelude::*;
use serde::Deserialize;

/// Every URL the app serves, with the handler that serves it. Views link to these types, so a
/// link cannot point at a route that does not exist, changing a path here changes every link to
/// it, and a route without a handler does not compile.
#[corten::routes]
pub mod url {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/greet", post = greet)]
    pub struct Greet;
}

/// The routes, the static files, the error page and the components with scripts or styles.
/// Security headers, health checks, compression and live reload are Corten's defaults; see `App`
/// to change them.
pub fn app() -> App {
    App::new(url::router())
        .assets(views::Static)
        .error_page(views::error_page, ())
        .components(&[views::ClickCounter])
}

async fn home(req: Req) -> HtmlResult {
    req.page(views::home(&req, ""))
}

#[derive(Deserialize, Fields)]
struct GreetForm {
    name: String,
}

/// With JavaScript the runtime swaps in the greeting; without it the form posts and the whole
/// page comes back. One handler serves both.
async fn greet(req: Req, Form(form): Form<GreetForm>) -> HtmlResult {
    let name = form.name.trim();
    let page = || async { req.page(views::home(&req, name)) };
    req.patch_or(views::Greeting { name }, page).await
}

#[cfg(test)]
mod tests {
    use corten::Local;

    use super::*;

    #[tokio::test]
    async fn home_page_renders_in_the_layout() {
        let home = app().test().get(&url::Home).await;
        let html = home.text();
        assert!(html.contains("<title>{{name}}</title>"));
        assert!(html.contains("<header>"));
        assert!(html.contains(r#"<link rel="icon" type="image/svg+xml""#));
        assert!(
            html.contains("click_counter.count(@total)"),
            "the counter's handler: {html}"
        );
    }

    #[tokio::test]
    async fn greeting_is_a_patch_for_the_runtime() {
        let greeting = app()
            .test()
            .post(&url::Greet)
            .mode(Mode::Action)
            .field(GreetForm::FIELDS.name, "Ada")
            .await;
        assert_eq!(
            greeting.text(),
            r#"<p id="greeting" aria-live="polite">Hello, Ada!</p>"#
        );
    }

    #[tokio::test]
    async fn an_unknown_url_gets_the_error_page_in_the_layout() {
        let nope = Local::parse("/nope").unwrap();
        let missing = app().test().get(&nope).await;
        assert_eq!(missing.status(), 404);
        let html = missing.text();
        assert!(html.contains("<h1>Not found</h1>") && html.contains("<header>"));
    }
}
