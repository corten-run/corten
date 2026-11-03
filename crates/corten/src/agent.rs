//! Agent tools over the Model Context Protocol (feature `agent`): one `POST` route that speaks
//! JSON-RPC 2.0 as MCP's streamable HTTP transport defines it, answering with `application/json`.
//!
//! A tool is one of the app's actions with a name, a description, a typed input and a typed
//! output. Both derive `schemars::JsonSchema` (the app depends on `schemars = "1"`), so the
//! `inputSchema` and `outputSchema` agents see are generated from the same structs the
//! handler receives and returns, and cannot drift from them. A form's input struct can be the
//! tool's input as is, so the browser and the agent share one definition and one set of rules.
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
//! clients that only read text. The output is serialized once and written into the response as
//! is, so a tool returning a large borrowed value (`Arc<T>` with serde's `rc` feature) costs one
//! serialization and no copy.

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
use schemars::{generate::SchemaSettings, JsonSchema};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

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
/// A tool: its output as JSON text.
type Handler = Arc<dyn Fn(HeaderMap, Value) -> BoxFuture<String> + Send + Sync>;
type Auth<A> = Arc<dyn Fn(&HeaderMap) -> Result<A, ToolError> + Send + Sync>;

/// Where an MCP client gets a token for the endpoint: its OAuth 2.0 protected-resource metadata
/// (RFC 9728), given to [`Tools::authorization`]. Corten serves it as JSON at the endpoint's
/// well-known path (`/.well-known/oauth-protected-resource/mcp` for `/mcp`), and every 401 the
/// endpoint answers names it: `WWW-Authenticate: Bearer resource_metadata="https://cards.example/.well-known/oauth-protected-resource/mcp"`,
/// with `scope` when [`Authorization::scopes`] lists some. The document's `resource` is the
/// endpoint's URL (`https://cards.example/mcp`), the audience the app's token check expects.
///
/// ```
/// use corten::agent::{Authorization, ToolError, Tools};
///
/// let tools = Tools::new("card-market", "1.0")
///     .authorization(Authorization::new("https://cards.example", "https://auth.example").scopes(&["inventory:read"]))
///     .auth(|headers| headers.get("authorization").map(|_| ()).ok_or(ToolError::Unauthorized));
/// # let _ = tools;
/// ```
///
/// Every value is checked when it is given, so a typo is a startup panic, not a header a client
/// cannot read:
///
/// ```should_panic
/// corten::agent::Authorization::new("https://cards.example/mcp", "https://auth.example");
/// ```
#[derive(Clone, Debug)]
pub struct Authorization {
    origin: String,
    servers: Vec<String>,
    scopes: Vec<String>,
}

