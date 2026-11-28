//! Reading `application/x-www-form-urlencoded` into a struct, the way a browser posts a form:
//! a key sent once per value. Pairs are grouped by key (keeping the order the values came in),
//! so a `Vec` field gets every value of its key and any other field exactly one.
//!
//! | Field | Reads |
//! |---|---|
//! | `String`, a number, a unit-variant enum | the key's one value; sent twice is an error |
//! | `bool` | `true` for `true` or `on` (a checked checkbox), `false` for `false` |
//! | `Option<T>` | `None` when the key is missing or its value is empty (a blank field), else `T` |
//! | `Vec<T>` | every value of the key, in order |
//!
//! A key the browser leaves out (an unchecked checkbox, a list with nothing selected) is
//! missing, as serde sees it: `#[derive(Fields)]` requires `#[serde(default)]` on a `bool` or a
//! list so that reads as `false` or empty instead of failing.

use std::{borrow::Cow, fmt};

use serde::de::{self, value::StrDeserializer, DeserializeSeed, Deserializer, IntoDeserializer, MapAccess, SeqAccess, Visitor};

pub type Pair<'a> = (Cow<'a, str>, Cow<'a, str>);

/// Why a form or query string did not read into its type: the field and what was wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormError {
    message: String,
    /// A word a unit-variant enum does not have: a query value written by an older version of
    /// the app, or by hand.
    unknown_word: bool,
    /// A path parameter's, read with the query (one followed by text in its segment).
    in_path: bool,
}

impl FormError {
    fn new(message: impl Into<String>) -> Self {
        FormError { message: message.into(), unknown_word: false, in_path: false }
    }

    /// A path parameter that did not read.
    pub(crate) fn in_path(message: impl Into<String>) -> Self {
        FormError { message: message.into(), unknown_word: false, in_path: true }
    }

    pub(crate) fn is_in_path(&self) -> bool {
        self.in_path
    }
}

impl fmt::Display for FormError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FormError {}

impl de::Error for FormError {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        FormError::new(msg.to_string())
    }

    #[cold]
    fn unknown_variant(variant: &str, expected: &'static [&'static str]) -> Self {
        // serde's own wording, marked so a query parameter can read the word as missing.
        let message = <de::value::Error as de::Error>::unknown_variant(variant, expected).to_string();
        FormError { message, unknown_word: true, in_path: false }
    }
}

/// Reads `bytes` (a body or a query string, without the `?`) into `T`.
pub fn from_bytes<T: de::DeserializeOwned>(bytes: &[u8]) -> Result<T, FormError> {
    from_pairs(form_urlencoded::parse(bytes).collect())
}

/// Reads the fields a form sent, in the order it sent them, into `T`.
pub(crate) fn from_pairs<T: de::DeserializeOwned>(mut pairs: Vec<Pair<'_>>) -> Result<T, FormError> {
    // Stable: the values of one key stay in the order they were sent.
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    T::deserialize(Form(&pairs))
}

/// A query string's pairs sorted by key (the values of one key in the order sent), for
/// [`field`] and [`prefixed`]: what `Params` reads a route's query parameters from.
pub fn sorted_pairs(query: &str) -> Vec<Pair<'_>> {
    // What `form_urlencoded::parse` reads, in one walk over the bytes: fields at `&`, empty ones
    // skipped, key and value at the first `=`, a field with no `=` a key with an empty value. The
    // walk that finds a key's or a value's end also sees whether it has a `+` or a `%`, so one
    // with neither is borrowed as it is (a `&str` is UTF-8 already), which is every key and value
    // of a link an app writes itself (`?a=1&b=2`), and only one that has either is decoded.
    let bytes = query.as_bytes();
    // The empty fields a query begins with are passed first, so what is left has a pair in it or
    // is nothing: an empty query, or one of `&` alone, takes no memory, and any other takes room
    // for four pairs at once, as collecting the decoder's took with its first.
    let mut at = 0;
    while bytes.get(at) == Some(&b'&') {
        at += 1;
    }
    if at == bytes.len() {
        return Vec::new();
    }
    let mut pairs: Vec<Pair<'_>> = Vec::with_capacity(4);
    while at < bytes.len() {
        let start = at;
        let key = half(query, &mut at, true);
        let value = if bytes.get(at) == Some(&b'=') {
            at += 1;
            half(query, &mut at, false)
        } else {
            Cow::Borrowed("")
        };
        // A field with nothing in it is no pair; `=` alone is one, of an empty key and value.
        if at > start {
            pairs.push((key, value));
        }
        at += 1;
    }
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
}

/// The key (`key`) or the value of a query's field that starts at `at`, which is left at its
/// end: the next `&`, for a key the next `=` if that comes first, or the query's end. Those and
/// the two characters looked for are ASCII, so no byte of another character is taken for one
/// and the text between them is whole characters.
fn half<'a>(query: &'a str, at: &mut usize, key: bool) -> Cow<'a, str> {
    let (start, mut plus, mut percent) = (*at, false, false);
    while let Some(&byte) = query.as_bytes().get(*at) {
        if byte == b'&' || (key && byte == b'=') {
            break;
        }
        plus |= byte == b'+';
        percent |= byte == b'%';
        *at += 1;
    }
    let text = &query[start..*at];
    if plus || percent {
        unescaped(text, plus, percent)
    } else {
        Cow::Borrowed(text)
    }
}

