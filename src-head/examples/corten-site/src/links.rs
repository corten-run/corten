//! Addresses outside the app. Each is a `Uri`, not text, so no view writes one as a string.
use corten::http::Uri;

pub fn repository() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten")
}

pub fn getting_started() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/blob/main/docs/guide/getting-started.md")
}

pub fn guides() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/tree/main/docs/guide")
}

pub fn examples() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/tree/main/examples")
}

/// The example to read first: a watchlist with live prices.
pub fn watchlist() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/tree/main/examples/watchlist")
}

/// A store with every production module on.
pub fn card_market() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/tree/main/examples/card-market")
}

/// Signed-in people acting on shared data, with SQLite.
pub fn auction_room() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/tree/main/examples/auction-room")
}

pub fn deploying() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/blob/main/docs/guide/deploy.md")
}

/// Where the method and every round's full table are.
pub fn performance() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/blob/main/docs/performance.md")
}

pub fn changelog() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/blob/main/CHANGELOG.md")
}

pub fn license() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/blob/main/LICENSE")
}

pub fn security() -> Uri {
    Uri::from_static("https://github.com/corten-run/corten/blob/main/SECURITY.md")
}

/// Who Corten is built for, as the README links it.
pub fn chase_sets() -> Uri {
    Uri::from_static("https://chasesets.com")
}
