//! Reading JSON into a [`FromJson`] type: a reader for the common case, and serde_json for the rest.
//!
//! The reader takes keys without escapes, the fields a type declares, and skips the others; on
//! anything else (an escaped key, a duplicate or missing field, a struct sent as an array, nesting
//! deeper than 100, a number it does not parse itself) it gives up, and [`from_str`] runs serde_json
//! on the same text. So the value, and every error, is serde_json's. A value it skips is
//! validated as serde_json validates one, so it never accepts text serde_json rejects.
//!
//! An escaped key is left to serde_json on purpose: decoding it here made reading the item API's
//! compact responses 2.4% dearer (callgrind, `read_cost` in `examples/card-market`) for keys a
//! program seldom escapes.

use std::{
    collections::{BTreeMap, HashMap},
    hash::BuildHasher,
};

use serde::de::DeserializeOwned;
use serde_json::{Number, Value};

/// A type read from JSON by the reader, with serde_json as the fallback: what
/// `#[derive(FromJson)]` implements, with the type's serde `Deserialize`. Read one with
/// [`from_str`] or [`from_slice`].
///
/// A type whose `Deserialize` is written by hand, or derived by serde for an attribute
/// `#[derive(FromJson)]` does not follow, says so with an empty impl, and serde_json reads it
/// through that `Deserialize`: the whole text, or the value's own text inside a derived type.
///
/// ```
/// #[derive(serde::Deserialize, Debug, PartialEq)]
/// struct Page {
///     id: u32,
///     #[serde(flatten)]
///     extra: std::collections::BTreeMap<String, u32>,
/// }
/// impl corten::FromJson for Page {}
///
/// let page: Page = corten::json::from_str(r#"{"id":1,"views":9}"#).unwrap();
/// assert_eq!(page.extra["views"], 9);
/// ```
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not read from JSON: it is not a `FromJson`",
    note = "derive FromJson on it; a #[derive(Fields)] or #[derive(UrlValue)] type is one already (a generic one where its Deserialize applies) (deriving FromJson beside them is E0119); a type whose Deserialize is written by hand, or by serde for an attribute FromJson refuses, takes `impl corten::FromJson for T {{}}`; a type whose Deserialize borrows from the input cannot be one"
)]
pub trait FromJson: DeserializeOwned {
    /// Reads the value at the reader's position. Not a public API.
    #[doc(hidden)]
    #[inline]
    fn __read(r: &mut Reader<'_>) -> Result<Self, Fallback> {
        // Alone (or in an `Option` or `Box`), the whole text is this value: give up, and
        // serde_json reads it once. Inside an array or object, serde_json reads its own text.
        if r.depth == 0 {
            return Err(Fallback);
        }
        serde_json::from_str(r.span()?).map_err(|_| Fallback)
    }
}

/// `s` as a `T`: the same value, or the same error, as `serde_json::from_str`.
pub fn from_str<T: FromJson>(s: &str) -> serde_json::Result<T> {
    match fast(s) {
        Some(value) => Ok(value),
        None => serde_json::from_str(s),
    }
}

/// `bytes` as a `T`: the same value, or the same error, as `serde_json::from_slice`.
pub fn from_slice<T: FromJson>(bytes: &[u8]) -> serde_json::Result<T> {
    match std::str::from_utf8(bytes) {
        Ok(s) => from_str(s),
        Err(_) => serde_json::from_slice(bytes),
    }
}

/// The reader alone: `None` where it gives up.
pub(crate) fn fast<T: FromJson>(s: &str) -> Option<T> {
    let mut r = Reader::new(s);
    let value = T::__read(&mut r).ok()?;
    r.end().ok()?;
    Some(value)
}

/// The reader gave up; serde_json reads the text instead. Not a public API.
#[doc(hidden)]
#[derive(Debug)]
pub struct Fallback;

type R<T> = Result<T, Fallback>;

const ONES: u64 = u64::from_ne_bytes([1; 8]);
const HIGH: u64 = ONES << 7;

/// Marks (high bit) the bytes of `x` that end a plain run of string bytes: a control
/// character, `"` or `\`. A borrow can only mark bytes above a real one, so the lowest mark is
/// exact.
#[inline(always)]
fn stops(x: u64) -> u64 {
    let below = |x: u64, n: u8| x.wrapping_sub(ONES * n as u64) & !x;
    (below(x, 0x20) | below(x ^ (ONES * b'"' as u64), 1) | below(x ^ (ONES * b'\\' as u64), 1)) & HIGH
}

/// The first byte at or after `i` that ends a plain run of string bytes (a control character,
/// `"` or `\`), or the end of `b`. Sixteen bytes a step while they last, so the two words'
/// tests overlap, then eight, then one.
#[inline(always)]
fn plain_end(b: &[u8], mut i: usize) -> usize {
    while let Some(chunk) = b.get(i..i + 16) {
        let lo = stops(u64::from_le_bytes(chunk[..8].try_into().expect("eight bytes")));
        let hi = stops(u64::from_le_bytes(chunk[8..].try_into().expect("eight bytes")));
        if lo | hi != 0 {
            return i + if lo != 0 { (lo.trailing_zeros() / 8) as usize } else { 8 + (hi.trailing_zeros() / 8) as usize };
        }
        i += 16;
    }
    if let Some(chunk) = b.get(i..i + 8) {
        let hit = stops(u64::from_le_bytes(chunk.try_into().expect("eight bytes")));
        if hit != 0 {
            return i + (hit.trailing_zeros() / 8) as usize;
        }
        i += 8;
    }
    while i < b.len() && !matches!(b[i], 0..0x20 | b'"' | b'\\') {
        i += 1;
    }
    i
}

/// Past `c` at `i`, or after the whitespace there: the byte is tested first, since JSON written by
/// a program mostly has no whitespace.
#[inline(always)]
fn past(b: &[u8], i: usize, c: u8) -> R<usize> {
    if b.get(i) == Some(&c) {
        return Ok(i + 1);
    }
    let i = ws(b, i);
    if b.get(i) == Some(&c) {
        Ok(i + 1)
    } else {
        Err(Fallback)
    }
}