/// A key or a value with a `+` (`plus`) or a `%` (`percent`) in it, read as `form_urlencoded`
/// reads one (it offers that for a whole query only): each `+` a space, then percent-decoded
/// with the function it uses, then as UTF-8 with what is not UTF-8 replaced. Out of line, so the
/// walk stays small for the queries with nothing to decode: left to the compiler, this was put
/// into [`half`] and `half` was then called from the walk, which cost every query more.
#[inline(never)]
fn unescaped(text: &str, plus: bool, percent: bool) -> Cow<'_, str> {
    let spaced: Cow<'_, [u8]> = if plus {
        Cow::Owned(text.bytes().map(|byte| if byte == b'+' { b' ' } else { byte }).collect())
    } else {
        Cow::Borrowed(text.as_bytes())
    };
    // Borrowed when no `%` is followed by two hex digits (`%`, `%zz`), which stay as written.
    let decoded = if percent { Cow::from(percent_encoding::percent_decode(&spaced)) } else { Cow::Borrowed(&[][..]) };
    let bytes = match decoded {
        Cow::Owned(decoded) => decoded,
        Cow::Borrowed(_) => match spaced {
            Cow::Borrowed(_) => return Cow::Borrowed(text),
            Cow::Owned(spaced) => spaced,
        },
    };
    Cow::Owned(String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()))
}

/// One field of a route's query, by its key, from [`sorted_pairs`]. A key that is missing is
/// `None` for an `Option`, empty for a list, and `default` (`#[serde(default)]`) or an
/// error for anything else, the way a link leaves those out.
pub fn field<T: de::DeserializeOwned>(pairs: &[Pair<'_>], key: &str, default: Option<fn() -> T>) -> Result<T, FormError> {
    let start = pairs.partition_point(|(k, _)| k.as_ref() < key);
    let end = start + pairs[start..].iter().take_while(|(k, _)| k == key).count();
    match (&pairs[start..end], default) {
        ([], Some(default)) => Ok(default()),
        ([], None) => T::deserialize(Missing(key)),
        (values, default) => T::deserialize(Values(values)).or_else(|e| {
            // A word the app no longer has (an old bookmark, an address edited by hand) reads as
            // if the key were missing, so a filter, a sort or a tab falls back to its default
            // instead of refusing the page. A field that must have a value still refuses it.
            if e.unknown_word && values.len() == 1 {
                if let Some(read) = default.map(|default| default()).map(Ok).or_else(|| T::deserialize(Absent).ok().map(Ok)) {
                    return read;
                }
            }
            Err(FormError::new(format!("{key}: {e}")))
        }),
    }
}

/// A key read as missing in place of a word the app does not know: `None` for an `Option`, and
/// an error for anything else.
struct Absent;

impl<'de> Deserializer<'de> for Absent {
    type Error = FormError;

    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, FormError> {
        Err(FormError::new("absent"))
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_none()
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        unit unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
    }
}

/// A `#[route(prefix = "dim.")]` field's parameters: each whose key starts with `prefix`, the
/// prefix taken off, in order.
pub fn prefixed<'b>(pairs: &'b [Pair<'_>], prefix: &'b str) -> impl Iterator<Item = (&'b str, &'b str)> {
    let start = pairs.partition_point(|(k, _)| k.as_ref() < prefix);
    pairs[start..].iter().map_while(move |(k, v)| Some((k.strip_prefix(prefix)?, v.as_ref())))
}

/// One entry of a `#[route(prefix = "dim.")]` field, its key and its value each read as a form
/// field's value is. An entry whose key or value is a word the app does not have (a dimension
/// renamed since the address was written) is left out, as a missing key would be; any other
/// error names the parameter.
pub fn entry<K: de::DeserializeOwned, V: de::DeserializeOwned>(
    prefix: &str,
    key: &str,
    value: &str,
) -> Result<Option<(K, V)>, FormError> {
    match one(key).and_then(|k| Ok((k, one(value)?))) {
        Ok(pair) => Ok(Some(pair)),
        Err(e) if e.unknown_word => Ok(None),
        Err(e) => Err(FormError::new(format!("{prefix}{key}: {e}"))),
    }
}

/// One text read into `T` as a form field's value is.
pub fn one<T: de::DeserializeOwned>(text: &str) -> Result<T, FormError> {
    T::deserialize(Values(&[(Cow::Borrowed(""), Cow::Borrowed(text))]))
}

/// A path parameter's text read into `T` as axum's `Path` reads one, for a parameter followed by
/// text in its segment: as a field's value, except that a `bool` is `true` or `false` alone (a
/// checkbox's `on` is a form's word, not a path's), so a type reads the same wherever it is.
pub(crate) fn in_path<T: de::DeserializeOwned>(text: &str) -> Result<T, FormError> {
    T::deserialize(PathText(&[(Cow::Borrowed(""), Cow::Borrowed(text))]))
}

/// [`in_path`] for one of a route's parameters, read in a sequence of them.
pub(crate) fn path_value<'de, T: de::DeserializeSeed<'de>>(seed: T, text: &str) -> Result<T::Value, FormError> {
    seed.deserialize(PathText(&[(Cow::Borrowed(""), Cow::Borrowed(text))]))
}

/// A path parameter `value` that is not a `ty`: Cannot parse `x` to a `u32` for a primitive (axum's
/// `Path` said that for one value, and named the value's index in a route's tuple), and as serde
/// says it for the app's own type, whose path is never shown.
pub(crate) fn not_in_path(value: &str, ty: &str, error: FormError) -> FormError {
    FormError::in_path(if ty.contains("::") { format!("{error}") } else { format!("Cannot parse `{value}` to a `{ty}`") })
}

/// A key the query does not have: `None`, an empty list, or the error serde gives a missing field.
struct Missing<'b>(&'b str);

impl<'de> Deserializer<'de> for Missing<'_> {
    type Error = FormError;

    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, FormError> {
        Err(FormError::new(format!("missing field `{}`", self.0)))
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_none()
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_seq(List([].iter()))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        unit unit_struct newtype_struct tuple tuple_struct map struct enum identifier ignored_any
    }
}

/// The whole form: a map from each key to its values.
struct Form<'a, 'b>(&'b [Pair<'a>]);

impl<'de> Deserializer<'de> for Form<'_, '_> {
    type Error = FormError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_map(Groups::new(self.0, 0, None))
    }

    /// A struct's fields, and its groups and rows (`address.street`, `domains[key].max`).
    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        visitor.visit_map(Groups::new(self.0, 0, Some(fields)))
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_unit<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_unit()
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option
        unit_struct seq tuple tuple_struct map enum identifier ignored_any
    }
}

