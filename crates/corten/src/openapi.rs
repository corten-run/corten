//! An OpenAPI 3.1 document of an API's routes (feature `types`), generated from the same route
//! table and types the handlers are checked against, so it cannot drift from them.
//!
//! A `#[corten::routes(api = ..)]` module names the route that serves it, `openapi = ApiDoc`, a route
//! of the module with no handler:
//!
//! ```ignore
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     /// The OpenAPI document of these routes.
//!     #[route("/api/openapi.json")]
//!     pub struct ApiDoc;
//!
//!     /// An item's lowest price.
//!     #[route("/api/items/{id}/price", get = price)]
//!     pub struct ItemPrice { pub id: u32 }
//! }
//!
//! async fn price(Params(item): Params<api::ItemPrice>) -> JsonResult<Price> { .. }
//! ```
//!
//! Each route's handlers are its operations, named by the handler (`operationId: price`), with
//! the route's doc comment as their summary (its first paragraph) and description:
//!
//! 1. `Params<R>` gives the route's path and query parameters, each with its type's JSON Schema
//!    (a `u32` is an integer), and required unless it is an `Option`, a list or has a serde
//!    default. A parameter whose type has no schema fails the document, naming the type, as a
//!    body's does.
//! 2. `Json<T>` as an argument is the request body, `application/json`, with `T`'s schema as
//!    it is read; as the answer (`JsonResult<T>`) the 200 response, with `T`'s schema as it is
//!    written.
//! 3. Every operation's `default` response is the API's failure: a Problem Details document
//!    (RFC 9457, `application/problem+json`), or the API's own JSON when it sets
//!    [`crate::Api::errors`]. An answer that may carry a failure of its own adds it: JSON for a
//!    `JsonResponse` or a `JsonResult` (its `JsonError::Own`), any content for a `Relay`.
//! 4. A credential is a security scheme ([`Operation::api_key`], [`Operation::bearer`]), which
//!    an `Option<..>` of the argument makes optional, as it does a body, a parameter or a header.
//! 5. What the types cannot say is described as what it is and no more: a `JsonResponse` or a
//!    `StatusCode` is a 2XX of the handler's choosing, a [`crate::Relay`] or a [`crate::Media`] any content,
//!    a raw body (`Bytes`, `String`, a `Body`) any content, a `Form` or an `Upload` an object of fields, and a
//!    `#[route(prefix = ..)]` family, which no OpenAPI parameter can name, is listed in the
//!    operation's `x-corten-query-prefixes`.
//!
//! Every argument says how it appears ([`Argument`]) and every answer ([`Answers`]), checked
//! when the crate compiles, so a handler of such an API cannot be left out of the document or
//! described as less than it is. Corten's extractors and answers do (a protocol switch, a live or
//! feed stream's `since` and `Last-Event-ID` included). An extractor of the app's own implements
//! [`Argument`]: an empty impl adds nothing, [`Operation::header`] describes a header it reads,
//! and [`Operation::api_key`] or [`Operation::bearer`] the credential it checks. Operations are
//! named by their handlers; handlers that share a name are named by route and method instead
//! (`item_price_get`), whatever order the routes are in.
//! A route added by hand ([`crate::Api::route`], an MCP endpoint) is not in the document.
//!
//! ```
//! use corten::{http::request::Parts, prelude::*};
//!
//! #[derive(Clone, Hash)]
//! struct Partner;
//!
//! impl<S: Sync> Identify<S> for Partner {
//!     async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
//!         Err(Refused::unauthorized())
//!     }
//! }
//!
//! impl corten::openapi::Argument for Partner {
//!     fn describe(operation: &mut corten::openapi::Operation<'_>) {
//!         operation.api_key("x-api-key", "The partner's API key.");
//!     }
//! }
//!
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/openapi.json")]
//!     pub struct ApiDoc;
//!
//!     #[route("/api/rates", get = rates)]
//!     pub struct Rates;
//! }
//!
//! async fn rates(_: Caller<Partner>) -> &'static str { "rates" }
//! # fn main() { let _ = App::new(Routes::new()).api(api::api).router(); }
//! ```
//!
//! Without the impl, the handler does not compile, at its name:
//!
//! ```compile_fail,E0277
//! use corten::{http::request::Parts, prelude::*};
//!
//! #[derive(Clone, Hash)]
//! struct Partner;
//!
//! impl<S: Sync> Identify<S> for Partner {
//!     async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
//!         Err(Refused::unauthorized())
//!     }
//! }
//!
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/openapi.json")]
//!     pub struct ApiDoc;
//!
//!     #[route("/api/rates", get = rates)]
//!     pub struct Rates;
//! }
//!
//! async fn rates(_: Caller<Partner>) -> &'static str { "rates" }
//! # fn main() { let _ = App::new(Routes::new()).api(api::api).router(); }
//! ```
//!
//! An answer type of the app's own (a [`crate::Answer`]) implements [`Answers`] as well, usually
//! by describing what it sends as that type does:
//!
//! ```
//! use corten::{answer::{AnyInputs, Format, NotAFeed}, axum::response::{IntoResponse, Response}};
//!
//! /// Rates as text, from a cache of the app's own.
//! struct Cached(String);
//!
//! impl IntoResponse for Cached {
//!     fn into_response(self) -> Response {
//!         self.0.into_response()
//!     }
//! }
//!
//! impl corten::Answer for Cached {
//!     const FORMAT: Format = Format::Json;
//!     type Inputs = AnyInputs;
//!     type Rows = NotAFeed;
//! }
//!
//! impl corten::openapi::Answers for Cached {
//!     fn describe(operation: &mut corten::openapi::Operation<'_>) {
//!         <String as corten::openapi::Answers>::describe(operation)
//!     }
//! }
//!
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/openapi.json")]
//!     pub struct ApiDoc;
//!
//!     #[route("/api/rates", get = rates)]
//!     pub struct Rates;
//! }
//!
//! async fn rates() -> Cached {
//!     Cached("1.00".into())
//! }
//! # fn main() { let _ = corten::App::new(corten::Routes::new()).api(api::api).router(); }
//! ```
//!
//! Without it, the handler does not compile:
//!
//! ```compile_fail,E0277
//! use corten::{answer::{AnyInputs, Format, NotAFeed}, axum::response::{IntoResponse, Response}};
//!
//! /// Rates as text, from a cache of the app's own.
//! struct Cached(String);
//!
//! impl IntoResponse for Cached {
//!     fn into_response(self) -> Response {
//!         self.0.into_response()
//!     }
//! }
//!
//! impl corten::Answer for Cached {
//!     const FORMAT: Format = Format::Json;
//!     type Inputs = AnyInputs;
//!     type Rows = NotAFeed;
//! }
//!
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/openapi.json")]
//!     pub struct ApiDoc;
//!
//!     #[route("/api/rates", get = rates)]
//!     pub struct Rates;
//! }
//!
//! async fn rates() -> Cached {
//!     Cached("1.00".into())
//! }
//! # fn main() { let _ = corten::App::new(corten::Routes::new()).api(api::api).router(); }
//! ```
//!
//! `openapi` names a route of an API, so a module that is not one does not compile:
//!
//! ```compile_fail
//! #[corten::routes(openapi = Doc)]
//! mod url {
//!     #[route("/openapi.json")]
//!     pub struct Doc;
//! }
//! # fn main() {}
//! ```
//!
//! The document's route serves the document alone, so a handler on it does not compile, nor a
//! parameter in its path:
//!
//! ```compile_fail
//! # use corten::prelude::*;
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/openapi.json", get = doc)]
//!     pub struct ApiDoc;
//! }
//!
//! async fn doc() -> &'static str { "{}" }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! # use corten::prelude::*;
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/{version}/openapi.json")]
//!     pub struct ApiDoc { pub version: u32 }
//! }
//! # fn main() {}
//! ```
//!
//! Nor can it be the API's prefix, or a route the module does not have:
//!
//! ```compile_fail
//! # use corten::prelude::*;
//! #[corten::routes(api = ApiRoot, openapi = ApiRoot)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//! }
//! # fn main() {}
//! ```
//!
//! ```compile_fail
//! # use corten::prelude::*;
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//! }
//! # fn main() {}
//! ```
//!
//! A route with a type parameter has no one operation to describe:
//!
//! ```compile_fail
//! # use corten::prelude::*;
//! #[corten::routes(api = ApiRoot, openapi = ApiDoc)]
//! mod api {
//!     #[route("/api")]
//!     pub struct ApiRoot;
//!
//!     #[route("/api/openapi.json")]
//!     pub struct ApiDoc;
//!
//!     #[route("/api/items", get = items)]
//!     pub struct Items<T: std::fmt::Display> { pub order: T }
//! }
//!
//! async fn items() -> &'static str { "" }
//! # fn main() {}
//! ```
//!
//! The document is built once, when the app's router is built, and served as it was built; a type
//! with no JSON Schema in it fails then, naming the type, as [`crate::types`] does. A test keeps a
//! copy beside the code with [`sync`], for a client generator or a contract test:
//!
//! ```ignore
//! #[tokio::test]
//! async fn the_openapi_document_is_current() {
//!     let doc = app().test().get(&api::ApiDoc).await;
//!     corten::openapi::sync(concat!(env!("CARGO_MANIFEST_DIR"), "/openapi.json"), doc.text());
//! }
//! ```