/// Past the whitespace at `i`. JSON written by a program mostly has none, so the first test
/// is the one that ends the loop.
#[inline(always)]
fn ws(b: &[u8], mut i: usize) -> usize {
    while let Some(&c) = b.get(i) {
        if c > b' ' || !matches!(c, b' ' | b'\n' | b'\r' | b'\t') {
            break;
        }
        i += 1;
    }
    i
}

/// Past the string whose opening quote is before `i`, validated as serde_json validates a
/// string it ignores: it checks an escape's form (and a `\u`'s hex digits), not what it means.
#[inline(always)]
fn string_end(b: &[u8], mut i: usize) -> R<usize> {
    loop {
        i = plain_end(b, i);
        match b.get(i) {
            Some(b'"') => return Ok(i + 1),
            Some(b'\\') => match b.get(i + 1) {
                Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => i += 2,
                Some(b'u') if b.get(i + 2..i + 6).is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit)) => i += 6,
                _ => return Err(Fallback),
            },
            Some(0..0x20) | None => return Err(Fallback),
            Some(_) => i += 1,
        }
    }
}

/// The end of the number at `i`, its grammar checked.
#[inline(always)]
fn number_end(b: &[u8], mut i: usize) -> R<usize> {
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    if b.get(i) == Some(&b'-') {
        i += 1;
    }
    match b.get(i) {
        Some(b'0') => {
            i += 1;
            if digit(i) {
                return Err(Fallback);
            }
        }
        Some(b'1'..=b'9') => {
            i += 1;
            while digit(i) {
                i += 1;
            }
        }
        _ => return Err(Fallback),
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        if !digit(i) {
            return Err(Fallback);
        }
        while digit(i) {
            i += 1;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digit(i) {
            return Err(Fallback);
        }
        while digit(i) {
            i += 1;
        }
    }
    Ok(i)
}

/// Nesting the reader follows before it gives up (serde_json's limit is 128).
const MAX_DEPTH: u32 = 100;

/// A position in the text being read. Not a public API.
#[doc(hidden)]
pub struct Reader<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
    depth: u32,
}

impl<'a> Reader<'a> {
    fn new(s: &'a str) -> Self {
        Reader { s, b: s.as_bytes(), i: 0, depth: 0 }
    }

    #[inline(always)]
    fn peek(&self) -> u8 {
        self.b.get(self.i).copied().unwrap_or(0)
    }

    #[inline(always)]
    fn ws(&mut self) {
        self.i = ws(self.b, self.i);
    }

    #[inline(always)]
    fn eat(&mut self, c: u8) -> R<()> {
        self.i = past(self.b, self.i, c)?;
        Ok(())
    }

    fn end(&mut self) -> R<()> {
        self.ws();
        if self.i == self.b.len() {
            Ok(())
        } else {
            Err(Fallback)
        }
    }