/// The form's keys (or a group's, each past `skip` bytes of its prefix), each with every value
/// sent for it. Reading a struct (`fields`), a key that is not one of its fields but starts with
/// one and `.` or `[` is that field's group or rows, with every key that shares the prefix.
struct Groups<'a, 'b> {
    rest: &'b [Pair<'a>],
    skip: usize,
    fields: Option<&'static [&'static str]>,
    values: &'b [Pair<'a>],
    /// The current key's group (`.`) or rows (`[`), and its prefix's length.
    nested: Option<(u8, usize)>,
    /// Every key of this map, sorted: a field sent as `x` is a value of its own, not a group, so
    /// `x.y` keys beside it (an image button's `x.x`) are left to serde, as on any form.
    all: &'b [Pair<'a>],
}

impl<'a, 'b> Groups<'a, 'b> {
    fn new(rest: &'b [Pair<'a>], skip: usize, fields: Option<&'static [&'static str]>) -> Self {
        Groups { rest, skip, fields, values: &[], nested: None, all: rest }
    }

    /// Whether the form sent `key` itself, as a value.
    fn sent(&self, key: &str) -> bool {
        self.all.binary_search_by(|(k, _)| k.as_ref().cmp(key)).is_ok()
    }
}

impl<'de> MapAccess<'de> for Groups<'_, '_> {
    type Error = FormError;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, FormError> {
        let Some((first, _)) = self.rest.first() else { return Ok(None) };
        let local = &first[self.skip..];
        let split = self.fields.and_then(|fields| {
            // Bytes, not chars: `.` and `[` are ASCII, and most keys have neither.
            let at = local.bytes().position(|b| b == b'.' || b == b'[')?;
            let head = &local[..at];
            let split = !fields.contains(&local) && fields.contains(&head);
            (split && !self.sent(&first[..self.skip + at])).then_some(at)
        });
        let (count, key) = match split {
            None => {
                self.nested = None;
                (self.rest.iter().take_while(|(k, _)| k == first).count(), local)
            }
            Some(at) => {
                let prefix = &first[..self.skip + at + 1];
                self.nested = Some((local.as_bytes()[at], prefix.len()));
                (self.rest.iter().take_while(|(k, _)| k.starts_with(prefix)).count(), &local[..at])
            }
        };
        let (values, rest) = self.rest.split_at(count);
        (self.values, self.rest) = (values, rest);
        let key: StrDeserializer<'_, FormError> = key.into_deserializer();
        seed.deserialize(key).map(Some)
    }

    #[inline]
    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, FormError> {
        let Some((sep, skip)) = self.nested else {
            let values = self.values;
            return seed.deserialize(Values(values)).map_err(|e| FormError::new(format!("{}: {e}", values[0].0)));
        };
        nested_value(self.values, sep, skip, seed)
    }

    fn size_hint(&self) -> Option<usize> {
        None
    }
}

/// A group's or rows' value, out of line so a plain field's read stays small enough to inline.
#[inline(never)]
fn nested_value<'de, V: DeserializeSeed<'de>>(pairs: &[Pair<'_>], sep: u8, skip: usize, seed: V) -> Result<V::Value, FormError> {
    let full = pairs.first().map_or("", |(k, _)| k.as_ref());
    seed.deserialize(Nested { pairs, skip, rows: sep == b'[', path: &full[..skip - 1] })
}

/// A group's fields (`address.street`, `rows` false) or rows' (`domains[key].max`): the keys
/// that start with `path` and its separator, `skip` bytes long.
struct Nested<'a, 'b> {
    pairs: &'b [Pair<'a>],
    skip: usize,
    rows: bool,
    path: &'b str,
}

impl Nested<'_, '_> {
    /// serde's own errors ("missing field", "unknown field") name the field alone: the group's
    /// path goes in front, unless a value's error already starts with its full key.
    fn at(&self, error: FormError) -> FormError {
        if error.message.starts_with(self.path) {
            error
        } else {
            FormError::new(format!("{}: {}", self.path, error.message))
        }
    }
}

impl<'de> Deserializer<'de> for Nested<'_, '_> {
    type Error = FormError;

    /// A value that is not a group or rows (`go: bool` with only an image button's `go.x` sent):
    /// keys under its name are read as a group's or rows', so it was not sent as itself.
    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, FormError> {
        Err(FormError::new(format!(
            "{0}: sent only as {0}. or {0}[ keys, which are a group's or rows', and not as {0} itself",
            self.path
        )))
    }

    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        let result = if self.rows {
            visitor.visit_map(Rows { rest: self.pairs, skip: self.skip, values: &[], row: 0 })
        } else {
            visitor.visit_map(Groups::new(self.pairs, self.skip, None))
        };
        result.map_err(|e| self.at(e))
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        if self.rows {
            return Err(FormError::new(format!("{}: rows are a map from each row's key to its fields", self.path)));
        }
        visitor.visit_map(Groups::new(self.pairs, self.skip, Some(fields))).map_err(|e| self.at(e))
    }

    /// A group or rows is never optional (`#[derive(Fields)]` refuses it), so an `Option` field
    /// whose own key was not sent is `None` (an image button's `go.x` beside `go: Option<_>`).
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_none()
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_unit()
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        unit unit_struct seq tuple tuple_struct enum identifier
    }
}

/// Rows' keys, each with the fields of its row: `domains[key].max` past `domains[`.
struct Rows<'a, 'b> {
    rest: &'b [Pair<'a>],
    skip: usize,
    values: &'b [Pair<'a>],
    /// The length of the current row's prefix, `domains[key].`.
    row: usize,
}

