//! The `Deserialize` `#[derive(Fields)]`, `#[derive(UrlValue)]` and `#[derive(FromJson)]` write is
//! serde_derive's: each type here is declared twice from one body, once with Corten's derive and
//! once with serde's, and both read every input to the same value or the same error, and pass the
//! deserializer the same names. A `FromJson` type is also read by Corten's reader, which gives
//! serde's answer too.

#![cfg(feature = "json")]

use std::{borrow::Cow, cell::RefCell, collections::BTreeMap, marker::PhantomData};

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

pub fn fallback_filters() -> fallback::ours::Fallback {
    fallback::ours::Fallback { page: 3, search: Some("all".into()) }
}

pub fn fallback_filters_theirs() -> fallback::theirs::Fallback {
    fallback::theirs::Fallback { page: 3, search: Some("all".into()) }
}

twin! { sort, corten::UrlValue,
    #[derive(Clone, Copy)]
    pub enum Sort {
        Price,
        Newest,
        #[serde(other)]
        Unknown,
    }
}

mod fallback {
    pub mod ours {
        #[derive(Debug, PartialEq, corten::Fields)]
        #[serde(default = "crate::fallback_filters")]
        pub struct Fallback {
            pub page: u32,
            pub search: Option<String>,
        }
    }
    pub mod theirs {
        #[derive(Debug, PartialEq, serde::Deserialize)]
        #[serde(default = "crate::fallback_filters_theirs")]
        pub struct Fallback {
            pub page: u32,
            pub search: Option<String>,
        }
    }
}

twin! { aliased, corten::Fields,
    #[serde(deny_unknown_fields)]
    pub struct Aliased {
        #[serde(alias = "q", alias = "query")]
        pub search: String,
    }
}

// Bounds as serde infers them: `T: Default` for a defaulted `T`, none for one only a
// `PhantomData` or a skipped field names; and a `bound` in their place.
twin! { defaults, corten::Fields,
    pub struct Defaults<T, U, K> {
        #[serde(default)]
        pub value: T,
        pub kind: PhantomData<U>,
        #[serde(skip)]
        pub cache: Option<K>,
    }
}

/// A number read for any `T`: a field a `bound` lets a type read when `T` is not `Deserialize`.
#[derive(Debug, PartialEq)]
pub struct Tagged<T>(pub u8, PhantomData<T>);

impl<'de, T> Deserialize<'de> for Tagged<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        u8::deserialize(deserializer).map(|n| Tagged(n, PhantomData))
    }
}

twin! { field_bound, corten::Fields,
    pub struct FieldBound<T> {
        #[serde(bound = "")]
        pub value: Tagged<T>,
    }
}

twin! { container_bound, corten::Fields,
    #[serde(bound(serialize = "T: Copy", deserialize = "T: Default"), into = "u8")]
    pub struct ContainerBound<T> {
        pub value: Tagged<T>,
    }
}

twin! { bytes, corten::Fields,
    pub struct Bytes<'a, 'b> {
        #[serde(borrow)]
        pub raw: Cow<'a, [u8]>,
        #[serde(borrow = "'b")]
        pub named: Cow<'b, str>,
        #[serde(borrow)]
        pub maybe: Option<Cow<'a, str>>,
    }
}

twin! { fixed, corten::Fields,
    pub struct Fixed {
        pub name: &'static str,
    }
}

twin! { tree, corten::Fields,
    pub struct Tree {
        pub label: String,
        #[serde(default)]
        pub next: Option<Box<Self>>,
    }
}

twin! { old, corten::Fields,
    #[deprecated = "a test of a deprecated form type"]
    pub struct Old {
        pub a: u8,
    }
}

twin! { raw, corten::Fields,
    #[allow(non_camel_case_types)]
    pub struct r#match {
        pub a: u8,
    }
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

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        fields: &'static [&'static str],
        _: V,
    ) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), fields.iter().map(|f| f.to_string()).collect()));
        Err(serde::de::Error::custom("captured"))
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        _: V,
    ) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), variants.iter().map(|f| f.to_string()).collect()));
        Err(serde::de::Error::custom("captured"))
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(self, name: &'static str, _: V) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), Vec::new()));
        Err(serde::de::Error::custom("captured"))
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, name: &'static str, _: V) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), vec!["newtype".into()]));
        Err(serde::de::Error::custom("captured"))
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(self, name: &'static str, len: usize, _: V) -> Result<V::Value, ValueError> {
        *self.0.borrow_mut() = Some((name.to_string(), vec![len.to_string()]));
        Err(serde::de::Error::custom("captured"))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit
        seq tuple map identifier ignored_any
    }
}

