//! `#[derive(Row)]`: a row's id is the field marked `#[row(id)]`, and the feed sends what it
//! sent with the impl written by hand.

#![cfg(feature = "feed")]

use std::borrow::Cow;

use corten::feed::{Cursor, Feed, Row, Since};
use http_body_util::BodyExt;
use serde::Serialize;

#[derive(Clone, Serialize, Row)]
struct Level {
    #[row(id)]
    sku: String,
    qty: u32,
}

/// The same row with the impl written by hand: the bytes the derive must not change.
#[derive(Clone, Serialize)]
struct ByHand {
    sku: String,
    qty: u32,
}

impl Row for ByHand {
    fn id(&self) -> &str {
        &self.sku
    }
}

/// The id renamed on the wire and not first: the row's key is still the field's value.
#[derive(Clone, Serialize, Row)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub price_cents: i64,
    #[row(id)]
    #[serde(rename = "key")]
    pub listing_id: Box<str>,
}

#[derive(Clone, Serialize, Row)]
struct Coded {
    rank: u32,
    #[row(id)]
    code: Cow<'static, str>,
}

/// A generic row with no bounds of its own: a row for each argument that makes it one.
#[derive(Clone, Serialize, Row)]
struct Quote<P> {
    #[row(id)]
    ticker: String,
    price: P,
}

#[derive(Clone, Serialize, Row)]
struct Fixed {
    #[row(id)]
    id: &'static str,
}

#[derive(Clone, Serialize, Row)]
struct Tagged<T>
where
    T: Clone + Serialize + Send + Sync + 'static,
{
    #[row(id)]
    pub(crate) key: String,
    value: T,
}

/// A row a `macro_rules!` declares, its id field named by the caller.
macro_rules! row {
    ($name:ident, $id:ident) => {
        #[derive(Clone, Serialize, Row)]
        struct $name {
            #[row(id)]
            $id: String,
        }
    };
}
row!(Made, code);

/// A row a `macro_rules!` declares with the id's visibility and attributes passed in, each
/// reaching the derive in an invisible group.
macro_rules! row_with {
    ($(#[$m:meta])* $v:vis $name:ident, $id:ident) => {
        #[derive(Clone, Serialize, Row)]
        struct $name {
            $(#[$m])*
            $v $id: String,
        }
    };
}
row_with!(#[row(id)] pub(crate) Passed, code);
row_with!(
    #[row(id)]
    #[serde(rename = "key")]
    Renamed,
    code
);

#[test]
fn the_id_is_the_marked_field() {
    assert_eq!(Made { code: "m".into() }.id(), "m");
    assert_eq!(Passed { code: "v".into() }.id(), "v");
    assert_eq!(Renamed { code: "r".into() }.id(), "r");
    assert_eq!(Level { sku: "a".into(), qty: 1 }.id(), "a");
    assert_eq!(Listing { price_cents: 5, listing_id: "l1".into() }.id(), "l1");
    assert_eq!(Coded { rank: 3, code: "p".into() }.id(), "p");
    assert_eq!(Quote { ticker: "q".into(), price: 1.5_f64 }.id(), "q");
    let _feed = Feed::new([Quote { ticker: "q".into(), price: 1_u32 }]);
    assert_eq!(Fixed { id: "f" }.id(), "f");
    assert_eq!(Tagged { key: "t".into(), value: vec![1u8] }.id(), "t");
}

async fn body(response: impl corten::axum::response::IntoResponse) -> String {
    let bytes = response.into_response().into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// The live stream's first frames: the retry line and the replayed patch.
async fn first_frames(mut stream: corten::axum::body::Body) -> String {
    let mut text = String::new();
    while !text.contains("data: ") {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), stream.frame()).await.expect("answered in time");
        let Some(frame) = frame else { break };
        text.push_str(std::str::from_utf8(&frame.unwrap().into_data().unwrap()).unwrap());
    }
    text
}

/// Without the epoch, which is the process's own for each feed.
fn rows(snapshot: &str) -> serde_json::Value {
    let mut value: serde_json::Value = serde_json::from_str(snapshot).unwrap();
    value.as_object_mut().unwrap().remove("epoch");
    value
}

#[tokio::test]
async fn a_derived_row_is_sent_as_one_written_by_hand() {
    let derived = Feed::new([Level { sku: "b".into(), qty: 2 }, Level { sku: "a".into(), qty: 1 }]);
    let by_hand = Feed::new([ByHand { sku: "b".into(), qty: 2 }, ByHand { sku: "a".into(), qty: 1 }]);
    assert_eq!(rows(&body(derived.snapshot()).await), rows(&body(by_hand.snapshot()).await));
    let start = |generation: String| Since(Some(Cursor::parse(&format!("{generation}-0")).unwrap()));
    let (from_derived, from_by_hand) = (start(derived.generation().to_string()), start(by_hand.generation().to_string()));
    // A write keys its upsert and remove by the id.
    derived.write(|tx| {
        tx.insert(Level { sku: "a".into(), qty: 5 });
        tx.remove("b");
    });
    by_hand.write(|tx| {
        tx.insert(ByHand { sku: "a".into(), qty: 5 });
        tx.remove("b");
    });
    let after = rows(&body(derived.snapshot()).await);
    assert_eq!(after, rows(&body(by_hand.snapshot()).await));
    assert_eq!(after["rows"], serde_json::json!([{ "sku": "a", "qty": 5 }]));
    // The write replayed to a client that was at 0: the same patch, keyed by the id.
    let patch = |feed_body: String| feed_body.lines().find(|l| l.starts_with("data: ")).map(str::to_string);
    let replayed = patch(first_frames(derived.live(from_derived).into_body()).await);
    assert_eq!(replayed, patch(first_frames(by_hand.live(from_by_hand).into_body()).await));
    assert_eq!(
        replayed.as_deref(),
        Some(r#"data: {"seq":1,"changes":[{"op":"upsert","id":"a","value":{"sku":"a","qty":5}},{"op":"remove","id":"b"}]}"#)
    );
    let renamed = Feed::new([Listing { price_cents: 5, listing_id: "l1".into() }]);
    assert_eq!(rows(&body(renamed.snapshot()).await)["rows"], serde_json::json!([{ "priceCents": 5, "key": "l1" }]));
}