use std::{
    path::Path,
    sync::{Arc, OnceLock},
};

use serde_json::{json, Map, Value};

use crate::{
    json::schema::{FromJsonSchema, ToJsonSchema},
    route::__private::Parameters,
};

/// How a handler's argument appears in its operation: path and query parameters, a header, the
/// request body. Implemented for Corten's extractors; an app's own extractor in an API with an
/// OpenAPI document implements it too, and so does a caller type (`Caller<Partner>` is described
/// by `Partner`), with an empty impl when it adds nothing the document shows (a session, a
/// database handle), [`Operation::api_key`] or [`Operation::bearer`] for the credential it
/// checks, or [`Operation::header`] for another header it reads.
///
/// ```
/// use corten::openapi::{Argument, Operation};
///
/// struct ApiKey(String);
///
/// impl Argument for ApiKey {
///     fn describe(operation: &mut Operation<'_>) {
///         operation.api_key("x-api-key", "The partner's API key.");
///     }
/// }
/// ```
#[diagnostic::on_unimplemented(
    message = "`{Self}` does not say how it appears in the API's OpenAPI document",
    label = "an argument of a handler in an API with openapi = ..",
    note = "implement corten::openapi::Argument for it: an empty impl adds nothing to the document, Operation::header describes a header it reads and Operation::api_key or Operation::bearer a credential; for another crate's type, implement it for a newtype around the type"
)]
pub trait Argument {
    /// Adds what the argument reads to the operation.
    #[allow(unused_variables)]
    fn describe(operation: &mut Operation<'_>) {}
}

/// How a handler's answer appears in its operation's responses.
#[diagnostic::on_unimplemented(
    message = "`{Self}` has no description in an OpenAPI document",
    label = "the answer of a handler in an API with openapi = ..",
    note = "an API with an OpenAPI document answers JsonResult<T>, Json<T>, JsonResponse, StatusCode, text, a Relay, a Media, a feed, a protocol switch (Switch, SwitchOr<..>), or Public<..> or NoStore<..> of one; an answer type of the app's own implements corten::openapi::Answers, and for another crate's type, a newtype around it does"
)]
pub trait Answers {
    /// Adds the answer's responses to the operation.
    fn describe(operation: &mut Operation<'_>);
}

/// One operation (a route's handler for one method) as it is described: what its arguments and
/// answer add.
pub struct Operation<'a> {
    parameters: &'a mut Parameters,
    /// The document's security schemes, by name (`components.securitySchemes`).
    schemes: &'a mut Map<String, Value>,
    /// Each argument's credentials, the ones it accepts any one of (an `Identify` that takes a
    /// key or a token), with `None` for an argument that may leave them out: every argument's
    /// are required together.
    security: Vec<(Vec<String>, bool)>,
    body: Option<Value>,
    responses: Map<String, Value>,
    /// The media type of a failure the handler or the service it relays may write instead of the
    /// API's: JSON for a `JsonResponse` or a `JsonError::Own`, any for a `Relay`.
    own_failure: Option<&'static str>,
}

