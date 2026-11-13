use corten::{extract::FromRequestParts, http::request::Parts};
use std::convert::Infallible;

pub struct TraceParent(pub Option<String>);

impl<S: Sync> FromRequestParts<S> for TraceParent {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        let headers = parts.headers.get_all("traceparent");
        let mut values = headers.iter();
        let value = values.next().and_then(|value| value.to_str().ok()).map(str::to_owned);
        Ok(Self(if values.next().is_none() { value } else { None }))
    }
}

// W3C Trace Context: validate the known fields, down-version future formats to 00.
pub fn parent(value: Option<&str>) -> Option<String> {
    let value = value?;
    let prefix = value.get(..55)?;
    if !prefix.is_ascii() {
        return None;
    }
    let bytes = prefix.as_bytes();
    if value.contains(',')
        || &prefix[..2] == "ff"
        || (value.len() > 55 && (&prefix[..2] == "00" || value.as_bytes()[55] != b'-'))
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| if [2, 35, 52].contains(&i) { *b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(b) })
        || bytes[3..35].iter().all(|b| *b == b'0')
        || bytes[36..52].iter().all(|b| *b == b'0')
    {
        return None;
    }
    Some(format!("00{}", &prefix[2..]))
}

#[cfg(test)]
mod tests {
    use super::parent;

    #[test]
    fn validates_optional_w3c_parent_without_retaining_context() {
        let valid = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-00";
        assert_eq!(parent(Some(valid)).as_deref(), Some(valid));
        assert_eq!(parent(Some(&format!("01{}-future", &valid[2..]))).as_deref(), Some(valid));
        for invalid in [
            "bad".to_owned(),
            valid.to_uppercase(),
            valid.replace("00-", "ff-"),
            valid.replace("0123456789abcdef0123456789abcdef", &"0".repeat(32)),
            valid.replace("-0123456789abcdef-", &format!("-{}-", "0".repeat(16))),
            format!("{valid}-extra"),
            valid.replace('-', "_"),
            format!("{valid}, {valid}"),
            "\u{e9}".repeat(30),
            format!("\u{4e16}{}", "a".repeat(52)),
        ] {
            assert_eq!(parent(Some(&invalid)), None, "{invalid}");
            assert_eq!(parent(None), None);
        }
    }
}
