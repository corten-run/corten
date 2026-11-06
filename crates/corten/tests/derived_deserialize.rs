//! The `Deserialize` `#[derive(Fields)]` and `#[derive(UrlValue)]` write is serde_derive's: each type here is
//! declared twice from one body, once with Corten's derive and once with serde's, and both read
//! every input to the same value or the same error, and pass the deserializer the same names.

#![cfg(feature = "json")]

use std::{borrow::Cow, cell::RefCell, collections::BTreeMap};

use serde::de::{value::Error as ValueError, Deserialize, DeserializeOwned, Deserializer, IntoDeserializer, Visitor};

/// One type twice, in `$module::ours` with Corten's derive and in `$module::theirs` with serde's.
macro_rules! twin {
    ($module:ident, $ours:path, $($item:tt)*) => {
        mod $module {
            pub mod ours {
                #[allow(unused_imports)]
                use super::super::*;
                #[derive(Debug, PartialEq, $ours)]
                $($item)*
            }
            pub mod theirs {
                #[allow(unused_imports)]
                use super::super::*;
                #[derive(Debug, PartialEq, serde::Deserialize)]
                $($item)*
            }
        }
    };
}

pub fn seven() -> u32 {
    7
}

twin! { tab, corten::UrlValue,
    #[derive(Clone, Copy)]
    #[serde(rename_all = "kebab-case")]
    pub enum Tab {
        Open,
        AwaitingLabel,
        #[serde(rename = "done")]
        Shipped,
        #[serde(alias = "old", alias = "older")]
        Aliased,
    }
}

twin! { sell, corten::Fields,
    #[serde(rename_all = "camelCase")]
    pub struct Sell {
        pub item_id: String,
        #[serde(rename = "qty", alias = "quantity")]
        pub count: u32,
        pub note: Option<String>,
        #[serde(default)]
        pub tags: Vec<String>,
        #[serde(default)]
        pub gift: bool,
        #[serde(default = "crate::seven")]
        pub days: u32,
        #[serde(skip)]
        pub cache: u8,
        #[serde(skip_deserializing, default = "crate::seven")]
        pub kept: u32,
        pub r#type: Option<String>,
    }
}

twin! { strict, corten::Fields,
    #[derive(Default)]
    #[serde(default, deny_unknown_fields, rename = "Filters!")]
    pub struct Strict {
        pub page: u32,
        pub search: Option<String>,
        #[serde(skip)]
        pub seen: bool,
    }
}

twin! { search, corten::Fields,
    pub struct Search<'a> {
        pub q: &'a str,
        #[serde(borrow)]
        pub note: Cow<'a, str>,
        pub owned: Cow<'a, str>,
    }
}

twin! { owned, corten::Fields,
    pub struct Owned<'a> {
        pub text: Cow<'a, str>,
    }
}

/// Owned for every input lifetime, as serde's is: a struct whose lifetime nothing borrows.
#[test]
fn a_struct_that_borrows_nothing_is_deserialize_owned() {
    fn owned<T: DeserializeOwned>(text: &str) -> T {
        corten::form::from_bytes(text.as_bytes()).unwrap()
    }
    let ours: owned::ours::Owned<'static> = owned("text=a");
    let theirs: owned::theirs::Owned<'static> = owned("text=a");
    assert_eq!(format!("{ours:?}"), format!("{theirs:?}"));
}

twin! { generic, corten::Fields,
    #[serde(deny_unknown_fields, expecting = "a filter")]
    pub struct Generic<T> {
        pub value: T,
        #[serde(default)]
        pub list: Vec<T>,
    }
}

twin! { empty, corten::Fields,
    pub struct Empty {}
}

mod orders {
    pub mod ours {
        #[derive(Debug, PartialEq, corten::Fields)]
        pub struct Orders {
            pub tab: Option<crate::tab::ours::Tab>,
            #[serde(default)]
            pub tabs: Vec<crate::tab::ours::Tab>,
        }
    }
    pub mod theirs {
        #[derive(Debug, PartialEq, serde::Deserialize)]
        pub struct Orders {
            pub tab: Option<crate::tab::theirs::Tab>,
            #[serde(default)]
            pub tabs: Vec<crate::tab::theirs::Tab>,
        }
    }
}