impl<'de> MapAccess<'de> for Rows<'_, '_> {
    type Error = FormError;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, FormError> {
        let Some((first, _)) = self.rest.first() else { return Ok(None) };
        let local = &first[self.skip..];
        // `rows[key].field` (a row's field), or `map[key]` alone (a map's value).
        let close = local
            .find(']')
            .filter(|close| matches!(local.as_bytes().get(close + 1), Some(b'.') | None))
            .ok_or_else(|| FormError::new(format!("{first}: a row's field is named rows[key].field, a map's value map[key]")))?;
        let value = close + 1 == local.len();
        self.row = self.skip + close + if value { 1 } else { 2 };
        let prefix = &first[..self.row];
        let count = if value {
            self.rest.iter().take_while(|(k, _)| k == first).count()
        } else {
            self.rest.iter().take_while(|(k, _)| k.starts_with(prefix)).count()
        };
        let (values, rest) = self.rest.split_at(count);
        (self.values, self.rest) = (values, rest);
        let key = decode_key(&local[..close])
            .ok_or_else(|| FormError::new(format!("{first}: the row's key is not written the way the form writes it")))?;
        let pair: Pair<'_> = (Cow::Borrowed(""), key);
        seed.deserialize(RowKeyText(std::slice::from_ref(&pair)))
            .map(Some)
            // The row's or the map value's whole name: `lines[x]`, not the `.` after a row's.
            .map_err(|e| FormError::new(format!("{}: key: {e}", &first[..self.skip + close + 1])))
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, FormError> {
        let full = self.values.first().map_or("", |(k, _)| k.as_ref());
        if self.row == full.len() {
            // A map's value: the key's own values.
            return seed.deserialize(Values(self.values)).map_err(|e| FormError::new(format!("{full}: {e}")));
        }
        seed.deserialize(Nested { pairs: self.values, skip: self.row, rows: false, path: &full[..self.row - 1] })
    }

    fn size_hint(&self) -> Option<usize> {
        None
    }
}

/// A row's key, read as its type (text, an integer, an enum's word). An integer is read only as
/// it writes itself (not `07`, `+7` or `-0`), so one integer key cannot reach a row two ways.
struct RowKeyText<'a, 'b>(&'b [Pair<'a>]);

macro_rules! strict_integers {
    ($($method:ident => $visit:ident: $t:ty,)*) => {$(
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
            let text = Values(self.0).one()?;
            match text.parse::<$t>() {
                Ok(value) if value.to_string() == text => visitor.$visit(value),
                _ => Err(de::Error::invalid_value(de::Unexpected::Str(text), &"an integer as the form writes it")),
            }
        }
    )*};
}

macro_rules! as_values {
    ($($method:ident,)*) => {$(
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
            Values(self.0).$method(visitor)
        }
    )*};
}

impl<'de> Deserializer<'de> for RowKeyText<'_, '_> {
    type Error = FormError;

    strict_integers! {
        deserialize_i8 => visit_i8: i8,
        deserialize_i16 => visit_i16: i16,
        deserialize_i32 => visit_i32: i32,
        deserialize_i64 => visit_i64: i64,
        deserialize_i128 => visit_i128: i128,
        deserialize_u8 => visit_u8: u8,
        deserialize_u16 => visit_u16: u16,
        deserialize_u32 => visit_u32: u32,
        deserialize_u64 => visit_u64: u64,
        deserialize_u128 => visit_u128: u128,
    }

    as_values! {
        deserialize_any, deserialize_bool, deserialize_f32, deserialize_f64, deserialize_char, deserialize_str,
        deserialize_string, deserialize_bytes, deserialize_byte_buf, deserialize_option, deserialize_unit,
        deserialize_seq, deserialize_map, deserialize_identifier, deserialize_ignored_any,
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(self, name: &'static str, visitor: V) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_unit_struct(name, visitor)
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, FormError> {
        // A newtype key (`struct Sku(u32)`) is read as the value it wraps, strictly too.
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_tuple(len, visitor)
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_tuple_struct(name, len, visitor)
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_struct(name, fields, visitor)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_enum(name, variants, visitor)
    }
}

/// Read with `str::parse`, as axum's `Path` reads a parameter.
macro_rules! parse {
    ($($method:ident => $visit:ident,)*) => {$(
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
            let text = Values(self.0).one()?;
            match text.parse() {
                Ok(value) => visitor.$visit(value),
                Err(_) => Err(de::Error::invalid_value(de::Unexpected::Str(text), &visitor)),
            }
        }
    )*};
}

/// [`in_path`]'s deserializer.
struct PathText<'a, 'b>(&'b [Pair<'a>]);

impl<'de> Deserializer<'de> for PathText<'_, '_> {
    type Error = FormError;

    fn deserialize_bool<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        match Values(self.0).one()? {
            "true" => visitor.visit_bool(true),
            "false" => visitor.visit_bool(false),
            other => Err(de::Error::invalid_value(de::Unexpected::Str(other), &"true or false")),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_newtype_struct(self)
    }

    // A number as `Path` reads one, not a number input's syntax: no form writes a path, so
    // `{page}.xml` and `{page}` refuse `3.0` alike.
    parse! {
        deserialize_i8 => visit_i8,
        deserialize_i16 => visit_i16,
        deserialize_i32 => visit_i32,
        deserialize_i64 => visit_i64,
        deserialize_i128 => visit_i128,
        deserialize_u8 => visit_u8,
        deserialize_u16 => visit_u16,
        deserialize_u32 => visit_u32,
        deserialize_u64 => visit_u64,
        deserialize_u128 => visit_u128,
        deserialize_f32 => visit_f32,
        deserialize_f64 => visit_f64,
    }