impl Operation<'_> {
    /// A header the argument reads: `.header("x-request-id", false, "Echoed in the answer.")`.
    /// A credential in a header is [`Operation::api_key`] or [`Operation::bearer`] instead, and
    /// `Accept`, `Content-Type` and `Authorization`, which OpenAPI ignores as parameters, are
    /// refused: the app fails at startup, when the API is added, naming the header.
    pub fn header(&mut self, name: &str, required: bool, description: &str) {
        assert!(
            !["accept", "content-type", "authorization"].iter().any(|h| name.eq_ignore_ascii_case(h)),
            "corten: OpenAPI ignores a header parameter named {name}: describe a credential with Operation::api_key or Operation::bearer, and a body's type with the argument that reads it"
        );
        let mut parameter = json!({ "name": name, "in": "header", "schema": { "type": "string" } });
        if required {
            parameter["required"] = Value::Bool(true);
        }
        if !description.is_empty() {
            parameter["description"] = Value::String(description.into());
        }
        self.parameters.list.push(parameter);
    }

    /// A key the caller sends in a header (`x-api-key`): a security scheme of the document, named
    /// after the header, that the operation requires. Call it from an argument's `describe` (a
    /// caller type's); an answer's credentials would join the last argument's.
    pub fn api_key(&mut self, header: &str, description: &str) {
        let mut scheme = json!({ "type": "apiKey", "in": "header", "name": header });
        if !description.is_empty() {
            scheme["description"] = Value::String(description.into());
        }
        self.require(header, scheme);
    }

    /// A bearer token in `Authorization` (RFC 6750): the document's `bearer` security scheme,
    /// which the operation requires. Like [`Operation::api_key`], an argument's to call.
    pub fn bearer(&mut self, description: &str) {
        let mut scheme = json!({ "type": "http", "scheme": "bearer" });
        if !description.is_empty() {
            scheme["description"] = Value::String(description.into());
        }
        self.require("bearer", scheme);
    }

    /// The argument being described accepts `name`: one of its own alternatives, required with
    /// every other argument's.
    fn require(&mut self, name: &str, scheme: Value) {
        assert!(
            !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
            "corten: an OpenAPI security scheme is named after its header, so {name:?} must be letters, digits, '.', '_' or '-'"
        );
        self.schemes.entry(name).or_insert(scheme);
        match self.security.last_mut() {
            Some((alternatives, _)) => {
                if !alternatives.iter().any(|a| a == name) {
                    alternatives.push(name.into());
                }
            }
            None => self.security.push((vec![name.into()], false)),
        }
    }

    /// Starts an argument's own group of credentials: what it accepts is required alongside what
    /// the ones before it accept, not instead. A group is never reused, even an empty one, so an
    /// optional argument that took none (`Option<ClientIp>`) leaves the next one's required.
    fn argument(&mut self) {
        self.security.push((Vec::new(), false));
    }

    /// The operation's `security`: one requirement per way of meeting every argument's (each
    /// group's alternatives, times the next group's), and none when no argument takes one.
    fn requirements(security: &[(Vec<String>, bool)]) -> Vec<Value> {
        let mut out: Vec<Map<String, Value>> = vec![Map::new()];
        let mut any = false;
        for (alternatives, optional) in security.iter().filter(|(a, _)| !a.is_empty()) {
            any = true;
            let mut next = Vec::new();
            for have in &out {
                for name in alternatives {
                    let mut more = have.clone();
                    more.insert(name.clone(), json!([]));
                    next.push(more);
                }
                if *optional {
                    next.push(have.clone());
                }
            }
            out = next;
        }
        if !any {
            return Vec::new();
        }
        let mut seen = Vec::new();
        for requirement in out.into_iter().map(Value::Object) {
            if !seen.contains(&requirement) {
                seen.push(requirement);
            }
        }
        seen
    }

    /// A failure may also be JSON the handler wrote.
    fn own_json_failure(&mut self) {
        self.own_failure.get_or_insert("application/json");
    }

    fn body(&mut self, media: &str, schema: Value) {
        self.body = Some(json!({ "required": true, "content": { media: { "schema": schema } } }));
    }

    fn response(&mut self, status: &str, description: &str, content: Option<(&str, Value)>) {
        let mut response = json!({ "description": description });
        if let Some((media, schema)) = content {
            response["content"] = json!({ media: { "schema": schema } });
        }
        self.responses.insert(status.into(), response);
    }

    fn read<T: FromJsonSchema + ?Sized>(&mut self) -> Value {
        T::json_schema(&mut self.parameters.generator)
    }

    fn written<T: ToJsonSchema + ?Sized>(&mut self) -> Value {
        T::json_schema(&mut self.parameters.generator)
    }
}

/// A handler's arguments, each an [`Argument`].
#[doc(hidden)]
pub trait Arguments {
    fn describe(operation: &mut Operation<'_>);
}

impl Arguments for () {
    fn describe(_: &mut Operation<'_>) {}
}

macro_rules! arguments {
    ($($ty:ident),*) => {
        impl<$($ty: Argument,)*> Arguments for ($($ty,)*) {
            fn describe(operation: &mut Operation<'_>) {
                $(operation.argument(); $ty::describe(operation);)*
            }
        }
    };
}
arguments!(A1);
arguments!(A1, A2);
arguments!(A1, A2, A3);
arguments!(A1, A2, A3, A4);
arguments!(A1, A2, A3, A4, A5);
arguments!(A1, A2, A3, A4, A5, A6);
arguments!(A1, A2, A3, A4, A5, A6, A7);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15);
arguments!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16);

impl<R: crate::route::FromUrl + ?Sized> Argument for crate::Params<R> {
    fn describe(operation: &mut Operation<'_>) {
        R::__describe(operation.parameters);
    }
}

impl<T: FromJsonSchema> Argument for crate::Json<T> {
    fn describe(operation: &mut Operation<'_>) {
        let schema = operation.read::<T>();
        operation.body("application/json", schema);
    }
}

/// What it may leave out (`Option<Json<T>>`, `Option<Caller<Partner>>`) is not required: its
/// body, its parameters and headers, and its credentials, any one of which may then be missing.
impl<T: Argument> Argument for Option<T> {
    fn describe(operation: &mut Operation<'_>) {
        let had = operation.body.is_some();
        let parameters = operation.parameters.list.len();
        operation.argument();
        let group = operation.security.len() - 1;
        T::describe(operation);
        if let (false, Some(body)) = (had, &mut operation.body) {
            body["required"] = Value::Bool(false);
        }
        for parameter in &mut operation.parameters.list[parameters..] {
            if let Some(parameter) = parameter.as_object_mut() {
                parameter.remove("required");
            }
        }
        // Its own credentials may be missing; the other arguments' are still required.
        if let Some((_, optional)) = operation.security.get_mut(group) {
            *optional = true;
        }
    }
}

impl<T> Argument for crate::Form<T> {
    fn describe(operation: &mut Operation<'_>) {
        operation.body("application/x-www-form-urlencoded", json!({ "type": "object" }));
    }
}

