//! Agent tools over the Model Context Protocol (feature `agent`): one `POST` route that speaks
//! JSON-RPC 2.0 as MCP's streamable HTTP transport defines it, answering with `application/json`.
//!
//! A tool is one of the app's actions with a name, a description, a typed input and a typed
//! output. The input derives `FromJson` and the output `ToJson`, which describe the JSON from the
//! same reading of `#[serde(..)]` they read and write it by, so the `inputSchema` and
//! `outputSchema` agents see are generated from the same structs the handler receives and
//! returns, and cannot drift from them. An input with no schema for agents does not compile as
//! one, even one that is read (here a `Deserialize` with the opt-in `FromJson` impl, below):
//!
//! ```compile_fail,E0277
//! use corten::agent::Tools;
//! #[derive(serde::Deserialize)]
//! struct Adjust { id: String }
//! impl corten::FromJson for Adjust {}
//! #[derive(corten::ToJson)]
//! struct Done { ok: bool }
//! let _ = Tools::new("t", "1").tool("adjust", "Adjust", |(), _: Adjust| async { Ok(Done { ok: true }) });
//! ```
//!
//! Nor does one that derives serde's `Deserialize` beside a schema written by hand, since its
//! schema and what it reads could drift apart (the opt-in `impl corten::FromJson for Adjust {}`
//! would compile it, for a type whose `Deserialize` `FromJson` cannot write: written by hand, or
//! serde's for an attribute it refuses):
//!
//! ```compile_fail,E0277
//! use corten::{agent::Tools, json::schema::{FromJsonSchema, Generator}};
//! #[derive(serde::Deserialize)]
//! struct Adjust { id: String }
//! impl FromJsonSchema for Adjust {
//!     fn json_schema(_: &mut Generator) -> serde_json::Value { serde_json::json!({ "type": "object" }) }
//! }
//! #[derive(corten::ToJson)]
//! struct Done { ok: bool }
//! let _ = Tools::new("t", "1").tool("adjust", "Adjust", |(), _: Adjust| async { Ok(Done { ok: true }) });
//! ```
//!
//! With the opt-in impl it does. Here the input trims its id with serde's `deserialize_with`,
//! which `FromJson` does not follow, and the schema written beside it describes what that reads:
//!
//! ```
//! use corten::{agent::Tools, json::schema::{FromJsonSchema, Generator}};
//! use serde::Deserialize;
//! #[derive(Deserialize)]
//! struct Adjust {
//!     #[serde(deserialize_with = "trimmed")]
//!     id: String,
//! }
//! fn trimmed<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
//!     String::deserialize(d).map(|id| id.trim().to_owned())
//! }
//! impl FromJsonSchema for Adjust {
//!     fn json_schema(_: &mut Generator) -> serde_json::Value {
//!         serde_json::json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] })
//!     }
//! }
//! impl corten::FromJson for Adjust {}
//! #[derive(corten::ToJson)]
//! struct Done { ok: bool }
//! let _ = Tools::new("t", "1").tool("adjust", "Adjust", |(), _: Adjust| async { Ok(Done { ok: true }) });
//! ```
//!
//! The same input deriving `FromJson` instead does too, with nothing written by hand:
//!
//! ```
//! use corten::agent::Tools;
//! #[derive(corten::FromJson)]
//! struct Adjust { id: String }
//! #[derive(corten::ToJson)]
//! struct Done { ok: bool }
//! let _ = Tools::new("t", "1").tool("adjust", "Adjust", |(), _: Adjust| async { Ok(Done { ok: true }) });
//! ```
//!
//! A form's input struct (`#[derive(Fields)]`, which is a `FromJson` too) can be the tool's input
//! as is, so the browser and the agent share one definition and one set of rules.
//!
//! Agents authenticate the way any other client does: a bearer token, never ambient cookies.
//! [`Tools::auth`] runs once per call, and its result is handed to the tool:
//!
//! ```ignore
//! let tools = Tools::new("card-market", env!("CARGO_PKG_VERSION"))
//!     .auth(|headers| auth::bearer(headers).ok_or(ToolError::Unauthorized))
//!     .tool("inventory.adjust", "Change the quantity of an inventory item", |user: User, input: Adjust| async move {
//!         Ok(Adjusted { quantity: inventory::adjust(&user, input).await? })
//!     });
//! // #[corten::routes(api = Mcp)] mod mcp { #[route("/mcp")] pub struct Mcp; }
//! let app = App::new(url::router()).api(|routes| mcp::api(routes).route::<mcp::Mcp>(tools.route()));
//! ```
//!
//! An endpoint whose tokens come from an OAuth authorization server says which one with
//! [`Tools::authorization`], as the MCP authorization spec asks: Corten serves the endpoint's
//! protected-resource metadata (RFC 9728) and names it in every 401, so a client that is refused
//! finds where to get a token from the refusal.
//!
//! A screen's data is already available to agents through [`crate::Req::screen`]; tools cover
//! the writes. Results go back as `structuredContent` and as the same JSON in a text block, for
//! clients that only read text. The output is written once, by its `ToJson` (a derived one
//! writes the JSON serde's `Serialize` would, laid out when the crate compiles), into the response
//! as is, so a tool returning a large shared value (`Arc<T>`) costs one write and no copy. As in
//! any `ToJson` answer, a field whose own `Serialize` fails (another crate's map with a key JSON
//! cannot hold, a path that is not UTF-8, a `SystemTime` before the epoch) panics where it is
//! written; for a tool's output the call catches that panic and answers it as the tool's internal
//! error (`isError`, "internal error"), logged with the tool's name and the panic's message. An
//! app built with `panic = "abort"` ends instead.
//!
//! An output needs `ToJson` and no `Serialize`. One written by serde, with a schema written by
//! hand, does not compile as one: derive `ToJson`, which writes the schema and the bytes from one
//! reading of the type. A `Serialize` type that has a schema but is not a `ToJson` (another
//! crate's, or a map of one) goes in a `#[serde(transparent)]` newtype that derives `ToJson`, one
//! impl that writes it by serde. A type whose schema is written by hand (one the derive refuses, or
//! another crate's type, in a newtype of the app's) writes its `ToJson` by hand too, beside its
//! `ToJsonSchema`, two impls you keep in step (deriving `ToJson` beside a hand-written schema is
//! E0119). A hand-written one writes exactly one JSON object, which goes into the response as
//! written: a debug build (`corten dev`, tests without `--release`) answers a call whose output is
//! not one with the app's 500 and a log line naming the tool. A release build answers one that does
//! not start with `{` and end with `}` as the tool's internal error, logged with its name, and
//! sends any other as written, so a broken object breaks the JSON-RPC answer around it (parsing it
//! there would add about 44% to a call):
//!
//! ```compile_fail,E0277
//! use corten::{agent::Tools, json::schema::{Generator, ToJsonSchema}};
//! #[derive(corten::FromJson)]
//! struct Adjust { id: String }
//! #[derive(serde::Serialize)]
//! struct Done { ok: bool }
//! impl ToJsonSchema for Done {
//!     fn json_schema(_: &mut Generator) -> serde_json::Value { serde_json::json!({ "type": "object" }) }
//! }
//! let _ = Tools::new("t", "1").tool("adjust", "Adjust", |(), _: Adjust| async { Ok(Done { ok: true }) });
//! ```
//!
//! Written by hand, it does. Here the output is another crate's type, which serde writes, in a
//! newtype of the app's:
//!
//! ```
//! use corten::{agent::Tools, json::schema::{Generator, ToJsonSchema}, ToJson};
//! mod other_crate {
//!     #[derive(serde::Serialize)]
//!     pub struct Done { pub ok: bool }
//! }
//! #[derive(corten::FromJson)]
//! struct Adjust { id: String }
//! struct Done(other_crate::Done);
//! impl ToJson for Done {
//!     fn write_json(&self, out: &mut Vec<u8>) {
//!         serde_json::to_writer(&mut *out, &self.0).expect("Done is written as JSON");
//!     }
//! }
//! impl ToJsonSchema for Done {
//!     fn json_schema(_: &mut Generator) -> serde_json::Value {
//!         serde_json::json!({ "type": "object", "properties": { "ok": { "type": "boolean" } } })
//!     }
//! }
//! let _ = Tools::new("t", "1").tool("adjust", "Adjust", |(), _: Adjust| async { Ok(Done(other_crate::Done { ok: true })) });
//! ```

use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};