    as_values! {
        deserialize_any, deserialize_char, deserialize_str, deserialize_string, deserialize_bytes,
        deserialize_byte_buf, deserialize_option, deserialize_unit, deserialize_seq, deserialize_map,
        deserialize_identifier, deserialize_ignored_any,
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(self, name: &'static str, visitor: V) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_unit_struct(name, visitor)
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_tuple(len, visitor)
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_tuple_struct(name, len, visitor)
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_struct(name, fields, visitor)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        Values(self.0).deserialize_enum(name, variants, visitor)
    }
}

/// A row's key as `FieldName` writes it, its `%XX` decoded; `None` for a key written any other
/// way (`%61` for `a`, lowercase hex, a character the form encodes), so one key cannot be sent
/// two ways and land in one row.
fn decode_key(text: &str) -> Option<Cow<'_, str>> {
    let plain = |b: u8| b.is_ascii_alphanumeric() || b == b'-' || b == b'_';
    let hex = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    let bytes = text.as_bytes();
    if bytes.iter().all(|&b| plain(b)) {
        return Some(Cow::Borrowed(text));
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let byte = hex(*bytes.get(i + 1)?)? << 4 | hex(*bytes.get(i + 2)?)?;
            if plain(byte) {
                return None;
            }
            out.push(byte);
            i += 3;
        } else if plain(bytes[i]) {
            out.push(bytes[i]);
            i += 1;
        } else {
            return None;
        }
    }
    String::from_utf8(out).ok().map(Cow::Owned)
}

/// The values of one key: a list for a sequence, else exactly one.
struct Values<'a, 'b>(&'b [Pair<'a>]);

impl<'b> Values<'_, 'b> {
    fn one(&self) -> Result<&'b str, FormError> {
        match self.0 {
            [(_, value)] => Ok(value),
            [] => Err(FormError::new("no value")),
            _ => Err(FormError::new(format!("sent {} times; a field that takes several values is a Vec", self.0.len()))),
        }
    }
}

/// A number in HTML's syntax, as a number input sends it (`3.0` and `1e1` are whole numbers):
/// [`crate::form::read_number`].
macro_rules! number {
    ($($method:ident => $visit:ident: $t:ty,)*) => {$(
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
            let text = self.one()?;
            match crate::form::read_number::<$t>(text) {
                Some(value) => visitor.$visit(value),
                None => Err(de::Error::invalid_value(de::Unexpected::Str(text), &visitor)),
            }
        }
    )*};
}

impl<'de> Deserializer<'de> for Values<'_, '_> {
    type Error = FormError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        match self.0 {
            [(_, value)] => visitor.visit_str(value),
            values => visitor.visit_seq(List(values.iter())),
        }
    }

    fn deserialize_bool<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        match self.one()? {
            "true" | "on" => visitor.visit_bool(true),
            "false" => visitor.visit_bool(false),
            other => Err(de::Error::invalid_value(de::Unexpected::Str(other), &"true, on or false")),
        }
    }

    number! {
        deserialize_i8 => visit_i8: i8,
        deserialize_i16 => visit_i16: i16,
        deserialize_i32 => visit_i32: i32,
        deserialize_i64 => visit_i64: i64,
        deserialize_i128 => visit_i128: i128,
        deserialize_u8 => visit_u8: u8,
        deserialize_u16 => visit_u16: u16,
        deserialize_u32 => visit_u32: u32,
        deserialize_u64 => visit_u64: u64,
        deserialize_u128 => visit_u128: u128,
        deserialize_f32 => visit_f32: f32,
        deserialize_f64 => visit_f64: f64,
    }

    parse! {
        deserialize_char => visit_char,
    }

    fn deserialize_str<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_str(self.one()?)
    }

    fn deserialize_string<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_str(self.one()?)
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_str(self.one()?)
    }

    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_bytes(self.one()?.as_bytes())
    }

    fn deserialize_byte_buf<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_bytes(self.one()?.as_bytes())
    }

    /// A blank field is no value: `<input name="max">` left empty is `None`, not `Some("")`.
    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        match self.0 {
            [(_, value)] if value.is_empty() => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_unit<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_unit()
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_unit()
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _: &'static str, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_seq(List(self.0.iter()))
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, _: usize, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_seq(List(self.0.iter()))
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(self, _: &'static str, _: usize, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_seq(List(self.0.iter()))
    }

    fn deserialize_map<V: Visitor<'de>>(self, _: V) -> Result<V::Value, FormError> {
        Err(FormError::new("a form field is text, not a map; name each field in the form struct"))
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        _: &'static [&'static str],
        _: V,
    ) -> Result<V::Value, FormError> {
        Err(FormError::new("a form field is text, not a struct; name each field in the form struct"))
    }

    /// A unit variant, by its name: `<select name="sort">` into `enum Sort { Price, New }`.
    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _: &'static str,
        _: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, FormError> {
        let variant: StrDeserializer<'_, FormError> = self.one()?.into_deserializer();
        visitor.visit_enum(variant)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, FormError> {
        visitor.visit_unit()
    }
}

/// A key's values, one element each.
struct List<'a, 'b>(std::slice::Iter<'b, Pair<'a>>);