impl Authorization {
    /// The app's origin as clients reach it (`https://cards.example`; the endpoint's path comes
    /// from the route it is mounted at), and the issuer of an authorization server that issues
    /// its tokens (`https://auth.example`).
    pub fn new(origin: &str, server: &str) -> Self {
        let origin = origin.trim_end_matches('/').to_ascii_lowercase();
        let host = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://")).unwrap_or("");
        assert!(
            !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b"-.:[]".contains(&b)),
            "corten: Authorization::new takes the app's origin, a scheme and a host like https://cards.example, not {origin:?}"
        );
        Authorization { origin, servers: Vec::new(), scopes: Vec::new() }.server(server)
    }

    /// Another authorization server whose tokens the endpoint takes; the client picks one.
    pub fn server(mut self, server: &str) -> Self {
        let rest = server.strip_prefix("https://").or_else(|| server.strip_prefix("http://")).unwrap_or("");
        assert!(
            !rest.is_empty() && !rest.starts_with('/') && server.bytes().all(|b| b.is_ascii_graphic() && !b"\"\\?#".contains(&b)),
            "corten: an authorization server is its issuer URL, like https://auth.example, not {server:?}"
        );
        self.servers.push(server.to_string());
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
        assert!(!path.contains('{'), "corten: an MCP endpoint with an Authorization has a fixed path, not {path:?}");
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
            "resource": format!("{}{path}", self.origin),
            "authorization_servers": self.servers,
            "bearer_methods_supported": ["header"],
        });
        if !self.scopes.is_empty() {
            document["scopes_supported"] = json!(self.scopes);
        }
        let document = Bytes::from(document.to_string());
        let route = get(move || {
            let document = document.clone();
            async move {
                let headers = [
                    (header::CONTENT_TYPE, HeaderValue::from_static("application/json")),
                    (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600")),
                    // Public and read without credentials, so a client in a browser on any site
                    // can read it.
                    (header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*")),
                ];
                (headers, document).into_response()
            }
        });
        (well_known, route)
    }
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

struct Tool {
    description: String,
    input_schema: Value,
    output_schema: Value,
    read_only: bool,
    handler: Handler,
}

/// The tools one MCP endpoint offers. `A` is what [`Tools::auth`] proves about the caller (a
/// user, a scope); it is `()` until `auth` is set.
pub struct Tools<A = ()> {
    name: String,
    version: String,
    auth: Auth<A>,
    tools: Arc<BTreeMap<String, Tool>>,
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

    /// Checks every tool call before it runs: `Err(ToolError::Unauthorized)` answers 401, and
    /// `Ok(caller)` is passed to the tool. Set it before adding tools.
    pub fn auth<A, F>(self, auth: F) -> Tools<A>
    where
        F: Fn(&HeaderMap) -> Result<A, ToolError> + Send + Sync + 'static,
    {
        assert!(self.tools.is_empty(), "set Tools::auth before adding tools");
        Tools {
            name: self.name,
            version: self.version,
            auth: Arc::new(auth),
            tools: self.tools,
            authorization: self.authorization,
            challenge: self.challenge,
        }
    }
}

/// JSON Schema for a tool's input (as the server reads it) or output (as it writes it). MCP
/// requires an object at the top.
fn schema<T: JsonSchema>(serialize: bool) -> Value {
    let settings = SchemaSettings::draft2020_12();
    let settings = if serialize { settings.for_serialize() } else { settings.for_deserialize() };
    let mut schema = settings.into_generator().into_root_schema_for::<T>().to_value();
    if let Some(map) = schema.as_object_mut() {
        map.remove("$schema");
        map.remove("title");
    }
    schema
}

impl<A: Send + 'static> Tools<A> {
    /// Where clients get a token for the endpoint ([`Authorization`]): Corten serves its
    /// protected-resource metadata next to the endpoint and names it in every 401. Without it a
    /// 401 says only `Bearer`, for tokens handed out by hand.
    pub fn authorization(mut self, authorization: Authorization) -> Self {
        self.authorization = Some(Arc::new(authorization));
        self
    }

    /// Adds a tool that changes data.
    pub fn tool<I, O, F, Fut>(self, name: &str, description: &str, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + Send + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        self.add(name, description, false, handler)
    }

    /// Adds a tool that only reads (marked `readOnlyHint`, so clients may call it without asking).
    pub fn read_tool<I, O, F, Fut>(self, name: &str, description: &str, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + Send + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        self.add(name, description, true, handler)
    }

    fn add<I, O, F, Fut>(mut self, name: &str, description: &str, read_only: bool, handler: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + Send + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(A, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, ToolError>> + Send + 'static,
    {
        let input_schema = schema::<I>(false);
        assert!(
            input_schema.get("type") == Some(&json!("object")),
            "tool {name}: the input must be a struct (MCP input schemas are objects)"
        );
        let output_schema = schema::<O>(true);
        assert!(
            output_schema.get("type") == Some(&json!("object")),
            "tool {name}: the output must be a struct (MCP structured content is an object)"
        );
        let auth = self.auth.clone();
        let handler = Arc::new(handler);
        let handler: Handler = Arc::new(move |headers, args| {
            let caller = auth(&headers);
            let handler = handler.clone();
            Box::pin(async move {
                let caller = caller?;
                let input: I = serde_json::from_value(args)?;
                let output = handler(caller, input).await?;
                serde_json::to_string(&output).map_err(ToolError::internal)
            })
        });
        let tools = Arc::get_mut(&mut self.tools).expect("add tools before serving");
        let tool = Tool { description: description.into(), input_schema, output_schema, read_only, handler };
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
            "tools/call" => match self.call(headers, params).await {
                Err(CallError::Unauthorized) => {
                    let mut res = reply(id, Err((-32001, "unauthorized".into())));
                    *res.status_mut() = StatusCode::UNAUTHORIZED;
                    let challenge = self.challenge.get().map_or(HeaderValue::from_static("Bearer"), |c| c.unauthorized.clone());
                    res.headers_mut().insert(header::WWW_AUTHENTICATE, challenge);
                    return res;
                }
                Err(CallError::InsufficientScope(scope)) => {
                    let mut res = reply(id, Err((-32001, "insufficient scope".into())));
                    *res.status_mut() = StatusCode::FORBIDDEN;
                    res.headers_mut().insert(header::WWW_AUTHENTICATE, self.insufficient_scope(&scope));
                    return res;
                }
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

    /// The 403's `WWW-Authenticate` for a call that needs `scope`.
    fn insufficient_scope(&self, scope: &str) -> HeaderValue {
        let mut value = String::from("Bearer error=\"insufficient_scope\"");
        if scope.split(' ').all(scope_token) {
            value.push_str(&format!(", scope=\"{scope}\""));
        } else {
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
                    "annotations": { "readOnlyHint": tool.read_only },
                })
            })
            .collect()
    }

    /// The call's `result`, as JSON text.
    async fn call(&self, headers: HeaderMap, params: Value) -> Result<String, CallError> {
        let name = params.get("name").and_then(Value::as_str).ok_or(CallError::Rpc(-32602, "missing tool name".into()))?;
        let tool = self.tools.get(name).ok_or_else(|| CallError::Rpc(-32602, format!("unknown tool: {name}")))?;
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err(CallError::Rpc(-32602, "arguments must be an object".into()));
        }
        // Tool failures are results with isError, so the agent can read them and retry.
        let failed = |text: String| json!({ "content": [{ "type": "text", "text": text }], "isError": true }).to_string();
        match (tool.handler)(headers, args).await {
            Ok(output) => {
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
            Err(ToolError::Unauthorized) => Err(CallError::Unauthorized),
            Err(ToolError::InsufficientScope(scope)) => Err(CallError::InsufficientScope(scope)),
            Err(ToolError::Invalid(message)) => Ok(failed(format!("invalid arguments: {message}"))),
            Err(ToolError::Refused(message)) => Ok(failed(format!("refused, read the current state first: {message}"))),
            Err(ToolError::Upstream(message)) => Ok(failed(format!("a service it calls failed, try again later: {message}"))),
            Err(ToolError::Forbidden(message)) => Ok(failed(format!("not allowed: {message}"))),
            Err(ToolError::Internal(error)) => {
                tracing::error!(tool = name, %error, "corten: agent tool failed");
                Ok(failed("internal error".into()))
            }
        }
    }
}

enum CallError {
    Unauthorized,
    InsufficientScope(String),
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
    #[derive(serde::Deserialize, JsonSchema)]
    struct Adjust {
        id: String,
        /// Added to the quantity; negative to remove.
        delta: i64,
        #[serde(default)]
        note: Option<String>,
    }

    #[derive(Serialize, JsonSchema)]
    struct Adjusted {
        id: String,
        quantity: i64,
    }

    #[derive(serde::Deserialize, JsonSchema)]
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

    #[derive(Serialize, JsonSchema)]
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
        assert_eq!(tools[1]["annotations"]["readOnlyHint"], true);
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
                token.map(|t| Agent(t.to_string())).ok_or(ToolError::Unauthorized)
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
        let authorization = Authorization::new("https://Cards.example/", "https://auth.example").scopes(&["inventory:read"]);
        let app = protected(Some(authorization));
        let (status, headers, body) = send(&app, adjust(None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let metadata = "https://cards.example/.well-known/oauth-protected-resource/mcp";
        assert_eq!(headers["www-authenticate"], format!(r#"Bearer resource_metadata="{metadata}", scope="inventory:read""#));
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"]["code"], -32001);
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
        let (status, headers, _) = send(&app, adjust(Some("reader"))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(headers["www-authenticate"], r#"Bearer error="insufficient_scope", scope="inventory:read inventory:write""#);
        let (status, ..) =
            send(&app, Request::get("/.well-known/oauth-protected-resource/mcp").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "no document is served");
    }

    #[test]
    #[should_panic(expected = "goes under App::api, not an area")]
    fn an_endpoint_with_an_authorization_is_not_a_page() {
        let tools = Tools::new("t", "1").authorization(Authorization::new("https://cards.example", "https://auth.example"));
        let _ = crate::App::new(crate::Routes::new()).area::<Mcp>(|area| area.route::<Mcp>(tools.route()));
    }

    #[test]
    #[should_panic(expected = "a scope is printable ASCII")]
    fn a_scope_with_a_quote_is_refused_at_startup() {
        let _ = Authorization::new("https://cards.example", "https://auth.example").scopes(&["read\"write"]);
    }
}