    #[inline(always)]
    fn open(&mut self, open: u8, close: u8) -> R<bool> {
        self.eat(open)?;
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(Fallback);
        }
        self.ws();
        if self.peek() == close {
            self.i += 1;
            self.depth -= 1;
            return Ok(false);
        }
        Ok(true)
    }

    #[inline(always)]
    fn next(&mut self, close: u8) -> R<bool> {
        self.ws();
        match self.peek() {
            b',' => {
                self.i += 1;
                Ok(true)
            }
            c if c == close => {
                self.i += 1;
                self.depth -= 1;
                Ok(false)
            }
            _ => Err(Fallback),
        }
    }

    /// `{`: false when the object is empty (and closed).
    #[inline]
    pub fn object(&mut self) -> R<bool> {
        self.open(b'{', b'}')
    }

    /// After a member: true at `,` (another follows), false at `}`.
    #[inline]
    pub fn more(&mut self) -> R<bool> {
        self.next(b'}')
    }

    /// `[`: false when the array is empty (and closed).
    #[inline]
    pub fn array(&mut self) -> R<bool> {
        self.open(b'[', b']')
    }

    /// After an item: true at `,`, false at `]`.
    #[inline]
    pub fn more_items(&mut self) -> R<bool> {
        self.next(b']')
    }

    /// A key and its colon, as written. An escaped key gives up (serde_json decodes it first).
    #[inline(always)]
    pub fn key(&mut self) -> R<&'a [u8]> {
        self.eat(b'"')?;
        let start = self.i;
        let end = self.plain_run();
        if self.peek() != b'"' {
            return Err(Fallback);
        }
        self.i += 1;
        self.eat(b':')?;
        Ok(&self.b[start..end])
    }

    /// A string without escapes, as written: an enum's variant name. An escaped one gives up.
    #[inline]
    pub fn name(&mut self) -> R<&'a [u8]> {
        self.eat(b'"')?;
        let start = self.i;
        let end = self.plain_run();
        if self.peek() != b'"' {
            return Err(Fallback);
        }
        self.i += 1;
        Ok(&self.b[start..end])
    }

    /// Moves past the bytes of a string that need no attention; returns where it stopped.
    #[inline(always)]
    fn plain_run(&mut self) -> usize {
        self.i = plain_end(self.b, self.i);
        self.i
    }

    fn hex4(&mut self) -> R<u16> {
        let digits = self.b.get(self.i..self.i + 4).ok_or(Fallback)?;
        let mut n = 0u16;
        for &d in digits {
            let v = match d {
                b'0'..=b'9' => d - b'0',
                b'a'..=b'f' => d - b'a' + 10,
                b'A'..=b'F' => d - b'A' + 10,
                _ => return Err(Fallback),
            };
            n = n << 4 | v as u16;
        }
        self.i += 4;
        Ok(n)
    }

    /// A string after its opening quote, decoded into `out`. A lone surrogate gives up.
    fn string_body(&mut self, out: &mut String) -> R<()> {
        loop {
            let start = self.i;
            let end = self.plain_run();
            out.push_str(&self.s[start..end]);
            match self.peek() {
                b'"' => {
                    self.i += 1;
                    return Ok(());
                }
                b'\\' => {
                    self.i += 1;
                    let c = self.peek();
                    self.i += 1;
                    out.push(match c {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => match self.hex4()? {
                            hi @ 0xD800..=0xDBFF => {
                                if self.b.get(self.i..self.i + 2) != Some(b"\\u") {
                                    return Err(Fallback);
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return Err(Fallback);
                                }
                                char::from_u32(0x10000 + ((hi as u32 - 0xD800) << 10) + (lo as u32 - 0xDC00)).ok_or(Fallback)?
                            }
                            0xDC00..=0xDFFF => return Err(Fallback),
                            c => char::from_u32(c as u32).ok_or(Fallback)?,
                        },
                        _ => return Err(Fallback),
                    });
                }
                _ => return Err(Fallback), // a control character, or the end of the text
            }
        }
    }

    #[inline]
    fn string(&mut self) -> R<String> {
        self.eat(b'"')?;
        let start = self.i;
        let end = self.plain_run();
        if self.peek() == b'"' {
            self.i += 1;
            return Ok(self.s[start..end].to_owned());
        }
        let mut out = String::with_capacity(end - start + 16);
        self.i = start;
        self.string_body(&mut out)?;
        Ok(out)
    }

    /// A number at the position (whitespace already skipped), its grammar checked; returns its
    /// text.
    #[inline]
    fn number(&mut self) -> R<&'a str> {
        let start = self.i;
        let end = number_end(self.b, start)?;
        self.i = end;
        Ok(&self.s[start..end])
    }

    /// An integer literal, the way serde_json reads one into an integer type: `-0` is a float to
    /// it, and so is anything with a fraction or exponent; those give up.
    #[inline]
    fn integer<T: std::str::FromStr>(&mut self) -> R<T> {
        self.ws();
        let text = self.number()?;
        if text == "-0" || text.bytes().any(|b| matches!(b, b'.' | b'e' | b'E')) {
            return Err(Fallback);
        }
        text.parse().map_err(|_| Fallback)
    }

    fn word(&mut self, w: &[u8]) -> R<()> {
        if self.b[self.i..].starts_with(w) {
            self.i += w.len();
            Ok(())
        } else {
            Err(Fallback)
        }
    }

    /// `null` is next: taken, true.
    #[inline]
    pub fn null(&mut self) -> bool {
        self.ws();
        self.word(b"null").is_ok()
    }

    /// Skips any value, validating it as serde_json does when it ignores one. Most skipped values
    /// are scalars, read here; an array or an object goes to [`Reader::skip_nested`].
    #[inline(always)]
    pub fn skip(&mut self) -> R<()> {
        let b = self.b;
        let i = ws(b, self.i);
        self.i = match b.get(i) {
            Some(b'"') => string_end(b, i + 1)?,
            Some(b'{' | b'[') => {
                self.i = i;
                return self.skip_nested();
            }
            Some(b't') if b.get(i..i + 4) == Some(b"true") => i + 4,
            Some(b'f') if b.get(i..i + 5) == Some(b"false") => i + 5,
            Some(b'n') if b.get(i..i + 4) == Some(b"null") => i + 4,
            _ => number_end(b, i)?,
        };
        Ok(())
    }

    /// Skips an array or an object: one loop over the text with the open containers as bits
    /// (1 = object), no recursion and nothing decoded.
    #[inline(never)]
    fn skip_nested(&mut self) -> R<()> {
        let b = self.b;
        let mut i = self.i;
        let mut stack: u128 = 0;
        let start_depth = self.depth;
        let mut depth = start_depth;
        macro_rules! ws {
            () => {
                i = ws(b, i);
            };
        }
        // After a string's opening quote.
        macro_rules! string {
            () => {
                i = string_end(b, i)?;
            };
        }
        macro_rules! key {
            () => {
                i = past(b, i, b'"')?;
                string!();
                i = past(b, i, b':')?;
            };
        }
        'value: loop {
            ws!();
            match b.get(i) {
                Some(b'"') => {
                    i += 1;
                    string!();
                }
                Some(&open @ (b'{' | b'[')) => {
                    i += 1;
                    depth += 1;
                    if depth > MAX_DEPTH {
                        return Err(Fallback);
                    }
                    let object = open == b'{';
                    stack = stack << 1 | object as u128;
                    ws!();
                    if b.get(i) == Some(if object { &b'}' } else { &b']' }) {
                        i += 1;
                        depth -= 1;
                        stack >>= 1;
                    } else {
                        if object {
                            key!();
                        }
                        continue 'value;
                    }
                }
                Some(b't') if b.get(i..i + 4) == Some(b"true") => i += 4,
                Some(b'f') if b.get(i..i + 5) == Some(b"false") => i += 5,
                Some(b'n') if b.get(i..i + 4) == Some(b"null") => i += 4,
                _ => i = number_end(b, i)?,
            }
            // After a value: close containers, or go on to the next member or item.
            loop {
                if depth == start_depth {
                    self.i = i;
                    return Ok(());
                }
                ws!();
                let object = stack & 1 == 1;
                match b.get(i) {
                    Some(b',') => {
                        i += 1;
                        if object {
                            key!();
                        }
                        continue 'value;
                    }
                    Some(b'}') if object => {}
                    Some(b']') if !object => {}
                    _ => return Err(Fallback),
                }
                i += 1;
                depth -= 1;
                stack >>= 1;
            }
        }
    }

    /// The next value's text, validated: for serde_json to read one field.
    #[inline]
    fn span(&mut self) -> R<&'a str> {
        self.ws();
        let start = self.i;
        self.skip()?;
        Ok(&self.s[start..self.i])
    }
}

impl FromJson for String {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        r.string()
    }
}

impl FromJson for crate::i18n::Day {
    /// `"2026-09-02"`; anything else falls back to serde_json for its error.
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        r.string()?.parse().map_err(|_| Fallback)
    }
}

impl FromJson for bool {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        r.ws();
        match r.peek() {
            b't' => r.word(b"true").map(|()| true),
            b'f' => r.word(b"false").map(|()| false),
            _ => Err(Fallback),
        }
    }
}

impl FromJson for char {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        let s = r.string()?;
        let mut chars = s.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) => Ok(c),
            _ => Err(Fallback),
        }
    }
}

impl FromJson for () {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        if r.null() {
            Ok(())
        } else {
            Err(Fallback)
        }
    }
}

macro_rules! integers {
    ($($t:ty),*) => {$(
        impl FromJson for $t {
            #[inline]
            fn __read(r: &mut Reader<'_>) -> R<Self> {
                r.integer()
            }
        }
    )*};
}
integers!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

