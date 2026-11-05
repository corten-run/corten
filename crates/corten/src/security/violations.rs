//! What browsers report a page's CSP blocked ([`super::Policy::report_to`]), read the same
//! whichever browser sent it.

use axum::{
    extract::{FromRequest, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Deserializer};

/// The most a post of reports may be. A browser sends a batch of up to about a hundred, each a
/// little over the page's CSP in size.
const LIMIT: usize = 256 * 1024;

/// What browsers reported the pages' CSP blocked, or under [`super::Policy::report_only`] would
/// block: the body of a post to the route [`super::Policy::report_to`] names, as a handler's
/// extractor (`Violations(found): Violations`). Browsers send it in two shapes, and both are read
/// alike: a list in the Reporting API's format (`application/reports+json`; Firefox, Chromium)
/// and one report at a time (WebKit sends each as `application/csp-report`). Reports of other
/// types are left out. A body of another type is answered 415, one that does not read 400, and
/// one over 256 KiB 413.
///
/// Anyone can post to the route, so a violation is a hint, not a fact: log it (as debug text,
/// `?v.blocked_url`, so a line break cannot forge a log line), count it, and never trust its URLs
/// or put its text in a page unescaped. Its `sample` is the start of what was blocked (a script's
/// text, a string of markup), which may hold the visitor's data.
///
/// ```
/// use corten::{axum::http::StatusCode, security::Violations};
///
/// async fn csp_reports(Violations(found): Violations) -> StatusCode {
///     for v in found.iter().take(32) {
///         // A real app logs or counts them: tracing::warn!(directive = ?v.directive, ..).
///         let _ = (&v.directive, &v.blocked_url, &v.document_url);
///     }
///     StatusCode::NO_CONTENT
/// }
/// ```
#[derive(Clone, Debug, Default)]
pub struct Violations(pub Vec<Violation>);

/// One thing a page's CSP blocked, as the browser reported it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct Violation {
    /// The page's address (without its fragment).
    #[serde(rename = "documentURL", deserialize_with = "text")]
    pub document_url: String,
    /// The directive that blocked it: `script-src-elem`, `connect-src`,
    /// `require-trusted-types-for`.
    #[serde(rename = "effectiveDirective", deserialize_with = "text")]
    pub directive: String,
    /// What was blocked: a URL, or a keyword (`inline`, `eval`, `trusted-types-sink`).
    #[serde(rename = "blockedURL", deserialize_with = "text")]
    pub blocked_url: String,
    /// Whether the policy only reported it (`Policy::report_only`) rather than blocked it.
    #[serde(rename = "disposition", deserialize_with = "reported")]
    pub report_only: bool,
    /// The script that did it, when the browser says.
    #[serde(rename = "sourceFile")]
    pub source_file: Option<String>,
    /// Its line in `source_file`.
    #[serde(rename = "lineNumber")]
    pub line: Option<u32>,
    /// Its column in `source_file`.
    #[serde(rename = "columnNumber")]
    pub column: Option<u32>,
    /// The start of what was blocked (a script's text, a string of markup), when the policy
    /// asks for it; it may hold the visitor's data.
    #[serde(deserialize_with = "text")]
    pub sample: String,
}

/// Text that a browser may send as `null`.
fn text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// `"report"` for a report-only policy, `"enforce"` for one that blocked.
fn reported<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<String>::deserialize(d)?.as_deref() == Some("report"))
}

/// A report: its type and, for a CSP violation, what it says.
#[derive(Deserialize)]
struct Report {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    body: Option<Violation>,
}

/// A browser's post: a list (the Reporting API's batch) or one report (WebKit's).
#[derive(Deserialize)]
#[serde(untagged)]
enum Sent {
    Many(Vec<Report>),
    One(Report),
}

impl Violations {
    /// The violations a post's body holds, from a body of `content_type`.
    fn read(content_type: Option<&str>, body: &[u8]) -> Result<Self, (StatusCode, &'static str)> {
        let kind = content_type.and_then(|t| t.split(';').next()).map(str::trim);
        let known = ["application/reports+json", "application/csp-report", "application/json"];
        if !kind.is_some_and(|kind| known.iter().any(|k| k.eq_ignore_ascii_case(kind))) {
            return Err((
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Expected reports: application/reports+json or application/csp-report.",
            ));
        }
        let sent: Sent = serde_json::from_slice(body).map_err(|_| (StatusCode::BAD_REQUEST, "The reports did not read."))?;
        let reports = match sent {
            Sent::Many(reports) => reports,
            Sent::One(report) => vec![report],
        };
        Ok(Violations(
            reports
                .into_iter()
                .filter(|r| r.kind.as_deref().is_none_or(|kind| kind == "csp-violation"))
                .filter_map(|r| r.body)
                .collect(),
        ))
    }
}