impl<T> Argument for crate::Upload<T> {
    fn describe(operation: &mut Operation<'_>) {
        operation.body("multipart/form-data", json!({ "type": "object" }));
    }
}

/// A body the handler reads itself: any content.
macro_rules! raw_body {
    ($($ty:ty),*) => {
        $(impl Argument for $ty {
            fn describe(operation: &mut Operation<'_>) {
                operation.body("*/*", json!({}));
            }
        })*
    };
}
raw_body!(bytes::Bytes, String, axum::body::Body, axum::extract::Request);

/// Nothing a client sends that the document shows: what the server holds or works out.
macro_rules! nothing {
    ($($ty:ty),*) => {
        $(impl Argument for $ty {})*
    };
}
nothing!(
    crate::Req,
    crate::Signal,
    axum::http::Method,
    axum::http::Uri,
    axum::http::HeaderMap,
    crate::ClientIp,
    crate::ClientZone
);

/// A request to switch protocols: a `GET` with `Upgrade` (and `Connection: upgrade`).
impl Argument for crate::upgrade::Upgrade {
    fn describe(operation: &mut Operation<'_>) {
        operation.header("upgrade", true, "The protocol to switch to (with Connection: upgrade).");
    }
}

/// Where a stream resumes: `since` in the query on the first connection, `Last-Event-ID` when it
/// reconnects.
fn resumes(operation: &mut Operation<'_>) {
    let since = json!({ "name": "since", "in": "query", "schema": { "type": "string" }, "description": "The cursor to resume after, on the first connection." });
    operation.parameters.list.push(since);
    operation.header("last-event-id", false, "The cursor of the last event received, when reconnecting.");
}

impl Argument for crate::LiveSince {
    fn describe(operation: &mut Operation<'_>) {
        resumes(operation)
    }
}

#[cfg(feature = "feed")]
impl Argument for corten_feed::Since {
    fn describe(operation: &mut Operation<'_>) {
        resumes(operation)
    }
}

impl<T> Argument for axum::extract::State<T> {}

/// What its caller type says: the header an API key is read from (an app's type implements
/// [`Argument`], as a caller type of an API with a document must).
impl<T: Argument> Argument for crate::Caller<T> {
    fn describe(operation: &mut Operation<'_>) {
        T::describe(operation)
    }
}

impl<T: ToJsonSchema> Answers for crate::Json<T> {
    fn describe(operation: &mut Operation<'_>) {
        let schema = operation.written::<T>();
        operation.response("200", "OK", Some(("application/json", schema)));
    }
}

impl<A: Answers> Answers for Result<A, crate::Error> {
    fn describe(operation: &mut Operation<'_>) {
        A::describe(operation)
    }
}

/// A `JsonError::Own` is a body the handler wrote.
impl<A: Answers> Answers for Result<A, crate::JsonError> {
    fn describe(operation: &mut Operation<'_>) {
        A::describe(operation);
        operation.own_json_failure();
    }
}

impl<A: Answers + crate::answer::Shareable> Answers for crate::answer::Public<A> {
    fn describe(operation: &mut Operation<'_>) {
        A::describe(operation)
    }
}

impl<A: Answers> Answers for crate::answer::NoStore<A> {
    fn describe(operation: &mut Operation<'_>) {
        A::describe(operation)
    }
}

impl Answers for crate::JsonResponse {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("2XX", "JSON, with a status the handler sets", Some(("application/json", json!({}))));
        operation.own_json_failure();
    }
}

impl Answers for axum::http::StatusCode {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("2XX", "A status the handler sets, without a body", None);
    }
}

impl Answers for String {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("200", "OK", Some(("text/plain", json!({ "type": "string" }))));
    }
}

impl Answers for &'static str {
    fn describe(operation: &mut Operation<'_>) {
        <String as Answers>::describe(operation)
    }
}

impl Answers for crate::answer::Relay {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("2XX", "The answer of another service, passed on", Some(("*/*", json!({}))));
        operation.own_failure = Some("*/*");
    }
}

impl Answers for crate::answer::Media {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("200", "A file", Some(("*/*", json!({}))));
    }
}

impl Answers for crate::upgrade::Switch {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("101", "Switching Protocols: the connection is the new protocol's", None);
    }
}

impl<A: Answers> Answers for crate::upgrade::SwitchOr<A> {
    fn describe(operation: &mut Operation<'_>) {
        A::describe(operation);
        <crate::upgrade::Switch as Answers>::describe(operation)
    }
}

#[cfg(feature = "feed")]
impl<T> Answers for corten_feed::FeedResponse<T> {
    fn describe(operation: &mut Operation<'_>) {
        operation.response("200", "Server-sent events", Some(("text/event-stream", json!({ "type": "string" }))));
    }
}

/// Writes `document` (an API's, as its route serves it) to `path` when it differs from what is
/// there, and then panics with the file name, so a test that calls it fails until the new file is
/// committed, as [`crate::types::Types::sync`] does. Line endings do not count.
pub fn sync(path: impl AsRef<Path>, document: &str) {
    let path = path.as_ref();
    if std::fs::read_to_string(path).is_ok_and(|was| was.replace("\r\n", "\n") == document) {
        return;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("create the OpenAPI document's directory");
    }
    std::fs::write(path, document).expect("write the OpenAPI document");
    panic!("{} was out of date with the API's routes and has been rewritten; commit it", path.display());
}

/// An API's document as its module builds it: its operations, with the failure response left to
/// [`Served::finish`], which knows whether the API writes its own error shape.
#[doc(hidden)]
pub struct Document {
    title: &'static str,
    version: &'static str,
    parameters: Parameters,
    paths: Map<String, Value>,
    schemes: Map<String, Value>,
    /// Each operation's path, method, handler and route, named once every one is known.
    named: Vec<(String, &'static str, &'static str, &'static str)>,
    /// The media types of failures operations may write themselves (`FailureOr..`).
    own_failures: std::collections::BTreeSet<&'static str>,
}

/// The document an API serves, made into its JSON once the router knows the API's settings.
pub(crate) struct Served {
    document: std::sync::Mutex<Option<Document>>,
    json: OnceLock<bytes::Bytes>,
}

impl Served {
    pub(crate) fn new(document: Document) -> Arc<Self> {
        Arc::new(Served { document: std::sync::Mutex::new(Some(document)), json: OnceLock::new() })
    }