impl FromJson for f64 {
    /// A plain integer becomes the float serde_json makes of it (`n as f64`); any other number is
    /// parsed by serde_json, whose float parsing rounds its own way.
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        r.ws();
        let text = r.number()?;
        if text.len() <= 19 && text.bytes().all(|b| b.is_ascii_digit()) {
            return text.parse::<u64>().map(|n| n as f64).map_err(|_| Fallback);
        }
        serde_json::from_str(text).map_err(|_| Fallback)
    }
}

impl FromJson for f32 {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        r.ws();
        let text = r.number()?;
        serde_json::from_str(text).map_err(|_| Fallback)
    }
}

impl<T: FromJson> FromJson for Option<T> {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        if r.null() {
            Ok(None)
        } else {
            T::__read(r).map(Some)
        }
    }
}

impl<T: FromJson> FromJson for Box<T> {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        T::__read(r).map(Box::new)
    }
}

/// Text, read as a `String` is and moved into place.
impl FromJson for Box<str> {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        String::__read(r).map(Box::from)
    }
}

/// A path, read as a `PathBuf` is and moved into place.
impl FromJson for Box<std::path::Path> {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        std::path::PathBuf::__read(r).map(std::path::PathBuf::into_boxed_path)
    }
}

/// A list, read as a `Vec` is and moved into place.
impl<T: FromJson> FromJson for Box<[T]> {
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        Vec::<T>::__read(r).map(Box::from)
    }
}

/// Read as its item, as serde's `rc` feature reads it (an app turns that feature on to read one),
/// for an item that is a `FromJson`, `str`, `Path`, `[T]` of a `FromJson`, or (feature `types`)
/// `RawValue`.
impl<T: __private::Shared + ?Sized> FromJson for std::sync::Arc<T>
where
    std::sync::Arc<T>: DeserializeOwned,
{
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        T::__read_arc(r)
    }
}

/// Read as its item, as serde's `rc` feature reads it (an app turns that feature on to read one),
/// for an item that is a `FromJson`, `str`, `Path`, `[T]` of a `FromJson`, or (feature `types`)
/// `RawValue`.
impl<T: __private::Shared + ?Sized> FromJson for std::rc::Rc<T>
where
    std::rc::Rc<T>: DeserializeOwned,
{
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        T::__read_rc(r)
    }
}

/// Read as its owned form, as serde reads a `Cow`.
impl<T: ToOwned + ?Sized> FromJson for std::borrow::Cow<'_, T>
where
    T::Owned: FromJson,
{
    #[inline]
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        T::Owned::__read(r).map(std::borrow::Cow::Owned)
    }
}

impl<T: FromJson> FromJson for Vec<T> {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        let mut out = Vec::new();
        if r.array()? {
            loop {
                out.push(T::__read(r)?);
                if !r.more_items()? {
                    break;
                }
            }
        }
        Ok(out)
    }
}

/// An object's members into a map; a key written twice keeps its last value, as serde's maps do.
fn map<V: FromJson>(r: &mut Reader<'_>, mut insert: impl FnMut(String, V)) -> R<()> {
    if r.object()? {
        loop {
            let key = r.string()?;
            r.eat(b':')?;
            insert(key, V::__read(r)?);
            if !r.more()? {
                break;
            }
        }
    }
    Ok(())
}

impl<V: FromJson> FromJson for BTreeMap<String, V> {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        let mut out = BTreeMap::new();
        map(r, |k, v| {
            out.insert(k, v);
        })?;
        Ok(out)
    }
}

impl<V: FromJson, S: BuildHasher + Default> FromJson for HashMap<String, V, S> {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        let mut out = HashMap::with_hasher(S::default());
        map(r, |k, v| {
            out.insert(k, v);
        })?;
        Ok(out)
    }
}

/// An object read whole, as `Value`'s object: a map whose values are any JSON.
impl FromJson for serde_json::Map<String, Value> {
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        let mut out = serde_json::Map::new();
        map(r, |k, v| {
            out.insert(k, v);
        })?;
        Ok(out)
    }
}

macro_rules! by_serde {
    ($($t:ty),*) => {$(
        /// Read by serde_json, as its `Deserialize` reads it.
        impl FromJson for $t {}
    )*};
}
by_serde!(
    std::path::PathBuf,
    std::net::IpAddr,
    std::net::Ipv4Addr,
    std::net::Ipv6Addr,
    std::net::SocketAddr,
    std::net::SocketAddrV4,
    std::net::SocketAddrV6,
    std::time::Duration,
    std::time::SystemTime,
    std::num::NonZeroU8,
    std::num::NonZeroU16,
    std::num::NonZeroU32,
    std::num::NonZeroU64,
    std::num::NonZeroU128,
    std::num::NonZeroUsize,
    std::num::NonZeroI8,
    std::num::NonZeroI16,
    std::num::NonZeroI32,
    std::num::NonZeroI64,
    std::num::NonZeroI128,
    std::num::NonZeroIsize,
    serde_json::Number
);

/// Read as `null`, as serde reads it.
impl<T: ?Sized> FromJson for std::marker::PhantomData<T> {}

/// Read by serde_json, as serde reads a 128-bit integer.
impl FromJson for u128 {}

/// Read by serde_json, as serde reads a 128-bit integer.
impl FromJson for i128 {}

/// Read by serde_json, as serde reads a set.
impl<T: FromJson> FromJson for std::collections::BTreeSet<T> where Self: DeserializeOwned {}

/// Read by serde_json, as serde reads a set.
impl<T: FromJson, S> FromJson for std::collections::HashSet<T, S> where Self: DeserializeOwned {}

/// Read by serde_json, as serde reads a list.
impl<T: FromJson> FromJson for std::collections::VecDeque<T> where Self: DeserializeOwned {}

/// Read by serde_json, as serde reads an array of exactly `N` items.
impl<T: FromJson, const N: usize> FromJson for [T; N] where Self: DeserializeOwned {}

macro_rules! tuples {
    ($(($($n:ident),*)),*) => {$(
        /// Read by serde_json, as serde reads a tuple: an array of exactly its items.
        impl<$($n: FromJson),*> FromJson for ($($n,)*) {}
    )*};
}
tuples!((A), (A, B), (A, B, C), (A, B, C, D), (A, B, C, D, E), (A, B, C, D, E, F));