use axum::{
    body::Bytes,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{json, Value};

use crate::json::{
    schema::{FromJsonSchema, Generator, ToJsonSchema},
    FromJson, ToJson,
};

/// Protocol revisions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

/// Why a tool call failed.
#[derive(Debug)]
pub enum ToolError {
    /// The arguments are wrong; the message goes back to the agent so it can correct them.
    Invalid(String),
    /// The arguments are fine, but what they act on has moved on (a stale revision, a record
    /// deleted meanwhile) or other work on it is under way
    /// ([`Errors::refuse`](crate::Errors::refuse)); the message goes back to the agent so it
    /// reads the current state (or, as the message says, waits for that work) before trying
    /// again.
    Refused(String),
    /// A service the tool calls failed ([`Refusal::Upstream`](crate::Refusal::Upstream)); the
    /// message goes back to the agent, which may try again later.
    Upstream(String),
    /// No valid credentials: the response is HTTP 401 so the client can authenticate.
    Unauthorized,
    /// The token is valid but lacks a scope this call needs. The text is the scopes to ask the
    /// authorization server for, space separated (`"inventory:read inventory:write"`; include
    /// those the client already holds that the call still needs, so it does not lose them). The
    /// response is HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the
    /// scopes, so the client asks for them and tries again.
    InsufficientScope(String),
    /// Authenticated but not allowed; the message goes back to the agent.
    Forbidden(String),
    /// Anything else. Logged; the agent only sees "internal error".
    Internal(Box<dyn std::error::Error + Send + Sync>),
}

impl ToolError {
    /// An unexpected failure (a database error, say): logged, and the agent sees "internal error".
    pub fn internal(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        ToolError::Internal(error.into())
    }
}

/// Validation errors go back to the agent as one message per field, so it can correct them; a
/// refusal for a state that moved on or work under way ([`Errors::refuse`](crate::Errors::refuse))
/// as that.
impl From<crate::Errors> for ToolError {
    fn from(errors: crate::Errors) -> Self {
        match errors.refusal() {
            crate::Refusal::Invalid => ToolError::Invalid(errors.to_string()),
            crate::Refusal::Conflict | crate::Refusal::Gone => ToolError::Refused(errors.to_string()),
            crate::Refusal::Upstream => ToolError::Upstream(errors.to_string()),
        }
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(error: serde_json::Error) -> Self {
        ToolError::Invalid(error.to_string())
    }
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = Result<T, ToolError>> + Send>>;
/// A tool, given who [`Tools::auth`] says is calling: its output as JSON text.
type Handler<A> = Arc<dyn Fn(A, Value) -> BoxFuture<String> + Send + Sync>;
type Auth<A> = Arc<dyn Fn(&HeaderMap) -> Result<A, ToolError> + Send + Sync>;

/// Where an MCP client gets a token for the endpoint: its OAuth 2.0 protected-resource metadata
/// (RFC 9728), given to [`Tools::authorization`]. Corten serves it as JSON at the endpoint's
/// well-known path (`/.well-known/oauth-protected-resource/mcp` for `/mcp`), and every 401 the
/// endpoint answers names it: `WWW-Authenticate: Bearer resource_metadata="https://cards.example/.well-known/oauth-protected-resource/mcp"`,
/// with `scope` when [`Authorization::scopes`] lists some. With one, every request to the
/// endpoint runs [`Tools::auth`] (`initialize` and `tools/list` too, as the spec asks), not only
/// a tool call.
///
/// The document's `resource` is the endpoint's URL, the origin and the path of the route it is
/// for (`https://cards.example/mcp`), which the token check takes from
/// [`Authorization::resource`] to refuse a token issued for another server, as the spec requires:
///
/// ```
/// use corten::{agent::{Authorization, ToolError, Tools}, prelude::*};
///
/// #[derive(Route)]
/// #[route("/mcp")]
/// struct Mcp;
///
/// # fn token_for(_: &corten::http::HeaderMap, _: &str) -> Option<()> { Some(()) }
/// let authorization = Authorization::new::<Mcp>("https://cards.example", "https://auth.example").scopes(&["inventory:read"]);
/// let audience = authorization.resource().to_string();
/// assert_eq!(audience, "https://cards.example/mcp");
/// let tools = Tools::new("card-market", "1.0")
///     .authorization(authorization)
///     .auth(move |headers| token_for(headers, &audience).ok_or(ToolError::Unauthorized));
/// # let _ = tools;
/// ```
///
/// The endpoint's path is the route's, a fixed path without a trailing slash, or the app does not
/// build:
///
/// ```compile_fail,E0080
/// use corten::{agent::Authorization, prelude::*};
///
/// #[derive(Route)]
/// #[route("/mcp/{tenant}")]
/// struct Mcp;
///
/// let _ = Authorization::new::<Mcp>("https://cards.example", "https://auth.example");
/// ```
///
/// The origin and the issuers are checked when they are given (an `https` URL, or `http` on
/// `localhost` or a loopback address for development; no path on the origin), so a typo is a
/// startup panic, not a document a client cannot use:
///
/// ```should_panic
/// # use corten::prelude::*;
/// # #[derive(Route)]
/// # #[route("/mcp")]
/// # struct Mcp;
/// corten::agent::Authorization::new::<Mcp>("https://cards.example/mcp", "https://auth.example");
/// ```
#[derive(Clone, Debug)]
pub struct Authorization {
    /// The endpoint's route path, which the route it is mounted at must have.
    path: &'static str,
    origin: String,
    resource: String,
    servers: Vec<String>,
    scopes: Vec<String>,
}

impl Authorization {
    /// The endpoint at route `R`, served on the app's origin as clients reach it
    /// (`https://cards.example`, from the deployment's settings), and the issuer of an
    /// authorization server that issues its tokens (`https://auth.example`). Mounted at another
    /// route, the app panics at startup.
    pub fn new<R: crate::Route>(origin: &str, server: &str) -> Self {
        const {
            assert!(
                resource_path(R::PATH),
                "corten: an MCP endpoint with an Authorization has a fixed path without a trailing slash (the note below names the route)"
            )
        };
        let origin = origin.strip_suffix('/').unwrap_or(origin);
        let origin = web_origin(origin)
            .unwrap_or_else(|| panic!("corten: Authorization::new takes the app's origin, a scheme and a host like https://cards.example, not {origin:?}"));
        let resource = if R::PATH == "/" { format!("{origin}/") } else { format!("{origin}{}", R::PATH) };
        Authorization { path: R::PATH, origin, resource, servers: Vec::new(), scopes: Vec::new() }.server(server)
    }

    /// The endpoint's URL, the `resource` its tokens are issued for (RFC 8707): what the token
    /// check compares a token's audience with.
    pub fn resource(&self) -> &str {
        &self.resource
    }

    /// Another authorization server whose tokens the endpoint takes; the client picks one.
    pub fn server(mut self, server: &str) -> Self {
        let (at, path) = server.find("://").map_or((server, ""), |scheme| match server[scheme + 3..].find('/') {
            Some(slash) => server.split_at(scheme + 3 + slash),
            None => (server, ""),
        });
        let issuer = web_origin(at).filter(|_| path.bytes().all(|b| b.is_ascii_graphic() && !b"\"\\?#".contains(&b)));
        let issuer = issuer.unwrap_or_else(|| {
            panic!("corten: an authorization server is its issuer URL, like https://auth.example, not {server:?}")
        });
        self.servers.push(format!("{issuer}{path}"));
        self
    }

    /// The scopes a client asks for to use the endpoint (`scopes_supported`), sent with every
    /// 401 as `scope` too; a call that needs more answers [`ToolError::InsufficientScope`].
    pub fn scopes(mut self, scopes: &[&str]) -> Self {
        for scope in scopes {
            assert!(scope_token(scope), "corten: a scope is printable ASCII with no space, quote or backslash, not {scope:?}");
            self.scopes.push(scope.to_string());
        }
        self
    }

    /// The metadata's route for an endpoint at `path`, and the 401's challenge into `challenge`.
    fn serve(&self, path: &'static str, challenge: &OnceLock<Challenge>) -> (String, axum::routing::MethodRouter) {
        assert!(
            path == self.path,
            "corten: the MCP endpoint is mounted at {path:?}, but its Authorization was made for the route at {:?}, the resource its tokens name",
            self.path
        );
        // RFC 9728 3.1: the well-known path goes between the host and the resource's path.
        let well_known = format!("/.well-known/oauth-protected-resource{}", path.trim_end_matches('/'));
        let metadata = format!("{}{well_known}", self.origin);
        let mut unauthorized = format!("Bearer resource_metadata=\"{metadata}\"");
        if !self.scopes.is_empty() {
            unauthorized.push_str(&format!(", scope=\"{}\"", self.scopes.join(" ")));
        }
        let unauthorized = HeaderValue::from_str(&unauthorized).expect("checked when given");
        assert!(challenge.set(Challenge { metadata, unauthorized }).is_ok(), "corten: an MCP endpoint is mounted once");
        let mut document = json!({
            "resource": self.resource,
            "authorization_servers": self.servers,
            "bearer_methods_supported": ["header"],
        });
        if !self.scopes.is_empty() {
            document["scopes_supported"] = json!(self.scopes);
        }
        let document = Bytes::from(document.to_string());
        // Public and read without credentials, so a client in a browser on any site may read it,
        // with the headers it sends (its preflight answered).
        let route = get(move || {
            let document = document.clone();
            async move {
                let headers = [
                    (header::CONTENT_TYPE, HeaderValue::from_static("application/json")),
                    (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600")),
                    (header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*")),
                ];
                (headers, document).into_response()
            }
        })
        .options(|headers: HeaderMap| async move {
            let mut res = StatusCode::NO_CONTENT.into_response();
            let out = res.headers_mut();
            out.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
            out.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET"));
            if let Some(asked) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
                out.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
            }
            res
        });
        (well_known, route)
    }
}

/// A route path an endpoint's resource can be made from: fixed, with no trailing slash but `/`.
const fn resource_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.is_empty() || bytes[0] != b'/' || (bytes.len() > 1 && bytes[bytes.len() - 1] == b'/') {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' || bytes[i] == b'?' || bytes[i] == b'#' {
            return false;
        }
        i += 1;
    }
    true
}

/// `https://host[:port]`, lowercase and without its default port, or `http://` on `localhost`
/// or a loopback address; `None` for anything else (a path, a bad port, another scheme).
fn web_origin(origin: &str) -> Option<String> {
    let origin = origin.to_ascii_lowercase();
    let (scheme, at) = origin.split_once("://")?;
    let (host, port) = match at.rsplit_once(':') {
        Some((host, _)) if !host.ends_with(']') && host.contains(':') => (at, None),
        Some((host, port)) => (host, Some(port)),
        None => (at, None),
    };
    let named = !host.is_empty()
        && !host.starts_with(['.', '-'])
        && !host.contains("..")
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b"-.".contains(&b));
    let v6 = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).and_then(|h| h.parse::<std::net::Ipv6Addr>().ok());
    if !named && v6.is_none() {
        return None;
    }
    // Parsed, so `:0443` is the default port and `:08443` is written `:8443`.
    let port = match port {
        None => None,
        Some(port) if port.bytes().all(|b| b.is_ascii_digit()) => Some(port.parse::<u16>().ok().filter(|port| *port != 0)?),
        Some(_) => return None,
    };
    // A name that only starts like an address (`127.attacker.example`) is a name.
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || v6.is_some_and(|ip| ip.is_loopback())
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback());
    let default = match scheme {
        "https" => 443,
        "http" if loopback => 80,
        _ => return None,
    };
    Some(match port.filter(|port| *port != default) {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// RFC 6749's `scope-token`: printable ASCII but space, `"` and `\`.
fn scope_token(scope: &str) -> bool {
    !scope.is_empty() && scope.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
}

/// What a refusal names, once the endpoint is mounted with an [`Authorization`].
struct Challenge {
    /// The metadata document's URL.
    metadata: String,
    /// The 401's `WWW-Authenticate`.
    unauthorized: HeaderValue,
}

struct Tool<A> {
    description: String,
    input_schema: Value,
    output_schema: Value,
    read_only: bool,
    /// Calling it again with the same arguments does nothing more (`idempotentHint`): its input
    /// requires a `SubmitKey`, or it was added with [`Tools::idempotent_tool`].
    idempotent: bool,
    handler: Handler<A>,
}

/// The tools one MCP endpoint offers. `A` is what [`Tools::auth`] proves about the caller (a
/// user, a scope); it is `()` until `auth` is set.
pub struct Tools<A = ()> {
    name: String,
    version: String,
    auth: Auth<A>,
    tools: Arc<BTreeMap<String, Tool<A>>>,
    authorization: Option<Arc<Authorization>>,
    challenge: Arc<OnceLock<Challenge>>,
}

impl<A> Clone for Tools<A> {
    fn clone(&self) -> Self {
        Tools {
            name: self.name.clone(),
            version: self.version.clone(),
            auth: self.auth.clone(),
            tools: self.tools.clone(),
            authorization: self.authorization.clone(),
            challenge: self.challenge.clone(),
        }
    }
}

impl Tools<()> {
    /// An endpoint whose tools anyone may call, until [`Tools::auth`] says otherwise.
    pub fn new(name: &str, version: &str) -> Self {
        Tools {
            name: name.into(),
            version: version.into(),
            auth: Arc::new(|_| Ok(())),
            tools: Arc::default(),
            authorization: None,
            challenge: Arc::default(),
        }
    }

    /// Checks every tool call before it runs (with an [`Authorization`], every request to the
    /// endpoint): `Err(ToolError::Unauthorized)` answers 401, and `Ok(caller)` is passed to the
    /// tool. It runs once per request. Set it before adding tools.
    pub fn auth<A, F>(self, auth: F) -> Tools<A>
    where
        F: Fn(&HeaderMap) -> Result<A, ToolError> + Send + Sync + 'static,
    {
        assert!(self.tools.is_empty(), "set Tools::auth before adding tools");
        Tools {
            name: self.name,
            version: self.version,
            auth: Arc::new(auth),
            tools: Arc::default(),
            authorization: self.authorization,
            challenge: self.challenge,
        }
    }
}

/// Whether an input's schema requires a [`crate::SubmitKey`] at its top level: known by the
/// key's pattern, which a field's doc comment does not replace.
fn keyed(input: &Value) -> bool {
    let required = input.get("required").and_then(Value::as_array);
    let properties = input.get("properties").and_then(Value::as_object);
    let (Some(required), Some(properties)) = (required, properties) else { return false };
    required
        .iter()
        .filter_map(Value::as_str)
        .any(|name| properties.get(name).and_then(|field| field.get("pattern")) == Some(&json!(crate::form::SUBMIT_KEY_PATTERN)))
}

impl<A: Send + 'static> Tools<A> {
    /// Where clients get a token for the endpoint ([`Authorization`]): Corten serves its
    /// protected-resource metadata next to the endpoint and names it in every 401. Without it a
    /// 401 says only `Bearer`, for tokens handed out by hand.
    pub fn authorization(mut self, authorization: Authorization) -> Self {
        self.authorization = Some(Arc::new(authorization));
        self
    }

    /// Adds a tool that changes data. A write only the call identifies (placing an order) takes
    /// a `submit: SubmitKey` field in its input, which the agent sends again on a retry. Such a
    /// tool is marked `idempotentHint`, which tells clients they may retry it on their own: that
    /// holds because the tool stores the key with the write and answers a repeat from it, so a
    /// tool never takes a key it does not store.
    pub fn tool<I, O, F, Fut>(self, name: &str, description: &str, handler: F) -> Self
    where
        I: FromJson + FromJsonSchema + Send + 'static,
        O: ToJson + ToJsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        self.add(name, description, false, false, handler)
    }

    /// Adds a tool that changes data and is idempotent without a key, since what it does is
    /// named by its arguments ("set the quantity to 5"): marked `idempotentHint`, so a client
    /// may call it again after a lost reply.
    pub fn idempotent_tool<I, O, F, Fut>(self, name: &str, description: &str, handler: F) -> Self
    where
        I: FromJson + FromJsonSchema + Send + 'static,
        O: ToJson + ToJsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        self.add(name, description, false, true, handler)
    }

    /// Adds a tool that only reads (marked `readOnlyHint`, so clients may call it without asking).
    pub fn read_tool<I, O, F, Fut>(self, name: &str, description: &str, handler: F) -> Self
    where
        I: FromJson + FromJsonSchema + Send + 'static,
        O: ToJson + ToJsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        self.add(name, description, true, true, handler)
    }

    fn add<I, O, F, Fut>(mut self, name: &str, description: &str, read_only: bool, idempotent: bool, handler: F) -> Self
    where
        I: FromJson + FromJsonSchema + Send + 'static,
        O: ToJson + ToJsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        // JSON Schema for the input as the server reads it and the output as it writes it. MCP
        // requires an object at the top.
        let input_schema = Generator::root_for_read::<I>();
        assert!(
            input_schema.get("type") == Some(&json!("object")),
            "tool {name}: the input must be a struct (MCP input schemas are objects)"
        );
        let idempotent = idempotent || keyed(&input_schema);
        let output_schema = Generator::root_for_write::<O>();
        assert!(
            output_schema.get("type") == Some(&json!("object")),
            "tool {name}: the output must be a struct (MCP structured content is an object)"
        );
        let handler = Arc::new(handler);
        let handler: Handler<A> = Arc::new(move |caller, args| {
            let handler = handler.clone();
            Box::pin(async move {
                let input: I = serde_json::from_value(args)?;
                let output = handler(caller, input).await?;
                // A value in the output that its `ToJson` cannot write (a field whose own
                // `Serialize` fails) panics there; the call answers it as the tool's internal
                // error, a JSON-RPC result the agent reads, as it did when serde wrote outputs.
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| output.to_json()))
                    .map_err(|panic| ToolError::internal(crate::task::panic_message(&*panic).to_owned()))
            })
        });
        let tools = Arc::get_mut(&mut self.tools).expect("add tools before serving");
        let tool = Tool { description: description.into(), input_schema, output_schema, read_only, idempotent, handler };
        assert!(tools.insert(name.into(), tool).is_none(), "tool {name} is defined twice");
        self
    }

    /// The `POST` route for the endpoint, usually mounted at `/mcp` under [`crate::App::api`]:
    /// `.api(|routes| mcp::api(routes).route::<mcp::Mcp>(tools.route()))`. With an
    /// [`Authorization`], its metadata's route comes with it, so it goes under an API, where
    /// Corten learns the endpoint's path.
    pub fn route<S: Clone + Send + Sync + 'static>(self) -> crate::Methods<S>
    where
        A: 'static,
    {
        let mut tools = self;
        // Each route has its own challenge, set when the metadata's route is placed.
        tools.challenge = Arc::default();
        let companion = tools.authorization.clone().map(|authorization| {
            let challenge = tools.challenge.clone();
            crate::route::Companion(Arc::new(move |path| authorization.serve(path, &challenge)))
        });
        let tools = Arc::new(tools);
        // Corten's own handler: it answers JSON-RPC errors in the protocol's shape itself.
        let methods = crate::Methods::writes(post(move |headers: HeaderMap, body: Bytes| {
            let tools = tools.clone();
            async move { tools.handle(headers, &body).await }
        }));
        crate::Methods(methods.0, methods.1, companion)
    }

    async fn handle(&self, headers: HeaderMap, body: &[u8]) -> Response {
        let message: Value = match serde_json::from_slice(body) {
            Ok(value) => value,
            Err(_) => return reply(Value::Null, Err((-32700, "parse error".into()))),
        };
        if !message.is_object() {
            // JSON-RPC batches were removed from MCP in 2025-06-18.
            return reply(Value::Null, Err((-32600, "invalid request: send one JSON-RPC message per request".into())));
        }
        let id = message.get("id").cloned();
        // An endpoint that names where to get a token takes one on every request, as the spec
        // asks, so a client without one is told where before it starts a session; a tool call
        // gets the caller found here.
        let mut caller = None;
        if self.authorization.is_some() {
            match (self.auth)(&headers) {
                Ok(found) => caller = Some(found),
                Err(error) => return self.refused(id.unwrap_or(Value::Null), error, &headers),
            }
        }
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let Some(id) = id else {
            // A notification (`notifications/initialized`) or a response: nothing to answer.
            return StatusCode::ACCEPTED.into_response();
        };
        if message.get("jsonrpc") != Some(&json!("2.0")) || method.is_empty() {
            return reply(id, Err((-32600, "invalid request".into())));
        }
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "tools/call" => match self.call(&headers, caller, params).await {
                Err(CallError::Refused(error)) => return self.refused(id, error, &headers),
                Err(CallError::Rpc(code, message)) => Err((code, message)),
                Ok(result) => return reply_raw(&id, &result),
            },
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": self.name, "version": self.version },
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.list() })),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        reply(id, result)
    }

    /// A request [`Tools::auth`] turned away, before any tool ran: 401 or 403 with the challenge
    /// for a token the check did not take, 403 for a caller it knows and refuses, 503 when it
    /// could not check (its provider is down), 500 (logged) for anything else. Never the answer.
    fn refused(&self, id: Value, error: ToolError, headers: &HeaderMap) -> Response {
        let (status, message) = match error {
            ToolError::Unauthorized => return self.unauthorized(id, bearer(headers)),
            ToolError::InsufficientScope(scope) => return self.forbidden(id, &scope),
            // A malformed request (RFC 6750 3.1), told so in the challenge.
            ToolError::Invalid(message) => {
                let mut res = reply(id, Err((-32600, format!("invalid request: {message}"))));
                *res.status_mut() = StatusCode::BAD_REQUEST;
                let challenge = HeaderValue::from_static(r#"Bearer error="invalid_request""#);
                res.headers_mut().insert(header::WWW_AUTHENTICATE, challenge);
                return res;
            }
            ToolError::Forbidden(message) | ToolError::Refused(message) => {
                (StatusCode::FORBIDDEN, format!("not allowed: {message}"))
            }
            ToolError::Upstream(message) => (StatusCode::SERVICE_UNAVAILABLE, format!("cannot check the token now: {message}")),
            ToolError::Internal(error) => {
                let error: &(dyn std::error::Error + 'static) = &*error;
                tracing::error!(error, "corten: the MCP endpoint's auth check failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        let code = if status == StatusCode::FORBIDDEN { -32001 } else { -32603 };
        let mut res = reply(id, Err((code, message)));
        *res.status_mut() = status;
        res
    }

    /// The 401: the challenge, and `error="invalid_token"` when the request sent one (RFC 6750
    /// 3.1; a request with no bearer token, or another scheme's credentials, is told only where
    /// to get one).
    fn unauthorized(&self, id: Value, sent: bool) -> Response {
        let mut res = reply(id, Err((-32001, "unauthorized".into())));
        *res.status_mut() = StatusCode::UNAUTHORIZED;
        let mut challenge = self.challenge.get().map_or(HeaderValue::from_static("Bearer"), |c| c.unauthorized.clone());
        if sent {
            let text =
                [challenge.as_bytes(), if challenge.len() > 6 { b", " } else { b" " }, br#"error="invalid_token""#].concat();
            challenge = HeaderValue::from_bytes(&text).expect("made of a header value and ASCII");
        }
        res.headers_mut().insert(header::WWW_AUTHENTICATE, challenge);
        res
    }

    /// The 403 for a token without a scope the request needs.
    fn forbidden(&self, id: Value, scope: &str) -> Response {
        let mut res = reply(id, Err((-32001, "insufficient scope".into())));
        *res.status_mut() = StatusCode::FORBIDDEN;
        res.headers_mut().insert(header::WWW_AUTHENTICATE, self.insufficient_scope(scope));
        res
    }

    /// The 403's `WWW-Authenticate` for a call that needs `scope`.
    fn insufficient_scope(&self, scope: &str) -> HeaderValue {
        let mut value = String::from("Bearer error=\"insufficient_scope\"");
        if scope.split(' ').all(scope_token) {
            value.push_str(&format!(", scope=\"{scope}\""));
        } else {
            // A test or `corten dev` stops at it; a release build sends the 403 without it.
            debug_assert!(false, "corten: ToolError::InsufficientScope names scopes separated by single spaces, not {scope:?}");
            tracing::error!(scope, "corten: ToolError::InsufficientScope names scopes separated by single spaces");
        }
        if let Some(challenge) = self.challenge.get() {
            value.push_str(&format!(", resource_metadata=\"{}\"", challenge.metadata));
        }
        HeaderValue::from_str(&value).expect("every part is printable ASCII")
    }

    fn list(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|(name, tool)| {
                json!({
                    "name": name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                    "outputSchema": tool.output_schema,
                    "annotations": { "readOnlyHint": tool.read_only, "idempotentHint": tool.idempotent },
                })
            })
            .collect()
    }

    /// The call's `result`, as JSON text, for `caller` when the request's check found it already.
    async fn call(&self, headers: &HeaderMap, caller: Option<A>, params: Value) -> Result<String, CallError> {
        let name = params.get("name").and_then(Value::as_str).ok_or(CallError::Rpc(-32602, "missing tool name".into()))?;
        let tool = self.tools.get(name).ok_or_else(|| CallError::Rpc(-32602, format!("unknown tool: {name}")))?;
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err(CallError::Rpc(-32602, "arguments must be an object".into()));
        }
        // Tool failures are results with isError, so the agent can read them and retry.
        let caller = match caller {
            Some(caller) => caller,
            None => match (self.auth)(headers) {
                Ok(caller) => caller,
                Err(error @ (ToolError::Unauthorized | ToolError::InsufficientScope(_))) => {
                    return Err(CallError::Refused(error))
                }
                // Other refusals are the tool's result, as they were before a check per request.
                Err(error) => return Ok(self.failed(name, error)),
            },
        };
        match (tool.handler)(caller, args).await {
            Ok(output) => {
                // A hand-written `ToJson` goes into the envelope as written. A debug build parses it
                // and answers one that is not one JSON object with a 500 (the panic, logged with the
                // tool's name). Parsing it in a release build would add about 44% to a call (card-
                // market's `tool_cost`), so there only its ends are checked: one that is not an object
                // at all is the tool's internal error, and a broken object is sent as written.
                let shown = || output.char_indices().nth(80).map_or(&output[..], |(end, _)| &output[..end]);
                debug_assert!(
                    output.trim_start().starts_with('{') && serde_json::from_str::<serde::de::IgnoredAny>(&output).is_ok(),
                    "corten: tool {name}'s output ToJson must write one JSON object, not {}",
                    shown()
                );
                let ends = output.trim_ascii();
                if !(ends.starts_with('{') && ends.ends_with('}')) {
                    let error = format!("its output ToJson must write one JSON object, not {}", shown());
                    return Ok(self.failed(name, ToolError::internal(error)));
                }
                // The output as written, and once more as a JSON string for the text block, into
                // one string sized for both: a large result is not copied as it grows.
                let text = serde_json::to_string(&output).map_err(|e| CallError::Rpc(-32603, e.to_string()))?;
                Ok([
                    r#"{"content":[{"type":"text","text":"#,
                    &text,
                    r#"}],"structuredContent":"#,
                    &output,
                    r#","isError":false}"#,
                ]
                .concat())
            }
            Err(error @ (ToolError::Unauthorized | ToolError::InsufficientScope(_))) => Err(CallError::Refused(error)),
            Err(error) => Ok(self.failed(name, error)),
        }
    }

    /// A tool's failure as its result, with `isError`, so the agent can read it and retry.
    fn failed(&self, name: &str, error: ToolError) -> String {
        let text = match error {
            ToolError::Invalid(message) => format!("invalid arguments: {message}"),
            ToolError::Refused(message) => format!("refused, read the current state first: {message}"),
            ToolError::Upstream(message) => format!("a service it calls failed, try again later: {message}"),
            ToolError::Forbidden(message) => format!("not allowed: {message}"),
            ToolError::Unauthorized | ToolError::InsufficientScope(_) => unreachable!("answered with a 401 or 403"),
            ToolError::Internal(error) => {
                let error: &(dyn std::error::Error + 'static) = &*error;
                tracing::error!(tool = name, error, "corten: agent tool failed");
                "internal error".into()
            }
        };
        json!({ "content": [{ "type": "text", "text": text }], "isError": true }).to_string()
    }
}

/// Whether the request sent a bearer token (RFC 6750: another scheme's credentials are no token).
fn bearer(headers: &HeaderMap) -> bool {
    headers.get(header::AUTHORIZATION).is_some_and(|value| {
        let value = value.as_bytes();
        value.len() > 7 && value[..7].eq_ignore_ascii_case(b"bearer ")
    })
}

enum CallError {
    /// The check turned the call away (`Unauthorized`, `InsufficientScope`): a 401 or 403.
    Refused(ToolError),
    Rpc(i64, String),
}

fn reply(id: Value, result: Result<Value, (i64, String)>) -> Response {
    let body = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    };
    json_response(body.to_string())
}

/// A successful reply whose `result` is JSON text already, written into the body as is.
fn reply_raw(id: &Value, result: &str) -> Response {
    json_response([r#"{"id":"#, &id.to_string(), r#","jsonrpc":"2.0","result":"#, result, "}"].concat())
}

fn json_response(body: String) -> Response {
    ([(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, Router};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// Change an item's quantity.
    #[derive(crate::json::FromJson)]
    struct Adjust {
        id: String,
        /// Added to the quantity; negative to remove.
        delta: i64,
        #[serde(default)]
        note: Option<String>,
    }

    #[derive(crate::json::ToJson)]
    struct Adjusted {
        id: String,
        quantity: i64,
    }

    #[derive(crate::json::FromJson)]
    struct Nothing {}

    #[test]
    fn a_refusal_reaches_an_agent_as_what_it_can_do_about_it() {
        let refused = |why, text: &str| {
            let mut errors = crate::Errors::new();
            errors.refuse(why, text);
            ToolError::from(errors)
        };
        assert!(matches!(refused(crate::Refusal::Conflict, "moved"), ToolError::Refused(m) if m == "moved"));
        assert!(matches!(refused(crate::Refusal::Gone, "gone"), ToolError::Refused(m) if m == "gone"));
        assert!(matches!(refused(crate::Refusal::Upstream, "no answer"), ToolError::Upstream(m) if m == "no answer"));
    }

    #[derive(crate::json::ToJson)]
    struct Pong {
        pong: bool,
    }

    /// The caller, as the auth check proves it.
    #[derive(Clone)]
    struct Agent(String);

    fn app() -> Router {
        let tools = Tools::new("test", "1.0")
            .auth(|headers| {
                let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
                token.map(|t| Agent(t.to_string())).ok_or(ToolError::Unauthorized)
            })
            .tool("inventory.adjust", "Adjust quantity", |agent: Agent, input: Adjust| async move {
                if input.id == "locked" {
                    return Err(ToolError::Forbidden(format!("{} may not change a locked item", agent.0)));
                }
                let _ = input.note;
                Ok(Adjusted { id: input.id, quantity: 10 + input.delta })
            })
            .read_tool("ping", "Answers pong", |_: Agent, _: Nothing| async { Ok(Pong { pong: true }) });
        Router::new().route("/mcp", tools.route().0)
    }

    async fn rpc(body: Value, auth: bool) -> (StatusCode, Value) {
        let mut req = Request::post("/mcp").header("content-type", "application/json");
        if auth {
            req = req.header("authorization", "Bearer ada");
        }
        let res = app().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() })
    }

    #[tokio::test]
    async fn initialize_negotiates_the_protocol_version() {
        let (_, res) = rpc(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
            false,
        )
        .await;
        assert_eq!(res["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(res["result"]["serverInfo"]["name"], "test");
        let (_, res) = rpc(
            json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } }),
            false,
        )
        .await;
        assert_eq!(res["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
        let (status, _) = rpc(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), false).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn schemas_come_from_the_input_and_output_types() {
        let (_, res) = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }), false).await;
        let tools = res["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "inventory.adjust");
        assert_eq!(
            tools[0]["inputSchema"],
            json!({
                "description": "Change an item's quantity.",
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "delta": { "description": "Added to the quantity; negative to remove.", "type": "integer", "format": "int64" },
                    "note": { "type": ["string", "null"], "default": null }
                },
                "required": ["id", "delta"]
            })
        );
        assert_eq!(tools[0]["outputSchema"]["required"], json!(["id", "quantity"]));
        assert_eq!(tools[0]["annotations"], json!({ "readOnlyHint": false, "idempotentHint": false }), "a write with no key");
        assert_eq!(tools[1]["annotations"], json!({ "readOnlyHint": true, "idempotentHint": true }));
    }

    #[tokio::test]
    async fn calls_are_authorized_then_typed() {
        let call = |args: Value| json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "inventory.adjust", "arguments": args } });
        let (_, res) = rpc(call(json!({ "id": "a", "delta": 2 })), true).await;
        assert_eq!(res["id"], 7);
        assert_eq!(res["result"]["structuredContent"], json!({ "id": "a", "quantity": 12 }));
        assert_eq!(res["result"]["isError"], false);
        let text: Value = serde_json::from_str(res["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, res["result"]["structuredContent"], "the text block is the same JSON");
        let (_, res) = rpc(call(json!({ "id": "a" })), true).await;
        assert_eq!(res["result"]["isError"], true);
        assert!(res["result"]["content"][0]["text"].as_str().unwrap().starts_with("invalid arguments: missing field `delta`"));
        let (_, res) = rpc(call(json!({ "id": "a", "delta": "two" })), true).await;
        assert!(res["result"]["content"][0]["text"].as_str().unwrap().starts_with("invalid arguments: invalid type"));
        let (_, res) = rpc(call(json!({ "id": "locked", "delta": 1 })), true).await;
        assert_eq!(res["result"]["content"][0]["text"], "not allowed: ada may not change a locked item");
        let (status, res) = rpc(call(json!({ "id": "a" })), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "auth runs before the input is read");
        assert_eq!(res["error"]["code"], -32001);
    }

    #[tokio::test]
    async fn bad_requests_get_json_rpc_errors() {
        let (_, res) = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "nope" }), false).await;
        assert_eq!(res["error"]["code"], -32601);
        let (_, res) =
            rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "missing" } }), false).await;
        assert_eq!(res["error"]["code"], -32602);
        let res = app().oneshot(Request::post("/mcp").body(Body::from("{")).unwrap()).await.unwrap();
        let body: Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["error"]["code"], -32700);
        let (status, res) = rpc(json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }]), false).await;
        assert_eq!((status, res["error"]["code"].clone()), (StatusCode::OK, json!(-32600)), "batches are refused, not accepted");
    }

    #[test]
    #[should_panic(expected = "the input must be a struct")]
    fn a_non_object_input_is_refused_at_startup() {
        let _ = Tools::new("t", "1").tool("bad", "", |_: (), _: String| async { Ok(Pong { pong: true }) });
    }

    #[derive(crate::Route)]
    #[route("/mcp")]
    struct Mcp;

    /// A value inside a tool's output that serde cannot write (here, one whose `Serialize`
    /// fails): the call answers it as the tool's internal error, a JSON-RPC result with the call's
    /// `id`, and logs the tool's name with serde's message.
    #[tokio::test]
    async fn an_output_that_cannot_be_written_is_the_tools_internal_error() {
        struct Unwritable;
        impl serde::Serialize for Unwritable {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("not JSON"))
            }
        }
        impl ToJsonSchema for Unwritable {
            fn json_schema(_: &mut Generator) -> Value {
                json!({})
            }
        }
        #[derive(crate::json::ToJson)]
        struct Out {
            value: Unwritable,
        }
        let tools = Tools::new("test", "1.0")
            .read_tool("broken", "Fails to write", |(), _: Nothing| async { Ok(Out { value: Unwritable }) });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "broken", "arguments": {} } });
        let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(call.to_string())).unwrap();
        let ((status, _, body), text) = logging(send(&app, req)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["id"], 7, "{body}");
        assert_eq!(body["result"]["isError"], true, "{body}");
        assert_eq!(body["result"]["content"][0]["text"], "internal error", "{body}");
        assert!(
            text.lines().any(|line| line.contains("agent tool failed") && line.contains("broken") && line.contains("not JSON")),
            "the log names the tool and serde's message: {text}"
        );
    }

    /// A hand-written output `ToJson` that writes something other than one JSON object stops a
    /// test at the call, naming the tool, rather than sending a broken answer.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn a_hand_written_output_that_is_not_one_object_stops_a_test() {
        struct Listed;
        impl ToJson for Listed {
            fn write_json(&self, out: &mut Vec<u8>) {
                out.extend_from_slice(b"[1]");
            }
        }
        impl ToJsonSchema for Listed {
            fn json_schema(_: &mut Generator) -> Value {
                json!({ "type": "object" })
            }
        }
        let tools = Tools::new("test", "1.0").read_tool("listed", "Writes an array", |(), _: Nothing| async { Ok(Listed) });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "listed", "arguments": {} } });
        let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(call.to_string())).unwrap();
        let ((status, _, body), text) = logging(send(&app, req)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(text.contains("tool listed's output ToJson must write one JSON object, not [1]"), "{text}");
    }

    /// A release build answers a hand-written output that is not an object at all as the tool's
    /// internal error, naming the tool in the log, and sends an object as written without parsing
    /// it.
    #[cfg(not(debug_assertions))]
    #[tokio::test]
    async fn a_release_build_checks_only_a_hand_written_outputs_ends() {
        struct Written(&'static str);
        impl ToJson for Written {
            fn write_json(&self, out: &mut Vec<u8>) {
                out.extend_from_slice(self.0.as_bytes());
            }
        }
        impl ToJsonSchema for Written {
            fn json_schema(_: &mut Generator) -> Value {
                json!({ "type": "object" })
            }
        }
        let tools = Tools::new("test", "1.0")
            .read_tool("listed", "Writes an array", |(), _: Nothing| async { Ok(Written("[1]")) })
            .read_tool("spaced", "Writes an object", |(), _: Nothing| async { Ok(Written(" {\"a\":1} ")) });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        let call = |tool: &str| {
            let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": tool, "arguments": {} } });
            Request::post("/mcp").header("content-type", "application/json").body(Body::from(call.to_string())).unwrap()
        };
        let ((status, _, body), text) = logging(send(&app, call("listed"))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["id"], 7, "{body}");
        assert_eq!(body["result"]["isError"], true, "{body}");
        assert_eq!(body["result"]["content"][0]["text"], "internal error", "{body}");
        assert!(text.contains("listed") && text.contains("must write one JSON object, not [1]"), "{text}");
        let (status, _, body) = send(&app, call("spaced")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""structuredContent": {"a":1} ,"isError":false"#), "{body}");
    }

    /// Another crate's `Serialize` type with a schema is a tool's whole output in a
    /// `#[serde(transparent)]` newtype that derives `ToJson`: serde writes its bytes, and its
    /// schema is the output's.
    #[tokio::test]
    async fn an_output_can_be_another_crates_type_in_a_transparent_newtype() {
        #[derive(serde::Serialize)]
        struct Theirs {
            ok: bool,
            #[serde(rename = "seenAt")]
            seen_at: u32,
        }
        impl ToJsonSchema for Theirs {
            fn json_schema(_: &mut Generator) -> Value {
                json!({ "type": "object", "properties": { "ok": { "type": "boolean" }, "seenAt": { "type": "integer" } }, "required": ["ok", "seenAt"] })
            }
        }
        #[derive(crate::json::ToJson)]
        #[serde(transparent)]
        struct Done(Theirs);
        let tools = Tools::new("test", "1.0")
            .read_tool("theirs", "Another crate's", |(), _: Nothing| async { Ok(Done(Theirs { ok: true, seen_at: 3 })) });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(list.to_string())).unwrap();
        let (status, _, body) = send(&app, req).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let listed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(listed["result"]["tools"][0]["outputSchema"], Generator::root_for_write::<Theirs>(), "{body}");
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "theirs", "arguments": {} } });
        let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(call.to_string())).unwrap();
        let (status, _, body) = send(&app, req).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""structuredContent":{"ok":true,"seenAt":3}"#), "{body}");
    }

    /// A tool's input can be any object, read whole (`serde_json::Map`), and an integer-keyed map
    /// is one inside a newtype that derives `FromJson`.
    #[tokio::test]
    async fn an_input_can_be_any_object_or_a_map_in_a_newtype() {
        #[derive(crate::json::FromJson)]
        #[serde(transparent)]
        struct Counts(std::collections::BTreeMap<u32, u32>);
        #[derive(crate::json::ToJson)]
        struct Size {
            n: usize,
        }
        let tools = Tools::new("test", "1.0")
            .read_tool(
                "any",
                "Any object",
                |(), input: serde_json::Map<String, Value>| async move { Ok(Size { n: input.len() }) },
            )
            .read_tool("counts", "Counts by id", |(), input: Counts| async move { Ok(Size { n: input.0.len() }) });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        for (tool, arguments) in [("any", json!({ "a": 1, "b": [2] })), ("counts", json!({ "1": 2, "7": 3 }))] {
            let call =
                json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": tool, "arguments": arguments } });
            let req =
                Request::post("/mcp").header("content-type", "application/json").body(Body::from(call.to_string())).unwrap();
            let (status, _, body) = send(&app, req).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body.contains(r#""structuredContent":{"n":2}"#), "{tool}: {body}");
        }
    }

    /// A tool's output can hold text the app wrote (`Raw`), sent as it is.
    #[tokio::test]
    async fn an_output_can_hold_raw_json() {
        #[derive(crate::json::ToJson)]
        struct Quoted {
            quote: crate::json::Raw,
        }
        let tools = Tools::new("test", "1.0").read_tool("quote", "Quotes", |(), _: Nothing| async {
            Ok(Quoted { quote: crate::json::Raw::new(r#"{"price":2.50,"at":[1, 2]}"#).unwrap() })
        });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "quote", "arguments": {} } });
        let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(call.to_string())).unwrap();
        let (status, _, body) = send(&app, req).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""structuredContent":{"quote":{"price":2.50,"at":[1, 2]}}"#), "{body}");
    }

    /// `answer`'s result, with what the app logged on this thread while it ran.
    async fn logging<T>(answer: impl Future<Output = T>) -> (T, String) {
        #[derive(Clone, Default)]
        struct Lines(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Lines {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let lines = Lines::default();
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        let guard = tracing::subscriber::set_default(subscriber);
        let out = answer.await;
        drop(guard);
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        (out, text)
    }

    /// An app whose agents get tokens from an authorization server: `reader` may read, `writer`
    /// may write too.
    fn protected(authorization: Option<Authorization>) -> Router {
        let tools = Tools::new("test", "1.0");
        let tools = match authorization {
            Some(authorization) => tools.authorization(authorization),
            None => tools,
        };
        let tools = tools
            .auth(|headers| {
                let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
                token.filter(|t| *t != "expired").map(|t| Agent(t.to_string())).ok_or(ToolError::Unauthorized)
            })
            .tool("inventory.adjust", "Adjust quantity", |agent: Agent, input: Adjust| async move {
                if agent.0 != "writer" {
                    return Err(ToolError::InsufficientScope("inventory:read inventory:write".into()));
                }
                Ok(Adjusted { id: input.id, quantity: input.delta })
            });
        crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router()
    }

    async fn send(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let res = app.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        (parts.status, parts.headers, String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap())
    }

    /// With an [`Authorization`], a check that fails for any reason answers before any method
    /// does (an identity provider that is down never lists the tools), and a tool call runs the
    /// check once.
    #[tokio::test]
    async fn the_check_runs_once_and_every_failure_of_it_is_answered() {
        let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = checks.clone();
        let tools = Tools::new("test", "1.0")
            .authorization(Authorization::new::<Mcp>("https://cards.example", "https://auth.example"))
            .auth(move |headers| {
                counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                match headers.get("authorization").and_then(|v| v.to_str().ok()) {
                    Some("Bearer banned") => Err(ToolError::Forbidden("suspended".into())),
                    Some("Bearer idp-down") => Err(ToolError::Upstream("the identity provider timed out".into())),
                    Some("Bearer broken") => Err(ToolError::internal("bad key")),
                    Some("Bearer two words") => Err(ToolError::Invalid("one token".into())),
                    Some(_) => Ok(Agent("writer".into())),
                    None => Err(ToolError::Unauthorized),
                }
            })
            .tool("inventory.adjust", "Adjust quantity", |_: Agent, input: Adjust| async move {
                Ok(Adjusted { id: input.id, quantity: input.delta })
            });
        let app = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route())).router();
        let rpc = |token: &str, method: &str| {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": { "name": "inventory.adjust", "arguments": { "id": "a", "delta": 1 } } });
            let req = Request::post("/mcp")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"));
            req.body(Body::from(body.to_string())).unwrap()
        };
        for (token, status, code) in [
            ("banned", StatusCode::FORBIDDEN, -32001),
            ("idp-down", StatusCode::SERVICE_UNAVAILABLE, -32603),
            ("broken", StatusCode::INTERNAL_SERVER_ERROR, -32603),
            ("two words", StatusCode::BAD_REQUEST, -32600),
        ] {
            for method in ["initialize", "tools/list", "tools/call"] {
                let (got, _, body) = send(&app, rpc(token, method)).await;
                assert_eq!(got, status, "{token} {method}: {body}");
                let body: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(body["error"]["code"], code, "{token} {method}");
                assert!(body.get("result").is_none(), "{token} {method}: no tools listed");
            }
        }
        checks.store(0, std::sync::atomic::Ordering::Relaxed);
        let (status, _, _) = send(&app, rpc("good", "tools/call")).await;
        assert_eq!((status, checks.load(std::sync::atomic::Ordering::Relaxed)), (StatusCode::OK, 1), "one check per call");
    }

    fn adjust(token: Option<&str>) -> Request<Body> {
        let mut req = Request::post("/mcp").header("content-type", "application/json");
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "inventory.adjust", "arguments": { "id": "a", "delta": 1 } } });
        req.body(Body::from(call.to_string())).unwrap()
    }

    #[tokio::test]
    async fn a_client_finds_where_to_get_a_token_from_the_refusal() {
        let authorization =
            Authorization::new::<Mcp>("https://Cards.example:443/", "https://auth.example").scopes(&["inventory:read"]);
        assert_eq!(authorization.resource(), "https://cards.example/mcp", "what the token check compares the audience with");
        let app = protected(Some(authorization));
        // Other credentials than a bearer token are no token: told where to get one, nothing more.
        let basic = Request::post("/mcp").header("content-type", "application/json").header("authorization", "Basic YTpi");
        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "inventory.adjust", "arguments": {} } });
        let (status, headers, _) = send(&app, basic.body(Body::from(call.to_string())).unwrap()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers["www-authenticate"].to_str().unwrap().contains("invalid_token"), "{headers:?}");
        let (status, headers, body) = send(&app, adjust(None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let metadata = "https://cards.example/.well-known/oauth-protected-resource/mcp";
        assert_eq!(headers["www-authenticate"], format!(r#"Bearer resource_metadata="{metadata}", scope="inventory:read""#));
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32001);
        // A token that was sent and refused is named invalid (RFC 6750 3.1).
        let (status, headers, _) = send(&app, adjust(Some("expired"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            headers["www-authenticate"],
            format!(r#"Bearer resource_metadata="{metadata}", scope="inventory:read", error="invalid_token""#)
        );
        // The session cannot start without a token, so the client is told where to get one first.
        for method in ["initialize", "tools/list", "ping"] {
            let req = Request::post("/mcp").header("content-type", "application/json");
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": { "protocolVersion": "2025-11-25" } });
            let (status, headers, _) = send(&app, req.body(Body::from(body.to_string())).unwrap()).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method}");
            assert!(headers["www-authenticate"].to_str().unwrap().contains(metadata), "{method}");
        }
        // The client reads the document the challenge names, at the endpoint's well-known path.
        let path = metadata.strip_prefix("https://cards.example").unwrap();
        let (status, headers, body) = send(&app, Request::get(path).body(Body::empty()).unwrap()).await;
        assert_eq!((status, &headers["content-type"]), (StatusCode::OK, &HeaderValue::from_static("application/json")));
        assert_eq!(
            (&headers["cache-control"], &headers["access-control-allow-origin"]),
            (&HeaderValue::from_static("public, max-age=3600"), &HeaderValue::from_static("*"))
        );
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({
                "resource": "https://cards.example/mcp",
                "authorization_servers": ["https://auth.example"],
                "bearer_methods_supported": ["header"],
                "scopes_supported": ["inventory:read"],
            }),
            "RFC 9728: the resource is the URL the client called"
        );
        // A browser client's preflight for it, with a header of its own.
        let preflight = Request::options(path)
            .header("origin", "https://inspector.example")
            .header("access-control-request-method", "GET")
            .header("access-control-request-headers", "mcp-protocol-version");
        let (status, headers, _) = send(&app, preflight.body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            (&headers["access-control-allow-origin"], &headers["access-control-allow-headers"]),
            (&HeaderValue::from_static("*"), &HeaderValue::from_static("mcp-protocol-version"))
        );
        // A token without the scope a call needs is told which to ask for.
        let (status, headers, _) = send(&app, adjust(Some("reader"))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            headers["www-authenticate"],
            format!(
                r#"Bearer error="insufficient_scope", scope="inventory:read inventory:write", resource_metadata="{metadata}""#
            )
        );
        let (status, _, body) = send(&app, adjust(Some("writer"))).await;
        assert_eq!(
            (status, serde_json::from_str::<Value>(&body).unwrap()["result"]["isError"].clone()),
            (StatusCode::OK, json!(false))
        );
    }

    #[tokio::test]
    async fn without_an_authorization_a_refusal_names_no_metadata() {
        let app = protected(None);
        let (status, headers, _) = send(&app, adjust(None)).await;
        assert_eq!((status, &headers["www-authenticate"]), (StatusCode::UNAUTHORIZED, &HeaderValue::from_static("Bearer")));
        let (_, headers, _) = send(&app, adjust(Some("expired"))).await;
        assert_eq!(headers["www-authenticate"], r#"Bearer error="invalid_token""#);
        let list = Request::post("/mcp").header("content-type", "application/json");
        let list = list.body(Body::from(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string()));
        assert_eq!(send(&app, list.unwrap()).await.0, StatusCode::OK, "tokens are checked per call, as before");
        let (status, headers, _) = send(&app, adjust(Some("reader"))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(headers["www-authenticate"], r#"Bearer error="insufficient_scope", scope="inventory:read inventory:write""#);
        let (status, ..) =
            send(&app, Request::get("/.well-known/oauth-protected-resource/mcp").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "no document is served");
    }

    #[derive(crate::Route)]
    #[route("/")]
    struct Root;

    /// Turns every request away.
    struct Deny;

    impl crate::Middleware for Deny {
        async fn call(&self, _: axum::extract::Request, _: impl crate::middleware::Next) -> Response {
            crate::Refused::unauthorized().into_response()
        }
    }

    /// The document is Corten's own, as the health checks are: an API whose prefix holds its path
    /// (the whole app, `/`) does not answer it, nor does its middleware run for it.
    #[tokio::test]
    async fn the_metadata_is_not_the_apis_around_it() {
        let tools =
            Tools::new("t", "1").authorization(Authorization::new::<Mcp>("https://cards.example", "https://auth.example"));
        let app =
            crate::App::new(crate::Routes::new()).api::<Root>(|api| api.route::<Mcp>(tools.route()).middleware(Deny)).router();
        let (status, _, body) =
            send(&app, Request::get("/.well-known/oauth-protected-resource/mcp").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(send(&app, adjust(None)).await.0, StatusCode::UNAUTHORIZED, "the API's own route meets its middleware");
    }

    #[derive(crate::Route)]
    #[route("/.well-known")]
    struct WellKnown;

    /// An endpoint in an area keeps its metadata out of an area around the well-known path, as
    /// one under an API does.
    #[tokio::test]
    async fn the_metadata_is_not_an_areas_around_it() {
        let tools =
            Tools::new("t", "1").authorization(Authorization::new::<Mcp>("https://cards.example", "https://auth.example"));
        let app = crate::App::new(crate::Routes::new())
            .area::<Mcp>(|area| area.route::<Mcp>(tools.route()))
            .area::<WellKnown>(|area| area.middleware(Deny))
            .router();
        let (status, _, body) =
            send(&app, Request::get("/.well-known/oauth-protected-resource/mcp").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[test]
    fn an_origin_is_https_or_loopback_and_written_one_way() {
        for (given, origin) in [
            ("https://Cards.Example", Some("https://cards.example")),
            ("https://cards.example:443", Some("https://cards.example")),
            ("https://cards.example:8443", Some("https://cards.example:8443")),
            ("http://localhost:3000", Some("http://localhost:3000")),
            ("http://127.0.0.1", Some("http://127.0.0.1")),
            ("https://[::1]:8443", Some("https://[::1]:8443")),
            ("http://cards.example", None),
            ("https://cards.example:abc", None),
            ("https://cards.example:", None),
            ("https://..", None),
            ("https://cards.example/mcp", None),
            ("cards.example", None),
            ("ftp://cards.example", None),
            // A name that starts like a loopback address is a name, on plain http refused.
            ("http://127.attacker.example", None),
            ("http://[::2]", None),
            ("https://[a\"b]", None),
            ("https://[::1", None),
            ("https://cards.example:0", None),
            ("https://cards.example:99999", None),
            ("https://cards.example:65535", Some("https://cards.example:65535")),
            ("https://cards.example:0443", Some("https://cards.example")),
            ("https://cards.example:08443", Some("https://cards.example:8443")),
        ] {
            assert_eq!(web_origin(given).as_deref(), origin, "{given}");
        }
        assert!(resource_path("/mcp") && resource_path("/") && resource_path("/api/mcp"));
        assert!(!resource_path("/mcp/") && !resource_path("/mcp/{id}") && !resource_path("mcp"));
    }

    #[test]
    #[should_panic(expected = "an authorization server is its issuer URL")]
    fn an_issuer_on_plain_http_is_refused_at_startup() {
        let _ = Authorization::new::<Mcp>("https://cards.example", "http://auth.example");
    }

    #[derive(crate::Route)]
    #[route("/agents")]
    struct Agents;

    #[test]
    #[should_panic(expected = "but its Authorization was made for the route at \"/agents\"")]
    fn an_endpoint_mounted_at_another_route_is_refused_at_startup() {
        let tools =
            Tools::new("t", "1").authorization(Authorization::new::<Agents>("https://cards.example", "https://auth.example"));
        let _ = crate::App::new(crate::Routes::new()).api::<Mcp>(|api| api.route::<Mcp>(tools.route()));
    }

    /// An endpoint in an area (one its middleware guards) has its metadata served as under an
    /// API, outside the area, and named in its 401.
    #[tokio::test]
    async fn an_endpoint_in_an_area_serves_its_metadata_too() {
        let tools = Tools::new("t", "1")
            .authorization(Authorization::new::<Mcp>("https://cards.example", "https://auth.example"))
            .auth(|_| Err::<(), _>(ToolError::Unauthorized));
        let app = crate::App::new(crate::Routes::new()).area::<Mcp>(|area| area.route::<Mcp>(tools.route())).router();
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string();
        let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(body)).unwrap();
        let (status, headers, _) = send(&app, req).await;
        let metadata = "https://cards.example/.well-known/oauth-protected-resource/mcp";
        assert_eq!(
            (status, &headers["www-authenticate"]),
            (StatusCode::UNAUTHORIZED, &HeaderValue::from_str(&format!(r#"Bearer resource_metadata="{metadata}""#)).unwrap())
        );
        let (status, _, body) =
            send(&app, Request::get("/.well-known/oauth-protected-resource/mcp").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["resource"], "https://cards.example/mcp");
    }

    #[test]
    #[should_panic(expected = "a scope is printable ASCII")]
    fn a_scope_with_a_quote_is_refused_at_startup() {
        let _ = Authorization::new::<Mcp>("https://cards.example", "https://auth.example").scopes(&["read\"write"]);
    }

    /// A write an agent may retry.
    #[derive(crate::json::FromJson)]
    struct Order {
        sku: String,
        submit: crate::SubmitKey,
    }

    /// A write whose key may be left out (a form that data clients post without one).
    #[derive(crate::json::FromJson)]
    struct MaybeKeyed {
        sku: String,
        submit: Option<crate::SubmitKey>,
    }

    #[derive(crate::json::ToJson)]
    struct Placed {
        key: String,
    }

    #[tokio::test]
    async fn a_write_tool_takes_an_idempotency_key_as_a_form_does() {
        let tools = Tools::new("t", "1")
            .tool("orders.place", "Place an order", |(), order: Order| async move {
                let _ = order.sku;
                Ok(Placed { key: order.submit.as_str().to_string() })
            })
            .tool("orders.maybe", "Place an order", |(), order: MaybeKeyed| async move {
                Ok(Placed { key: order.submit.map_or(order.sku, |key| key.as_str().to_string()) })
            })
            .idempotent_tool("stock.set", "Set the quantity", |(), _: Nothing| async { Ok(Pong { pong: true }) });
        let app = Router::new().route("/mcp", tools.route().0);
        let rpc = |body: Value| {
            let app = app.clone();
            async move {
                let req = Request::post("/mcp").header("content-type", "application/json").body(Body::from(body.to_string()));
                let res = app.oneshot(req.unwrap()).await.unwrap();
                serde_json::from_slice::<Value>(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
            }
        };
        let list = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
        let listed =
            |name: &str| list["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == name).unwrap().clone();
        let place = listed("orders.place");
        let key = &place["inputSchema"]["properties"]["submit"];
        assert_eq!((&key["type"], &key["format"]), (&json!("string"), &json!("uuid")));
        assert!(key["description"].as_str().unwrap().contains("Send the same key again when retrying"), "{key}");
        assert_eq!(place["inputSchema"]["required"], json!(["sku", "submit"]));
        // Repeating it with the same key does nothing more; with the key left out it might.
        assert_eq!(place["annotations"], json!({ "readOnlyHint": false, "idempotentHint": true }));
        assert_eq!(listed("orders.maybe")["annotations"]["idempotentHint"], false, "a key it may go without");
        assert_eq!(listed("stock.set")["annotations"], json!({ "readOnlyHint": false, "idempotentHint": true }));
        let call = |key: &str| json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "orders.place", "arguments": { "sku": "a", "submit": key } } });
        let res = rpc(call("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).await;
        assert_eq!(
            res["result"]["structuredContent"]["key"], "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "the handler's SubmitKey, as a form gives it"
        );
        let res = rpc(call("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).await;
        assert_eq!(res["result"]["isError"], true, "a UUID that is not v4 is refused before the tool runs");
        let refusal = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(refusal.contains("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"), "{res}");
        // An agent told "like <a key>" may send that key, so the refusal names none.
        let words = refusal.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'));
        assert!(
            words.filter(|word| !word.is_empty()).all(|word| serde_json::from_value::<crate::SubmitKey>(json!(word)).is_err()),
            "{refusal}"
        );
    }

    /// A tool's failure and the auth check's are logged as the error itself, so the log line
    /// names each error under the message (a reset connection under "error sending request"),
    /// while the agent is told "internal error" alone.
    #[tokio::test]
    async fn a_tool_or_auth_failure_is_logged_with_each_cause_under_it() {
        #[derive(Debug)]
        struct Failed(&'static str, Option<Box<dyn std::error::Error + Send + Sync>>);
        impl std::fmt::Display for Failed {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl std::error::Error for Failed {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.1.as_deref().map(|source| source as _)
            }
        }
        #[derive(Clone)]
        struct Lines(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Lines {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let failure = || {
            let reset = Failed("client error (SendRequest)", Some(Box::new(Failed("connection reset", None))));
            ToolError::internal(Failed("error sending request", Some(Box::new(reset))))
        };
        let tools = Tools::new("test", "1.0");
        let lines = Lines(std::sync::Arc::default());
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        let (result, refused) = tracing::subscriber::with_default(subscriber, || {
            (tools.failed("stock.set", failure()), tools.refused(json!(1), failure(), &HeaderMap::new()))
        });
        assert!(result.contains(r#""text":"internal error""#), "{result}");
        assert!(!result.contains("connection reset"), "the agent is not told the cause: {result}");
        assert_eq!(refused.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = axum::body::to_bytes(refused.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8_lossy(&body);
        assert!(!body.contains("connection reset") && !body.contains("error sending request"), "nor is the client: {body}");
        assert!(body.contains("internal error"), "{body}");
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        let logged: Vec<&str> = text.lines().collect();
        assert_eq!(logged.len(), 2, "{text}");
        for (line, says) in logged.iter().zip(["agent tool failed", "auth check failed"]) {
            assert!(line.contains(says), "{line}");
            assert!(line.contains("error=error sending request"), "{line}");
            assert!(line.contains("error.sources=[client error (SendRequest), connection reset]"), "{line}");
        }
    }
}
