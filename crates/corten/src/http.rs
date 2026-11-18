//! The HTTP vocabulary every layer above the connection names ([design Choice 25](https://github.com/corten-run/corten/blob/main/docs/design.md#choice-axum-router), part 3):
//! the `http` crate's types (`StatusCode`, `HeaderMap`, `HeaderValue`, `Method`, `Uri`,
//! `request::Parts`), which hyper, tower and HTTP clients share, so an app names the same types
//! its HTTP client does; and the body, request and response Corten builds on them.
//!
//! [`Request`] and [`Response`] are the `http` crate's, over Corten's [`Body`] unless given
//! another. A handler answers with anything that is [`IntoResponse`], a raw `Response` included,
//! and a header or cookie an answer adds is [`IntoResponseParts`], which writes into
//! [`ResponseParts`]; a middleware answers with a `Response`. [`Bytes`] is a body's bytes,
//! shared rather than copied: what a whole-body reader gives and [`crate::Media::new`] takes.
//! [`BodyDataStream`] is a body read as a stream of those pieces.
//!
//! ```
//! use corten::http::{header, Body, IntoResponse, Response, StatusCode};
//!
//! fn teapot() -> Response {
//!     (StatusCode::IM_A_TEAPOT, [(header::CONTENT_TYPE, "text/plain")], Body::from("short and stout")).into_response()
//! }
//! # let _ = teapot();
//! ```
//!
//! Import the names a file uses: `use corten::http::*` also brings in the `http` crate's
//! `Result`, which hides the standard one.

#[doc(no_inline)]
pub use ::http::*;
pub use bytes::Bytes;

pub use crate::body::{Body, BodyDataStream};
pub use crate::handler::Request;
pub use crate::response::{IntoResponse, IntoResponseParts, Response, ResponseParts};

/// RFC 9110 section 12.4.2's qvalue, in thousandths, without rounding or float syntax.
pub(crate) fn qvalue(value: &[u8]) -> Option<u16> {
    let (&whole, rest) = value.split_first()?;
    let mut quality = match whole {
        b'0' => 0,
        b'1' => 1000,
        _ => return None,
    };
    if rest.is_empty() {
        return Some(quality);
    }
    let digits = rest.strip_prefix(b".")?;
    if digits.len() > 3 {
        return None;
    }
    let mut place = 100;
    for &digit in digits {
        if !digit.is_ascii_digit() || (whole == b'1' && digit != b'0') {
            return None;
        }
        quality += u16::from(digit - b'0') * place;
        place /= 10;
    }
    Some(quality)
}

/// The weight among a list item's parameters (the text after its first `;`), in thousandths:
/// 1000 without a `q` parameter, `None` for a malformed or repeated weight. RFC 9110
/// (sections 5.6.6 and 12.4.2) allows only SP and HTAB around `;` and no whitespace around `=`.
pub(crate) fn weight(params: &[u8]) -> Option<u16> {
    fn trim(mut s: &[u8]) -> &[u8] {
        while let [b' ' | b'\t', rest @ ..] = s {
            s = rest;
        }
        while let [rest @ .., b' ' | b'\t'] = s {
            s = rest;
        }
        s
    }
    let mut quality = None;
    for param in params.split(|&b| b == b';') {
        let param = trim(param);
        if let [b'q' | b'Q', b'=', value @ ..] = param {
            if quality.is_some() {
                return None;
            }
            quality = Some(qvalue(value)?);
        } else {
            let name = trim(param.split(|&b| b == b'=').next().unwrap_or_default());
            // A non-OWS separator must not disguise a weight as an unrelated parameter.
            if name.eq_ignore_ascii_case(b"q") || name.iter().any(|b| !b.is_ascii_graphic()) {
                return None;
            }
        }
    }
    Some(quality.unwrap_or(1000))
}

#[cfg(test)]
mod tests {
    use super::{qvalue, weight};

    #[test]
    fn qvalues_follow_the_rfc_grammar() {
        for (text, expected) in [
            ("0", 0),
            ("0.", 0),
            ("0.0", 0),
            ("0.00", 0),
            ("0.000", 0),
            ("1", 1000),
            ("1.", 1000),
            ("1.0", 1000),
            ("1.00", 1000),
            ("1.000", 1000),
            ("0.1", 100),
            ("0.12", 120),
            ("0.123", 123),
        ] {
            assert_eq!(qvalue(text.as_bytes()), Some(expected), "{text}");
        }
        for quality in 0..1000 {
            assert_eq!(qvalue(format!("0.{quality:03}").as_bytes()), Some(quality));
        }
        for text in [
            "nan", "NaN", "inf", "infinity", "1.5", "-0", "1.0001", "0.1234", "", ".5", "+0.5", "1e0", "00", "1.001", "0. 1",
            " 0.5", "0.5 ",
        ] {
            assert_eq!(qvalue(text.as_bytes()), None, "{text:?}");
        }
        assert_eq!(qvalue(b"0.\xff"), None);
    }

    #[test]
    fn a_weight_is_q_equals_a_qvalue_with_whitespace_only_around_its_semicolon() {
        for (params, expected) in [
            ("", 1000),
            ("level=1", 1000),
            ("q=0.5", 500),
            ("Q=0.5", 500),
            (" \tq=0.5\t ", 500),
            ("level=1; q=0", 0),
            ("qs=2;q=0.25", 250),
            ("q=0.25;qs=2", 250),
        ] {
            assert_eq!(weight(params.as_bytes()), Some(expected), "{params:?}");
        }
        for params in [
            "q =0",
            "q\t=0",
            "q= 0",
            "Q =0.5",
            "q",
            "q=",
            "q=nan",
            "level=1;q =1",
            "\u{00a0}q=0",
            "q\u{00a0}=0",
            "q=0\u{00a0}",
            "\x0bq=0",
            "q=1;q =0",
            "q=1;Q=0",
            "q=1;level=1;q=0",
        ] {
            assert_eq!(weight(params.as_bytes()), None, "{params:?}");
        }
        assert_eq!(weight(b"\xa0q=0"), None);
    }
}

/// This module is the one place these types are named: the paths each had before it are gone,
/// one test each.
///
/// ```compile_fail,E0432
/// use corten::answer::Body;
/// ```
///
/// ```compile_fail,E0432
/// use corten::answer::BodyDataStream;
/// ```
///
/// ```compile_fail,E0432
/// use corten::extract::Request;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::Response;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::IntoResponse;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::IntoResponseParts;
/// ```
///
/// ```compile_fail,E0432
/// use corten::middleware::ResponseParts;
/// ```
///
/// ```compile_fail,E0432
/// use corten::Bytes;
/// ```
#[cfg(doctest)]
pub struct OldPaths;