/// Text a test compares: the value's Debug (both types print the same name), or the error.
fn shown<T: std::fmt::Debug, E: std::fmt::Display>(result: Result<T, E>) -> String {
    match result {
        Ok(value) => format!("ok {value:?}"),
        Err(e) => format!("error {e}"),
    }
}

/// Both read `text` as a form, as JSON, and through serde's own value deserializers.
fn same_form<A: DeserializeOwned + std::fmt::Debug, B: DeserializeOwned + std::fmt::Debug>(text: &str) {
    assert_eq!(
        shown(corten::form::from_bytes::<A>(text.as_bytes())),
        shown(corten::form::from_bytes::<B>(text.as_bytes())),
        "form {text}"
    );
}

fn same_json<A: DeserializeOwned + std::fmt::Debug, B: DeserializeOwned + std::fmt::Debug>(text: &str) {
    assert_eq!(shown(serde_json::from_str::<A>(text)), shown(serde_json::from_str::<B>(text)), "json {text}");
}

/// Both read from a deserializer serde makes of a value: a map with integer keys (the field
/// identifier's index), a sequence, a string, an integer.
fn same_from<'de, A, B, D>(make: impl Fn() -> D, what: &str)
where
    A: Deserialize<'de> + std::fmt::Debug,
    B: Deserialize<'de> + std::fmt::Debug,
    D: Deserializer<'de, Error = ValueError>,
{
    assert_eq!(shown(A::deserialize(make())), shown(B::deserialize(make())), "{what}");
}

/// What a type passes the deserializer: its name and its fields' or variants' names.
#[derive(Default)]
struct Capture(RefCell<Option<(String, Vec<String>)>>);

impl<'de> Deserializer<'de> for &Capture {
    type Error = ValueError;

    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, ValueError> {
        Err(serde::de::Error::custom("not a struct or an enum"))
    }

    fn deserialize_struct<V: Visitor<'de>>(self, name: &'static str, fields: &'static [&'static str], _: V) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), fields.iter().map(|f| f.to_string()).collect()));
        Err(serde::de::Error::custom("captured"))
    }

    fn deserialize_enum<V: Visitor<'de>>(self, name: &'static str, variants: &'static [&'static str], _: V) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), variants.iter().map(|f| f.to_string()).collect()));
        Err(serde::de::Error::custom("captured"))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit
        unit_struct newtype_struct seq tuple tuple_struct map identifier ignored_any
    }
}

fn names<'de, T: Deserialize<'de>>() -> (String, Vec<String>) {
    let capture = Capture::default();
    let _ = T::deserialize(&capture);
    capture.0.into_inner().expect("deserialize_struct or deserialize_enum")
}

#[test]
fn the_names_passed_to_the_deserializer_are_serde_s() {
    assert_eq!(names::<sell::ours::Sell>(), names::<sell::theirs::Sell>());
    assert_eq!(names::<strict::ours::Strict>(), names::<strict::theirs::Strict>());
    assert_eq!(names::<search::ours::Search<'_>>(), names::<search::theirs::Search<'_>>());
    assert_eq!(names::<generic::ours::Generic<u8>>(), names::<generic::theirs::Generic<u8>>());
    assert_eq!(names::<empty::ours::Empty>(), names::<empty::theirs::Empty>());
    assert_eq!(names::<tab::ours::Tab>(), names::<tab::theirs::Tab>());
    assert_eq!(names::<sell::ours::Sell>().1, ["itemId", "qty", "quantity", "note", "tags", "gift", "days", "type"]);
}