    /// Makes the JSON, its failures in the API's own shape when `own_errors`. Panics, naming
    /// them, for types with no JSON Schema.
    pub(crate) fn finish(&self, own_errors: bool) {
        self.json.get_or_init(|| {
            let document = self.document.lock().unwrap_or_else(|e| e.into_inner()).take();
            document.map(|d| d.json(own_errors)).unwrap_or_default().into()
        });
    }

    pub(crate) fn json(&self) -> bytes::Bytes {
        self.finish(false);
        self.json.get().cloned().unwrap_or_default()
    }
}

impl Document {
    fn json(mut self, own_errors: bool) -> String {
        self.parameters.generator.missing("the OpenAPI document");
        // An operation is named by its handler, unless another handler has the same name: then
        // each of them by its route and method, so adding or moving a route renames only the
        // operations whose name it shares.
        let mut uses: std::collections::BTreeMap<&str, usize> = Default::default();
        for (_, _, id, _) in &self.named {
            *uses.entry(*id).or_default() += 1;
        }
        let mut given: std::collections::BTreeMap<String, String> = Default::default();
        for (path, method, id, route) in &self.named {
            let name = if uses[*id] == 1 { id.to_string() } else { format!("{}_{method}", snake(route)) };
            // A route-and-method name can be another handler's own (`file_get`): say so when the
            // router builds rather than serve a document with one name for two operations.
            if let Some(other) = given.insert(name.clone(), format!("{method} {path}")) {
                panic!(
                    "corten: the OpenAPI document names two operations {name} ({other} and {method} {path}): rename the handler {id} or the one that has that name"
                );
            }
            self.paths[path.as_str()][*method]["operationId"] = Value::String(name);
        }
        let mut schemas: Map<String, Value> = self.parameters.generator.definitions().into_iter().collect();
        let failure = if own_errors {
            json!({ "description": "A failure, in the API's own JSON (Api::errors)", "content": { "application/json": { "schema": {} } } })
        } else {
            schemas.insert("Problem".into(), problem());
            json!({
                "description": "A failure, as Problem Details (RFC 9457)",
                "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/Problem" } } },
            })
        };
        let mut responses = Map::new();
        for media in &self.own_failures {
            // The API's failure, or a body the handler (JSON) or the service it relays wrote.
            let (name, who) = own_failure(media);
            let mut own = failure.clone();
            own["description"] = Value::String(format!("{}, or {who}", own["description"].as_str().unwrap_or("A failure")));
            own["content"][*media] = json!({ "schema": {} });
            responses.insert(name.into(), own);
        }
        responses.insert("Failure".into(), failure);
        let mut parts = json!({ "schemas": schemas, "responses": responses });
        if !self.schemes.is_empty() {
            parts["securitySchemes"] = Value::Object(self.schemes);
        }
        let mut document = json!({
            "openapi": "3.1.1",
            "info": { "title": self.title, "version": self.version },
            "paths": self.paths,
            "components": parts,
        });
        components(&mut document);
        let mut text = serde_json::to_string_pretty(&document).expect("a JSON value writes");
        text.push('\n');
        text
    }
}

/// The schema of a Problem Details document as Corten writes one, with the members a refusal
/// of a form's input adds (`fields`, `form`).
fn problem() -> Value {
    json!({
        "description": "A failure, as Problem Details (RFC 9457)",
        "type": "object",
        "properties": {
            "type": { "type": "string", "format": "uri-reference" },
            "title": { "type": "string" },
            "status": { "type": "integer" },
            "detail": { "type": "string" },
            "fields": { "type": "object", "additionalProperties": { "type": "string" } },
            "form": { "type": "string" },
        },
        "required": ["title", "status"],
    })
}

/// The response that describes a failure the operation may write itself, as `media`, and who
/// writes it.
fn own_failure(media: &str) -> (&'static str, &'static str) {
    if media == "*/*" {
        ("FailureOrAny", "the answer of the service it relays")
    } else {
        ("FailureOrJson", "JSON the handler wrote")
    }
}

/// A route's name as an operation's: `ItemPrice` is `item_price`.
fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// Each schema's `$ref` to `#/$defs/Name` (the generator's) made one to the document's
/// `#/components/schemas/Name`.
fn components(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                match (key.as_str(), &mut *value) {
                    ("$ref", Value::String(target)) => {
                        if let Some(name) = target.strip_prefix("#/$defs/") {
                            *target = format!("#/components/schemas/{name}");
                        }
                    }
                    _ => components(value),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(components),
        _ => {}
    }
}

/// Not a public API: what `#[corten::routes(api = .., openapi = ..)]` builds the document with.
#[doc(hidden)]
pub mod __private {
    use axum::handler::Handler;
    use serde_json::{json, Map, Value};

    use super::{Answers, Arguments, Document, Operation};
    use crate::route::{
        __private::{Parameters, RouteHandler},
        Route,
    };

    /// An empty document, titled by the app's crate.
    pub fn document(title: &'static str, version: &'static str) -> Document {
        Document {
            title,
            version,
            parameters: Parameters::default(),
            paths: Map::new(),
            schemes: Map::new(),
            named: Vec::new(),
            own_failures: Default::default(),
        }
    }