impl<S: Send + Sync> FromRequest<S> for Violations {
    type Rejection = Response;

    async fn from_request(req: Request, _: &S) -> Result<Self, Self::Rejection> {
        let content_type = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let body = axum::body::to_bytes(req.into_body(), LIMIT)
            .await
            .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "The reports are over 256 KiB.").into_response())?;
        Violations::read(content_type.as_deref(), &body).map_err(IntoResponse::into_response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Firefox 157 sent for a Trusted Types sink and a fetch `connect-src` refused, as one batch.
    const FIREFOX: &str = r#"[
 {"age": 4, "type": "csp-violation", "url": "http://localhost:18412/", "user_agent": "Mozilla/5.0 Firefox/157.0",
  "body": {"documentURL": "http://localhost:18412/", "blockedURL": "trusted-types-sink", "referrer": null,
   "effectiveDirective": "require-trusted-types-for", "originalPolicy": "default-src 'self'; report-to csp",
   "sourceFile": "debugger eval code line 370 > eval", "sample": "Element insertAdjacentHTML|<b>x</b>",
   "disposition": "enforce", "statusCode": 200, "lineNumber": 1, "columnNumber": 29}},
 {"age": 4, "type": "csp-violation", "url": "http://localhost:18412/", "user_agent": "Mozilla/5.0 Firefox/157.0",
  "body": {"documentURL": "http://localhost:18412/", "blockedURL": "http://127.0.0.2:1/x", "referrer": null,
   "effectiveDirective": "connect-src", "originalPolicy": "default-src 'self'; report-to csp", "sourceFile": null,
   "sample": null, "disposition": "report", "statusCode": 200, "lineNumber": null, "columnNumber": null}}
]"#;

    /// What WebKit 27.2 sent for the sink: one report, as `application/csp-report`.
    const WEBKIT: &str = r#"{"type":"csp-violation","url":"http://localhost:18412/","body":{"documentURL":"http://localhost:18412/","disposition":"enforce","referrer":"","effectiveDirective":"require-trusted-types-for","blockedURL":"trusted-types-sink","originalPolicy":"default-src 'self'; report-to csp","statusCode":200,"sample":"Element insertAdjacentHTML|<b>x</b>"}}"#;

    #[test]
    fn a_batch_and_one_report_read_alike() {
        let Violations(firefox) = Violations::read(Some("application/reports+json"), FIREFOX.as_bytes()).unwrap();
        let sink = Violation {
            document_url: "http://localhost:18412/".into(),
            directive: "require-trusted-types-for".into(),
            blocked_url: "trusted-types-sink".into(),
            report_only: false,
            source_file: Some("debugger eval code line 370 > eval".into()),
            line: Some(1),
            column: Some(29),
            sample: "Element insertAdjacentHTML|<b>x</b>".into(),
        };
        assert_eq!(firefox[0], sink);
        assert_eq!(
            firefox[1],
            Violation {
                document_url: "http://localhost:18412/".into(),
                directive: "connect-src".into(),
                blocked_url: "http://127.0.0.2:1/x".into(),
                report_only: true,
                ..Violation::default()
            },
            "null is no text, and a report-only policy says so"
        );
        let Violations(webkit) = Violations::read(Some("application/csp-report"), WEBKIT.as_bytes()).unwrap();
        assert_eq!(webkit, vec![Violation { source_file: None, line: None, column: None, ..sink }]);
    }

    #[test]
    fn another_type_of_report_is_left_out_and_another_body_refused() {
        let mixed =
            r#"[{"type":"deprecation","body":{"id":"x"}},{"type":"csp-violation","body":{"effectiveDirective":"img-src"}}]"#;
        let Violations(found) = Violations::read(Some("application/reports+json; charset=utf-8"), mixed.as_bytes()).unwrap();
        assert_eq!(found.iter().map(|v| v.directive.as_str()).collect::<Vec<_>>(), ["img-src"]);
        assert_eq!(Violations::read(Some("text/plain"), WEBKIT.as_bytes()).unwrap_err().0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(Violations::read(None, WEBKIT.as_bytes()).unwrap_err().0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(Violations::read(Some("application/csp-report"), b"[1, 2").unwrap_err().0, StatusCode::BAD_REQUEST);
    }
}