/// The value's JSON text, kept as it is.
#[cfg(feature = "types")]
impl FromJson for Box<serde_json::value::RawValue> {}

impl FromJson for Value {
    /// Scalars are made here; an array or an object (rarer in a field typed `Value`) by serde_json.
    fn __read(r: &mut Reader<'_>) -> R<Self> {
        r.ws();
        Ok(match r.peek() {
            b'"' => Value::String(r.string()?),
            b'n' => {
                r.word(b"null")?;
                Value::Null
            }
            b't' => {
                r.word(b"true")?;
                Value::Bool(true)
            }
            b'f' => {
                r.word(b"false")?;
                Value::Bool(false)
            }
            b'[' | b'{' => serde_json::from_str(r.span()?).map_err(|_| Fallback)?,
            _ => {
                let text = r.number()?;
                // Plain digits that fit are serde_json's unsigned integer; any other number goes
                // through serde_json's own parser, so the Number is the one it would make.
                Value::Number(if text.len() <= 19 && text.bytes().all(|b| b.is_ascii_digit()) {
                    text.parse::<u64>().map(Number::from).map_err(|_| Fallback)?
                } else {
                    text.parse::<Number>().map_err(|_| Fallback)?
                })
            }
        })
    }
}

/// Used by the code `#[derive(FromJson)]` generates. Not a public API.
#[doc(hidden)]
pub mod __private {
    use std::marker::PhantomData;

    use serde::de::DeserializeOwned;

    use serde::de::{Deserializer, Visitor};

    pub use super::{Fallback, Reader};
    use super::{FromJson, R};

    /// What an `Arc` or `Rc` of it is read through: a `FromJson`, text, a path, a list or (feature
    /// `types`) a `RawValue`. Not a public API.
    pub trait Shared {
        fn __read_arc(r: &mut Reader<'_>) -> R<std::sync::Arc<Self>>;
        fn __read_rc(r: &mut Reader<'_>) -> R<std::rc::Rc<Self>>;
    }

    impl<T: FromJson> Shared for T {
        #[inline]
        fn __read_arc(r: &mut Reader<'_>) -> R<std::sync::Arc<Self>> {
            T::__read(r).map(std::sync::Arc::new)
        }

        #[inline]
        fn __read_rc(r: &mut Reader<'_>) -> R<std::rc::Rc<Self>> {
            T::__read(r).map(std::rc::Rc::new)
        }
    }

    impl Shared for str {
        #[inline]
        fn __read_arc(r: &mut Reader<'_>) -> R<std::sync::Arc<Self>> {
            String::__read(r).map(std::sync::Arc::from)
        }

        #[inline]
        fn __read_rc(r: &mut Reader<'_>) -> R<std::rc::Rc<Self>> {
            String::__read(r).map(std::rc::Rc::from)
        }
    }

    impl Shared for std::path::Path {
        #[inline]
        fn __read_arc(r: &mut Reader<'_>) -> R<std::sync::Arc<Self>> {
            std::path::PathBuf::__read(r).map(std::sync::Arc::from)
        }

        #[inline]
        fn __read_rc(r: &mut Reader<'_>) -> R<std::rc::Rc<Self>> {
            std::path::PathBuf::__read(r).map(std::rc::Rc::from)
        }
    }

    /// Read as a `Box<RawValue>` and moved behind the pointer, as serde's `rc` reads one.
    #[cfg(feature = "types")]
    impl Shared for serde_json::value::RawValue {
        #[inline]
        fn __read_arc(r: &mut Reader<'_>) -> R<std::sync::Arc<Self>> {
            Box::<serde_json::value::RawValue>::__read(r).map(std::sync::Arc::from)
        }

        #[inline]
        fn __read_rc(r: &mut Reader<'_>) -> R<std::rc::Rc<Self>> {
            Box::<serde_json::value::RawValue>::__read(r).map(std::rc::Rc::from)
        }
    }

    impl<T: FromJson> Shared for [T] {
        #[inline]
        fn __read_arc(r: &mut Reader<'_>) -> R<std::sync::Arc<Self>> {
            Vec::<T>::__read(r).map(std::sync::Arc::from)
        }

        #[inline]
        fn __read_rc(r: &mut Reader<'_>) -> R<std::rc::Rc<Self>> {
            Vec::<T>::__read(r).map(std::rc::Rc::from)
        }
    }

    /// `s` read by the reader alone, `None` where it gives up: for tests that show the reader
    /// read a type itself rather than hand it to serde_json.
    pub fn alone<T: FromJson>(s: &str) -> Option<T> {
        super::fast(s)
    }

    /// A field that is not in the object and has no default: what serde makes of it, which is
    /// `None` for an `Option` and an error (so serde_json reads the text) for anything else.
    pub fn missing<T: DeserializeOwned>() -> R<T> {
        struct Missing;
        impl<'de> Deserializer<'de> for Missing {
            type Error = serde::de::value::Error;
            fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
                Err(serde::de::Error::custom("missing field"))
            }
            fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
                visitor.visit_none()
            }
            serde::forward_to_deserialize_any! {
                bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf unit
                unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
            }
        }
        T::deserialize(Missing).map_err(|_| Fallback)
    }

    // A field's type picks `ViaFromJson` when it implements FromJson (it matches without an
    // extra reference) and falls back to `ViaDeserialize`, which hands serde_json the field's text.
    pub struct Read<T>(PhantomData<fn() -> T>);

    impl<T> Read<T> {
        #[inline(always)]
        pub fn new() -> Self {
            Read(PhantomData)
        }
    }

    impl<T> Default for Read<T> {
        fn default() -> Self {
            Self::new()
        }
    }

    pub trait ViaFromJson {
        type Out;
        fn __read(&self, r: &mut Reader<'_>) -> R<Self::Out>;
    }

    impl<T: FromJson> ViaFromJson for Read<T> {
        type Out = T;
        #[inline(always)]
        fn __read(&self, r: &mut Reader<'_>) -> R<T> {
            T::__read(r)
        }
    }