    /// Adds the operation of `R`'s handler for `method` (`"any"` for every method a client writes
    /// to), named `id` (its function's name; see `Document::json` for two of one name), on the
    /// route named `route` and described by its doc comment. `P` is the route's `Params` (`()`
    /// for a route with no path parameter), which ties a generic handler's to the route's, as
    /// registering it does.
    pub fn operation<R, H, T, S, P, J>(
        document: &mut Document,
        method: &'static str,
        id: &'static str,
        route: &'static str,
        doc: &'static str,
        _: &H,
    ) where
        R: Route + ?Sized,
        H: RouteHandler<T, S> + crate::answer::Signature<T>,
        <H as RouteHandler<T, S>>::Handler: Handler<T, S>,
        <H as crate::answer::Signature<T>>::Args: Arguments + crate::answer::Holds<P, J>,
        <H as crate::answer::Signature<T>>::Out: Answers,
    {
        let methods: &[&str] = if method == "any" { &["get", "put", "post", "delete", "patch"] } else { &[method] };
        for &method in methods {
            let mut operation = Operation {
                parameters: &mut document.parameters,
                schemes: &mut document.schemes,
                security: Vec::new(),
                body: None,
                responses: Map::new(),
                own_failure: None,
            };
            <H as crate::answer::Signature<T>>::Args::describe(&mut operation);
            <H as crate::answer::Signature<T>>::Out::describe(&mut operation);
            let Operation { body, mut responses, security, own_failure, .. } = operation;
            let parameters = std::mem::take(&mut document.parameters.list);
            let prefixes = std::mem::take(&mut document.parameters.prefixes);
            let failure = match own_failure {
                Some(media) => {
                    document.own_failures.insert(media);
                    super::own_failure(media).0
                }
                None => "Failure",
            };
            responses.insert("default".into(), json!({ "$ref": format!("#/components/responses/{failure}") }));
            let mut entry = Map::new();
            let doc = doc.trim();
            // The summary is the first paragraph, as rustdoc's is, with its lines joined; the
            // description is the whole comment when it has more than that paragraph.
            let first = doc.split("\n\n").next().unwrap_or_default();
            if !first.is_empty() {
                let summary = first.lines().map(str::trim).collect::<Vec<_>>().join(" ");
                entry.insert("summary".into(), Value::String(summary));
                if first.len() < doc.len() {
                    entry.insert("description".into(), Value::String(doc.into()));
                }
            }
            if !parameters.is_empty() {
                entry.insert("parameters".into(), Value::Array(parameters));
            }
            if let Some(body) = body {
                entry.insert("requestBody".into(), body);
            }
            let security = Operation::requirements(&security);
            if !security.is_empty() {
                entry.insert("security".into(), Value::Array(security));
            }
            entry.insert("responses".into(), Value::Object(responses));
            if !prefixes.is_empty() {
                entry.insert("x-corten-query-prefixes".into(), json!(prefixes));
            }
            let written = path(R::WRITTEN);
            document.paths.entry(written.clone()).or_insert_with(|| json!({}))[method] = Value::Object(entry);
            document.named.push((written, method, id, route));
        }
    }

    /// A route's path as OpenAPI writes one: a catch-all `{*rest}` is `{rest}`.
    fn path(written: &str) -> String {
        written.replace("{*", "{")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::{http::StatusCode, App, Error, Json, JsonResult, Params, Routes};

    #[derive(serde::Deserialize, crate::json::FromJson)]
    struct NewAlert {
        below: u32,
        note: Option<String>,
    }

    #[derive(serde::Serialize, crate::json::ToJson)]
    struct Price {
        lowest: String,
    }

    #[derive(serde::Deserialize, crate::Route)]
    #[route(query)]
    struct Paging {
        page: Option<u32>,
    }

    /// A list's order, written in its URL.
    #[derive(Clone, Copy, crate::UrlValue)]
    #[serde(rename_all = "kebab-case")]
    pub enum Order {
        Lowest,
        Newest,
    }

    /// A partner's service, known by the key it sends.
    #[derive(Clone, Hash)]
    struct Partner;

    impl<S: Sync> crate::Identify<S> for Partner {
        async fn identify(_: &crate::http::request::Parts, _: &S) -> Result<Self, crate::Refused> {
            Err(crate::Refused::unauthorized())
        }
    }

    impl super::Argument for Partner {
        fn describe(operation: &mut super::Operation<'_>) {
            operation.api_key("x-api-key", "The partner's key.");
        }
    }

    /// A list's order with no schema of any kind.
    #[derive(serde::Deserialize)]
    pub enum Unwritten {
        Lowest,
    }

    impl std::fmt::Display for Unwritten {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("lowest")
        }
    }

    #[crate::routes(api = ApiRoot, openapi = ApiDoc)]
    mod api {
        #[route("/api")]
        pub struct ApiRoot;

        /// This API's document.
        #[route("/api/openapi.json")]
        pub struct ApiDoc;

        /// An item's lowest
        /// price.
        ///
        /// In the currency asked for.
        #[route("/api/items/{id}/price", get = price)]
        pub struct ItemPrice {
            pub id: u32,
            pub currency: Option<String>,
            pub market: String,
            #[serde(default)]
            pub fresh: bool,
            #[route(query)]
            pub paging: super::Paging,
        }

        #[route("/api/items/{id}/alerts", post = alert)]
        pub struct Alerts {
            pub id: u32,
        }

        #[route("/api/files/{*path}", get = file, put = file)]
        pub struct File {
            pub path: String,
        }

        /// Quotes, for anyone, or a partner's own.
        #[route("/api/quotes", get = quotes, post = quote)]
        pub struct Quotes {
            pub order: Option<super::Order>,
        }

        #[route("/api/socket", get = socket)]
        pub struct Socket;

        #[route("/api/events", get = events)]
        pub struct Events;

        #[route("/api/relay/{*rest}", any = relay)]
        pub struct Relayed {
            pub rest: String,
        }
    }

    async fn quotes(_: Option<crate::Caller<Partner>>, Params(_): Params<api::Quotes>) -> crate::JsonResponse {
        unimplemented!("only described")
    }

    async fn quote(_: crate::Caller<Partner>, _: bytes::Bytes) -> Result<StatusCode, crate::JsonError> {
        unimplemented!("only described")
    }

    async fn socket(_: crate::upgrade::Upgrade) -> crate::upgrade::Switch {
        unimplemented!("only described")
    }

    /// An upstream's event stream passed on, resuming where the client left off.
    async fn events(_: crate::LiveSince) -> crate::answer::Relay {
        unimplemented!("only described")
    }

    /// Generic over its route, as a relay shared by several is (#994 review).
    async fn relay<R: crate::route::FromUrl>(_: Params<R>) -> crate::answer::Relay {
        unimplemented!("only described")
    }

    async fn price(Params(at): Params<api::ItemPrice>) -> JsonResult<Price> {
        Ok(Json(Price { lowest: format!("{} {:?}", at.id, at.currency) }))
    }

    async fn alert(Params(_): Params<api::Alerts>, Json(alert): Json<NewAlert>) -> Result<StatusCode, Error> {
        let _ = (alert.below, alert.note);
        Ok(StatusCode::CREATED)
    }

    async fn file(Params(at): Params<api::File>) -> String {
        at.path
    }

    async fn document(app: App) -> Value {
        let answer = app.test().get(&api::ApiDoc).await;
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(answer.headers()["content-type"], "application/json");
        serde_json::from_str(answer.text()).expect("the document is JSON")
    }