fn names<'de, T: Deserialize<'de>>() -> (String, Vec<String>) {
    let capture = Capture::default();
    let _ = T::deserialize(&capture);
    capture.0.into_inner().expect("deserialize_struct, deserialize_enum or a named struct form")
}

#[test]
fn the_names_passed_to_the_deserializer_are_serde_s() {
    assert_eq!(names::<sell::ours::Sell>(), names::<sell::theirs::Sell>());
    assert_eq!(names::<strict::ours::Strict>(), names::<strict::theirs::Strict>());
    assert_eq!(names::<search::ours::Search<'_>>(), names::<search::theirs::Search<'_>>());
    assert_eq!(names::<generic::ours::Generic<u8>>(), names::<generic::theirs::Generic<u8>>());
    assert_eq!(names::<empty::ours::Empty>(), names::<empty::theirs::Empty>());
    assert_eq!(names::<tab::ours::Tab>(), names::<tab::theirs::Tab>());
    assert_eq!(names::<sort::ours::Sort>(), names::<sort::theirs::Sort>());
    assert_eq!(names::<aliased::ours::Aliased>(), names::<aliased::theirs::Aliased>());
    assert_eq!(names::<raw::ours::r#match>(), names::<raw::theirs::r#match>());
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
    for text in [
        "tab=open",
        "tab=awaiting-label",
        "tab=done",
        "tab=shipped",
        "tab=old",
        "tab=older",
        "tab=Open",
        "tabs=open&tabs=done",
        "tab=",
    ] {
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
    for text in
        [r#""open""#, r#""done""#, r#""shipped""#, r#""old""#, r#""nope""#, r#"{"open":null}"#, r#"{"open":1}"#, "1", "null"]
    {
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
        same_from::<generic::ours::Generic<u64>, generic::theirs::Generic<u64>, _>(
            || MapDeserializer::new(entries.clone().into_iter()),
            &format!("{keys:?}"),
        );
        same_from::<strict::ours::Strict, strict::theirs::Strict, _>(
            || MapDeserializer::new(entries.clone().into_iter()),
            &format!("{keys:?}"),
        );
    }
    for entries in [vec![(&b"value"[..], 1u8)], vec![(&b"list"[..], 1)], vec![(&b"\xff"[..], 1)]] {
        let bytes = || {
            MapDeserializer::new(
                entries.clone().into_iter().map(|(k, v)| (serde::de::value::BytesDeserializer::<ValueError>::new(k), v)),
            )
        };
        same_from::<generic::ours::Generic<u8>, generic::theirs::Generic<u8>, _>(bytes, "bytes keys");
    }
    for items in [vec![], vec![4u32], vec![4, 5]] {
        same_from::<strict::ours::Strict, strict::theirs::Strict, _>(
            || SeqDeserializer::new(items.clone().into_iter()),
            &format!("{items:?}"),
        );
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

#[test]
fn other_attributes_read_the_same() {
    for text in [r#""price""#, r#""newest""#, r#""Price""#, r#""cheapest""#, "0", "2", "3"] {
        same_json::<sort::ours::Sort, sort::theirs::Sort>(text);
    }
    for word in ["Price", "cheapest", ""] {
        same_form::<orders_sort::ours::Orders, orders_sort::theirs::Orders>(&format!("sort={word}"));
    }
    for text in ["", "page=2", "search=red", "page=x"] {
        same_form::<fallback::ours::Fallback, fallback::theirs::Fallback>(text);
    }
    for text in [r#"{}"#, r#"[]"#, r#"[4]"#, r#"{"page":4}"#] {
        same_json::<fallback::ours::Fallback, fallback::theirs::Fallback>(text);
    }
    for text in ["search=a", "q=a", "query=a", "q=a&search=b", "other=1", ""] {
        same_form::<aliased::ours::Aliased, aliased::theirs::Aliased>(text);
    }
    for text in ["", "value=2", "value=x", "kind=1", "cache=1"] {
        same_form::<defaults::ours::Defaults<u8, NotRead, NotRead>, defaults::theirs::Defaults<u8, NotRead, NotRead>>(text);
    }
    for text in ["value=2", "", "value=x"] {
        same_form::<field_bound::ours::FieldBound<NotRead>, field_bound::theirs::FieldBound<NotRead>>(text);
        same_form::<container_bound::ours::ContainerBound<NotRead>, container_bound::theirs::ContainerBound<NotRead>>(text);
    }
    for text in [r#"{"label":"a"}"#, r#"{"label":"a","next":{"label":"b"}}"#, r#"{"label":"a","next":{}}"#] {
        same_json::<tree::ours::Tree, tree::theirs::Tree>(text);
    }
    for text in [r#"{"a":1}"#, "1", "[]"] {
        same_json::<raw::ours::r#match, raw::theirs::r#match>(text);
        #[allow(deprecated)]
        same_json::<old::ours::Old, old::theirs::Old>(text);
    }
}

/// A type that is not `Deserialize`, which only a `PhantomData` or a skipped field names (serde
/// bounds a skipped field's parameters by `Default`).
#[derive(Debug, PartialEq, Default)]
pub struct NotRead;

mod orders_sort {
    pub mod ours {
        #[derive(Debug, PartialEq, corten::Fields)]
        pub struct Orders {
            pub sort: Option<crate::sort::ours::Sort>,
        }
    }
    pub mod theirs {
        #[derive(Debug, PartialEq, serde::Deserialize)]
        pub struct Orders {
            pub sort: Option<crate::sort::theirs::Sort>,
        }
    }
}

#[test]
fn borrowed_bytes_and_named_lifetimes_borrow_where_serde_s_do() {
    let text = r#"{"raw":"abc","named":"n","maybe":"m"}"#;
    let ours: bytes::ours::Bytes<'_, '_> = serde_json::from_str(text).unwrap();
    let theirs: bytes::theirs::Bytes<'_, '_> = serde_json::from_str(text).unwrap();
    assert_eq!(format!("{ours:?}"), format!("{theirs:?}"));
    assert!(matches!(ours.raw, Cow::Borrowed(b"abc")) && matches!(theirs.raw, Cow::Borrowed(b"abc")));
    assert!(matches!(ours.named, Cow::Borrowed("n")) && matches!(theirs.named, Cow::Borrowed("n")));
    // An `Option<Cow>` borrows the lifetime but reads by `Option`'s own `Deserialize`: owned.
    assert!(matches!(ours.maybe, Some(Cow::Owned(_))) && matches!(theirs.maybe, Some(Cow::Owned(_))));
    for text in [
        r#"{"raw":"a
b","named":"n"}"#,
        r#"{"raw":[1,2],"named":"n"}"#,
        r#"{"named":"n"}"#,
        r#"{"raw":"r","named":1}"#,
    ] {
        assert_eq!(
            shown(serde_json::from_str::<bytes::ours::Bytes<'_, '_>>(text)),
            shown(serde_json::from_str::<bytes::theirs::Bytes<'_, '_>>(text)),
            "{text}"
        );
    }
    // A borrowed `Cow<str>` read from bytes, as serde's reads one: borrowed when they are UTF-8.
    use corten::form::__private::Borrow;
    use serde::de::value::{BorrowedBytesDeserializer, BytesDeserializer};
    let text = Borrow::<Cow<'_, str>>::deserialize(BorrowedBytesDeserializer::<ValueError>::new(b"plain")).unwrap();
    assert!(matches!(text.0, Cow::Borrowed("plain")));
    let text = Borrow::<Cow<'_, str>>::deserialize(BytesDeserializer::<ValueError>::new(b"plain")).unwrap();
    assert!(matches!(text.0, Cow::Owned(_)));
    let refused = Borrow::<Cow<'_, str>>::deserialize(BorrowedBytesDeserializer::<ValueError>::new(b"\xff")).err().unwrap();
    assert_eq!(refused.to_string(), "invalid value: byte array, expected a string");
}

#[test]
fn a_static_field_reads_static_input() {
    let ours: fixed::ours::Fixed = serde_json::from_str(r#"{"name":"n"}"#).unwrap();
    let theirs: fixed::theirs::Fixed = serde_json::from_str(r#"{"name":"n"}"#).unwrap();
    assert_eq!(ours.name, theirs.name);
    assert_eq!(names::<fixed::ours::Fixed>(), names::<fixed::theirs::Fixed>());
}

/// A type whose associated type is not `Default`: serde bounds `T::Value: Default` only.
pub trait Kind {
    type Value;
}

#[derive(Debug, PartialEq)]
pub struct NoDefault;

impl Kind for NoDefault {
    type Value = u8;
}

mod associated {
    pub mod ours {
        #[derive(Debug, PartialEq, corten::Fields)]
        pub struct Associated<T: crate::Kind> {
            #[serde(default)]
            pub value: T::Value,
            #[serde(skip)]
            pub kept: T::Value,
        }
    }
    pub mod theirs {
        #[derive(Debug, PartialEq, serde::Deserialize)]
        pub struct Associated<T: crate::Kind> {
            #[serde(default)]
            pub value: T::Value,
            #[serde(skip)]
            pub kept: T::Value,
        }
    }
}

/// A field's type as a `macro_rules!` passes it, inside an invisible group.
macro_rules! passed {
    ($name:ident, $derive:path, $text:ty, $bytes:ty, $value:ty) => {
        #[derive(Debug, $derive)]
        pub struct $name<'a, T: crate::Kind> {
            #[serde(borrow)]
            pub note: $text,
            #[serde(borrow)]
            pub raw: $bytes,
            #[serde(default)]
            pub value: $value,
        }
    };
}

mod passed {
    use std::borrow::Cow;
    passed!(Ours, corten::Fields, Cow<'a, str>, Cow<'a, [u8]>, T::Value);
    passed!(Theirs, serde::Deserialize, Cow<'a, str>, Cow<'a, [u8]>, T::Value);
}

#[test]
fn associated_types_and_types_a_macro_passes_read_the_same() {
    for text in [r#"{}"#, r#"{"value":3}"#, r#"{"value":"x"}"#, r#"{"value":3,"kept":4}"#] {
        same_json::<associated::ours::Associated<NoDefault>, associated::theirs::Associated<NoDefault>>(text);
    }
    let text = r#"{"note":"plain","raw":"r","value":2}"#;
    let ours: passed::Ours<'_, NoDefault> = serde_json::from_str(text).unwrap();
    let theirs: passed::Theirs<'_, NoDefault> = serde_json::from_str(text).unwrap();
    assert!(matches!(ours.note, Cow::Borrowed("plain")) && matches!(theirs.note, Cow::Borrowed("plain")));
    assert!(matches!(ours.raw, Cow::Borrowed(b"r")) && matches!(theirs.raw, Cow::Borrowed(b"r")));
    assert_eq!((ours.value, theirs.value), (2, 2));
    let ours: passed::Ours<'_, NoDefault> = serde_json::from_str(r#"{"note":"n","raw":"r"}"#).unwrap();
    assert_eq!(ours.value, 0);
}

pub fn half() -> f64 {
    0.5
}

/// Not `FromJson`: a field of this type is read by serde_json from the field's text.
#[derive(Debug, PartialEq, serde::Deserialize)]
pub struct Elsewhere {
    pub id: u32,
}

twin! { seller, corten::FromJson,
    pub struct Seller {
        pub id: u32,
    }
}

twin! { listing, corten::FromJson,
    #[serde(rename_all = "camelCase")]
    pub struct Listing<S> {
        pub listing_id: String,
        #[serde(rename = "qty", alias = "quantity")]
        pub count: u32,
        #[serde(default)]
        pub tags: Vec<String>,
        #[serde(default = "crate::half")]
        pub share: f64,
        #[serde(skip)]
        pub seen: bool,
        pub price: Option<f64>,
        pub seller: S,
        pub address: std::net::IpAddr,
        pub other: Option<crate::Elsewhere>,
        pub r#type: String,
    }
}

twin! { pair, corten::FromJson,
    pub struct Pair(pub u32, pub String);
}

twin! { span, corten::FromJson,
    #[derive(Default)]
    #[serde(default)]
    pub struct Span(pub u32, pub u32);
}

twin! { id, corten::FromJson,
    pub struct Id(pub u64);
}

twin! { marker, corten::FromJson,
    pub struct Marker;
}

twin! { name, corten::FromJson,
    #[serde(transparent)]
    pub struct Name {
        pub text: String,
        #[serde(skip)]
        pub cache: Option<u8>,
    }
}

twin! { cents, corten::FromJson,
    #[serde(transparent)]
    pub struct Cents(pub i64);
}

twin! { filters, corten::FromJson,
    #[derive(Default)]
    #[serde(default, deny_unknown_fields, rename = "Filter", expecting = "a filter")]
    pub struct Filters {
        pub page: u32,
        pub search: Option<String>,
    }
}

twin! { status, corten::FromJson,
    #[serde(rename_all = "kebab-case")]
    pub enum Status {
        Open,
        #[serde(rename = "awaiting")]
        AwaitingLabel,
        #[serde(alias = "sent")]
        Shipped,
        // Never read, so never built.
        #[allow(dead_code)]
        #[serde(skip)]
        Hidden,
    }
}

/// serde_json through each impl, and Corten's reader (which hands serde_json what it gives up
/// on) through ours, all give serde's answer.
fn same_read<A: corten::FromJson + std::fmt::Debug, B: DeserializeOwned + std::fmt::Debug>(text: &str) {
    let theirs = shown(serde_json::from_str::<B>(text));
    assert_eq!(shown(serde_json::from_str::<A>(text)), theirs, "serde_json {text}");
    assert_eq!(shown(corten::json::from_str::<A>(text)), theirs, "corten {text}");
    assert_eq!(shown(corten::json::from_slice::<A>(text.as_bytes())), theirs, "corten bytes {text}");
}

#[test]
fn from_json_reads_what_serde_s_derive_reads() {
    type Ours = listing::ours::Listing<seller::ours::Seller>;
    type Theirs = listing::theirs::Listing<seller::theirs::Seller>;
    let whole = r#"{"listingId":"l1","qty":2,"price":2.5,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#;
    for text in [
        whole,
        r#"{"listingId":"l1","quantity":2,"tags":["a"],"share":1.5,"seen":true,"price":null,"seller":{"id":7,"x":1},"address":"::1","other":{"id":3},"type":"card","more":[1,{"a":2}]}"#,
        r#"{"listingId":"l1","qty":2,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#,
        r#"{"listingId":"l1","qty":2,"qty":3,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#,
        r#"{"listingId":"l1","qty":2,"quantity":3,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#,
        r#"{"listing\u0049d":"l1","qty":2,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#,
        r#"{"qty":2,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#,
        r#"{"listingId":"l1","qty":"2","seller":{"id":7},"address":"127.0.0.1","type":"card"}"#,
        r#"{"listingId":"l1","qty":2,"seller":{},"address":"127.0.0.1","type":"card"}"#,
        r#"{"listingId":"l1","qty":2,"seller":{"id":7},"address":"nowhere","type":"card"}"#,
        r#"{"listingId":"l1","qty":2,"seller":{"id":7},"address":"127.0.0.1","other":{"id":"x"},"type":"card"}"#,
        r#"["l1",2,["a"],1.5,2.5,{"id":7},"127.0.0.1",null,"card"]"#,
        r#"["l1",2]"#,
        "null",
        "1",
        "{",
    ] {
        same_read::<Ours, Theirs>(text);
    }
    for text in ["[3,\"x\"]", "[3]", "[3,\"x\",4]", "[]", r#"{"0":3,"1":"x"}"#, "3"] {
        same_read::<pair::ours::Pair, pair::theirs::Pair>(text);
    }
    for text in ["[1,2]", "[1]", "[]", "[1,2,3]", "null"] {
        same_read::<span::ours::Span, span::theirs::Span>(text);
    }
    for text in ["7", "[7]", "[7,8]", "-1", "\"7\"", "null"] {
        same_read::<id::ours::Id, id::theirs::Id>(text);
    }
    for text in ["null", "{}", "[]", "0"] {
        same_read::<marker::ours::Marker, marker::theirs::Marker>(text);
    }
    for text in ["\"Ada\"", "1", "null", r#"{"text":"Ada"}"#] {
        same_read::<name::ours::Name, name::theirs::Name>(text);
    }
    for text in ["250", "-3", "2.5", "\"250\"", "[250]"] {
        same_read::<cents::ours::Cents, cents::theirs::Cents>(text);
    }
    for text in [r#"{}"#, r#"{"page":2}"#, r#"{"page":2,"search":"red"}"#, r#"{"page":2,"x":1}"#, "[3]", "[]", "null"] {
        same_read::<filters::ours::Filters, filters::theirs::Filters>(text);
    }
    for text in [
        "\"open\"",
        "\"awaiting\"",
        "\"awaiting-label\"",
        "\"shipped\"",
        "\"sent\"",
        "\"hidden\"",
        "\"Open\"",
        r#"{"open":null}"#,
        "1",
        "null",
    ] {
        same_read::<status::ours::Status, status::theirs::Status>(text);
    }
}

/// Corten's reader reads `text` itself, to serde's value: it does not give up and hand the text
/// to serde_json.
fn read_alone<A: corten::FromJson + std::fmt::Debug, B: DeserializeOwned + std::fmt::Debug>(text: &str) {
    let ours = corten::json::__read::alone::<A>(text).unwrap_or_else(|| panic!("the reader gave up on {text}"));
    assert_eq!(format!("{ours:?}"), format!("{:?}", serde_json::from_str::<B>(text).unwrap()), "{text}");
}

#[test]
fn corten_s_reader_reads_each_type_itself() {
    type Ours = listing::ours::Listing<seller::ours::Seller>;
    type Theirs = listing::theirs::Listing<seller::theirs::Seller>;
    read_alone::<Ours, Theirs>(r#"{"listingId":"l1","qty":2,"price":2.5,"seller":{"id":7},"address":"127.0.0.1","type":"card"}"#);
    read_alone::<pair::ours::Pair, pair::theirs::Pair>("[3,\"x\"]");
    read_alone::<span::ours::Span, span::theirs::Span>("[1,2]");
    read_alone::<id::ours::Id, id::theirs::Id>("7");
    read_alone::<marker::ours::Marker, marker::theirs::Marker>("null");
    read_alone::<name::ours::Name, name::theirs::Name>("\"Ada\"");
    read_alone::<cents::ours::Cents, cents::theirs::Cents>("250");
    read_alone::<filters::ours::Filters, filters::theirs::Filters>(r#"{"page":2,"search":"red"}"#);
    read_alone::<status::ours::Status, status::theirs::Status>("\"sent\"");
}

twin! { never, corten::FromJson,
    pub enum Never {}
}

twin! { skipped, corten::FromJson,
    pub enum Skipped {
        #[allow(dead_code)]
        #[serde(skip)]
        Hidden,
    }
}

twin! { renamed, corten::FromJson,
    #[serde(rename(serialize = "Out", deserialize = "In"))]
    pub struct Renamed {
        pub id: u32,
    }
}

#[test]
fn from_json_reads_enums_with_no_variant_read_and_a_split_rename() {
    for text in ["\"Hidden\"", "\"x\"", "null", "1", r#"{"Hidden":null}"#] {
        same_read::<never::ours::Never, never::theirs::Never>(text);
        same_read::<skipped::ours::Skipped, skipped::theirs::Skipped>(text);
    }
    for text in [r#"{"id":1}"#, "[1]", "{}", "null"] {
        same_read::<renamed::ours::Renamed, renamed::theirs::Renamed>(text);
    }
    assert_eq!(names::<renamed::ours::Renamed>(), names::<renamed::theirs::Renamed>());
    assert_eq!(names::<renamed::ours::Renamed>().0, "In");
    assert_eq!(names::<skipped::ours::Skipped>(), names::<skipped::theirs::Skipped>());
}

twin! { shipping, corten::UrlValue,
    #[serde(rename_all = "snake_case")]
    pub enum Shipping {
        Standard,
        #[serde(alias = "express")]
        NextDay,
    }
}

twin! { order, corten::Fields,
    #[serde(rename_all = "camelCase")]
    pub struct Order {
        pub email: String,
        #[serde(default)]
        pub gift_note: Option<String>,
        pub shipping: crate::shipping::ours::Shipping,
    }
}

twin! { note, corten::Fields,
    pub struct Note {
        pub text: Cow<'static, str>,
    }
}

// Owned too: a `Cow` by its full path, a field named `borrow`, and a reference in a skipped
// field, which is never read.
twin! { kept, corten::Fields,
    pub struct Kept {
        pub text: std::borrow::Cow<'static, str>,
        pub borrow: String,
        #[serde(skip)]
        pub cache: Option<&'static str>,
    }
}

#[test]
fn fields_and_url_value_are_read_from_json_as_they_are() {
    // A `Cow<'static, str>` read without `borrow` is owned, so the struct is a `FromJson`.
    same_read::<note::ours::Note, note::theirs::Note>(r#"{"text":"hi"}"#);
    read_alone::<note::ours::Note, note::theirs::Note>(r#"{"text":"hi"}"#);
    same_read::<kept::ours::Kept, kept::theirs::Kept>(r#"{"text":"hi","borrow":"b"}"#);
    read_alone::<kept::ours::Kept, kept::theirs::Kept>(r#"{"text":"hi","borrow":"b"}"#);
    // The twins' `shipping` is the same type on both sides, so serde's reads it by ours.
    for text in [
        r#"{"email":"a@b.c","shipping":"next_day"}"#,
        r#"{"email":"a@b.c","giftNote":"hi","shipping":"express"}"#,
        r#"{"email":"a@b.c","shipping":"overnight"}"#,
        r#"{"email":"a@b.c"}"#,
        "null",
    ] {
        same_read::<order::ours::Order, order::theirs::Order>(text);
    }
    read_alone::<order::ours::Order, order::theirs::Order>(r#"{"email":"a@b.c","giftNote":"hi","shipping":"express"}"#);
    for text in ["\"standard\"", "\"next_day\"", "\"express\"", "\"NextDay\"", "1"] {
        same_read::<shipping::ours::Shipping, shipping::theirs::Shipping>(text);
    }
    read_alone::<shipping::ours::Shipping, shipping::theirs::Shipping>("\"next_day\"");
    read_alone::<fallback::ours::Fallback, fallback::theirs::Fallback>(r#"{"page":2}"#);
}

/// A constant a discriminant reads through a qualified path.
pub trait Width {
    const N: isize;
}

impl Width for std::collections::HashMap<u8, u16> {
    const N: isize = 40;
}

twin! { shifted, corten::UrlValue,
    #[derive(Clone, Copy)]
    #[serde(rename_all = "snake_case")]
    pub enum Shifted {
        Read = 1 << 0,
        Write = 1 << 1,
        Admin = size_of::<std::collections::HashMap<u8, u16>>() as isize,
        Long = size_of::<fn() -> std::collections::HashMap<u8, u16>>() as isize + 100,
        Qualified = <std::collections::HashMap<u8, u16> as Width>::N,
    }
}

twin! { shifted_json, corten::FromJson,
    pub enum ShiftedJson {
        Read = 1 << 0,
        Write = 1 << 1,
    }
}

twin! { wording, corten::UrlValue,
    #[serde(rename_all = "snake_case")]
    pub enum Wording {
        Plain,
        Bold,
        #[serde(other)]
        Other,
    }
}

#[test]
fn a_generic_form_a_shifted_discriminant_and_another_word_read_as_serde_s() {
    for text in [r#"{"value":1,"list":[2,3]}"#, r#"{"value":1}"#, r#"{"value":"x"}"#, r#"{"value":1,"x":2}"#, "null"] {
        same_read::<generic::ours::Generic<u32>, generic::theirs::Generic<u32>>(text);
    }
    // A generic one is the trait's own body: serde_json reads it, alone and inside another value.
    assert!(corten::json::__read::alone::<generic::ours::Generic<u32>>(r#"{"value":1,"list":[2,3]}"#).is_none());
    same_read::<Vec<generic::ours::Generic<u32>>, Vec<generic::theirs::Generic<u32>>>(
        r#"[{"value":1,"list":[2,3]},{"value":4}]"#,
    );
    // Its bounds are the ones serde infers (`T: Default` here), not `FromJson` on each parameter.
    same_read::<defaults::ours::Defaults<u8, NotRead, NotRead>, defaults::theirs::Defaults<u8, NotRead, NotRead>>(
        r#"{"kind":null}"#,
    );
    same_read::<associated::ours::Associated<NoDefault>, associated::theirs::Associated<NoDefault>>(r#"{"value":3}"#);
    for text in ["\"read\"", "\"write\"", "\"admin\"", "\"long\"", "\"qualified\"", "\"Write\"", "1"] {
        same_read::<shifted::ours::Shifted, shifted::theirs::Shifted>(text);
    }
    read_alone::<shifted::ours::Shifted, shifted::theirs::Shifted>("\"admin\"");
    for text in ["\"Read\"", "\"Write\"", "\"write\""] {
        same_read::<shifted_json::ours::ShiftedJson, shifted_json::theirs::ShiftedJson>(text);
    }
    for text in ["\"plain\"", "\"bold\"", "\"italic\"", "\"other\"", "1"] {
        same_read::<wording::ours::Wording, wording::theirs::Wording>(text);
    }
    read_alone::<wording::ours::Wording, wording::theirs::Wording>("\"bold\"");
    assert_eq!(names::<wording::ours::Wording>(), names::<wording::theirs::Wording>());
}

/// The schema `Fields` and `UrlValue` write is the one `FromJson` derived on the same body writes.
#[cfg(feature = "types")]
#[test]
fn fields_and_url_value_describe_what_they_read_as_from_json_does() {
    use corten::json::schema::Generator;
    mod derived {
        #[derive(corten::FromJson)]
        #[serde(rename_all = "snake_case")]
        pub enum Shipping {
            Standard,
            #[serde(alias = "express")]
            NextDay,
        }
        #[derive(corten::FromJson)]
        #[serde(rename_all = "camelCase")]
        pub struct Order {
            pub email: String,
            #[serde(default)]
            pub gift_note: Option<String>,
            pub shipping: crate::shipping::ours::Shipping,
        }
        #[derive(corten::FromJson)]
        #[serde(deny_unknown_fields, expecting = "a filter")]
        pub struct Generic<T> {
            pub value: T,
            #[serde(default)]
            pub list: Vec<T>,
        }
    }
    let named = |schema: serde_json::Value| schema.to_string().replace("derived::", "").replace("ours::", "");
    assert_eq!(
        named(Generator::root_for_read::<shipping::ours::Shipping>()),
        named(Generator::root_for_read::<derived::Shipping>())
    );
    assert_eq!(named(Generator::root_for_read::<order::ours::Order>()), named(Generator::root_for_read::<derived::Order>()));
    assert_eq!(
        named(Generator::root_for_read::<generic::ours::Generic<u32>>()),
        named(Generator::root_for_read::<derived::Generic<u32>>())
    );
    // Another word is one of the enum's.
    assert_eq!(Generator::root_for_read::<wording::ours::Wording>()["type"], "string");
}

#[test]
fn from_json_passes_the_deserializer_serde_s_names() {
    type Ours = listing::ours::Listing<seller::ours::Seller>;
    type Theirs = listing::theirs::Listing<seller::theirs::Seller>;
    assert_eq!(names::<Ours>(), names::<Theirs>());
    assert_eq!(
        names::<Ours>().1,
        ["listingId", "qty", "quantity", "tags", "share", "price", "seller", "address", "other", "type"]
    );
    assert_eq!(names::<pair::ours::Pair>(), names::<pair::theirs::Pair>());
    assert_eq!(names::<span::ours::Span>(), names::<span::theirs::Span>());
    assert_eq!(names::<id::ours::Id>(), names::<id::theirs::Id>());
    assert_eq!(names::<marker::ours::Marker>(), names::<marker::theirs::Marker>());
    assert_eq!(names::<filters::ours::Filters>(), names::<filters::theirs::Filters>());
    assert_eq!(names::<status::ours::Status>(), names::<status::theirs::Status>());
}

#[test]
fn from_json_reads_serde_s_value_deserializers_the_same() {
    same_from::<id::ours::Id, id::theirs::Id, _>(|| 7u64.into_deserializer(), "an integer as a newtype");
    same_from::<cents::ours::Cents, cents::theirs::Cents, _>(|| 7i64.into_deserializer(), "an integer as a transparent");
    same_from::<marker::ours::Marker, marker::theirs::Marker, _>(|| ().into_deserializer(), "a unit");
    same_from::<status::ours::Status, status::theirs::Status, _>(|| "sent".into_deserializer(), "a variant by alias");
    same_from::<status::ours::Status, status::theirs::Status, _>(|| "hidden".into_deserializer(), "a skipped variant");
    same_from::<pair::ours::Pair, pair::theirs::Pair, _>(
        || serde::de::value::SeqDeserializer::<_, ValueError>::new([1u32].into_iter()),
        "a list one short",
    );
}