#[test]
fn a_form_reads_the_same() {
    for text in [
        "itemId=a&qty=2",
        "itemId=a&quantity=2&note=&tags=x&tags=y&gift=on&days=3&type=t",
        "itemId=a&qty=2&qty=3",
        "itemId=a&qty=2&quantity=3",
        "itemId=a",
        "qty=2",
        "itemId=a&qty=-1",
        "itemId=a&qty=2&cache=9&kept=1&other=1",
        "item_id=a&qty=2",
        "",
    ] {
        same_form::<sell::ours::Sell, sell::theirs::Sell>(text);
    }
    for text in ["", "page=2", "page=x", "page=2&search=red", "page=2&other=1", "seen=true"] {
        same_form::<strict::ours::Strict, strict::theirs::Strict>(text);
    }
    for text in ["value=1", "value=1&list=2&list=3", "list=2", "value=1&other=2", "value=300"] {
        same_form::<generic::ours::Generic<u8>, generic::theirs::Generic<u8>>(text);
    }
    for text in ["tab=open", "tab=awaiting-label", "tab=done", "tab=shipped", "tab=old", "tab=older", "tab=Open", "tabs=open&tabs=done", "tab="] {
        same_form::<orders::ours::Orders, orders::theirs::Orders>(text);
    }
    same_form::<empty::ours::Empty, empty::theirs::Empty>("a=1");
}