    #[tokio::test]
    async fn an_api_serves_its_routes_as_an_openapi_document() {
        let doc = document(App::new(Routes::new()).api(api::api)).await;
        assert_eq!(doc["openapi"], "3.1.1");
        assert_eq!(doc["info"]["title"], env!("CARGO_PKG_NAME"), "titled by the crate that declares the API");
        let price = &doc["paths"]["/api/items/{id}/price"]["get"];
        assert_eq!(price["operationId"], "price");
        assert_eq!(price["summary"], "An item's lowest price.", "the first paragraph, its lines joined");
        assert_eq!(price["description"], "An item's lowest\nprice.\n\nIn the currency asked for.");
        assert_eq!(
            price["parameters"],
            json!([
                { "name": "id", "in": "path", "required": true, "schema": { "type": "integer", "format": "uint32", "minimum": 0 } },
                { "name": "currency", "in": "query", "schema": { "type": "string" } },
                { "name": "market", "in": "query", "required": true, "schema": { "type": "string" } },
                { "name": "fresh", "in": "query", "schema": { "type": "boolean" } },
                { "name": "page", "in": "query", "schema": { "type": "integer", "format": "uint32", "minimum": 0 } },
            ])
        );
        assert_eq!(
            price["responses"]["200"]["content"]["application/json"]["schema"],
            json!({ "$ref": "#/components/schemas/Price" })
        );
        // A `JsonResult` may answer a `JsonError::Own`, JSON of the handler's own.
        assert_eq!(price["responses"]["default"], json!({ "$ref": "#/components/responses/FailureOrJson" }));
        assert!(price.get("requestBody").is_none());
        let alert = &doc["paths"]["/api/items/{id}/alerts"]["post"];
        assert_eq!(alert["requestBody"]["required"], true);
        assert_eq!(
            alert["requestBody"]["content"]["application/json"]["schema"],
            json!({ "$ref": "#/components/schemas/NewAlert" })
        );
        assert_eq!(alert["responses"]["2XX"]["description"], "A status the handler sets, without a body");
        assert_eq!(
            alert["responses"]["default"],
            json!({ "$ref": "#/components/responses/Failure" }),
            "an Error is the API's failure"
        );
        assert!(alert.get("summary").is_none(), "a route with no doc comment has no summary");
        // A catch-all is a parameter as OpenAPI writes one, and a handler named twice is two
        // operations with names of their own.
        let file = &doc["paths"]["/api/files/{path}"];
        assert_eq!((&file["get"]["operationId"], &file["put"]["operationId"]), (&json!("file_get"), &json!("file_put")));
        assert_eq!(file["get"]["responses"]["200"]["content"]["text/plain"]["schema"], json!({ "type": "string" }));
        let schemas = &doc["components"]["schemas"];
        assert_eq!(schemas["NewAlert"]["required"], json!(["below"]));
        assert_eq!(schemas["Problem"]["required"], json!(["title", "status"]));
        assert_eq!(
            doc["components"]["responses"]["Failure"]["content"]["application/problem+json"]["schema"],
            json!({ "$ref": "#/components/schemas/Problem" })
        );
        assert!(doc["paths"].get("/api/openapi.json").is_none(), "the document is not one of its own operations");
        // A key is a security scheme, optional where the handler takes `Option<Caller<..>>`; a
        // UrlValue parameter lists its words; an answer that writes its own failure says so.
        assert_eq!(
            doc["components"]["securitySchemes"]["x-api-key"],
            json!({ "type": "apiKey", "in": "header", "name": "x-api-key", "description": "The partner's key." })
        );
        let quotes = &doc["paths"]["/api/quotes"];
        assert_eq!(quotes["get"]["security"], json!([{ "x-api-key": [] }, {}]));
        assert_eq!(quotes["post"]["security"], json!([{ "x-api-key": [] }]));
        assert_eq!(
            quotes["get"]["parameters"],
            json!([{ "name": "order", "in": "query", "schema": { "type": "string", "enum": ["lowest", "newest"] } }])
        );
        assert_eq!(quotes["get"]["responses"]["default"], json!({ "$ref": "#/components/responses/FailureOrJson" }));
        assert_eq!(quotes["post"]["responses"]["default"], json!({ "$ref": "#/components/responses/FailureOrJson" }));
        assert_eq!(quotes["post"]["requestBody"]["content"]["*/*"], json!({ "schema": {} }));
        let own = &doc["components"]["responses"]["FailureOrJson"]["content"];
        assert_eq!(own["application/json"], json!({ "schema": {} }));
        assert_eq!(own["application/problem+json"]["schema"], json!({ "$ref": "#/components/schemas/Problem" }));
        // A protocol switch, a stream that resumes, and a generic relay on every method.
        let socket = &doc["paths"]["/api/socket"]["get"];
        assert!(socket["responses"]["101"].is_object());
        assert_eq!(socket["parameters"][0]["name"], "upgrade");
        let events = &doc["paths"]["/api/events"]["get"];
        let names: Vec<&str> = events["parameters"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["since", "last-event-id"]);
        let relayed = &doc["paths"]["/api/relay/{rest}"];
        for method in ["get", "put", "post", "delete", "patch"] {
            assert_eq!(relayed[method]["operationId"], format!("relayed_{method}"));
        }
        assert_eq!(relayed["get"]["responses"]["default"], json!({ "$ref": "#/components/responses/FailureOrAny" }));
        assert_eq!(doc["components"]["responses"]["FailureOrAny"]["content"]["*/*"], json!({ "schema": {} }));
        // Kept beside the code, where `npm run check` validates it as OpenAPI 3.1.
        super::sync(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/openapi.json"), &serde_json::to_string_pretty(&doc).unwrap());
    }

    #[crate::routes(api = UnwrittenRoot, openapi = UnwrittenDoc)]
    mod unwritten {
        #[route("/api")]
        pub struct UnwrittenRoot;

        #[route("/api/openapi.json")]
        pub struct UnwrittenDoc;

        #[route("/api/sorted", get = sorted)]
        pub struct Sorted {
            pub order: super::Unwritten,
        }
    }

    async fn sorted(Params(_): Params<unwritten::Sorted>) -> &'static str {
        "sorted"
    }