    pub trait ViaDeserialize {
        type Out;
        fn __read(&self, r: &mut Reader<'_>) -> R<Self::Out>;
    }

    /// The field's text, validated and at most 100 deep, read alone by serde_json: what serde_json
    /// makes of it inside the whole text (a raw value is the same slice).
    impl<T: DeserializeOwned> ViaDeserialize for &Read<T> {
        type Out = T;
        fn __read(&self, r: &mut Reader<'_>) -> R<T> {
            serde_json::from_str(r.span()?).map_err(|_| Fallback)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use serde::Deserialize;
    use serde_json::Value;

    use super::{fast, from_slice, from_str};
    use crate::json::FromJson;

    /// `text` read by `from_str` is serde_json's answer: the same value, or an error with the
    /// same message. Returns whether the reader took it itself.
    fn same<T: FromJson + PartialEq + std::fmt::Debug>(text: &str) -> bool {
        let ours = from_str::<T>(text);
        let theirs = serde_json::from_str::<T>(text);
        match (&ours, &theirs) {
            (Ok(a), Ok(b)) => assert_eq!(a, b, "{text}"),
            (Err(a), Err(b)) => assert_eq!(a.to_string(), b.to_string(), "{text}"),
            _ => panic!("from_str {ours:?} but serde_json {theirs:?} on {text}"),
        }
        let rejected = theirs.is_err();
        let from_bytes = from_slice::<T>(text.as_bytes()).map_err(|e| e.to_string());
        assert_eq!(from_bytes, theirs.map_err(|e| e.to_string()), "{text}");
        let took = fast::<T>(text).is_some();
        assert!(!(took && rejected), "the reader accepted what serde_json rejects: {text}");
        took
    }

    #[derive(Debug, PartialEq, FromJson)]
    struct Line {
        id: String,
        #[serde(rename = "qty", alias = "quantity")]
        count: u32,
        price: f64,
        note: Option<String>,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default = "seven")]
        seven: i64,
        #[serde(skip_deserializing)]
        cache: u8,
        extra: Value,
        r#type: Kind,
    }

    fn seven() -> i64 {
        7
    }

    #[derive(Debug, PartialEq, FromJson)]
    #[serde(rename_all = "kebab-case")]
    enum Kind {
        Card,
        #[serde(alias = "box")]
        SealedBox,
        #[serde(rename = "other!")]
        Other,
    }

    #[derive(Debug, PartialEq, Default, FromJson)]
    #[serde(default, rename_all = "camelCase")]
    struct Page {
        item_count: i32,
        title: String,
        lines: Vec<Line>,
        by_id: BTreeMap<String, u8>,
        counts: HashMap<String, Option<bool>>,
        inner: Option<Box<Page>>,
        letter: char,
        pair: Pair,
        id: Id,
        nothing: Unit,
        any: Vec<Value>,
        date: Foreign,
    }

    /// A container default from a path, read over: a field's own default wins where the object
    /// leaves it out, and a skipped field keeps the container's value unless it has its own.
    #[derive(Debug, PartialEq, FromJson)]
    #[serde(default = "shelf")]
    struct Shelf {
        name: String,
        #[serde(default = "seven")]
        size: i64,
        #[serde(skip)]
        kept: u8,
        #[serde(skip_deserializing, default = "seven")]
        own: i64,
        #[serde(alias = "labels")]
        tags: Vec<String>,
    }

    fn shelf() -> Shelf {
        Shelf { name: "shelf".into(), size: 3, kept: 9, own: 4, tags: vec!["t".into()] }
    }

    #[derive(Debug, PartialEq, Default, FromJson)]
    struct Pair(i8, String);

    #[derive(Debug, PartialEq, Default, FromJson)]
    struct Id(u64);

    #[derive(Debug, PartialEq, Default, FromJson)]
    struct Unit;

    /// A type that only implements Deserialize: read by serde_json from its own text.
    #[derive(Debug, PartialEq, Default, Deserialize)]
    struct Foreign {
        y: u16,
        m: u8,
    }

    /// A `Deserialize` serde writes for an attribute the derive does not follow, made `FromJson`
    /// by an empty impl: read by serde_json, alone or as a field.
    #[derive(Debug, PartialEq, Deserialize)]
    struct Flat {
        id: u8,
        #[serde(flatten)]
        rest: BTreeMap<String, u8>,
    }

    impl FromJson for Flat {}

    #[derive(Debug, PartialEq, FromJson)]
    struct Holds {
        flat: Flat,
        list: Vec<Flat>,
    }

