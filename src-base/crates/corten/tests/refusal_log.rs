//! A refusal moved to another status without a message tells a client only that status's reason,
//! and the log still says what was refused and why (#890): a hidden 403 is logged as one, and a
//! session store that is down as that. In a process of its own, so its subscriber is the only one:
//! another test's, installed or dropped at the same time, cannot change what this one is sent. It
//! installs the process's subscriber, so it is the only test in this file.
#![cfg(feature = "json")]

use std::sync::{Arc, Mutex};

use corten::{http::StatusCode, App, Error, Mode, Refused};

#[corten::routes]
mod url {
    #[route("/down", get = down)]
    pub struct Down;

    #[route("/hidden", get = hidden)]
    pub struct Hidden;
}

async fn down() -> corten::Result<&'static str> {
    Err(Error::from(Refused::unavailable("session store down")).with_status(StatusCode::INTERNAL_SERVER_ERROR))
}

async fn hidden() -> corten::Result<&'static str> {
    Err(Error::from(Refused::forbidden()).with_status(StatusCode::NOT_FOUND))
}

#[derive(Clone, Default)]
struct Lines(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Lines {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a_refusal_moved_to_another_status_is_logged_with_its_cause() {
    let lines = Lines::default();
    let writer = lines.clone();
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_max_level(tracing_subscriber::filter::LevelFilter::DEBUG)
        .with_writer(move || writer.clone())
        .try_init()
        .unwrap();
    let text = || String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
    let app = App::new(url::router()).test();
    let down = app.get(&url::Down).mode(Mode::Data).await;
    assert_eq!(down.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let logged = text();
    assert!(logged.contains("session store down"), "{logged}");
    let hidden = app.get(&url::Hidden).mode(Mode::Data).await;
    assert_eq!((hidden.status(), hidden.text()), (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404}"#));
    let logged = text();
    assert!(logged.contains("403 Forbidden"), "{logged}");
}