impl<'de> SeqAccess<'de> for List<'_, '_> {
    type Error = FormError;

    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, FormError> {
        match self.0.next() {
            // A list holding a word the app does not have is refused, not read as missing: the
            // word is one of several the address chose, not the whole parameter.
            Some(pair) => seed.deserialize(Values(std::slice::from_ref(pair))).map(Some).map_err(|e| FormError::new(e.message)),
            None => Ok(None),
        }
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.0.len())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum Sort {
        Price,
        New,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct Bulk {
        #[serde(default)]
        ids: Vec<String>,
        #[serde(default)]
        counts: Vec<u32>,
        #[serde(default)]
        notify: bool,
        max: Option<u32>,
        note: Option<String>,
        sort: Sort,
    }

    #[test]
    fn a_query_word_the_app_does_not_know_reads_as_missing() {
        let pairs = sorted_pairs("sort=due_now&page=2");
        assert_eq!(field::<Option<Sort>>(&pairs, "sort", None).unwrap(), None, "an Option: unset");
        assert_eq!(field::<Sort>(&pairs, "sort", Some(|| Sort::New)).unwrap(), Sort::New, "a default: the default");
        let required = field::<Sort>(&pairs, "sort", None).unwrap_err().to_string();
        assert!(required.starts_with("sort: unknown variant `due_now`, expected `price` or `new`"), "{required}");
        assert_eq!(field::<Option<Sort>>(&sorted_pairs("sort=new"), "sort", None).unwrap(), Some(Sort::New));
        // Only a word: a number that does not parse is still refused, and so is a list with one.
        assert!(field::<Option<u32>>(&sorted_pairs("page=two"), "page", None).is_err());
        assert!(field::<Vec<Sort>>(&sorted_pairs("sort=new&sort=old"), "sort", Some(Vec::new)).is_err());
        assert!(field::<Vec<Sort>>(&sorted_pairs("sort=old"), "sort", Some(Vec::new)).is_err(), "a list with only one");
        assert!(field::<Option<Vec<Sort>>>(&sorted_pairs("sort=old"), "sort", None).is_err());
        // A form's body is read as sent: an unknown word in a post is refused.
        #[derive(Debug, Deserialize)]
        struct Filter {
            #[allow(dead_code)]
            sort: Option<Sort>,
        }
        assert!(from_bytes::<Filter>(b"sort=due_now").is_err());
    }

    /// What the form decoder makes of `query`, sorted as [`sorted_pairs`] sorts.
    fn decoded(query: &str) -> Vec<Pair<'_>> {
        let mut pairs: Vec<Pair<'_>> = form_urlencoded::parse(query.as_bytes()).collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        pairs
    }

    fn pairs<'a>(list: &[(&'a str, &'a str)]) -> Vec<Pair<'a>> {
        list.iter().map(|&(key, value)| (Cow::Borrowed(key), Cow::Borrowed(value))).collect()
    }

    /// Whether each key and each value of `pairs` is borrowed from the query. `assert_eq!` compares
    /// a `Cow` by its text alone, so a read that copied what it could borrow would pass it.
    fn borrowed(pairs: &[Pair<'_>]) -> Vec<(bool, bool)> {
        pairs.iter().map(|(key, value)| (matches!(key, Cow::Borrowed(_)), matches!(value, Cow::Borrowed(_)))).collect()
    }

    /// What [`sorted_pairs`] reads from `query`, which must be what the form decoder reads: the
    /// same pairs, each key and value borrowed where the decoder's is and owned where it is.
    #[track_caller]
    fn read_as_decoded(query: &str) -> Vec<Pair<'_>> {
        let (read, decoded) = (sorted_pairs(query), decoded(query));
        assert_eq!(read, decoded, "{query}");
        assert_eq!(borrowed(&read), borrowed(&decoded), "borrowed or owned: {query}");
        read
    }

    #[test]
    fn a_query_reads_as_the_form_decoder_reads_it() {
        // Every key with every value, plain and escaped, among empty fields, a field with no `=`,
        // one with no key and the key again. So an escape is in a key alone, in a value alone, in
        // both and in neither, and what is not quite one (`%`, `%f`, `%zz`), bytes that are not
        // UTF-8 (`%ff`) and a `+` beside a character of several bytes are in each.
        let keys =
            ["", "a", "猫", "%61", "+", "%ff", "%", "=", ";", "a;b", "%f", "%zz", "猫+é", "a%2", "+%2B+", "é%C3%A9+", "%+"];
        let values =
            ["", "b", "é", "%26", "+", "=z", "%f0%9f", "c;d", "x=y=z", "%", "%f", "%zz", "%ff", "é+猫", "%3D+=%2B", "a%", "+%"];
        for key in keys {
            for value in values {
                let query = format!("&&{key}={value}&z&{key}&=v&{key}=last&&");
                read_as_decoded(&query);
                // And with the value as the key and the key as a value after a plain one.
                let query = format!("{value}&first=1&k={key}&last={value}");
                read_as_decoded(&query);
            }
        }
        let long = "k".repeat(70_000);
        let (long, long_keys) = (long.as_str(), format!("{long}=v&a=1&{long}&{long}=w"));
        let queries = [
            "",
            "&",
            "&&&",
            "=",
            "==",
            "&=&",
            "=&=&&==&",
            "a;b=c;d&e=f;g&;=;&h;",
            "a=b=c&d==e&f=g=&=h=i",
            "日本=語&ключ=значение&é=ü&🦀=🚀&猫",
            "b=2&a=1&b=1&a=2&b=3&a&b=",
            long_keys.as_str(),
        ];
        for query in queries {
            read_as_decoded(query);
        }
        // And as written here, so the decoder is not the only word on it. Nothing of a query with
        // no escape is copied, and of one with an escape only the key or the value that has it;
        // what is not quite an escape (`%zz`) is borrowed as written.
        assert_eq!(borrowed(&sorted_pairs("a=1&b=2")), [(true, true), (true, true)]);
        assert_eq!(
            borrowed(&sorted_pairs("q=first+edition&page=2&r=%zz&s%20=1&t")),
            [(true, true), (true, false), (true, true), (false, true), (true, true)],
            "`page`, `q`, `r`, `s ` and `t`"
        );
        assert_eq!(sorted_pairs(""), pairs(&[]));
        assert_eq!(sorted_pairs("&&&"), pairs(&[]), "empty fields are skipped");
        assert_eq!(sorted_pairs("=&=&&==&"), pairs(&[("", ""), ("", ""), ("", "=")]), "a field of `=` alone is one");
        assert_eq!(sorted_pairs("a;b=c;d&e=f;g&;=;&h;"), pairs(&[(";", ";"), ("a;b", "c;d"), ("e", "f;g"), ("h;", "")]));
        assert_eq!(sorted_pairs("a=b=c&d==e&f=g=&=h=i"), pairs(&[("", "h=i"), ("a", "b=c"), ("d", "=e"), ("f", "g=")]));
        assert_eq!(sorted_pairs("é=ü&猫&日本=語"), pairs(&[("é", "ü"), ("日本", "語"), ("猫", "")]));
        assert_eq!(
            sorted_pairs("b=2&a=1&b=1&a=2&b=3&a&b="),
            pairs(&[("a", "1"), ("a", "2"), ("a", ""), ("b", "2"), ("b", "1"), ("b", "3"), ("b", "")]),
            "the values of one key in the order sent"
        );
        assert_eq!(sorted_pairs(&long_keys), pairs(&[("a", "1"), (long, "v"), (long, ""), (long, "w")]));
    }