    #[test]
    fn an_empty_impl_is_read_by_serde_json() {
        // Alone the reader gives up at once, so serde_json reads the text a single time.
        assert!(!same::<Flat>(r#"{"id":1,"a":2}"#));
        assert!(!same::<Flat>(r#"{"id":"x"}"#));
        assert!(!same::<Option<Flat>>(r#"{"id":1}"#));
        // Inside an array or a derived type the reader goes on, and serde_json reads its text.
        assert!(same::<Vec<Flat>>(r#"[{"id":1,"a":2},{"id":3}]"#));
        assert!(same::<Holds>(r#"{"flat":{"id":1,"b":2},"list":[{"id":4}]}"#));
        assert!(!same::<Holds>(r#"{"flat":{"id":300},"list":[]}"#));
        assert!(!same::<Vec<Flat>>(r#"[{"a":2}]"#));
    }

    #[derive(Debug, PartialEq, FromJson)]
    #[serde(deny_unknown_fields)]
    struct Strict {
        a: u8,
        #[serde(skip)]
        b: u8,
    }

    #[derive(Debug, PartialEq, FromJson)]
    #[serde(transparent)]
    struct Wrapper {
        inner: Vec<i64>,
        #[serde(skip)]
        seen: bool,
    }

    #[derive(Debug, PartialEq, FromJson)]
    struct Generic<T> {
        value: T,
        list: Vec<T>,
    }

    const LINE: &str = r#"{"id":"l\u00e9 \ud83c\udfb4 \"1\"","qty":3,"price":2.5,"note":null,"extra":{"a":[1,2.50,-0,1e3,"x",true,null]},"type":"sealed-box","unknown":[{"x":"\u0041"}]}"#;

    #[test]
    fn values_are_serde_json_s() {
        assert!(same::<Line>(LINE));
        assert!(same::<Line>(
            r#" { "type" : "card" , "price" : 1 , "quantity" : 0 , "id" : "" , "tags" : ["a"] , "seven" : -1 , "cache" : 9 , "extra" : 5 , "note" : "n" } "#
        ));
        assert!(same::<Line>(&LINE.replace("sealed-box", "box")));
        assert!(same::<Line>(&LINE.replace("sealed-box", "other!")));
        assert!(same::<Page>(&format!(
            r#"{{"itemCount":-4,"title":"T","lines":[{LINE},{LINE}],"byId":{{"a":1,"b":2,"a":3,"\u00e9":4}},"counts":{{"x":null,"y":true}},"inner":{{"title":"in","inner":null}},"letter":"é","pair":[-128,"p"],"id":18446744073709551615,"nothing":null,"any":[[],{{}},0,-1.5,"s"],"date":{{"y":2026,"m":10}}}}"#
        )));
        assert!(same::<Page>("{}"));
        for text in [
            "{}",
            r#"{"name":"a"}"#,
            r#"{"size":1,"name":"b","kept":5,"own":6,"labels":["x"]}"#,
            r#"{"tags":[],"other":{"deep":[1]}}"#,
        ] {
            assert!(same::<Shelf>(text), "{text}");
        }
        assert!(!same::<Shelf>(r#"{"name":"a","name":"b"}"#));
        assert!(!same::<Shelf>(r#"{"tags":["a"],"labels":["b"]}"#));
        assert!(same::<Strict>(r#"{"a":1}"#));
        assert!(same::<Wrapper>("[1,-2,3]"));
        assert!(same::<Generic<String>>(r#"{"value":"v","list":["a","b"]}"#));
        assert!(same::<Generic<Option<u8>>>(r#"{"value":null,"list":[1,null]}"#));
        assert!(same::<Vec<f64>>(
            "[0,1,-1,0.1,1e-7,123456789012345678901234567890,2.2250738585072014e-308,-0,1.7976931348623157e308]"
        ));
        assert!(same::<Vec<i64>>("[0,-1,9223372036854775807,-9223372036854775808]"));
        assert!(same::<Vec<u8>>("[0,255]"));
        assert!(same::<Vec<f32>>("[0.1,16777217,3.4028235e38]"));
    }

    /// The std types a schema is given for, and the pointers serde reads through, read as serde_json
    /// reads them, alone and inside a container.
    #[test]
    fn std_types_with_a_schema_are_serde_json_s() {
        use std::{
            borrow::Cow,
            marker::PhantomData,
            net::{IpAddr, Ipv4Addr, SocketAddr},
            num::{NonZeroI8, NonZeroU32},
            path::PathBuf,
            rc::Rc,
            sync::Arc,
            time::{Duration, SystemTime},
        };
        same::<Ipv4Addr>(r#""10.0.0.1""#);
        same::<Ipv4Addr>(r#""10.0.0""#);
        same::<IpAddr>(r#""::1""#);
        same::<SocketAddr>(r#""127.0.0.1:80""#);
        same::<PathBuf>(r#""a/b""#);
        same::<Duration>(r#"{"secs":1,"nanos":5}"#);
        same::<SystemTime>(r#"{"secs_since_epoch":1700000000,"nanos_since_epoch":7}"#);
        same::<NonZeroU32>("7");
        same::<NonZeroU32>("0");
        same::<NonZeroI8>("-8");
        same::<PhantomData<String>>("null");
        same::<serde_json::Number>("1.5");
        same::<BTreeMap<String, Duration>>(r#"{"a":{"secs":1,"nanos":0}}"#);
        assert!(same::<Arc<Line>>(LINE));
        assert!(same::<Rc<Vec<u8>>>("[1,2]"));
        assert!(same::<Cow<'static, str>>(r#""c""#));
        assert!(same::<Vec<Box<str>>>(r#"["a","\u00e9"]"#));
        assert!(same::<Arc<str>>(r#""a""#));
        assert!(same::<Rc<str>>(r#""a""#));
        assert!(same::<Box<[u8]>>("[1,2]"));
        same::<Box<std::path::Path>>(r#""a/b""#);
        same::<Arc<std::path::Path>>(r#""a/b""#);
        same::<Rc<std::path::Path>>(r#""a""#);
        same::<BTreeMap<String, Box<std::path::Path>>>(r#"{"x":"c"}"#);
        assert!(same::<Arc<[String]>>(r#"["a"]"#));
        assert!(same::<BTreeMap<String, Box<[u8]>>>(r#"{"x":[1]}"#));
        same::<u128>("340282366920938463463374607431768211455");
        same::<i128>("-170141183460469231731687303715884105728");
        same::<BTreeMap<String, u128>>(r#"{"a":1}"#);
        same::<std::collections::BTreeSet<String>>(r#"["b","a"]"#);
        same::<std::collections::VecDeque<u8>>("[1,2]");
        same::<[u8; 2]>("[1,2]");
        same::<[u8; 2]>("[1]");
        same::<(f64, String)>(r#"[1.5,"a"]"#);
        same::<BTreeMap<String, (f64, f64)>>(r#"{"p":[1,2]}"#);
        let sets: std::collections::HashSet<String> = from_str(r#"["a","b","a"]"#).unwrap();
        assert_eq!(sets, serde_json::from_str(r#"["a","b","a"]"#).unwrap());
        assert!(same::<Vec<Cow<'static, [u8]>>>("[[1],[2,3]]"));
        assert!(same::<BTreeMap<String, Arc<Line>>>(&format!(r#"{{"x":{LINE}}}"#)));
        #[cfg(feature = "types")]
        {
            let raw: BTreeMap<String, Box<serde_json::value::RawValue>> = from_str(r#"{"x": [1, {"a": 2}]}"#).unwrap();
            assert_eq!(raw["x"].get(), r#"[1, {"a": 2}]"#);
            let shared: Vec<Arc<serde_json::value::RawValue>> = from_str(r#"[ {"a": 1}, 2]"#).unwrap();
            let theirs: Vec<Arc<serde_json::value::RawValue>> = serde_json::from_str(r#"[ {"a": 1}, 2]"#).unwrap();
            assert_eq!(shared.iter().map(|v| v.get()).collect::<Vec<_>>(), theirs.iter().map(|v| v.get()).collect::<Vec<_>>());
            let one: Rc<serde_json::value::RawValue> = from_str("[1]").unwrap();
            assert_eq!(one.get(), "[1]");
        }
    }

    /// A string read or skipped stops where serde_json does at every place in the scan's 16 and 8
    /// byte steps: its closing quote, an escape, or a control character. One the reader can take
    /// (anything but a control character or a bad escape) it takes, so a scan that stopped early
    /// or ran past a quote fails here rather than handing the text to serde_json.
    #[test]
    fn strings_stop_at_every_place_in_a_step() {
        // Bytes with the high bit set next to the stops (`¢` is C2 A2, `ܢ` DC A2): the test for
        // `"` and `\` must not mark them.
        let fillers = ["a", "é", "€", "𝄞", "¢", "ܢ"];
        for filler in fillers {
            for len in 0..40 {
                let plain = filler.repeat(len);
                for (stop, taken) in
                    [("\"", true), ("\\n\"", true), ("\\u00e9\"", true), ("é\"", true), ("\u{1}\"", false), ("\\x\"", false)]
                {
                    let text = format!("\"{plain}{stop}");
                    assert_eq!(same::<String>(&text), taken, "{text:?}");
                    assert_eq!(same::<Value>(&text), taken, "{text:?}");
                    let line = LINE.replace(r#""unknown""#, &format!(r#""s":{text},"l":[{text}],"unknown""#));
                    assert_eq!(same::<Line>(&line), taken, "{line:?}");
                }
                // Unterminated: the text ends in the plain run, at every length.
                let open = format!("\"{plain}");
                assert!(!same::<String>(&open), "{open:?}");
                assert!(!same::<Line>(&LINE.replace(r#""unknown""#, &format!(r#""s":{open}"#))), "{open:?}");
            }
        }
    }

    /// What serde_json decides (an error, or None for a missing Option) is handed to it.
    #[test]
    fn what_the_reader_does_not_take_serde_json_answers() {
        for (text, ok) in [
            (r#"{"id":"a","qty":1,"price":1,"extra":null,"type":"card"}"#, true), // a missing Option: None
            (r#"{"id":"a","price":1,"extra":null,"type":"card"}"#, false),        // a missing field
            (r#"{"id":"a","id":"b","qty":1,"price":1,"extra":null,"type":"card"}"#, false), // a duplicate
            (r#"{"id":"a","qty":1,"quantity":2,"price":1,"extra":null,"type":"card"}"#, false), // the alias too
            (r#"{"\u0069d":"a","qty":1,"price":1,"extra":null,"type":"card"}"#, true), // an escaped key
            (r#"["a",1,1.0,null,[],0,0,null,"card"]"#, false),                    // a struct as an array
            (r#"{"id":"a","qty":-0,"price":1,"extra":null,"type":"card"}"#, false), // -0 is a float to serde_json
            (r#"{"id":"a","qty":1.0,"price":1,"extra":null,"type":"card"}"#, false),
            (r#"{"id":"a","qty":4294967296,"price":1,"extra":null,"type":"card"}"#, false),
            (r#"{"id":"a","qty":1,"price":1e400,"extra":null,"type":"card"}"#, false),
            (r#"{"id":"a","qty":1,"price":1,"extra":1e400,"type":"card"}"#, false),
            (r#"{"id":"a","qty":1,"price":1,"extra":null,"type":"Card"}"#, false),
            (r#"{"id":"\ud800","qty":1,"price":1,"extra":null,"type":"card"}"#, false),
            (r#"{"id":"a","qty":1,"price":1,"extra":null,"type":"card"} x"#, false),
        ] {
            same::<Line>(text);
            assert_eq!(serde_json::from_str::<Line>(text).is_ok(), ok, "{text}");
        }
        same::<Strict>(r#"{"a":1,"b":2}"#);
        same::<Strict>(r#"{"a":1,"c":2}"#);
        same::<Pair>(r#"[1]"#);
        same::<Pair>(r#"[1,"a",2]"#);
        same::<Kind>(r#"{"card":null}"#);
        same::<Unit>("{}");
        same::<char>(r#""ab""#);
        same::<Value>(&("[".repeat(127) + &"]".repeat(127)));
        same::<Value>(&("[".repeat(129) + &"]".repeat(129)));
        // An object read whole, a key written twice keeping its last value.
        assert!(same::<serde_json::Map<String, Value>>(r#"{"a":1,"b":[true,null],"a":"x"}"#));
        same::<serde_json::Map<String, Value>>(r#"[1]"#);
        same::<serde_json::Map<String, Value>>(r#"{"a":}"#);
        same::<Line>(
            &LINE.replace(r#""unknown":[{"x":"\u0041"}]"#, &format!(r#""unknown":{}"#, "[".repeat(130) + &"]".repeat(130))),
        );
        assert!(from_slice::<String>(b"\"\xff\"").is_err());
    }

    /// Every byte of an item deleted, or replaced by one that matters to JSON: the same value or
    /// the same error as serde_json, and the reader never takes text serde_json rejects.
    #[test]
    fn broken_text_gets_serde_json_s_answer() {
        // Undeclared scalars too: they are skipped on their own path, not the nested one.
        let text =
            LINE.replace("\"unknown\"", "\"tags\":[\"t\"],\"s\":\"a\\\"b\",\"n\":-1.5e3,\"t\":true,\"z\":null,\"unknown\"");
        let bytes = text.as_bytes();
        let (mut taken, mut cases) = (0, 0);
        for at in 0..bytes.len() {
            let mut variants = vec![{
                let mut v = bytes.to_vec();
                v.remove(at);
                v
            }];
            for c in *b"\"\\,:{}[]0-.e+ xn\x01" {
                let mut v = bytes.to_vec();
                v[at] = c;
                variants.push(v);
            }
            for v in variants {
                if let Ok(s) = String::from_utf8(v) {
                    cases += 1;
                    taken += same::<Line>(&s) as usize;
                }
            }
        }
        assert!(cases > 1000 && taken > 0, "{cases} cases, {taken} read by the reader");
    }
}