    /// Credentials two arguments check are both required; one argument's are either; an optional
    /// argument's may be missing while the other's stays required (#994 review 2).
    #[test]
    fn credentials_of_two_arguments_are_required_together() {
        let group = |names: &[&str], optional| (names.iter().map(|n| n.to_string()).collect::<Vec<_>>(), optional);
        let both = super::Operation::requirements(&[group(&["key"], false), group(&["bearer"], false)]);
        assert_eq!(both, [json!({ "key": [], "bearer": [] })]);
        let either = super::Operation::requirements(&[group(&["key", "bearer"], false)]);
        assert_eq!(either, [json!({ "key": [] }), json!({ "bearer": [] })]);
        let partly = super::Operation::requirements(&[group(&["key"], true), group(&["bearer"], false)]);
        assert_eq!(partly, [json!({ "key": [], "bearer": [] }), json!({ "bearer": [] })]);
        let open = super::Operation::requirements(&[group(&["key"], true), group(&[], false)]);
        assert_eq!(open, [json!({ "key": [] }), json!({})]);
        assert!(super::Operation::requirements(&[group(&[], false)]).is_empty());
    }

    /// An optional argument that takes no credentials leaves the next argument's required, in
    /// either order (#994 review 3).
    #[test]
    fn an_optional_argument_without_credentials_leaves_the_next_required() {
        fn security<A: super::Arguments>() -> Vec<Value> {
            let mut parameters = crate::route::__private::Parameters::default();
            let mut schemes = serde_json::Map::new();
            let mut operation = super::Operation {
                parameters: &mut parameters,
                schemes: &mut schemes,
                security: Vec::new(),
                body: None,
                responses: serde_json::Map::new(),
                own_failure: None,
            };
            A::describe(&mut operation);
            super::Operation::requirements(&operation.security)
        }
        let required = [json!({ "x-api-key": [] })];
        assert_eq!(security::<(Option<crate::ClientIp>, crate::Caller<Partner>)>(), required);
        assert_eq!(security::<(crate::Caller<Partner>, Option<crate::ClientIp>)>(), required);
        assert_eq!(
            security::<(Option<crate::ClientIp>, Option<crate::Caller<Partner>>)>(),
            [json!({ "x-api-key": [] }), json!({})]
        );
    }

    /// A feed is described as server-sent events, which no route in the tested document answers
    /// (#964 review).
    #[cfg(feature = "feed")]
    #[test]
    fn a_feed_is_described_as_server_sent_events() {
        let mut parameters = crate::route::__private::Parameters::default();
        let mut schemes = serde_json::Map::new();
        let mut operation = super::Operation {
            parameters: &mut parameters,
            schemes: &mut schemes,
            security: Vec::new(),
            body: None,
            responses: serde_json::Map::new(),
            own_failure: None,
        };
        <corten_feed::FeedResponse<()> as super::Answers>::describe(&mut operation);
        assert_eq!(
            Value::Object(operation.responses),
            json!({ "200": { "description": "Server-sent events", "content": { "text/event-stream": { "schema": { "type": "string" } } } } })
        );
    }

    #[crate::routes(api = ClashRoot, openapi = ClashDoc)]
    mod clash {
        #[route("/api")]
        pub struct ClashRoot;

        #[route("/api/openapi.json")]
        pub struct ClashDoc;

        #[route("/api/file", get = clash_file, put = clash_file)]
        pub struct File;

        #[route("/api/other", get = file_get)]
        pub struct Other;
    }

    async fn clash_file() -> &'static str {
        ""
    }

    async fn file_get() -> &'static str {
        ""
    }

    /// Two operations given one name (a route-and-method name another handler has) fail the
    /// document, naming both (#994 review 2).
    #[test]
    fn two_operations_of_one_name_fail_the_document() {
        let built = std::panic::catch_unwind(|| App::new(Routes::new()).api(clash::api).router());
        let message = built.expect_err("the router does not build").downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(message.contains("file_get") && message.contains("/api/other"), "{message}");
    }

    /// A parameter whose type has no JSON Schema fails the document, naming the type, as a body's
    /// does, rather than being described as any text (#994 review).
    #[test]
    fn a_parameter_with_no_schema_fails_the_document_naming_its_type() {
        let built = std::panic::catch_unwind(|| App::new(Routes::new()).api(unwritten::api).router());
        let panic = built.expect_err("the router does not build");
        let message = panic.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(message.contains("Unwritten") && message.contains("FromJson"), "{message}");
    }

    /// The same routes with no document, for what the document costs.
    #[crate::routes(api = PlainRoot)]
    mod plain {
        #[route("/api")]
        pub struct PlainRoot;

        #[route("/api/items/{id}/price", get = plain_price)]
        pub struct ItemPrice {
            pub id: u32,
            pub currency: Option<String>,
            pub market: String,
            #[serde(default)]
            pub fresh: bool,
            #[route(query)]
            pub paging: super::Paging,
        }

        #[route("/api/items/{id}/alerts", post = plain_alert)]
        pub struct Alerts {
            pub id: u32,
        }

        #[route("/api/files/{*path}", get = plain_file, put = plain_file)]
        pub struct File {
            pub path: String,
        }
    }

    async fn plain_price(Params(at): Params<plain::ItemPrice>) -> JsonResult<Price> {
        Ok(Json(Price { lowest: format!("{} {:?}", at.id, at.currency) }))
    }

    async fn plain_alert(Params(_): Params<plain::Alerts>, Json(alert): Json<NewAlert>) -> Result<StatusCode, Error> {
        let _ = (alert.below, alert.note);
        Ok(StatusCode::CREATED)
    }

    async fn plain_file(Params(at): Params<plain::File>) -> String {
        at.path
    }

    /// What the document adds to building the app's router: `BUILDS` routers (default 20) of the
    /// API with its document (`DOC=1`) or of the same routes without one. Counted under callgrind at
    /// two numbers of builds, the difference over their difference is the cost of one build.
    #[test]
    #[ignore]
    fn what_the_document_costs_a_router() {
        let builds: usize = std::env::var("BUILDS").ok().and_then(|n| n.parse().ok()).unwrap_or(20);
        let with = std::env::var("DOC").is_ok_and(|d| d == "1");
        for _ in 0..builds {
            let app = if with { App::new(Routes::new()).api(api::api) } else { App::new(Routes::new()).api(plain::api) };
            let _ = std::hint::black_box(app.router());
        }
    }

    #[tokio::test]
    async fn an_api_with_its_own_error_shape_says_its_failures_are_that_json() {
        #[derive(serde::Serialize, crate::json::ToJson)]
        struct Shaped {
            error: String,
        }
        let app = App::new(Routes::new()).api(|routes| api::api(routes).errors(|_, message| Shaped { error: message.into() }));
        let doc = document(app).await;
        let failure = &doc["components"]["responses"]["Failure"];
        assert_eq!(failure["content"]["application/json"]["schema"], json!({}));
        assert!(doc["components"]["schemas"].get("Problem").is_none());
    }
}