    #[test]
    fn an_escaped_query_is_decoded_wherever_the_escape_is() {
        let cases: [(&str, &[(&str, &str)]); 27] = [
            // In a key, in a value, and in a field after ones that have none.
            ("a%20b=1", &[("a b", "1")]),
            ("a+b=1", &[("a b", "1")]),
            ("a=1%202", &[("a", "1 2")]),
            ("a=1+2", &[("a", "1 2")]),
            ("a=1&b=2&c=x%26y", &[("a", "1"), ("b", "2"), ("c", "x&y")]),
            ("a=1&b=2&c=x+y", &[("a", "1"), ("b", "2"), ("c", "x y")]),
            ("a=1&b=2&c%3Dd=3", &[("a", "1"), ("b", "2"), ("c=d", "3")]),
            ("a=1&b=2&c+d", &[("a", "1"), ("b", "2"), ("c d", "")]),
            // In a key alone and in a value alone: the other is as written, whatever the first has.
            ("a+b=c%d", &[("a b", "c%d")]),
            ("a%20b=c%d", &[("a b", "c%d")]),
            ("a%b=c+d", &[("a%b", "c d")]),
            ("a%b=c%20d", &[("a%b", "c d")]),
            // In one field of several, its neighbours as written.
            ("a=1&b+c=2&d=3", &[("a", "1"), ("b c", "2"), ("d", "3")]),
            ("a=1&b=%32&c=3&d=4", &[("a", "1"), ("b", "2"), ("c", "3"), ("d", "4")]),
            ("q=first+edition&page=2", &[("page", "2"), ("q", "first edition")]),
            // Sorted by the key as decoded, not as written.
            ("b=1&%61=2", &[("a", "2"), ("b", "1")]),
            ("b=1&+=2&a=3", &[(" ", "2"), ("a", "3"), ("b", "1")]),
            // An escaped `+` is a `+` beside one that is a space, and an escaped separator is no
            // separator.
            ("a=1%2B2&b=%3D%26", &[("a", "1+2"), ("b", "=&")]),
            ("a=1%2B2+3&%2B+=4", &[("+ ", "4"), ("a", "1+2 3")]),
            ("%E7%8C%AB=%C3%A9", &[("猫", "é")]),
            // A `+` beside a character of several bytes, written out and escaped.
            ("猫+é=+ü+", &[("猫 é", " ü ")]),
            ("%E7%8C%AB+é=ü+%C3%A9", &[("猫 é", "ü é")]),
            // What is no escape stays as written, also beside one, and bytes that are not UTF-8 are
            // replaced, the start of a character that does not end by one mark.
            ("a=%&b=%zz&c=%4", &[("a", "%"), ("b", "%zz"), ("c", "%4")]),
            ("%=%f&%zz=%%&%f+=+%zz%41%", &[("%", "%f"), ("%f ", " %zzA%"), ("%zz", "%%")]),
            ("a=%ff", &[("a", "\u{fffd}")]),
            ("%ff+=x%ffy+%C3&b=%e7%8c", &[("b", "\u{fffd}"), ("\u{fffd} ", "x\u{fffd}y \u{fffd}")]),
            ("a=1&+", &[(" ", ""), ("a", "1")]),
        ];
        for (query, read) in cases {
            assert_eq!(read_as_decoded(query), pairs(read), "{query}");
        }
    }

    #[test]
    fn an_escape_at_any_place_in_a_query_is_decoded() {
        // Every kind of field. The walk that finds where a key or a value ends is the one that
        // sees its escape, so an escape could be missed by where it lies in one: first, last,
        // next to the `=` or the `&`, in a field with no `=`, at the query's end. A query of each
        // length up to this one's is read with the escape at each of its places.
        let whole = "alpha=one&beta=two&&gamma&=delta&epsilon=猫=é;x&".repeat(2);
        assert!(whole.len() > 96 && !whole.contains(['%', '+']));
        let places = |text: &str| (0..=text.len()).filter(|&at| text.is_char_boundary(at)).collect::<Vec<_>>();
        for plain in places(&whole).into_iter().map(|end| &whole[..end]) {
            for at in places(plain) {
                for escape in ["+", "%2B", "%41", "+%20"] {
                    let query = format!("{}{escape}{}", &plain[..at], &plain[at..]);
                    let read = read_as_decoded(&query);
                    // Not decoded, the escape would be in a key or a value as it was written.
                    assert!(read.iter().all(|(key, value)| !key.contains(escape) && !value.contains(escape)), "{query}");
                }
                // What is no escape is in the one it was written in, as written.
                for not_one in ["%", "%z", "%4"] {
                    let query = format!("{}{not_one}{}", &plain[..at], &plain[at..]);
                    let read = read_as_decoded(&query);
                    // Before a hex digit of the query's own, `%4` is an escape after all.
                    if !plain[at..].starts_with(|next: char| next.is_ascii_hexdigit()) || not_one == "%z" {
                        let written = read.iter().filter(|(key, value)| key.contains(not_one) || value.contains(not_one));
                        assert_eq!(written.count(), 1, "{query}");
                    }
                }
            }
        }
    }

    #[test]
    fn repeated_keys_are_a_list_in_the_order_sent() {
        let form: Bulk =
            from_bytes(b"ids=b&sort=price&ids=a&counts=2&ids=c%20d&counts=1&notify=on&max=5&note=hi+there").expect("reads");
        assert_eq!(form.ids, ["b", "a", "c d"]);
        assert_eq!(form.counts, [2, 1]);
        assert!(form.notify);
        assert_eq!(form.max, Some(5));
        assert_eq!(form.note.as_deref(), Some("hi there"));
        assert_eq!(form.sort, Sort::Price);
    }

