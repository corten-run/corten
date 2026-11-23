//! What the tests of each screen share: the app, to send requests to, and a signed-in session.
use corten::testing::Client;

use crate::{
    alerts::AlertStore,
    app::{app, app_with},
    market::Market,
};

/// A visitor id, as the app writes one into the `visitor` cookie.
pub(crate) const VISITOR: &str = "0123456789abcdef0123456789abcdef";

/// The app, with a market of its own.
pub(crate) fn client() -> Client {
    app(Market::new()).test()
}

/// The app with an alert store whose writes land `lag` after they are made: at once for a test
/// that reads one back, after the test for one that reads while they land.
pub(crate) fn client_with_lag(lag: std::time::Duration) -> Client {
    app_with(Market::new(), AlertStore::new(lag)).test()
}

/// Signs in on `app` and gives the token of the new session, the `session` cookie's value.
pub(crate) async fn sign_in(app: &Client) -> String {
    let res = app.post(&crate::app::url::SignIn).await;
    let set = res.headers()["set-cookie"].to_str().unwrap();
    // 128 random bits, out of scripts' reach and sent over HTTPS only.
    let token = res.cookie("session").unwrap();
    assert!(token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()), "{set}");
    assert_eq!(set, format!("session={token}; Path=/; SameSite=Lax; HttpOnly; Secure"));
    token.to_string()
}