#[test]
fn json_reads_the_same() {
    for text in [
        r#"{"itemId":"a","qty":2}"#,
        r#"{"itemId":"a","quantity":2,"note":null,"tags":["x"],"gift":true,"days":3,"type":"t"}"#,
        r#"{"itemId":"a","qty":2,"qty":3}"#,
        r#"{"itemId":"a","qty":2,"quantity":3}"#,
        r#"{"itemId":"a"}"#,
        r#"{"item\u0049d":"a","qty":2}"#,
        r#"{"itemId":1,"qty":2}"#,
        r#"["a",2,null,[],false,1,"t"]"#,
        r#"["a",2]"#,
        r#"["a"]"#,
        r#"[]"#,
        r#""a""#,
        r#"{"itemId":"a","qty":2,"cache":1,"kept":2,"x":{"y":[1]}}"#,
    ] {
        same_json::<sell::ours::Sell, sell::theirs::Sell>(text);
    }
    for text in [r#"{}"#, r#"{"page":2}"#, r#"{"page":2,"x":1}"#, r#"{"seen":true}"#, r#"[3]"#, r#"[]"#, r#"[3,"s",4]"#] {
        same_json::<strict::ours::Strict, strict::theirs::Strict>(text);
    }
    for text in [r#"{"value":1}"#, r#"{"value":1,"list":[2]}"#, r#"{"list":[2]}"#, r#"{"value":1,"x":2}"#, "[1]", "1"] {
        same_json::<generic::ours::Generic<u8>, generic::theirs::Generic<u8>>(text);
    }
    for text in [r#""open""#, r#""done""#, r#""shipped""#, r#""old""#, r#""nope""#, r#"{"open":null}"#, r#"{"open":1}"#, "1", "null"] {
        same_json::<tab::ours::Tab, tab::theirs::Tab>(text);
    }
    same_json::<empty::ours::Empty, empty::theirs::Empty>(r#"{"a":1}"#);
    same_json::<empty::ours::Empty, empty::theirs::Empty>("[]");
}

#[test]
fn identifiers_by_index_and_bytes_read_the_same() {
    use serde::de::value::{MapDeserializer, SeqDeserializer};
    for keys in [vec![0u64, 1], vec![1, 0], vec![0, 0], vec![0, 1, 7], vec![9]] {
        let entries: Vec<(u64, u64)> = keys.iter().map(|k| (*k, 2)).collect();
        same_from::<generic::ours::Generic<u64>, generic::theirs::Generic<u64>, _>(|| MapDeserializer::new(entries.clone().into_iter()), &format!("{keys:?}"));
        same_from::<strict::ours::Strict, strict::theirs::Strict, _>(|| MapDeserializer::new(entries.clone().into_iter()), &format!("{keys:?}"));
    }
    for entries in [vec![(&b"value"[..], 1u8)], vec![(&b"list"[..], 1)], vec![(&b"\xff"[..], 1)]] {
        let bytes = || MapDeserializer::new(entries.clone().into_iter().map(|(k, v)| (serde::de::value::BytesDeserializer::<ValueError>::new(k), v)));
        same_from::<generic::ours::Generic<u8>, generic::theirs::Generic<u8>, _>(bytes, "bytes keys");
    }
    for items in [vec![], vec![4u32], vec![4, 5]] {
        same_from::<strict::ours::Strict, strict::theirs::Strict, _>(|| SeqDeserializer::new(items.clone().into_iter()), &format!("{items:?}"));
    }
    for index in [0u32, 3, 4, 9] {
        same_from::<tab::ours::Tab, tab::theirs::Tab, _>(|| index.into_deserializer(), &format!("variant {index}"));
    }
    for word in ["open", "old", "nope"] {
        same_from::<tab::ours::Tab, tab::theirs::Tab, _>(|| serde::de::value::BytesDeserializer::new(word.as_bytes()), word);
        same_from::<tab::ours::Tab, tab::theirs::Tab, _>(|| word.into_deserializer(), word);
    }
}

#[test]
fn a_borrowed_field_borrows_where_serde_s_does() {
    let text = r#"{"q":"red","note":"plain","owned":"x"}"#;
    let ours: search::ours::Search<'_> = serde_json::from_str(text).unwrap();
    let theirs: search::theirs::Search<'_> = serde_json::from_str(text).unwrap();
    assert_eq!(format!("{ours:?}"), format!("{theirs:?}"));
    assert!(matches!(ours.note, Cow::Borrowed("plain")) && matches!(theirs.note, Cow::Borrowed("plain")));
    assert!(matches!(ours.owned, Cow::Owned(_)) && matches!(theirs.owned, Cow::Owned(_)));
    let escaped = r#"{"q":"red","note":"a\nb","owned":"x"}"#;
    let ours: search::ours::Search<'_> = serde_json::from_str(escaped).unwrap();
    assert!(matches!(ours.note, Cow::Owned(_)));
    same_json::<generic::ours::Generic<String>, generic::theirs::Generic<String>>(r#"{"value":"v"}"#);
    for text in [r#"{"q":"a\nb","note":"n","owned":"o"}"#, r#"{"note":"n","owned":"o"}"#] {
        assert_eq!(
            shown(serde_json::from_str::<search::ours::Search<'_>>(text)),
            shown(serde_json::from_str::<search::theirs::Search<'_>>(text)),
            "{text}"
        );
    }
}

/// A form type needs no serde of its own: `Fields` alone reads it, groups and rows included.
#[test]
fn fields_alone_reads_groups_and_rows() {
    #[derive(Debug, PartialEq, Default, corten::Fields)]
    struct Address {
        street: String,
        #[serde(default)]
        apt: Option<String>,
    }

    #[derive(Debug, PartialEq, corten::Fields)]
    struct Line {
        qty: u32,
    }

    #[derive(Debug, PartialEq, corten::Fields)]
    struct Order {
        #[fields(group)]
        ship_to: Address,
        #[fields(rows)]
        #[serde(default)]
        lines: BTreeMap<u32, Line>,
    }

    let read: Order = corten::form::from_bytes(b"ship_to.street=Main&lines[3].qty=2&lines[7].qty=1").unwrap();
    assert_eq!(read.ship_to, Address { street: "Main".into(), apt: None });
    assert_eq!(read.lines.into_iter().map(|(k, l)| (k, l.qty)).collect::<Vec<_>>(), [(3, 2), (7, 1)]);
    let refused = corten::form::from_bytes::<Order>(b"lines[3].qty=2").unwrap_err();
    assert_eq!(refused.to_string(), "missing field `ship_to`");
    let refused = corten::form::from_bytes::<Order>(b"ship_to.apt=2").unwrap_err();
    assert_eq!(refused.to_string(), "ship_to: missing field `street`");
}