    #[test]
    fn what_a_browser_leaves_out_or_leaves_blank() {
        // No box checked, the checkbox unchecked, the number field blank, the text field missing.
        let form: Bulk = from_bytes(b"max=&sort=new").expect("reads");
        assert_eq!(form, Bulk { ids: vec![], counts: vec![], notify: false, max: None, note: None, sort: Sort::New });
        let one: Bulk = from_bytes(b"ids=only&sort=new&notify=false").expect("reads");
        assert_eq!(one.ids, ["only"]);
        assert!(!one.notify);
        // A number input sends a whole number as typed: `3.0`, `1e1` (#842).
        let typed: Bulk = from_bytes(b"max=3.0&counts=1e1&counts=-0&sort=new").expect("reads");
        assert_eq!((typed.max, &typed.counts[..]), (Some(3), &[10, 0][..]));
        assert!(from_bytes::<Bulk>(b"max=3.5&sort=new").is_err(), "a fraction is no u32");
    }

    #[test]
    fn a_field_sent_only_under_its_name_is_refused_unless_it_is_an_option() {
        // An image button named `notify` sends `notify.x` and `notify.y`; a PHP-style list
        // sends `ids[0]`. Neither is the field, so a default would read what was not sent.
        let err = |body: &[u8]| from_bytes::<Bulk>(body).unwrap_err().to_string();
        assert!(
            err(b"sort=new&notify.x=3&notify.y=4").starts_with("notify: sent only as notify. or notify["),
            "{}",
            err(b"sort=new&notify.x=3")
        );
        assert!(err(b"sort=new&ids%5B0%5D=a").starts_with("ids: sent only as"), "{}", err(b"sort=new&ids%5B0%5D=a"));
        // An `Option` is `None`, and a key under a name the struct does not have is ignored.
        let form: Bulk = from_bytes(b"sort=new&max.x=1&page.x=2&page.y=3").expect("reads");
        assert_eq!(form.max, None);
        // The field sent as itself beside such keys reads as itself.
        let form: Bulk = from_bytes(b"sort=new&notify=on&notify.x=3").expect("reads");
        assert!(form.notify);
    }

    #[test]
    fn mistakes_name_the_field() {
        let err = |body: &[u8]| from_bytes::<Bulk>(body).unwrap_err().to_string();
        assert_eq!(err(b"sort=new&sort=price"), "sort: sent 2 times; a field that takes several values is a Vec");
        assert!(
            err(b"sort=new&counts=1&counts=x").starts_with("counts: invalid value: string \"x\""),
            "{}",
            err(b"sort=new&counts=x")
        );
        assert!(err(b"sort=old").starts_with("sort: unknown variant `old`"), "{}", err(b"sort=old"));
        assert!(err(b"sort=new&notify=yes").starts_with("notify: invalid value: string \"yes\""));
        assert_eq!(err(b"ids=a"), "missing field `sort`");
    }

    #[test]
    fn maps_and_unknown_keys() {
        let map: BTreeMap<String, String> = from_bytes(b"b=2&a=1").expect("reads");
        assert_eq!(map, BTreeMap::from([("a".into(), "1".into()), ("b".into(), "2".into())]));
        let lists: BTreeMap<String, Vec<String>> = from_bytes(b"a=1&a=2").expect("reads");
        assert_eq!(lists["a"], ["1", "2"]);
        // A key the struct does not name is ignored, as serde does by default.
        let form: Bulk = from_bytes(b"sort=new&utm_source=x&utm_source=y").expect("reads");
        assert_eq!(form.sort, Sort::New);
        let (): () = from_bytes(b"").expect("an empty form is unit");
        // A map's value whose key does not read names the whole key, brackets and all.
        #[derive(Debug, Deserialize)]
        struct Counts {
            #[allow(dead_code)]
            counts: BTreeMap<u32, u32>,
        }
        let why = from_bytes::<Counts>(b"counts%5Bx%5D=1").unwrap_err().to_string();
        assert!(why.starts_with("counts[x]: key: "), "{why}");
    }

    /// What reading a form costs, for callgrind: `FORM_READS` (200) reads of a seven-field post
    /// with a renamed field, an `Option`, a list and a default. Counted at two numbers of reads,
    /// the difference over 1,000 is the cost of 1,000.
    #[test]
    #[ignore]
    fn what_reading_a_form_costs() {
        #[derive(Debug, crate::Fields)]
        #[allow(dead_code)]
        #[serde(rename_all = "camelCase")]
        struct Sell {
            item_id: String,
            #[serde(rename = "qty")]
            count: u32,
            price_cents: u64,
            note: Option<String>,
            #[serde(default)]
            tags: Vec<String>,
            #[serde(default)]
            gift: bool,
            condition: String,
        }
        let reads: usize = std::env::var("FORM_READS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let body = b"itemId=item_42&qty=3&priceCents=1299&note=&tags=foil&tags=first+edition&gift=on&condition=near-mint";
        for _ in 0..reads {
            let read: Sell = from_bytes(std::hint::black_box(body)).unwrap();
            std::hint::black_box(read);
        }
    }

    /// What reading a route's query into its sorted pairs costs, for callgrind, counted as
    /// [`what_reading_a_form_costs`] is: `QUERY_READS` (200) reads of `QUERY`, which is `a=1&b=2`
    /// unless set. A key or a value with a `+` or a `%` in it (`q=a+b&page=2`) is decoded, which no
    /// case of `bench/request-cost` sends, so this is where that is counted.
    #[test]
    #[ignore]
    fn what_reading_a_query_costs() {
        let reads: usize = std::env::var("QUERY_READS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let query = std::env::var("QUERY").unwrap_or_else(|_| "a=1&b=2".into());
        for _ in 0..reads {
            std::hint::black_box(sorted_pairs(std::hint::black_box(&query)));
        }
    }
}
