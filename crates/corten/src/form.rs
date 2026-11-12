//! Forms: reading what a form posts ([`Form`]) and validation errors for it, shared
//! by every surface.
//!
//! [`Form`] and [`crate::Params`] read a body or a query string the way a browser sends it, a key once
//! per value, so a `Vec` field gets every checked box or selected option, a `bool` reads a
//! checkbox (`on`), and a blank field is `None` for an `Option`:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[derive(Fields)]
//! struct Archive {
//!     #[serde(default)]
//!     ids: Vec<String>,
//!     #[serde(default)]
//!     notify: bool,
//! }
//!
//! async fn archive(Form(form): Form<Archive>) -> String {
//!     format!("{} items, notify: {}", form.ids.len(), form.notify)
//! }
//! # let _: Methods = post(archive);
//! ```
//!
//! A browser leaves out a checkbox nobody checked and a list with nothing selected, so a `bool`
//! or list field of a `#[derive(Fields)]` struct needs `#[serde(default)]`; without it the
//! struct does not compile, rather than failing the first time someone checks nothing:
//!
//! ```compile_fail
//! #[derive(corten::Fields)]
//! struct Archive {
//!     ids: Vec<String>,
//! }
//! ```
//!
//! ```compile_fail
//! #[derive(corten::Fields)]
//! struct Alert {
//!     notify: bool,
//! }
//! ```
//!
//! A list's filters are a GET form whose controls are named as its links write the parameters.
//! One struct gives both, and it can borrow, so a page that writes many links copies nothing: its
//! `FIELDS` name the form's controls and its `#[derive(Route)]` writes the links, both renamed by
//! the same `#[serde(..)]`, which needs no serde derive of its own:
//!
//! ```
//! use corten::prelude::*;
//!
//! #[derive(Route, Fields)]
//! #[route("/search")]
//! #[serde(rename_all = "camelCase")]
//! struct Terms<'a> {
//!     price_min: Option<&'a str>,
//!     in_stock: Option<&'a str>,
//! }
//!
//! assert_eq!(Terms::FIELDS.price_min.as_str(), "priceMin");
//! assert_eq!(Terms { price_min: Some("5"), in_stock: None }.href(), "/search?priceMin=5");
//! ```
//!
//! Its handler reads what the form sent back as the route's own [`crate::Params`].
//!
//! The rest of this module carries validation errors to each surface.
//!
//! The rules stay in the app (they are business rules), a number field's allowed values too
//! ([`Bounds`], which gives the input the browser's own check of them and the handler the same
//! check); Corten only carries the result to each surface the same way: a browser gets the form
//! re-rendered with messages next to its fields and focus on the first one
//! ([`crate::Req::invalid`]), a data client or an [`crate::App::api`] route gets the JSON error
//! with one message per field (`Errors` is a response, feature `json`), and an agent tool gets
//! the same messages (`ToolError::from(errors)`, feature `agent`).
//!
//! Fields are named by [`FieldName`]s from `#[derive(Fields)]`, never by text. In the form, mark
//! each field and print its message, which the field points at. Both go through
//! [`Errors::within`] the form's id (the `#[derive(Id)]` of the element a refusal replaces), so a
//! message's id, `{form id}-{field}-error`, is not another form's on the same page:
//!
//! ```ignore
//! let f = Input::FIELDS;
//! let e = errors.within(SignupId);
//! html! {
//!     <form id={SignupId} method="post" data-patch>
//!         <input name={f.email} value={input.email} {..e.aria(f.email)}>
//!         {e.message(f.email)}
//!     </form>
//! }
//! ```
//!
//! Ids are written by `#[derive(Id)]` types, never as text:
//!
//! ```compile_fail
//! let errors = corten::Errors::new();
//! let e = errors.within("signup");
//! ```
//!
//! A field named as text does not compile:
//!
//! ```compile_fail
//! let mut errors = corten::Errors::new();
//! errors.add("email", "Enter an email address.");
//! ```
//!
//! A group of fields is a `Fields` struct put in a form with `#[fields(group)]`, named under its
//! field (`ship_to.street`), and rows are a map from each row's key to one
//! (`#[fields(rows)]`), named under the key (`lines[7].qty`), so the key puts each value in its
//! row and each row's field has its own error:
//!
//! ```
//! use std::collections::BTreeMap;
//! use corten::prelude::*;
//!
//! #[derive(Fields)]
//! struct Address { street: String }
//!
//! #[derive(Fields)]
//! struct Line { qty: u32, #[serde(default)] gift: bool }
//!
//! #[derive(Fields)]
//! struct Order {
//!     #[fields(group)]
//!     ship_to: Address,
//!     #[fields(rows)]
//!     #[serde(default)]
//!     lines: BTreeMap<u32, Line>,
//! }
//!
//! let f = Order::FIELDS;
//! assert_eq!(f.ship_to.street.to_string(), "ship_to.street");
//! assert_eq!(f.lines.at(&7).qty.to_string(), "lines[7].qty");
//!
//! let order: Order = corten::form::from_bytes(b"lines%5B9%5D.qty=1&ship_to.street=Elm&lines%5B7%5D.qty=2&lines%5B7%5D.gift=on").unwrap();
//! assert_eq!((order.ship_to.street.as_str(), order.lines[&7].qty, order.lines[&7].gift, order.lines[&9].gift), ("Elm", 2, true, false));
//!
//! let mut errors = Errors::new();
//! errors.add(f.lines.at(&9).qty, "At least 2.");
//! assert!(errors.has(f.lines.at(&9).qty) && !errors.has(f.lines.at(&7).qty));
//! ```
//!
//! A row is named by the map's key type only:
//!
//! ```compile_fail,E0308
//! # use std::collections::BTreeMap;
//! # use corten::prelude::*;
//! # #[derive(Fields)]
//! # struct Line { qty: u32 }
//! #[derive(Fields)]
//! struct Order {
//!     #[fields(rows)]
//!     #[serde(default)]
//!     lines: BTreeMap<u32, Line>,
//! }
//! let _ = Order::FIELDS.lines.at(&"7").qty;
//! ```
//!
//! and a row's field is reached through its row:
//!
//! ```compile_fail,E0609
//! # use std::collections::BTreeMap;
//! # use corten::prelude::*;
//! # #[derive(Fields)]
//! # struct Line { qty: u32 }
//! # #[derive(Fields)]
//! # struct Order { #[fields(rows)] #[serde(default)] lines: BTreeMap<u32, Line> }
//! let mut errors = Errors::new();
//! errors.add(Order::FIELDS.lines.qty, "At least 1.");
//! ```
//!
//! A form with none sends nothing for rows, so they need `#[serde(default)]`:
//!
//! ```compile_fail
//! # use std::collections::BTreeMap;
//! # #[derive(corten::Fields)]
//! # struct Line { qty: u32 }
//! #[derive(corten::Fields)]
//! struct Order {
//!     #[fields(rows)]
//!     lines: BTreeMap<u32, Line>,
//! }
//! ```
//!
//! and so does a map:
//!
//! ```compile_fail
//! # use std::collections::BTreeMap;
//! #[derive(corten::Fields)]
//! struct Counts {
//!     #[fields(map)]
//!     counts: BTreeMap<u32, u32>,
//! }
//! ```
//!
//! A map's value may be an `Option`, so a count left blank reads as `None`:
//!
//! ```
//! # use std::collections::BTreeMap;
//! #[derive(corten::Fields)]
//! struct Counts {
//!     #[fields(map)]
//!     #[serde(default)]
//!     counts: BTreeMap<u32, Option<u32>>,
//! }
//! let read: Counts = corten::form::from_bytes(b"counts%5B4%5D=2&counts%5B9%5D=").unwrap();
//! assert_eq!(read.counts, BTreeMap::from([(4, Some(2)), (9, None)]));
//! ```
//!
//! A field is `#[fields(group)]`, `#[fields(rows)]` or `#[fields(map)]`, and a name in the form
//! has no `.`, `[` or `]` of its own (they name a group's or a row's fields):
//!
//! ```compile_fail
//! # use std::collections::BTreeMap;
//! #[derive(corten::Fields)]
//! struct Counts {
//!     #[fields(list)]
//!     #[serde(default)]
//!     counts: BTreeMap<u32, u32>,
//! }
//! ```
//!
//! ```compile_fail
//! #[derive(corten::Fields)]
//! struct Order {
//!     #[serde(rename = "ship.zip")]
//!     zip: String,
//! }
//! ```
//!
//! A group's fields are plain, so a group of a type with groups or rows does not compile, and a
//! row holds plain fields and groups, not rows:
//!
//! ```compile_fail,E0080
//! # use corten::prelude::*;
//! #[derive(Fields)]
//! struct Street { line: String }
//! #[derive(Fields)]
//! struct Address { #[fields(group)] street: Street }
//! #[derive(Fields)]
//! struct Order { #[fields(group)] ship_to: Address }
//! let _ = Order::FIELDS;
//! ```
//!
//! ```compile_fail,E0080
//! # use std::collections::BTreeMap;
//! # use corten::prelude::*;
//! #[derive(Fields)]
//! struct Line { qty: u32 }
//! #[derive(Fields)]
//! struct Address { #[fields(rows)] #[serde(default)] lines: BTreeMap<u32, Line> }
//! #[derive(Fields)]
//! struct Order { #[fields(group)] ship_to: Address }
//! let _ = Order::FIELDS;
//! ```
//!
//! ```compile_fail,E0080
//! # use std::collections::BTreeMap;
//! # use corten::prelude::*;
//! #[derive(Fields)]
//! struct Part { qty: u32 }
//! #[derive(Fields)]
//! struct Line { #[fields(rows)] #[serde(default)] parts: BTreeMap<u32, Part> }
//! #[derive(Fields)]
//! struct Order { #[fields(rows)] #[serde(default)] lines: BTreeMap<u32, Line> }
//! let _ = Order::FIELDS;
//! ```
//!
//! A group whose fields a form can all leave out (checkboxes, `Option`s, file inputs, which are
//! never among the text fields) needs a default of its own, or a form that sends none of them is
//! refused:
//!
//! ```compile_fail,E0080
//! # use corten::prelude::*;
//! #[derive(Fields)]
//! struct Notices { #[serde(default)] email: bool, #[serde(default)] text: bool }
//! #[derive(Fields)]
//! struct Account { name: String, #[fields(group)] notices: Notices }
//! let _ = Account::FIELDS;
//! ```
//!
//! ```compile_fail,E0080
//! # use corten::prelude::*;
//! #[derive(Fields)]
//! struct Proof { scan: Files }
//! #[derive(Fields)]
//! struct Claim { title: String, #[fields(group)] proof: Proof }
//! let _ = Claim::FIELDS;
//! ```
//!
//! ```
//! # use corten::prelude::*;
//! #[derive(Fields, Default, PartialEq, Debug)]
//! struct Notices { #[serde(default)] email: bool, #[serde(default)] text: bool }
//! #[derive(Fields)]
//! struct Account { name: String, #[fields(group)] #[serde(default)] notices: Notices }
//! let _ = Account::FIELDS;
//! let read: Account = corten::form::from_bytes(b"name=Ada").unwrap();
//! assert_eq!(read.notices, Notices::default());
//! ```
//!
//! A group is never an `Option`: a form sends a group's fields one by one, so it is a group of
//! `Option`s with a default, as above.
//!
//! ```compile_fail
//! # use corten::prelude::*;
//! #[derive(Fields)]
//! struct Address { street: Option<String> }
//! #[derive(Fields)]
//! struct Order { #[fields(group)] #[serde(default)] ship_to: Option<Address> }
//! ```

use std::fmt;

use crate::extract::{BodyRejection, FromRequest};
use crate::handler::Request;
use bytes::Bytes;
use http::{header, HeaderValue, Method, StatusCode};

use crate::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;

use crate::view::{escape_into, quoted, AttrValue, Attrs, Id, Render};

mod bounds;
pub(crate) mod de;
mod number;
pub(crate) mod upload;
pub use bounds::{Bounds, Numeric};
pub use de::{from_bytes, FormError};
pub use number::{read_number, Entry};
pub use upload::{File, Files, Upload, UploadError};

/// Implemented by `#[derive(Fields)]` for a form with [`Files`], whose fields nothing else reads.
#[doc(hidden)]
pub trait __FileInputs {
    fn __file_inputs(&self) -> usize;
}

/// A form's fields: the body of a `POST` (`application/x-www-form-urlencoded`), or the query
/// string of a `GET`, read into `T` the way a browser sends them (see the [module](self)).
/// As an extractor it reads the body, so it comes last among a handler's arguments.
#[derive(Clone, Copy, Debug, Default)]
pub struct Form<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for Form<T> {
    type Rejection = FormRejection;

    async fn from_request(req: Request, _: &S) -> Result<Self, FormRejection> {
        let query = matches!(*req.method(), Method::GET | Method::HEAD);
        let bytes = fields(req).await.map_err(FormRejection::Body)?;
        match from_bytes(&bytes) {
            Ok(value) => Ok(Form(value)),
            // As axum's `Form`: a query string that does not fit is a bad request, a body a 422.
            Err(error) if query => Err(FormRejection::invalid(StatusCode::BAD_REQUEST, "Failed to deserialize form", error)),
            Err(error) => Err(FormRejection::invalid(StatusCode::UNPROCESSABLE_ENTITY, "Failed to deserialize form body", error)),
        }
    }
}

/// A form's fields as sent: a `GET`'s or a `HEAD`'s query string (a `HEAD` asks for what a `GET`
/// would answer), or any other request's body, which must be `application/x-www-form-urlencoded`
/// (a 415 otherwise).
async fn fields(req: Request) -> Result<Bytes, BodyRejection> {
    if matches!(*req.method(), Method::GET | Method::HEAD) {
        return Ok(req.uri().query().map_or_else(Bytes::new, |query| Bytes::copy_from_slice(query.as_bytes())));
    }
    let kind = req.headers().get(header::CONTENT_TYPE).and_then(|kind| kind.to_str().ok());
    if !kind.is_some_and(|kind| crate::api::media_type(kind).eq_ignore_ascii_case("application/x-www-form-urlencoded")) {
        return Err(BodyRejection::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Form requests must have `Content-Type: application/x-www-form-urlencoded`",
        ));
    }
    let limit = crate::extract::body_limit(req.extensions());
    crate::extract::whole(req.into_body(), limit).await
}

/// Why [`Form`] or [`crate::Params`] refused a request: plain text, so a browser gets the app's
/// error page (the text under it in dev mode) and a JSON client the JSON error.
#[derive(Debug)]
pub enum FormRejection {
    /// The body could not be read, or a `POST` was not `application/x-www-form-urlencoded`.
    Body(BodyRejection),
    /// The fields did not fit the type: a value of the wrong kind, a missing field, a field sent
    /// twice.
    Invalid(StatusCode, String),
}

impl FormRejection {
    pub(crate) fn invalid(status: StatusCode, what: &str, error: FormError) -> Self {
        FormRejection::Invalid(status, format!("{what}: {error}"))
    }
}

impl fmt::Display for FormRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormRejection::Body(rejection) => fmt::Display::fmt(rejection, f),
            FormRejection::Invalid(_, text) => f.write_str(text),
        }
    }
}

impl std::error::Error for FormRejection {}

impl IntoResponse for FormRejection {
    fn into_response(self) -> Response {
        match self {
            FormRejection::Body(rejection) => rejection.into_response(),
            FormRejection::Invalid(status, text) => {
                (status, [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))], text).into_response()
            }
        }
    }
}

macro_rules! deref {
    ($($name:ident),*) => {$(
        impl<T> std::ops::Deref for $name<T> {
            type Target = T;
            fn deref(&self) -> &T {
                &self.0
            }
        }

        impl<T> std::ops::DerefMut for $name<T> {
            fn deref_mut(&mut self) -> &mut T {
                &mut self.0
            }
        }
    )*};
}
deref!(Form);

/// The name a form field posts under, from `#[derive(Fields)]`: `Input::FIELDS.email`. Markup
/// prints it (`name={f.email}`) and [`Errors`] is keyed by it, so renaming or misspelling a field
/// of the form struct is a compile error in both.
///
/// `T` is the value the field's control sends: the field's type, without an `Option` or a `Vec`
/// around it (`condition: Option<Condition>` is a `FieldName<Condition>`), so a control that takes
/// a typed name (a picker of conditions, a submit key) cannot be given another field's. Text
/// borrowed from the request (`&'a str`, `Cow<'a, str>`) is a `String`'s. A field whose type uses
/// the struct's own generics or another lifetime is [`Untyped`]; [`FieldName::untyped`] drops the
/// type of any name, for a list of several fields' names.
///
/// `P` is where the field is: the form itself ([`Root`], the default), a group
/// (`f.ship_to.street`, posted `ship_to.street`) or a row of [`Rows`]
/// (`f.domains.at(&Domain::SellerPortal).max_concurrent`, posted
/// `domains[seller-portal].max_concurrent`). A form's own field is its name alone, so it costs
/// what a `&'static str` does.
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Clone, Copy, PartialEq, UrlValue)]
/// enum Condition { Mint, Played }
///
/// #[derive(Fields)]
/// struct Sell { condition: Option<Condition>, #[serde(default)] tags: Vec<String> }
///
/// let condition: FieldName<Condition> = Sell::FIELDS.condition;
/// let tags: FieldName<String> = Sell::FIELDS.tags;
/// assert_eq!((condition.as_str(), tags.as_str()), ("condition", "tags"));
/// assert_eq!(std::mem::size_of_val(&condition), std::mem::size_of::<&str>());
/// ```
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Search<'a> {
///     q: &'a str,
///     #[serde(borrow)]
///     note: std::borrow::Cow<'a, str>,
///     sizes: Option<Vec<u8>>,
///     #[serde(default)]
///     picks: Vec<Option<u8>>,
/// }
///
/// let f = Search::FIELDS;
/// let _: (FieldName<String>, FieldName<String>) = (f.q, f.note);
/// let _: (FieldName<u8>, FieldName<u8>) = (f.sizes, f.picks);
/// let names = [f.q.untyped(), f.sizes.untyped()];
/// assert_eq!(names.map(|n| n.as_str()), ["q", "sizes"]);
/// ```
///
/// A name of one field's type is not another's:
///
/// ```compile_fail,E0308
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Sell { price: u32, note: String }
///
/// let _: FieldName<u32> = Sell::FIELDS.note;
/// ```
pub struct FieldName<T = Untyped, P = Root> {
    at: P,
    name: &'static str,
    value: std::marker::PhantomData<fn() -> T>,
}

/// The value type of a [`FieldName`] that names none: a hand-written name, or a field whose type
/// uses its struct's generics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Untyped {}

impl<P: Copy, T> Clone for FieldName<T, P> {
    #[inline]
    fn clone(&self) -> Self {
        *self
    }
}

impl<P: Copy, T> Copy for FieldName<T, P> {}

impl<T> FieldName<T, Root> {
    /// Used by the code `#[derive(Fields)]` generates.
    #[doc(hidden)]
    pub const fn __new(name: &'static str) -> Self {
        FieldName { at: Root, name, value: std::marker::PhantomData }
    }

    /// The name as posted: `"email"`. A field of a group or a row is written, not stored: print
    /// it, or compare it with text (`f.ship_to.street == "ship_to.street"`).
    pub const fn as_str(self) -> &'static str {
        self.name
    }
}

impl<P: Place, T> FieldName<T, P> {
    /// Used by the code `#[derive(Fields)]` generates.
    #[doc(hidden)]
    pub const fn __at(at: P, name: &'static str) -> Self {
        FieldName { at, name, value: std::marker::PhantomData }
    }

    /// The same name without its value type: for the app's own helper that keeps names of several
    /// types in one list (`[f.email.untyped(), f.price.untyped()]`), or a control of its own that
    /// sends text whatever the field reads. A typed control does not take it back.
    pub const fn untyped(self) -> FieldName<Untyped, P> {
        FieldName { at: self.at, name: self.name, value: std::marker::PhantomData }
    }
}

/// Whether this name is the field `text` names, as a form posts it: `f.email == "email"`.
impl<P: Place, T> PartialEq<str> for FieldName<T, P> {
    fn eq(&self, text: &str) -> bool {
        self.at.is_text(self.name, text)
    }
}

impl<P: Place, T> PartialEq<&str> for FieldName<T, P> {
    fn eq(&self, text: &&str) -> bool {
        self.at.is_text(self.name, text)
    }
}

impl<P: Place, T> PartialEq for FieldName<T, P> {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name && self.at == other.at
    }
}

impl<P: Place, T> Eq for FieldName<T, P> {}

impl<P: Place, T> std::hash::Hash for FieldName<T, P> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.at.hash(state);
        self.name.hash(state);
    }
}

impl<P: Place, T> fmt::Debug for FieldName<T, P> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FieldName({self})")
    }
}

impl<P: Place, T> fmt::Display for FieldName<T, P> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.at.display(self.name, f)
    }
}

impl<P: Place, T> Render for FieldName<T, P> {
    #[inline]
    fn render(&self, out: &mut String) {
        self.at.render(self.name, out)
    }
}

impl<P: Place, T> AttrValue for FieldName<T, P> {
    #[inline]
    fn write_attr(&self, name: &str, out: &mut String) {
        quoted(name, self, out)
    }
}

/// A GET form's controls, and the rest of a typed route's query as hidden inputs: a GET form
/// sends only its own controls (and drops its `action`'s query), so a form that changes the
/// research on a screen whose address also holds the seller and the page would lose them.
/// `controls` is drawn first; every key of the route's query that no control in it names
/// (`name="grade"`, a set's `sortBy`, a prefixed `dim.color`) is then kept as a hidden input, in
/// the encoding the route's links use (an `Option` only when set, a list once per item, an enum
/// by its word). A field added to the route is kept by every such form without a change to it,
/// and a control's key is never sent twice, so there is no list of names to keep in step.
///
/// ```
/// use corten::prelude::*;
/// use corten::form::keep_query;
///
/// #[derive(Clone, Default, Route, Fields)]
/// #[route("/slab-pricing")]
/// struct Choice { cert: Option<String>, seller: Option<String>, #[serde(default)] trail: Vec<String>, grade: Option<u8> }
///
/// let at = Choice { cert: Some("a&b".into()), seller: None, trail: vec!["p1".into(), "p2".into()], grade: Some(9) };
/// let f = Choice::FIELDS;
/// let form = html! {
///     <form method="get" action={&at}>
///         {keep_query(&at, &html! { <input name={f.grade} value="10"> <button>"Price"</button> })}
///     </form>
/// };
/// assert_eq!(
///     form.to_html(),
///     concat!(
///         r#"<form method="get" action="/slab-pricing?cert=a%26b&amp;trail=p1&amp;trail=p2&amp;grade=9">"#,
///         r#"<input name="grade" value="10"><button>Price</button>"#,
///         r#"<input type="hidden" name="cert" value="a&amp;b">"#,
///         r#"<input type="hidden" name="trail" value="p1"><input type="hidden" name="trail" value="p2">"#,
///         r#"</form>"#,
///     )
/// );
/// ```
///
/// Lent (`&html! { .. }`), the controls borrow what they use, so the rest of the page reads the
/// same locals. A form that starts a new search (a new grade drops the page of results it was on)
/// passes the route with those fields cleared, `&Choice { after: None, ..at.clone() }`; they are
/// then not kept.
///
/// Given by value (`html! { .. }`), the controls own what they use, so a callee may keep them, and
/// the page cannot read a local they moved:
///
/// ```compile_fail,E0382
/// use corten::prelude::*;
/// use corten::form::keep_query;
///
/// #[derive(Default, Route)]
/// #[route("/slab-pricing")]
/// struct Choice { grade: Option<u8> }
///
/// let (at, shown) = (Choice::default(), String::from("PSA 9"));
/// let _ = html! { <form method="get">{keep_query(&at, html! { <p>{&shown}</p> })}</form> <p>{&shown}</p> };
/// ```
///
/// Every control the form sends goes inside, a named submit button included: one outside it is
/// not seen, so its key would be sent twice. It takes a link (a typed route, or the `&dyn Href` a
/// form several pages share is given), so a URL as text does not compile:
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
/// use corten::form::keep_query;
///
/// let _ = html! { <form method="get">{keep_query(&"/slab-pricing?grade=9", &html! { <input name="grade"> })}</form> };
/// ```
pub fn keep_query<'a, R: crate::Href + ?Sized, C: Render>(route: &'a R, controls: C) -> KeepQuery<'a, R, C> {
    KeepQuery { route, controls }
}

/// What [`keep_query`] returns: the controls, then hidden inputs for the route's query keys they
/// do not name.
pub struct KeepQuery<'a, R: ?Sized, C> {
    route: &'a R,
    controls: C,
}

impl<R: crate::Href + ?Sized, C: Render> Render for KeepQuery<'_, R, C> {
    fn render(&self, out: &mut String) {
        let start = out.len();
        self.controls.render(out);
        // The route's own encoding, read back: what its links send is what the form keeps.
        let mut href = String::new();
        self.route.write_link(&mut href, false);
        let query = href.split_once('?').map_or("", |(_, q)| q);
        let query = query.split_once('#').map_or(query, |(q, _)| q);
        if query.is_empty() {
            return;
        }
        let mut named = String::new();
        let mut kept = String::new();
        for (key, value) in form_urlencoded::parse(query.as_bytes()) {
            // The names the controls wrote, as they wrote them: escaped, in ` name="..."`.
            named.clear();
            named.push_str(" name=\"");
            escape_into(&key, &mut named);
            named.push('"');
            if out[start..].contains(named.as_str()) {
                continue;
            }
            kept.push_str(r#"<input type="hidden""#);
            kept.push_str(&named);
            kept.push_str(r#" value=""#);
            escape_into(&value, &mut kept);
            kept.push_str(r#"">"#);
        }
        out.push_str(&kept);
    }
}

/// Where a form struct's fields are, written in front of each field's name: implemented by
/// [`Root`], [`Group`], [`Row`] and [`RowGroup`]. Sealed.
pub trait Place: Copy + PartialEq + std::hash::Hash + private::Sealed {
    /// The name `name` here, escaped for HTML.
    #[doc(hidden)]
    fn render(&self, name: &'static str, out: &mut String) {
        let mut text = String::new();
        self.write(name, &mut text);
        escape_into(&text, out)
    }
    /// The name `name` here as posted, a row's key %-encoded.
    #[doc(hidden)]
    fn write(&self, name: &'static str, out: &mut String);
    #[doc(hidden)]
    fn display(&self, name: &'static str, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut text = String::new();
        self.write(name, &mut text);
        f.write_str(&text)
    }
    #[doc(hidden)]
    fn is_text(&self, name: &'static str, text: &str) -> bool {
        let mut own = String::with_capacity(text.len());
        self.write(name, &mut own);
        own == text
    }
    /// What an [`Errors`] keeps of it.
    #[doc(hidden)]
    fn kept(&self) -> At;
    /// Whether an [`Errors`] kept it as `at`.
    #[doc(hidden)]
    fn is_kept(&self, at: &At) -> bool {
        self.kept() == *at
    }
    /// The rows and key of a row's field, which [`Errors`] finds by an index.
    #[doc(hidden)]
    fn row(&self) -> Option<(&'static str, &(dyn RowKey + Sync))> {
        None
    }
}

mod private {
    pub trait Sealed {}
    impl Sealed for super::Root {}
    impl Sealed for super::Group {}
    impl Sealed for super::Row<'_> {}
    impl Sealed for super::RowGroup<'_> {}
}

/// A form's own fields: `email`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub struct Root;

impl Place for Root {
    #[inline]
    fn render(&self, name: &'static str, out: &mut String) {
        escape_into(name, out)
    }
    fn write(&self, name: &'static str, out: &mut String) {
        out.push_str(name)
    }
    fn display(&self, name: &'static str, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(name)
    }
    #[inline]
    fn is_text(&self, name: &'static str, text: &str) -> bool {
        name == text
    }
    fn kept(&self) -> At {
        At::Root
    }
    #[inline]
    fn is_kept(&self, at: &At) -> bool {
        matches!(at, At::Root)
    }
}

/// A group's fields (`#[fields(group)]`): `ship_to.street`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Group(&'static str);

impl Place for Group {
    fn render(&self, name: &'static str, out: &mut String) {
        escape_into(self.0, out);
        out.push('.');
        escape_into(name, out);
    }
    fn write(&self, name: &'static str, out: &mut String) {
        out.push_str(self.0);
        out.push('.');
        out.push_str(name);
    }
    fn kept(&self) -> At {
        At::Group(self.0)
    }
    fn is_kept(&self, at: &At) -> bool {
        *at == At::Group(self.0)
    }
}

/// A row's fields (`#[fields(rows)]`): `domains[seller-portal].max_concurrent`. `'k` borrows the key.
#[derive(Clone, Copy)]
pub struct Row<'k> {
    rows: &'static str,
    key: &'k (dyn RowKey + Sync),
}

impl PartialEq for Row<'_> {
    fn eq(&self, other: &Self) -> bool {
        let (mut a, mut b) = (KeyBuf::new(), KeyBuf::new());
        self.rows == other.rows && self.key.key_text(&mut a) == other.key.key_text(&mut b)
    }
}

impl std::hash::Hash for Row<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        (self.rows, self.key.key_text(&mut KeyBuf::new())).hash(state)
    }
}

impl Place for Row<'_> {
    fn render(&self, name: &'static str, out: &mut String) {
        render_row(self.rows, self.key, "", name, out)
    }
    fn write(&self, name: &'static str, out: &mut String) {
        write_row(self.rows, self.key.key_text(&mut KeyBuf::new()), out);
        write_tail("", name, out);
    }
    fn kept(&self) -> At {
        At::Row(self.rows, self.key.key_text(&mut KeyBuf::new()).into(), "")
    }
    fn is_kept(&self, at: &At) -> bool {
        matches!(at, At::Row(rows, key, "") if *rows == self.rows && **key == *self.key.key_text(&mut KeyBuf::new()))
    }
    fn row(&self) -> Option<(&'static str, &(dyn RowKey + Sync))> {
        Some((self.rows, self.key))
    }
}

/// A group's fields in a row: `shipments[7].address.street`.
#[derive(Clone, Copy)]
pub struct RowGroup<'k> {
    row: Row<'k>,
    group: &'static str,
}

impl PartialEq for RowGroup<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.row == other.row && self.group == other.group
    }
}

impl std::hash::Hash for RowGroup<'_> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.row.hash(state);
        self.group.hash(state);
    }
}

impl Place for RowGroup<'_> {
    fn render(&self, name: &'static str, out: &mut String) {
        render_row(self.row.rows, self.row.key, self.group, name, out)
    }
    fn write(&self, name: &'static str, out: &mut String) {
        write_row(self.row.rows, self.row.key.key_text(&mut KeyBuf::new()), out);
        write_tail(self.group, name, out);
    }
    fn kept(&self) -> At {
        At::Row(self.row.rows, self.row.key.key_text(&mut KeyBuf::new()).into(), self.group)
    }
    fn is_kept(&self, at: &At) -> bool {
        matches!(at, At::Row(rows, key, group) if *rows == self.row.rows && *group == self.group && **key == *self.row.key.key_text(&mut KeyBuf::new()))
    }
    fn row(&self) -> Option<(&'static str, &(dyn RowKey + Sync))> {
        Some((self.row.rows, self.row.key))
    }
}

/// `rows[key]`, the key %-encoded.
fn write_row(rows: &str, key: &str, out: &mut String) {
    out.push_str(rows);
    out.push('[');
    encode_key(key, out);
    out.push(']');
}

/// `.name` after a row, or nothing for a map's value (`#[fields(map)]`, which has no name).
fn write_tail(group: &str, name: &str, out: &mut String) {
    if !group.is_empty() {
        out.push('.');
        out.push_str(group);
    }
    if !name.is_empty() {
        out.push('.');
        out.push_str(name);
    }
}

/// `rows[key].group.name` for HTML: the names escaped, the key %-encoded (which leaves only
/// characters HTML takes as they are), with nothing allocated.
fn render_row(rows: &'static str, key: &(dyn RowKey + Sync), group: &'static str, name: &'static str, out: &mut String) {
    escape_into(rows, out);
    out.push('[');
    encode_key(key.key_text(&mut KeyBuf::new()), out);
    out.push(']');
    if !group.is_empty() {
        out.push('.');
        escape_into(group, out);
    }
    if !name.is_empty() {
        out.push('.');
        escape_into(name, out);
    }
}

/// Where a field an [`Errors`] keeps is, its row's key copied.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum At {
    Root,
    Group(&'static str),
    /// The rows' field, the key and a group in the row (`""` for none).
    Row(&'static str, Box<str>, &'static str),
}

impl At {
    fn write(&self, name: &'static str, out: &mut String) {
        match self {
            At::Root => out.push_str(name),
            At::Group(group) => Group(group).write(name, out),
            At::Row(rows, key, group) => {
                write_row(rows, key, out);
                write_tail(group, name, out);
            }
        }
    }
}

/// A row key's characters other than ASCII letters, digits, `-` and `_` as `%XX` (each byte of
/// their UTF-8), so a key cannot end its brackets or put a space in a message's id.
fn encode_key(key: &str, out: &mut String) {
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push(char::from(b"0123456789ABCDEF"[usize::from(b >> 4)]));
            out.push(char::from(b"0123456789ABCDEF"[usize::from(b & 15)]));
        }
    }
}

/// A key of a [`Rows`] field, written in its fields' names as the form reads it back: text, an
/// integer, or a `#[derive(UrlValue)]` enum (its word). A newtype key implements it as the value
/// it wraps (`self.0.key_text(buf)`), and its `Deserialize` must read it back from that text and
/// from no other (not case-insensitively, say), or one row could be reached by two keys.
///
/// An enum with a variant serde reads by more than its word (`#[serde(alias)]`, `#[serde(other)]`)
/// is no row's key: two keys the form tells apart would be one row on the server, so naming its
/// row does not compile:
///
/// ```compile_fail,E0277
/// use std::collections::BTreeMap;
/// use corten::prelude::*;
///
/// #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, UrlValue)]
/// #[serde(rename_all = "kebab-case")]
/// enum Condition { #[serde(alias = "nm")] NearMint, Played }
///
/// #[derive(Fields)]
/// struct Price { cents: u32 }
///
/// #[derive(Fields)]
/// struct Prices {
///     #[fields(rows)]
///     #[serde(default)]
///     by_condition: BTreeMap<Condition, Price>,
/// }
/// let _ = Prices::FIELDS.by_condition.at(&Condition::NearMint).cents;
/// ```
#[diagnostic::on_unimplemented(
    message = "{Self} is not a row's key",
    label = "names a row by a {Self}",
    note = "a row's key is text, an integer, a newtype of one, or a #[derive(UrlValue)] enum whose every variant serde reads by its word alone (no alias, no other)"
)]
pub trait RowKey {
    /// The key as text, as the form's field reads it back: its own text, or written into `buf`
    /// when it has none stored (an integer), so naming a row allocates nothing.
    fn key_text<'a>(&'a self, buf: &'a mut KeyBuf) -> &'a str;
}

/// Room for a [`RowKey`] with no text stored to write it: 40 bytes, the longest `i128`.
pub struct KeyBuf {
    bytes: [u8; 40],
    len: usize,
}

impl KeyBuf {
    pub fn new() -> Self {
        KeyBuf { bytes: [0; 40], len: 0 }
    }

    /// Writes an integer and gives it back as text. Private: an integer fits (`i128::MIN` is 40
    /// bytes), and any other key has text of its own (a newtype gives its field's).
    fn write(&mut self, value: impl fmt::Display) -> &str {
        use fmt::Write;
        self.len = 0;
        let _ = write!(self, "{value}");
        std::str::from_utf8(&self.bytes[..self.len]).unwrap_or_default()
    }
}

impl Default for KeyBuf {
    fn default() -> Self {
        KeyBuf::new()
    }
}

impl fmt::Write for KeyBuf {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let end = self.len + text.len();
        self.bytes.get_mut(self.len..end).ok_or(fmt::Error)?.copy_from_slice(text.as_bytes());
        self.len = end;
        Ok(())
    }
}

impl RowKey for String {
    fn key_text<'a>(&'a self, _: &'a mut KeyBuf) -> &'a str {
        self
    }
}

impl RowKey for Box<str> {
    fn key_text<'a>(&'a self, _: &'a mut KeyBuf) -> &'a str {
        self
    }
}

impl RowKey for &str {
    fn key_text<'a>(&'a self, _: &'a mut KeyBuf) -> &'a str {
        self
    }
}

macro_rules! integer_keys {
    ($($t:ty),*) => {$(
        impl RowKey for $t {
            fn key_text<'a>(&'a self, buf: &'a mut KeyBuf) -> &'a str {
                buf.write(self)
            }
        }
    )*};
}
integer_keys!(u8, u16, u32, u64, u128, usize, i8, i16, i32, i64, i128, isize);

/// A form struct's field names, from `#[derive(Fields)]`; what lets a struct be a group
/// (`#[fields(group)]`) or a row (`#[fields(rows)]`) of another.
pub trait Fields {
    /// Its names at the form's top.
    type Names: Copy + fmt::Debug;
    /// Its names as a group, `ship_to.street`.
    #[doc(hidden)]
    type InGroup: Copy + fmt::Debug;
    /// Its names in a row, `lines[7].qty`.
    #[doc(hidden)]
    type InRow<'k>: Copy + fmt::Debug;
    /// Its names as a group in a row, `lines[7].address.street`.
    #[doc(hidden)]
    type InRowGroup<'k>: Copy + fmt::Debug;
    /// 0 when it has no group and no rows, 1 when it has groups and no rows, 2 with rows.
    #[doc(hidden)]
    const SHAPE: u8;
    /// Whether a form can send none of its fields (each an `Option` or `#[serde(default)]`): such
    /// a group needs a default of its own.
    #[doc(hidden)]
    const LEAVE_OUT: bool;
    #[doc(hidden)]
    fn in_row<'k>(rows: &'static str, key: &'k (dyn RowKey + Sync)) -> Self::InRow<'k>;
}

/// What a group's or a row's names hold where another group or rows would be: nothing, since a
/// group holds plain fields and a row plain fields and groups (refused when the app builds).
#[doc(hidden)]
#[derive(Clone, Copy, Debug)]
pub struct Refused;

/// Used by the code `#[derive(Fields)]` generates.
#[doc(hidden)]
pub mod __private {
    use std::{borrow::Cow, marker::PhantomData};

    use serde::de::{Deserialize, Deserializer, Error, Visitor};

    use super::*;

    /// A field the input leaves out that has no default: `None` for an `Option`, and serde's
    /// missing-field error for anything else, as serde's derive reads one.
    pub fn missing_field<'de, V: Deserialize<'de>, E: Error>(field: &'static str) -> Result<V, E> {
        struct Missing<E>(&'static str, PhantomData<E>);
        impl<'de, E: Error> Deserializer<'de> for Missing<E> {
            type Error = E;
            fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, E> {
                Err(E::missing_field(self.0))
            }
            fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, E> {
                visitor.visit_none()
            }
            serde::forward_to_deserialize_any! {
                bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf unit
                unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
            }
        }
        V::deserialize(Missing(field, PhantomData))
    }

    /// A `#[serde(borrow)]` `Cow<'a, str>` or `Cow<'a, [u8]>` field: borrowed from the input where
    /// the input lends it, owned where it was decoded, as serde's derive reads one.
    pub struct Borrow<T>(pub T);

    impl<'de: 'a, 'a> Deserialize<'de> for Borrow<Cow<'a, str>> {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Text;
            impl<'de> Visitor<'de> for Text {
                type Value = Cow<'de, str>;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("a string")
                }
                fn visit_borrowed_str<E: Error>(self, text: &'de str) -> Result<Cow<'de, str>, E> {
                    Ok(Cow::Borrowed(text))
                }
                fn visit_str<E: Error>(self, text: &str) -> Result<Cow<'de, str>, E> {
                    Ok(Cow::Owned(text.to_owned()))
                }
                fn visit_string<E: Error>(self, text: String) -> Result<Cow<'de, str>, E> {
                    Ok(Cow::Owned(text))
                }
                fn visit_borrowed_bytes<E: Error>(self, bytes: &'de [u8]) -> Result<Cow<'de, str>, E> {
                    match std::str::from_utf8(bytes) {
                        Ok(text) => Ok(Cow::Borrowed(text)),
                        Err(_) => Err(E::invalid_value(serde::de::Unexpected::Bytes(bytes), &self)),
                    }
                }
                fn visit_bytes<E: Error>(self, bytes: &[u8]) -> Result<Cow<'de, str>, E> {
                    match std::str::from_utf8(bytes) {
                        Ok(text) => Ok(Cow::Owned(text.to_owned())),
                        Err(_) => Err(E::invalid_value(serde::de::Unexpected::Bytes(bytes), &self)),
                    }
                }
                fn visit_byte_buf<E: Error>(self, bytes: Vec<u8>) -> Result<Cow<'de, str>, E> {
                    match String::from_utf8(bytes) {
                        Ok(text) => Ok(Cow::Owned(text)),
                        Err(e) => Err(E::invalid_value(serde::de::Unexpected::Bytes(&e.into_bytes()), &self)),
                    }
                }
            }
            deserializer.deserialize_str(Text).map(Borrow)
        }
    }

    impl<'de: 'a, 'a> Deserialize<'de> for Borrow<Cow<'a, [u8]>> {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Bytes;
            impl<'de> Visitor<'de> for Bytes {
                type Value = Cow<'de, [u8]>;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("a byte array")
                }
                fn visit_borrowed_str<E: Error>(self, text: &'de str) -> Result<Cow<'de, [u8]>, E> {
                    Ok(Cow::Borrowed(text.as_bytes()))
                }
                fn visit_str<E: Error>(self, text: &str) -> Result<Cow<'de, [u8]>, E> {
                    Ok(Cow::Owned(text.as_bytes().to_vec()))
                }
                fn visit_string<E: Error>(self, text: String) -> Result<Cow<'de, [u8]>, E> {
                    Ok(Cow::Owned(text.into_bytes()))
                }
                fn visit_borrowed_bytes<E: Error>(self, bytes: &'de [u8]) -> Result<Cow<'de, [u8]>, E> {
                    Ok(Cow::Borrowed(bytes))
                }
                fn visit_bytes<E: Error>(self, bytes: &[u8]) -> Result<Cow<'de, [u8]>, E> {
                    Ok(Cow::Owned(bytes.to_vec()))
                }
                fn visit_byte_buf<E: Error>(self, bytes: Vec<u8>) -> Result<Cow<'de, [u8]>, E> {
                    Ok(Cow::Owned(bytes))
                }
            }
            deserializer.deserialize_bytes(Bytes).map(Borrow)
        }
    }

    pub const fn group(name: &'static str) -> Group {
        Group(name)
    }

    pub const fn row<'k>(rows: &'static str, key: &'k (dyn RowKey + Sync)) -> Row<'k> {
        Row { rows, key }
    }

    pub const fn row_group<'k>(row: Row<'k>, group: &'static str) -> RowGroup<'k> {
        RowGroup { row, group }
    }
}

/// A form field that is a map from a key to a group of fields, one per row (`#[fields(rows)]`
/// on `BTreeMap<K, V>`): a row's field is named by its key, `f.domains.at(&key).max_concurrent`,
/// so each row's values are read into its own entry and each row's field has its own error.
pub struct Rows<K, V> {
    name: &'static str,
    row: std::marker::PhantomData<fn() -> (K, V)>,
}

impl<K, V> Clone for Rows<K, V> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<K, V> Copy for Rows<K, V> {}

impl<K, V> fmt::Debug for Rows<K, V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Rows({})", self.name)
    }
}

impl<K, V: Fields> Rows<K, V> {
    /// Used by the code `#[derive(Fields)]` generates.
    #[doc(hidden)]
    pub const fn __new(name: &'static str) -> Self {
        Rows { name, row: std::marker::PhantomData }
    }

    /// The names of the row whose key is `key`: `f.domains.at(&Domain::SellerPortal).max_concurrent`
    /// is `domains[seller-portal].max_concurrent`. It takes a reference to the map's key type
    /// (`&row.domain`; for a `String` key, `&String`), so a key of another type does not compile.
    pub fn at<'k>(&self, key: &'k K) -> V::InRow<'k>
    where
        K: RowKey + Sync,
    {
        V::in_row(self.name, key)
    }
}

/// A form field that is a map from a key to one plain value (`#[fields(map)]` on
/// `BTreeMap<K, V>`): each key's value is a field of its own, `f.counts.at(&sku)`, posted as
/// `counts[sku]`, with its own error.
pub struct Keyed<K> {
    name: &'static str,
    key: std::marker::PhantomData<fn() -> K>,
}

impl<K> Clone for Keyed<K> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<K> Copy for Keyed<K> {}

impl<K> fmt::Debug for Keyed<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Keyed({})", self.name)
    }
}

impl<K> Keyed<K> {
    /// Used by the code `#[derive(Fields)]` generates.
    #[doc(hidden)]
    pub const fn __new(name: &'static str) -> Self {
        Keyed { name, key: std::marker::PhantomData }
    }

    /// The field of the key `key`: `f.counts.at(&sku)` is `counts[sku]`. It takes a reference to
    /// the map's key type, so a key of another type does not compile.
    pub fn at<'k>(&self, key: &'k K) -> FieldName<Untyped, Row<'k>>
    where
        K: RowKey + Sync,
    {
        FieldName { at: Row { rows: self.name, key }, name: "", value: std::marker::PhantomData }
    }
}

/// Field to message, in the order they were added, and a message about the whole form. A field
/// keeps its first message, and so does the form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Errors {
    fields: Vec<(Kept, String)>,
    form: Option<String>,
    /// Where each row's messages are in `fields`, by the rows' field and the row's key, so a form
    /// with many rows finds a row's message without reading every other row's.
    /// Made with the first row's message, so a form without rows builds and drops no map.
    rows: Option<Box<RowIndex>>,
    refusal: Refusal,
}

/// [`Errors`]' messages of rows: by the rows' field, then the row's key, where each is in the list.
type RowIndex = std::collections::HashMap<&'static str, std::collections::HashMap<Box<str>, Vec<u32>>>;

/// A [`FieldName`] an [`Errors`] keeps: where it is (its row's key copied) and its name.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Kept {
    at: At,
    name: &'static str,
}

impl Kept {
    fn new<P: Place>(field: FieldName<Untyped, P>) -> Self {
        Kept { at: field.at.kept(), name: field.name }
    }

    /// Whether this is `field`: for a form's own field, a comparison of two names.
    #[inline]
    fn is<P: Place>(&self, field: &FieldName<Untyped, P>) -> bool {
        self.name == field.name && field.at.is_kept(&self.at)
    }
}

/// A field's name as [`Errors::iter`] gives it: printed (`Display`) or compared with text.
#[derive(Clone, Copy, Debug)]
pub struct Named<'e>(&'e Kept);

impl fmt::Display for Named<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl PartialEq<str> for Named<'_> {
    fn eq(&self, text: &str) -> bool {
        let mut own = String::with_capacity(text.len());
        self.0.at.write(self.0.name, &mut own);
        own == text
    }
}

impl PartialEq<&str> for Named<'_> {
    fn eq(&self, text: &&str) -> bool {
        *self == **text
    }
}

impl<P: Place, T> PartialEq<FieldName<T, P>> for Named<'_> {
    fn eq(&self, field: &FieldName<T, P>) -> bool {
        self.0.is(&field.untyped())
    }
}

impl fmt::Display for Kept {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        self.at.write(self.name, &mut out);
        f.write_str(&out)
    }
}

/// Why a submit was refused, which [`Req::invalid`](crate::Req::invalid) answers with its status.
/// A closed set: a refusal is the client's to fix (a 4xx), or a failure of a service the handler
/// calls that the user can only retry (502); a 2xx, any other 5xx, or any `StatusCode`, does not
/// compile. A failure of the app itself (a database error) is no refusal: it is `?`'d, and the
/// error page answers it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Refusal {
    /// 422: the input breaks a rule ([`Errors::add`], [`Errors::add_form`]).
    #[default]
    Invalid,
    /// 409: the submit conflicts with the state of what it acts on. Either that state has moved
    /// on (a stale revision, a step already taken or out of order), and the same input would be
    /// refused again, so the user needs the current state first; or another request is acting
    /// on it now (work that must not run twice at once, under a lock), and the same input goes
    /// through once that one is done.
    Conflict,
    /// 410: what the submit acts on is gone (deleted meanwhile).
    Gone,
    /// 502: a service the handler calls for the submit (a payment provider, a carrier, another
    /// app) failed or did not answer. Nothing the user sent is at fault, and the same submit may
    /// succeed later. Whether the service applied it is not known, so a retry must be recognized
    /// as the same work: the runtime keeps the form's [`SubmitKey`](crate::SubmitKey), or the
    /// handler checks what is done already under a lock and sends the service a key made from
    /// what it acts on (the requests and forms guide, Work that must not run twice at once).
    Upstream,
}

impl Refusal {
    /// The status the refusal is answered with.
    pub fn status(self) -> http::StatusCode {
        use http::StatusCode;
        match self {
            Refusal::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
            Refusal::Conflict => StatusCode::CONFLICT,
            Refusal::Gone => StatusCode::GONE,
            Refusal::Upstream => StatusCode::BAD_GATEWAY,
        }
    }
}

impl Default for Errors {
    fn default() -> Self {
        Self::new()
    }
}

impl Errors {
    /// No messages. (A `const fn`, for the one [`Within::none`] reads; a form whose fields never
    /// have a message takes `Within::none`, not an `Errors` of its own.)
    pub const fn new() -> Self {
        Errors { fields: Vec::new(), form: None, rows: None, refusal: Refusal::Invalid }
    }

    /// Records `message` for `field`, unless the field already has one.
    pub fn add<P: Place, T>(&mut self, field: FieldName<T, P>, message: impl Into<String>) {
        // The type is for the caller: one copy of the work per place, not per field type.
        self.add_untyped(field.untyped(), message.into())
    }

    fn add_untyped<P: Place>(&mut self, field: FieldName<Untyped, P>, message: String) {
        if self.find(&field).is_some() {
            return;
        }
        if let Some((rows, key)) = field.at.row() {
            let at = u32::try_from(self.fields.len()).unwrap_or(u32::MAX);
            let mut buf = KeyBuf::new();
            let key = key.key_text(&mut buf);
            let row = self.rows.get_or_insert_with(Box::default).entry(rows).or_default();
            match row.get_mut(key) {
                Some(at_key) => at_key.push(at),
                None => {
                    row.insert(key.into(), vec![at]);
                }
            }
        }
        self.fields.push((Kept::new(field), message));
    }

    /// Where `field`'s message is: a row's by the index, any other by reading the list of messages
    /// (one per field given one, rows' included).
    fn find<P: Place>(&self, field: &FieldName<Untyped, P>) -> Option<usize> {
        match field.at.row() {
            None => self.fields.iter().position(|(f, _)| f.is(field)),
            Some((rows, key)) => {
                let at = self.rows.as_ref()?.get(rows)?.get(key.key_text(&mut KeyBuf::new()))?;
                at.iter().map(|&i| i as usize).find(|&i| self.fields[i].0.is(field))
            }
        }
    }

    /// Records a message about the whole form, unless it has one: a rule no single field breaks,
    /// or a refusal from the service the handler wrote to ("The policy was retired meanwhile.").
    /// Prefer [`Errors::add`] when a field is at fault, so the message sits next to it.
    pub fn add_form(&mut self, message: impl Into<String>) {
        self.form.get_or_insert_with(|| message.into());
    }

    /// Refuses the submit for something other than its input (the state it was made against, or a
    /// service the handler calls that failed): the form's message (in place of one
    /// [`Errors::add_form`] recorded, so the status and the message agree), answered with the
    /// refusal's status (409 for [`Refusal::Conflict`], 502 for [`Refusal::Upstream`]) by
    /// [`Req::invalid`](crate::Req::invalid) in every mode. The form
    /// is drawn again with what the user typed and the message at its top.
    ///
    /// ```
    /// use corten::{Errors, Refusal};
    ///
    /// let mut errors = Errors::new();
    /// errors.refuse(Refusal::Conflict, "Someone saved this sheet first. Reload to see their changes.");
    /// assert_eq!(errors.refusal().status().as_u16(), 409);
    /// assert_eq!(errors.form(), Some("Someone saved this sheet first. Reload to see their changes."));
    /// ```
    ///
    /// A status that is not a refusal does not compile:
    ///
    /// ```compile_fail,E0308
    /// let mut errors = corten::Errors::new();
    /// errors.refuse(200, "Saved.");
    /// ```
    pub fn refuse(&mut self, why: Refusal, message: impl Into<String>) {
        self.refusal = why;
        self.form = Some(message.into());
    }

    /// Why the submit was refused: [`Refusal::Invalid`] unless [`Errors::refuse`] said otherwise.
    pub fn refusal(&self) -> Refusal {
        self.refusal
    }

    pub fn get<P: Place, T>(&self, field: FieldName<T, P>) -> Option<&str> {
        self.find(&field.untyped()).map(|i| self.fields[i].1.as_str())
    }

    pub fn has<P: Place, T>(&self, field: FieldName<T, P>) -> bool {
        self.find(&field.untyped()).is_some()
    }

    /// The message about the whole form, from [`Errors::add_form`].
    pub fn form(&self) -> Option<&str> {
        self.form.as_deref()
    }

    /// True when no field and not the form has a message.
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.form.is_none()
    }

    /// How many messages there are, the form's included.
    pub fn len(&self) -> usize {
        self.fields.len() + usize::from(self.form.is_some())
    }

    /// The fields' messages, in the order they were added.
    pub fn iter(&self) -> impl Iterator<Item = (Named<'_>, &str)> {
        self.fields.iter().map(|(f, m)| (Named(f), m.as_str()))
    }

    /// `Ok(value)` when nothing was added, otherwise the errors.
    pub fn into_result<T>(self, value: T) -> Result<T, Errors> {
        if self.is_empty() {
            Ok(value)
        } else {
            Err(self)
        }
    }

    /// The fields' marks and messages in the form whose id is `form`: the `#[derive(Id)]` of the
    /// element a refused submit replaces (the form, or the block around it). Each message's id is
    /// `{form}-{field}-error`, so two forms on a page with a field of the same name (a price in
    /// every row) do not share one, and each field is described by its own message. A field
    /// several forms share is a helper that takes the form's errors, `e: &corten::Within<'_, I>`.
    #[doc(alias = "aria")]
    #[doc(alias = "message")]
    pub fn within<I: Id>(&self, form: I) -> Within<'_, I> {
        Within { errors: self, form }
    }

    /// `<p class="form-error" role="alert">message</p>` when the form has a message, else
    /// nothing. Put it at the top of the form; `role="alert"` announces it when a patch puts it in.
    /// It is a live region of its own, so it goes in no other (the UI kit's `Alert`): the kit's
    /// look for it is the kit's `FormAlert`, which draws [`Errors::form`] in one.
    pub fn form_message(&self) -> FormMessage<'_> {
        FormMessage { message: self.form() }
    }
}

/// [`Errors`] in one form, from [`Errors::within`], or [`Within::none`] for a form whose answer
/// never has a field's message.
pub struct Within<'a, I> {
    errors: &'a Errors,
    form: I,
}

/// The errors of every form that has none, which [`Within::none`] reads.
static NO_ERRORS: Errors = Errors::new();

impl<I: Id> Within<'static, I> {
    /// A form whose fields never have a message (the browser checks them with `required`, or a
    /// refusal answers for the whole page), named from its fields as one with [`Errors`] is:
    /// `e.id(f.grader)` and `{..e.control(f.grader)}`, while `e.message(..)` writes nothing. A form
    /// that later gains messages changes this one line to `errors.within(LookUpId)`.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[derive(Id)]
    /// struct LookUpId;
    ///
    /// #[derive(Fields)]
    /// struct LookUp { grader: String }
    ///
    /// let f = LookUp::FIELDS;
    /// let e = Within::none(LookUpId);
    /// let field = html! {
    ///     <label for={e.id(f.grader)}>"Grader"</label>
    ///     <input required {..e.control(f.grader)}>
    ///     {e.message(f.grader)}
    /// };
    /// assert_eq!(
    ///     field.to_html(),
    ///     r#"<label for="look-up-grader">Grader</label><input required id="look-up-grader" name="grader">"#
    /// );
    /// ```
    pub fn none(form: I) -> Self {
        Within { errors: &NO_ERRORS, form }
    }
}

impl<I: Id> Within<'_, I> {
    /// `aria-invalid="true" aria-describedby="{form}-{field}-error"` when `field` has an error,
    /// else nothing: `<input name={f.email} {..e.aria(f.email)}>`. A field with a hint of its own
    /// gives it here, `{..e.aria(f.email).hint(&EmailHintId)}`, and is described by the hint and
    /// then the error; a tag that writes `aria-describedby` itself as well does not compile.
    pub fn aria<P: Place, T>(&self, field: FieldName<T, P>) -> Aria<'_, I, P> {
        let field = field.untyped();
        Aria { form: &self.form, field, invalid: self.errors.has(field), hint: None }
    }

    /// `<p class="field-error" id="{form}-{field}-error">message</p>` when `field` has an error,
    /// else nothing: the element [`Within::aria`] points at.
    pub fn message<P: Place, T>(&self, field: FieldName<T, P>) -> FieldMessage<'_, I, P> {
        let field = field.untyped();
        FieldMessage { form: &self.form, field, message: self.errors.get(field) }
    }

    /// The id of `field`'s control in this form, `{form}-{field}`: what a label's `for` names
    /// (`<label for={e.id(f.email)}>`). It is the form's id and the field's name, so it needs no
    /// `#[derive(Id)]` of its own, and two forms with a field of one name (a price in every row)
    /// or two features' `search` fields never share one (a `#[derive(Id)]` that writes the same
    /// text, `SignUpEmailId`, is not compared with it). Its hint's id is `HintId(&e.id(f.email))`.
    ///
    /// ```
    /// use corten::{form::HintId, prelude::*};
    ///
    /// #[derive(Id)]
    /// struct SignUpId;
    ///
    /// #[derive(Fields)]
    /// struct SignUp { email: String }
    ///
    /// let (f, errors) = (SignUp::FIELDS, Errors::new());
    /// let e = errors.within(SignUpId);
    /// let field = html! {
    ///     <label for={e.id(f.email)}>"Email"</label>
    ///     <input type="email" {..e.control(f.email).hint()}>
    ///     <p id={HintId(&e.id(f.email))}>"Where we send the receipt."</p>
    /// };
    /// assert_eq!(
    ///     field.to_html(),
    ///     r#"<label for="sign-up-email">Email</label><input type="email" id="sign-up-email" name="email" aria-describedby="sign-up-email-hint"><p id="sign-up-email-hint">Where we send the receipt.</p>"#
    /// );
    /// ```
    pub fn id<P: Place, T>(&self, field: FieldName<T, P>) -> FieldId<'_, I, P> {
        FieldId { form: &self.form, field: field.untyped() }
    }

    /// The control's attributes, from its field: `id` (as [`Within::id`]), `name`, and
    /// `aria-invalid` and `aria-describedby` as [`Within::aria`] writes them:
    /// `<input type="email" {..e.control(f.email)}>`. `.hint()` adds the field's hint
    /// (`HintId(&e.id(f.email))`) to its description, ahead of the error. It is for a field's one
    /// control: radios or checkboxes that share a field would share its `id`. A tag that writes
    /// one of these itself as well does not compile, nor does one that spreads `e.aria(..)` too:
    ///
    /// ```compile_fail,E0080
    /// use corten::prelude::*;
    ///
    /// #[derive(Id)]
    /// struct SignUpId;
    ///
    /// #[derive(Fields)]
    /// struct SignUp { email: String }
    ///
    /// let (f, errors) = (SignUp::FIELDS, Errors::new());
    /// let e = errors.within(SignUpId);
    /// let view = html! { <input {..e.aria(f.email)} {..e.control(f.email)}> };
    /// # let _ = view.to_html();
    /// ```
    ///
    /// The first, a written attribute:
    ///
    /// ```compile_fail,E0080
    /// use corten::prelude::*;
    ///
    /// #[derive(Id)]
    /// struct SignUpId;
    ///
    /// #[derive(Fields)]
    /// struct SignUp { email: String }
    ///
    /// let (f, errors) = (SignUp::FIELDS, Errors::new());
    /// let e = errors.within(SignUpId);
    /// let view = html! { <input name={f.email} {..e.control(f.email)}> };
    /// # let _ = view.to_html();
    /// ```
    pub fn control<P: Place, T>(&self, field: FieldName<T, P>) -> Control<'_, I, P> {
        let field = field.untyped();
        Control { form: &self.form, field, invalid: self.errors.has(field), hint: false }
    }
}

/// The id of a form field's control, `{form}-{field}`, from [`Within::id`].
pub struct FieldId<'a, I, P = Root> {
    form: &'a I,
    field: FieldName<Untyped, P>,
}

impl<I, P: Copy> Clone for FieldId<'_, I, P> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<I, P: Copy> Copy for FieldId<'_, I, P> {}

impl<I: Id, P: Place> Id for FieldId<'_, I, P> {
    /// The form's: the field is part of the id's key.
    const NAME: &'static str = I::NAME;
    fn write_id(&self, out: &mut String) {
        Id::write_id(self.form, out);
        out.push('-');
        self.field.render(out);
    }
}

impl<I: Id, P: Place> Render for FieldId<'_, I, P> {
    fn render(&self, out: &mut String) {
        Id::write_id(self, out)
    }
}

impl<I: Id, P: Place> AttrValue for FieldId<'_, I, P> {
    fn write_attr(&self, name: &str, out: &mut String) {
        out.push_str(name);
        out.push_str("=\"");
        Id::write_id(self, out);
        out.push('"');
    }
}

/// The id of the hint that describes an element, `{id}-hint`: `HintId(&e.id(f.email))` is
/// `sign-up-email-hint`, which [`Control::hint`] names.
pub struct HintId<'a, I: ?Sized>(pub &'a I);

impl<I: Id + ?Sized> Id for HintId<'_, I> {
    /// The described element's: `-hint` is part of the id's key.
    const NAME: &'static str = I::NAME;
    fn write_id(&self, out: &mut String) {
        Id::write_id(self.0, out);
        out.push_str("-hint");
    }
}

impl<I: Id + ?Sized> Render for HintId<'_, I> {
    fn render(&self, out: &mut String) {
        Id::write_id(self, out)
    }
}

impl<I: Id + ?Sized> AttrValue for HintId<'_, I> {
    fn write_attr(&self, name: &str, out: &mut String) {
        out.push_str(name);
        out.push_str("=\"");
        #[cfg(debug_assertions)]
        let start = out.len();
        Id::write_id(self, out);
        #[cfg(debug_assertions)]
        if name.trim_start() == "id" {
            drew_hint(&out[start..]);
        }
        out.push('"');
    }
}

#[cfg(debug_assertions)]
thread_local! {
    /// The ids of the hints a page drew, as written, while a debug build renders it.
    static HINTS: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

/// Notes a hint element's id, when a page's render is collecting them.
#[cfg(debug_assertions)]
#[cold]
pub(crate) fn drew_hint(id: &str) {
    HINTS.with(|h| {
        if let Some(hints) = h.borrow_mut().as_mut() {
            hints.push(id.to_owned());
        }
    });
}

/// In a debug build: runs `render` and returns the ids of the hints it drew (`id={HintId(..)}`).
#[cfg(debug_assertions)]
pub(crate) fn collect_hints<T>(render: impl FnOnce() -> T) -> (T, Vec<String>) {
    let (value, hints) = crate::gather(&HINTS, Vec::new(), render);
    (value, hints.unwrap_or_default())
}

/// The first hint in `html` that has text and that the element it describes, also in `html`, does
/// not name in its `aria-describedby`: a screen reader never reads it. `HintId(&id)` is `{id}-hint`,
/// so the element it describes is the one whose id is `id`. A hint with no text (the kit's `Field`
/// with `hint=""`) describes nothing, so naming it or not is the same. In a page (`page`), a hint
/// whose element is not drawn describes nothing either (a radio group with no id), and is returned
/// too; a patch may redraw the hint alone, its control on the page already, so there it is not
/// checked. The markup is read tag by tag, so text inside another attribute's value (a handler
/// argument in `data-on`, whose JSON keeps its quotes) is not taken for an attribute.
#[cfg(debug_assertions)]
pub(crate) fn unnamed_hint<'a>(html: &str, hints: &'a [String], page: bool) -> Option<&'a str> {
    let tags: Vec<crate::html::Tag<'_>> = crate::html::start_tags(html).collect();
    let by_id = |id: &str| tags.iter().find(|tag| tag.attr("id") == Some(id));
    hints.iter().map(String::as_str).find(|hint| {
        let Some(shown) = by_id(hint) else { return false };
        if !has_text(html, shown) {
            return false;
        }
        let described = &hint[..hint.len() - "-hint".len()];
        let Some(tag) = by_id(described) else { return page };
        !tag.attr("aria-describedby").is_some_and(|names| names.split_ascii_whitespace().any(|id| id == *hint))
    })
}

/// The first submit key with no value ([`SubmitKey::template_field`]) in `html` that is not inside
/// a `<template>` a script copies, as written: a browser without JavaScript sends it empty, and the
/// post is refused. A declarative shadow root (`<template shadowrootmode="open">`) is drawn in the page,
/// so a field in one needs its own key. A page without one costs one search of its markup, and
/// only a debug build makes it (also for a field drawn ahead, `req.rendered`, which needs nothing
/// carried with it).
#[cfg(debug_assertions)]
pub(crate) fn keyless_submit_field(html: &str) -> Option<&str> {
    const EMPTY: &str = r#"" data-submit>"#;
    let mut templates = Templates::default();
    let mut from = 0;
    while let Some(found) = html[from..].find(EMPTY) {
        let end = from + found + EMPTY.len();
        if !templates.inert_at(html, end) {
            return Some(&html[html[..end].rfind("<input").unwrap_or(0)..end]);
        }
        from = end;
    }
    None
}

/// How deep a scan of markup is in `<template>`s, read on from where it last stopped, so the
/// markup is read once however many fields it holds. It reads the markup `html!` writes, where a
/// `<` in text or a value is `&lt;` and an attribute is `name="value"` with no space around the `=`
/// (hand-written `raw(..)` markup such as `shadowrootmode = "open"` can mislead it); it does not parse literal `<script>` or `<style>` text,
/// comments or `raw(..)`, so a `<template` in them can mislead this debug check.
#[cfg(debug_assertions)]
#[derive(Default)]
struct Templates {
    /// Where the scan stopped.
    at: usize,
    /// The `<template>`s open there.
    depth: usize,
    /// The depth of the outermost one open whose content the parser keeps out of the page. A
    /// declarative shadow root (`<template shadowrootmode="open">` or `"closed"`) is not one: its
    /// content is in the page.
    inert: Option<usize>,
}

#[cfg(debug_assertions)]
impl Templates {
    /// Reads `html` on to `end` and says whether `end` is inside an inert `<template>`. A start
    /// or end tag's name ends at `>`, `/` or whitespace, so a custom element such as
    /// `<template-picker>` is not one, and is matched ASCII case-insensitively, as the parser does.
    fn inert_at(&mut self, html: &str, end: usize) -> bool {
        const NAME: &[u8] = b"template";
        let bytes = html.as_bytes();
        while let Some(found) = html.get(self.at..end).and_then(|text| text.find('<')) {
            let closing = bytes.get(self.at + found + 1) == Some(&b'/');
            let name = self.at + found + 1 + usize::from(closing);
            self.at = name;
            if !bytes.get(name..name + NAME.len()).is_some_and(|text| text.eq_ignore_ascii_case(NAME)) {
                continue;
            }
            self.at = name + NAME.len();
            let rest = &html[self.at..];
            if !rest.starts_with(|c: char| c == '>' || c == '/' || c.is_ascii_whitespace()) {
                continue;
            }
            if closing {
                if self.inert == Some(self.depth) {
                    self.inert = None;
                }
                self.depth = self.depth.saturating_sub(1);
            } else {
                self.depth += 1;
                // A declarative shadow root takes `open` or `closed`, in any case; with no value or
                // another one, the template is inert (the HTML standard's `shadowrootmode`).
                let tag = crate::html::start_tag(html, name - 1);
                self.at = self.at.max(tag.end);
                let shadow_root = tag
                    .attr("shadowrootmode")
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("open") || mode.eq_ignore_ascii_case("closed"));
                if self.inert.is_none() && !shadow_root {
                    self.inert = Some(self.depth);
                }
            }
        }
        self.inert.is_some()
    }
}

/// Whether the element whose start tag is `tag` has text other than white space, in it or in an
/// element inside it.
#[cfg(debug_assertions)]
fn has_text(html: &str, tag: &crate::html::Tag<'_>) -> bool {
    let name = tag.name.as_str();
    let (mut rest, mut depth) = (&html[tag.end..], 1usize);
    while depth > 0 && !rest.is_empty() {
        match rest.find('<') {
            Some(lt) => {
                if !rest[..lt].trim().is_empty() {
                    return true;
                }
                let tag = &rest[lt..];
                let gt = tag.find('>').unwrap_or(tag.len() - 1);
                if let Some(closing) = tag.strip_prefix("</") {
                    depth -= usize::from(closing.starts_with(name));
                } else if tag[1..].starts_with(name) && !tag[..gt].ends_with('/') {
                    depth += 1;
                }
                rest = &tag[gt + 1..];
            }
            None => return !rest.trim().is_empty(),
        }
    }
    false
}

/// A form field's control's attributes, from [`Within::control`].
pub struct Control<'a, I, P = Root> {
    form: &'a I,
    field: FieldName<Untyped, P>,
    invalid: bool,
    hint: bool,
}

impl<I, P> Control<'_, I, P> {
    /// The field's hint describes the control, ahead of its error: `aria-describedby` names
    /// `HintId(&e.id(f.email))`. In the kit's `Field`, which always writes the hint's element (empty
    /// for `hint=""`), give it always: an empty hint describes nothing. A debug build's page is an
    /// error when a hint with text is named by no control.
    pub fn hint(self) -> Self {
        Control { hint: true, ..self }
    }
}

impl<I, P> crate::view::__private::Writes for Control<'_, I, P> {
    type Static = Control<'static, (), ()>;
    const WRITES: &'static [&'static str] = &["id", "name", "aria-invalid", "aria-describedby"];
}

impl<I: Id, P: Place> Attrs for Control<'_, I, P> {
    fn render_attrs(&self, out: &mut String) {
        let id = FieldId { form: self.form, field: self.field };
        out.push(' ');
        id.write_attr("id", out);
        out.push(' ');
        self.field.write_attr("name", out);
        if self.invalid {
            out.push_str(r#" aria-invalid="true""#);
        }
        if self.invalid || self.hint {
            out.push_str(r#" aria-describedby=""#);
            if self.hint {
                Id::write_id(&HintId(&id), out);
                if self.invalid {
                    out.push(' ');
                }
            }
            if self.invalid {
                message_id(self.form, self.field, out);
            }
            out.push('"');
        }
    }
}

/// `{form}-{field}-error`, escaped for an attribute.
fn message_id<P: Place>(form: &impl Id, field: FieldName<Untyped, P>, out: &mut String) {
    form.write_id(out);
    out.push('-');
    field.render(out);
    out.push_str("-error");
}

/// The ARIA attributes of a form field, from [`Within::aria`].
pub struct Aria<'a, I, P = Root> {
    form: &'a I,
    field: FieldName<Untyped, P>,
    invalid: bool,
    hint: Option<&'a dyn WriteId>,
}

impl<'a, I, P> Aria<'a, I, P> {
    /// The field's hint, the element with the id `hint` (a `#[derive(Id)]`), which describes it
    /// always, ahead of its error: `aria-describedby="{hint} {form}-{field}-error"`.
    pub fn hint<H: Id>(self, hint: &'a H) -> Self {
        Aria { hint: Some(hint), ..self }
    }
}

/// [`Id`] without its `NAME`, so a hint of any `Id` type is held behind one pointer.
trait WriteId {
    fn write_id(&self, out: &mut String);
}

impl<T: Id + ?Sized> WriteId for T {
    fn write_id(&self, out: &mut String) {
        Id::write_id(self, out)
    }
}

impl<I, P> crate::view::__private::Writes for Aria<'_, I, P> {
    type Static = Aria<'static, (), ()>;
    const WRITES: &'static [&'static str] = &["aria-invalid", "aria-describedby"];
}

impl<I: Id, P: Place> Attrs for Aria<'_, I, P> {
    fn render_attrs(&self, out: &mut String) {
        if self.invalid {
            out.push_str(r#" aria-invalid="true""#);
        }
        if self.invalid || self.hint.is_some() {
            out.push_str(r#" aria-describedby=""#);
            if let Some(hint) = self.hint {
                hint.write_id(out);
                if self.invalid {
                    out.push(' ');
                }
            }
            if self.invalid {
                message_id(self.form, self.field, out);
            }
            out.push('"');
        }
    }
}

/// A field's error message, from [`Within::message`].
pub struct FieldMessage<'a, I, P = Root> {
    form: &'a I,
    field: FieldName<Untyped, P>,
    message: Option<&'a str>,
}

impl<I: Id, P: Place> Render for FieldMessage<'_, I, P> {
    fn render(&self, out: &mut String) {
        if let Some(message) = self.message {
            out.push_str(r#"<p class="field-error" id=""#);
            message_id(self.form, self.field, out);
            out.push_str(r#"">"#);
            escape_into(message, out);
            out.push_str("</p>");
        }
    }
}

/// One submission of a form, so a write whose answer was lost and is sent again applies once.
///
/// Put a `SubmitKey` field in the form struct and draw it with [`SubmitKey::field`]: a hidden
/// input with a fresh random UUID v4 (122 random bits), named by the field's [`FieldName`]. A
/// UUID because that is what APIs take as an idempotency key, so the app sends it on unchanged
/// for a write that belongs to this submission.
///
/// A key makes one submission apply once; it does not keep two submissions apart (two tabs, two
/// people), whose keys differ. Work on something the app's data already names (postage for an
/// order, a charge for an invoice) that must not run twice takes a lock in the store every
/// instance of the app shares and, under it, leaves out what is done already, with no `SubmitKey`
/// (the requests and forms guide, Work that must not run twice at once): a lock in a static holds
/// within one process only. A write only the submission identifies (a new order) keeps its key.
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Alert {
///     email: String,
///     submit: SubmitKey,
/// }
///
/// let f = Alert::FIELDS;
/// let form = html! {
///     <form method="post" data-patch>
///         {SubmitKey::field(f.submit)}
///         <input name={f.email}>
///     </form>
/// };
/// let html = form.to_html();
/// assert!(html.contains(r#"<input type="hidden" name="submit" data-submit value=""#));
///
/// let key = &html[html.find("value=\"").unwrap() + 7..][..36];
/// assert!(key.as_bytes()[14] == b'4' && b"89ab".contains(&key.as_bytes()[19]), "a version 4 UUID: {key}");
///
/// let posted: Alert = corten::form::from_bytes(b"email=a%40b.c&submit=3F2504E0-4F89-41D3-9A0C-0305E82C3301").unwrap();
/// assert_eq!(posted.submit.as_str(), "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "read in either case, kept lowercase");
/// for bad in ["x", "3f2504e04f8941d39a0c0305e82c3301", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"] {
///     let body = format!("email=a%40b.c&submit={bad}");
///     assert!(corten::form::from_bytes::<Alert>(body.as_bytes()).is_err(), "{bad}: not a UUID v4, a 422 naming the field");
/// }
/// ```
///
/// The browser sends the same key for as long as the submission has no answer: a page reloaded
/// after a post sends it again, and so does the runtime when a `data-patch` form is sent again
/// after a network error, a 5xx or an abort (a navigation). Once an answer arrives (any status
/// below 500) the runtime gives the form a new key, so the next submit is a new one; a submit made
/// while a write is pending waits for it and goes out with the key the form has then. The app keeps the keys it
/// has applied (next to the write, in the same transaction) and answers a repeat with what it did
/// the first time; Corten keeps no store. [`corten_cluster`]'s `begin` takes one as its
/// idempotency key.
///
/// [`corten_cluster`]: https://docs.rs/corten-cluster
///
/// It takes the name of a `SubmitKey` field, so another field's does not compile:
///
/// ```compile_fail,E0308
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Alert { email: String, submit: SubmitKey }
///
/// let _ = SubmitKey::field(Alert::FIELDS.email);
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SubmitKey(Box<str>);

impl SubmitKey {
    /// The hidden input that carries a new key: `<input type="hidden" name=".." data-submit value="..">`.
    pub fn field(name: FieldName<SubmitKey>) -> SubmitField {
        SubmitField { name: name.untyped(), key: Some(uuid_v4(crate::security::random_hex())) }
    }

    /// The hidden input with no key yet, for a form inside a `<template>` that a script copies
    /// (`<input type="hidden" name=".." data-submit>`): the runtime gives an empty submit key a new
    /// one when its form is first sent, so each copy is a submission of its own. A form the server
    /// draws on the page takes [`SubmitKey::field`]: without JavaScript nothing fills the key, and
    /// a `SubmitKey` field posted empty is refused (a 422 naming it), as any key that is not a
    /// UUID v4 is. Nothing is drawn at random, so a page with only this one keeps its `ETag`.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[derive(Fields)]
    /// struct Count { qty: u32, submit: SubmitKey }
    ///
    /// let f = Count::FIELDS;
    /// let row = html! {
    ///     <template>
    ///         <form method="post" data-patch>{SubmitKey::template_field(f.submit)}<input name={f.qty}></form>
    ///     </template>
    /// };
    /// assert!(row.to_html().contains(r#"<input type="hidden" name="submit" data-submit>"#));
    /// assert!(corten::form::from_bytes::<Count>(b"qty=1&submit=").is_err(), "an empty key is refused");
    /// ```
    ///
    /// Like [`SubmitKey::field`], it takes only a `SubmitKey` field's name:
    ///
    /// ```compile_fail,E0308
    /// use corten::prelude::*;
    ///
    /// #[derive(Fields)]
    /// struct Count { qty: u32, submit: SubmitKey }
    ///
    /// let _ = SubmitKey::template_field(Count::FIELDS.qty);
    /// ```
    pub fn template_field(name: FieldName<SubmitKey>) -> SubmitField {
        SubmitField { name: name.untyped(), key: None }
    }

    /// The hidden input that carries this key again, for a form drawn again from the post that
    /// sent it (refused, or a service it calls failed): a browser without JavaScript sends what the
    /// page holds, so the redrawn form must hold the key it sent, or a retry after a 502 whose
    /// write did apply would be a new submission. The runtime keeps the form's key itself.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[derive(Fields)]
    /// struct Pay { amount: u32, submit: SubmitKey }
    ///
    /// let posted: Pay = corten::form::from_bytes(b"amount=5&submit=3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap();
    /// let html = posted.submit.again(Pay::FIELDS.submit).to_html();
    /// assert_eq!(html, r#"<input type="hidden" name="submit" data-submit value="3f2504e0-4f89-41d3-9a0c-0305e82c3301">"#);
    /// ```
    ///
    /// Like [`SubmitKey::field`], it takes only a `SubmitKey` field's name:
    ///
    /// ```compile_fail,E0308
    /// use corten::prelude::*;
    ///
    /// #[derive(Fields)]
    /// struct Pay { amount: u32, submit: SubmitKey }
    ///
    /// let posted: Pay = corten::form::from_bytes(b"amount=5&submit=3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap();
    /// let _ = posted.submit.again(Pay::FIELDS.amount);
    /// ```
    pub fn again(&self, name: FieldName<SubmitKey>) -> SubmitField {
        // Read only as a UUID (`Deserialize`), so it is 36 ASCII bytes.
        let mut key = [0u8; 36];
        key.copy_from_slice(self.0.as_bytes());
        SubmitField { name: name.untyped(), key: Some(key) }
    }

    /// A new key, as [`SubmitKey::field`] draws one: [`crate::testing::submit_key`].
    pub(crate) fn new() -> Self {
        let key = uuid_v4(crate::security::random_hex());
        SubmitKey(std::str::from_utf8(&key).expect("a UUID is ASCII").into())
    }

    /// The UUID, lowercase and hyphenated: `3f2504e0-4f89-41d3-9a0c-0305e82c3301`.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SubmitKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for SubmitKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = <std::borrow::Cow<'de, str>>::deserialize(deserializer)?;
        let bytes = text.as_bytes();
        let shaped = bytes.len() == 36
            && bytes
                .iter()
                .enumerate()
                .all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { *b == b'-' } else { b.is_ascii_hexdigit() });
        if shaped && bytes[14] == b'4' && b"89abAB".contains(&bytes[19]) {
            Ok(SubmitKey(text.to_ascii_lowercase().into()))
        } else {
            // The shape, never a key: an agent told "like <a key>" may send that key.
            Err(serde::de::Error::custom(
                "a submit key is a new random UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx, x a hex digit, y one of 8, 9, a, b",
            ))
        }
    }
}

/// The pattern of a [`SubmitKey`]'s schema, which [`crate::agent`] looks for in a tool's input.
#[cfg(feature = "types")]
pub(crate) const SUBMIT_KEY_PATTERN: &str =
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

/// A UUID v4 string, described for an agent: an MCP tool whose input has a `SubmitKey` shows it
/// in its `inputSchema`, and a call with a malformed key is refused before the tool runs, as a
/// form's is. A field's own doc comment replaces the description that tells the agent to send
/// the key again on a retry, so the key's field has none.
#[cfg(feature = "types")]
impl crate::json::schema::FromJsonSchema for SubmitKey {
    fn json_schema(_: &mut crate::json::schema::Generator) -> serde_json::Value {
        serde_json::json!({
            "description": "Idempotency key: a new random UUID v4 for each action. Send the same key again when retrying after a lost reply, so the action is not done twice.",
            "format": "uuid",
            "pattern": SUBMIT_KEY_PATTERN,
            "type": "string",
        })
    }
}

/// 32 random hex digits as a version 4 UUID: the version and variant digits set, hyphens added.
fn uuid_v4(hex: [u8; 32]) -> [u8; 36] {
    let mut out = [b'-'; 36];
    let mut digits = hex;
    digits[12] = b'4';
    digits[16] = b"89ab"[(digits[16] as usize) % 4];
    let mut at = 0;
    for (i, digit) in digits.iter().enumerate() {
        if matches!(i, 8 | 12 | 16 | 20) {
            at += 1;
        }
        out[at] = *digit;
        at += 1;
    }
    out
}

/// [`SubmitKey::field`]'s hidden input, or [`SubmitKey::template_field`]'s with no key.
pub struct SubmitField {
    name: FieldName,
    key: Option<[u8; 36]>,
}

thread_local! {
    /// Set when a [`SubmitField`] with a key is written: the page being rendered holds a key drawn
    /// for it.
    pub(crate) static DREW_KEY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl Render for SubmitField {
    fn render(&self, out: &mut String) {
        out.push_str(r#"<input type="hidden" name=""#);
        self.name.render(out);
        let Some(key) = &self.key else {
            out.push_str(r#"" data-submit>"#);
            return;
        };
        DREW_KEY.set(true);
        out.push_str(r#"" data-submit value=""#);
        out.push_str(std::str::from_utf8(key).expect("hex is ASCII"));
        out.push_str(r#"">"#);
    }
}

/// The form's message, from [`Errors::form_message`].
pub struct FormMessage<'a> {
    message: Option<&'a str>,
}

impl Render for FormMessage<'_> {
    fn render(&self, out: &mut String) {
        if let Some(message) = self.message {
            out.push_str(r#"<p class="form-error" role="alert">"#);
            escape_into(message, out);
            out.push_str("</p>");
        }
    }
}

/// `form message; field: message; field: message`, for logs and agent tool results.
impl fmt::Display for Errors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(form) = &self.form {
            f.write_str(form)?;
        }
        for (i, (field, message)) in self.fields.iter().enumerate() {
            if i > 0 || self.form.is_some() {
                f.write_str("; ")?;
            }
            write!(f, "{field}: {message}")?;
        }
        Ok(())
    }
}

/// A JSON object, field to message (the form's message is not a field; see [`Errors::form`]).
#[cfg(feature = "json")]
impl serde::Serialize for Errors {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.fields.len()))?;
        let mut name = String::new();
        for (field, message) in &self.fields {
            name.clear();
            field.at.write(field.name, &mut name);
            map.serialize_entry(&name, message)?;
        }
        map.end()
    }
}

/// 422 Unprocessable Content (or the status of [`Errors::refuse`]'s refusal, 409 for a stale
/// state) with the Problem Details document (RFC 9457) every JSON failure has, plus the fields
/// as an extension member:
/// `{"title":"Unprocessable Entity","status":422,"detail":"email: Enter an email address.","fields":{"email":"Enter an email address."}}`.
/// A message about the whole form comes first in `detail` and is `form` too:
/// `{"title":"Unprocessable Entity","status":422,"detail":"Sold out.","form":"Sold out.","fields":{}}`.
/// A JSON handler `?`s it (`check(&input)?` in a `JsonResult<T>` handler, whose error is a
/// [`crate::JsonError`]); pages use [`crate::Req::invalid`], which answers this way to data clients.
#[cfg(feature = "json")]
impl crate::response::IntoResponse for Errors {
    fn into_response(self) -> crate::response::Response {
        self.response()
    }
}

#[cfg(feature = "json")]
impl Errors {
    pub(crate) fn response(&self) -> crate::response::Response {
        use crate::response::IntoResponse;
        use http::header;
        use http::HeaderValue;
        let status = self.refusal.status();
        let mut members = String::new();
        if let Some(form) = &self.form {
            members.push_str(r#","form":"#);
            members.push_str(&serde_json::to_string(form).expect("strings serialize"));
        }
        members.push_str(r#","fields":"#);
        members.push_str(&serde_json::to_string(&self).expect("strings serialize"));
        let body = crate::api::problem(status, &self.to_string(), &members);
        let headers = [(header::CONTENT_TYPE, HeaderValue::from_static(crate::api::PROBLEM))];
        (status, headers, body).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hint is matched to its control by their tags' attributes. A handler argument in
    /// `data-on` keeps its JSON's quotes, so text in it can look like an `aria-describedby`; read
    /// as text, it would be taken for the control's own and the hint called unnamed.
    #[cfg(debug_assertions)]
    #[test]
    fn a_hint_is_matched_by_attributes_not_by_text_inside_another_value() {
        let hints = ["qty-hint".to_string()];
        let named = concat!(
            r#"<input id="qty" data-on='connect:m.f($t,["a aria-describedby=","b"])' aria-describedby="qty-hint">"#,
            r#"<p id="qty-hint">From 1 to 5.</p>"#,
        );
        assert_eq!(unnamed_hint(named, &hints, true), None);
        let unnamed = concat!(
            r#"<input id="qty" data-on='connect:m.f($t,[" aria-describedby=","qty-hint"])'>"#,
            r#"<p id="qty-hint"><em>From 1 to 5.</em></p>"#,
        );
        assert_eq!(unnamed_hint(unnamed, &hints, true), Some("qty-hint"));
        let empty = r#"<input id="qty"><p id="qty-hint"> <span></span></p>"#;
        assert_eq!(unnamed_hint(empty, &hints, true), None, "a hint with no text describes nothing");
        assert_eq!(unnamed_hint(r#"<p id="qty-hint">Pick one.</p>"#, &hints, true), Some("qty-hint"), "no control on a page");
        assert_eq!(unnamed_hint(r#"<p id="qty-hint">3 left.</p>"#, &hints, false), None, "a patch of the hint alone");
    }

    const EMAIL: FieldName = FieldName::__new("email");
    const PRICE: FieldName = FieldName::__new("price");
    const NAME: FieldName = FieldName::__new("name");

    #[derive(crate::view::Id)]
    struct RowId<'a>(&'a str);

    #[derive(crate::view::Id)]
    struct SignupId;

    #[test]
    fn a_refusal_replaces_the_form_message_so_status_and_message_agree() {
        let mut e = Errors::new();
        e.add_form("Pick a date after today.");
        e.refuse(Refusal::Conflict, "Someone saved first.");
        assert_eq!((e.refusal(), e.form()), (Refusal::Conflict, Some("Someone saved first.")));
        e.refuse(Refusal::Gone, "The sheet was deleted.");
        assert_eq!((e.refusal().status().as_u16(), e.form()), (410, Some("The sheet was deleted.")));
        e.add_form("later");
        assert_eq!(e.form(), Some("The sheet was deleted."), "add_form keeps the first, as before");
        e.refuse(Refusal::Upstream, "The carrier did not answer. Try again.");
        assert_eq!((e.refusal().status().as_u16(), e.form()), (502, Some("The carrier did not answer. Try again.")));
    }

    #[test]
    fn a_field_keeps_its_first_message_and_order_is_kept() {
        let mut e = Errors::new();
        e.add(EMAIL, "Enter an email address.");
        e.add(PRICE, "Enter a price.");
        e.add(EMAIL, "second");
        assert_eq!(e.get(EMAIL), Some("Enter an email address."));
        assert_eq!(e.len(), 2);
        assert_eq!(e.to_string(), "email: Enter an email address.; price: Enter a price.");
        let mut out = String::new();
        let row = e.within(RowId("s<1"));
        row.aria(PRICE).render_attrs(&mut out);
        row.aria(NAME).render_attrs(&mut out);
        assert_eq!(out, r#" aria-invalid="true" aria-describedby="row-s&lt;1-price-error""#);
        assert_eq!(row.message(PRICE).to_html(), r#"<p class="field-error" id="row-s&lt;1-price-error">Enter a price.</p>"#);
        assert_eq!(row.message(NAME).to_html(), "");
        // Two forms with a price field: each message has its own id.
        assert_eq!(
            e.within(RowId("s2")).message(PRICE).to_html(),
            r#"<p class="field-error" id="row-s2-price-error">Enter a price.</p>"#
        );
        assert_eq!(
            e.within(SignupId).message(EMAIL).to_html(),
            r#"<p class="field-error" id="signup-email-error">Enter an email address.</p>"#
        );
        assert!(e.clone().into_result(1).is_err());
        assert_eq!(Errors::new().into_result(1), Ok(1));
    }

    #[derive(crate::view::Id)]
    struct HintId<'a>(&'a str);

    #[test]
    fn a_hint_describes_its_field_ahead_of_the_error() {
        let mut e = Errors::new();
        e.add(PRICE, "Enter a price.");
        let row = e.within(RowId("s1"));
        let attrs = |aria: Aria<'_, RowId<'_>>| {
            let mut out = String::new();
            aria.render_attrs(&mut out);
            out
        };
        assert_eq!(
            attrs(row.aria(PRICE).hint(&HintId("a<b"))),
            r#" aria-invalid="true" aria-describedby="hint-a&lt;b row-s1-price-error""#
        );
        assert_eq!(attrs(row.aria(NAME).hint(&HintId("n"))), r#" aria-describedby="hint-n""#);
        assert_eq!(attrs(row.aria(NAME)), "");
    }

    #[test]
    fn a_control_is_named_and_described_from_its_field() {
        let mut e = Errors::new();
        e.add(PRICE, "Enter a price.");
        let row = e.within(RowId("s<1"));
        let attrs = |control: Control<'_, RowId<'_>>| {
            let mut out = String::new();
            control.render_attrs(&mut out);
            out
        };
        assert_eq!(row.id(PRICE).to_html(), "row-s&lt;1-price");
        assert_eq!(super::HintId(&row.id(PRICE)).to_html(), "row-s&lt;1-price-hint");
        assert_eq!(attrs(row.control(NAME)), r#" id="row-s&lt;1-name" name="name""#);
        assert_eq!(
            attrs(row.control(PRICE)),
            r#" id="row-s&lt;1-price" name="price" aria-invalid="true" aria-describedby="row-s&lt;1-price-error""#
        );
        assert_eq!(
            attrs(row.control(PRICE).hint()),
            r#" id="row-s&lt;1-price" name="price" aria-invalid="true" aria-describedby="row-s&lt;1-price-hint row-s&lt;1-price-error""#
        );
        assert_eq!(
            attrs(row.control(NAME).hint()),
            r#" id="row-s&lt;1-name" name="name" aria-describedby="row-s&lt;1-name-hint""#
        );
        // Another row's, or another form's, field of the same name has its own id.
        assert_eq!(e.within(RowId("s2")).id(PRICE).to_html(), "row-s2-price");
        // Two spreads that declare no attribute in common, or one whose attributes are only known
        // when it renders, share a tag.
        struct Lang;
        impl crate::view::Attrs for Lang {
            fn render_attrs(&self, out: &mut String) {
                out.push_str(r#" lang="fr""#);
            }
        }
        impl crate::view::__private::Writes for Lang {
            type Static = Self;
            const WRITES: &'static [&'static str] = &["lang"];
        }
        let extra = vec![("data-row", "s1")];
        assert_eq!(
            crate::html! { <input {..row.aria(PRICE)} {..Lang} {..extra}> }.to_html(),
            r#"<input aria-invalid="true" aria-describedby="row-s&lt;1-price-error" lang="fr" data-row="s1">"#
        );
        // A spread that moves a value, or borrows one mutably, beside another: each is evaluated
        // once, and the check holds none of its borrows.
        let owned = vec![("data-a".to_string(), "1".to_string())];
        let mut rows = vec![("data-b", "2"), ("data-c", "3")].into_iter();
        let mut next = || vec![rows.next().unwrap()];
        let mut refused = Errors::new();
        refused.add(PRICE, "Enter a price.");
        let other = refused.within(RowId("s<1"));
        assert_eq!(
            crate::html! { <input {..std::convert::identity(owned)} {..next()} {..next()} {..other.aria(PRICE)}> }.to_html(),
            r#"<input data-a="1" data-b="2" data-c="3" aria-invalid="true" aria-describedby="row-s&lt;1-price-error">"#
        );
        assert_eq!(e.within(SignupId).id(EMAIL).to_html(), "signup-email");
    }

    #[test]
    fn the_form_has_a_message_of_its_own() {
        let mut e = Errors::new();
        e.add_form("The policy was retired meanwhile.");
        e.add_form("second");
        assert_eq!(e.form(), Some("The policy was retired meanwhile."));
        assert!(!e.is_empty() && e.len() == 1 && e.iter().next().is_none(), "no field has a message");
        assert!(e.clone().into_result(1).is_err(), "a form message alone fails the check");
        assert_eq!(e.form_message().to_html(), r#"<p class="form-error" role="alert">The policy was retired meanwhile.</p>"#);
        assert_eq!(Errors::new().form_message().to_html(), "");
        e.add(EMAIL, "Enter an email address.");
        assert_eq!(e.to_string(), "The policy was retired meanwhile.; email: Enter an email address.");
    }

    #[cfg(feature = "json")]
    #[tokio::test]
    async fn json_clients_get_the_form_message() {
        use http_body_util::BodyExt;
        let mut e = Errors::new();
        e.add_form("Sold out.");
        let res = e.response();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(res.headers()["content-type"], "application/problem+json", "RFC 9457's media type");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            &body[..],
            br#"{"title":"Unprocessable Entity","status":422,"detail":"Sold out.","form":"Sold out.","fields":{}}"#
        );
        e.add(EMAIL, "Enter an email address.");
        let body = e.response().into_body().collect().await.unwrap().to_bytes();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["fields"]["email"], "Enter an email address.");
        assert_eq!(value["form"], "Sold out.");
    }

    #[derive(Debug, serde::Deserialize)]
    struct Picks {
        #[serde(default)]
        ids: Vec<String>,
        page: Option<u32>,
    }

    fn request(method: &str, uri: &str, content_type: Option<&str>, body: &'static str) -> Request {
        let mut req = http::Request::builder().method(method).uri(uri);
        if let Some(content_type) = content_type {
            req = req.header(header::CONTENT_TYPE, content_type);
        }
        req.body(crate::body::Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn form_reads_a_body_or_a_get_query_with_repeated_keys() {
        const URLENCODED: Option<&str> = Some("application/x-www-form-urlencoded");
        let Form(picks): Form<Picks> =
            Form::from_request(request("POST", "/", URLENCODED, "ids=a&ids=b&page="), &()).await.unwrap();
        assert_eq!((picks.ids, picks.page), (vec!["a".to_string(), "b".to_string()], None));
        let Form(picks): Form<Picks> = Form::from_request(request("GET", "/?ids=c&page=2", None, ""), &()).await.unwrap();
        assert_eq!((picks.ids, picks.page), (vec!["c".to_string()], Some(2)));

        let wrong_type = Form::<Picks>::from_request(request("POST", "/", Some("text/plain"), "ids=a"), &()).await.unwrap_err();
        assert_eq!(wrong_type.into_response().status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let bad = Form::<Picks>::from_request(request("POST", "/", URLENCODED, "page=x"), &()).await.unwrap_err();
        assert!(bad.to_string().starts_with("Failed to deserialize form body: page: invalid value"), "{bad}");
        let res = bad.into_response();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(crate::api::is_plain_text(res.headers()));
        let bad_get = Form::<Picks>::from_request(request("GET", "/?page=x", None, ""), &()).await.unwrap_err();
        assert_eq!(bad_get.into_response().status(), StatusCode::BAD_REQUEST);

        // A `HEAD` reads the query as the `GET` it asks about does.
        let Form(picks): Form<Picks> = Form::from_request(request("HEAD", "/?page=3", None, ""), &()).await.unwrap();
        assert_eq!(picks.page, Some(3));
        // The content type is matched in any case, its parameters after it.
        let upper = Some("Application/X-WWW-Form-URLEncoded; charset=UTF-8");
        let Form(picks): Form<Picks> = Form::from_request(request("POST", "/", upper, "page=4"), &()).await.unwrap();
        assert_eq!(picks.page, Some(4));
    }

    #[cfg(feature = "json")]
    #[test]
    fn serializes_as_an_object() {
        let mut e = Errors::new();
        e.add(FieldName::<Untyped>::__new("b"), "2");
        e.add(FieldName::<Untyped>::__new("a"), "1");
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"b":"2","a":"1"}"#);
    }

    #[derive(Debug, serde::Deserialize)]
    struct Keyed {
        submit: SubmitKey,
    }

    #[derive(Debug, serde::Deserialize)]
    struct MaybeKeyed {
        submit: Option<SubmitKey>,
    }

    /// A template's key field holds no key and marks nothing drawn for the request; the runtime
    /// fills it when a copy is sent. Posted empty (without JavaScript, or by a client that did not
    /// fill it), a required key is refused like a malformed one, and an optional one reads as none.
    #[test]
    fn a_template_s_submit_key_field_is_empty_and_an_empty_key_is_refused() {
        const SUBMIT: FieldName<SubmitKey> = FieldName::__new("submit");
        DREW_KEY.set(false);
        assert_eq!(SubmitKey::template_field(SUBMIT).to_html(), r#"<input type="hidden" name="submit" data-submit>"#);
        assert!(!DREW_KEY.get(), "nothing drawn for this request");
        let drawn = SubmitKey::field(SUBMIT).to_html();
        let start = r#"<input type="hidden" name="submit" data-submit value=""#;
        assert!(drawn.starts_with(start) && drawn.len() == start.len() + 36 + 2, "{drawn}");
        assert!(DREW_KEY.take(), "a drawn key is marked");

        let read = from_bytes::<Keyed>(b"submit=3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap().submit;
        assert_eq!(read.as_str(), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
        let empty = from_bytes::<Keyed>(b"submit=").unwrap_err().to_string();
        let forged = from_bytes::<Keyed>(b"submit=3f2504e0").unwrap_err().to_string();
        assert!(empty.starts_with("submit: ") && empty == forged, "refused as a malformed key is: {empty}");
        assert!(from_bytes::<Keyed>(b"").is_err(), "a missing key is refused too");
        assert!(from_bytes::<MaybeKeyed>(b"submit=").unwrap().submit.is_none());
        let kept = from_bytes::<MaybeKeyed>(b"submit=3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap().submit;
        assert_eq!(kept.as_ref().map(SubmitKey::as_str), Some("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
    }

    /// A debug build's check for a submit key with no value outside a `<template>` a script copies
    /// counts `<template>` tags in any case, not a custom element such as `<template-picker>`, and
    /// not a declarative shadow root (`shadowrootmode` `open` or `closed`, in any case), whose
    /// content is in the page.
    #[cfg(debug_assertions)]
    #[test]
    fn only_an_inert_template_holds_a_submit_key_with_no_value() {
        const F: &str = r#"<input type="hidden" name="submit" data-submit>"#;
        let found = |html: &str| keyless_submit_field(html).map(str::to_owned);
        for html in [
            format!("<template>{F}</template>"),
            format!(r#"<template class="row">{F}</template>"#),
            format!("<template\n  id=\"t\">{F}</template>"),
            format!(r#"<template title="shadowrootmode">{F}</template>"#),
            format!(r#"<template data-shadowrootmode="open">{F}</template>"#),
            format!("<template><div><template>{F}</template>{F}</div></template>"),
            format!(r#"<template shadowrootmode="open"><template>{F}</template></template>"#),
            format!(r#"<template><template shadowrootmode="open">{F}</template>{F}</template>"#),
            format!("<template>{F}</template><template>{F}</template>"),
            format!("<TEMPLATE>{F}</TEMPLATE>"),
            format!("<Template class=\"row\">{F}</template>"),
            format!("<template/>{F}</template>"),
            format!("<template shadowrootmode>{F}</template>"),
            format!(r#"<template shadowrootmode="">{F}</template>"#),
            format!(r#"<template shadowrootmode="nope">{F}</template>"#),
            format!(r#"<template shadowrootmode="open " >{F}</template>"#),
            format!(r#"<template title="a > b" shadowrootmode="nope">{F}</template>"#),
            format!(r#"<template shadowrootmode="nope" shadowrootmode="open">{F}</template>"#),
        ] {
            assert_eq!(found(&html), None, "{html}");
        }
        for html in [
            F.to_owned(),
            format!("<template-picker>{F}</template-picker>"),
            format!("<template-picker><template></template>{F}</template-picker>"),
            format!(r#"<template shadowrootmode="open">{F}</template>"#),
            format!("<template shadowrootmode=open>{F}</template>"),
            format!(r#"<div><template shadowrootmode="closed" shadowrootdelegatesfocus>{F}</template></div>"#),
            format!(r#"<template shadowrootmode="open"><template></template>{F}</template>"#),
            format!("<template>{F}</template>{F}"),
            format!("<template><template></template>{F}</template>{F}"),
            format!(r#"<template shadowRootMode="open">{F}</template>"#),
            format!(r#"<template shadowrootmode="CLOSED">{F}</template>"#),
            format!("<template SHADOWROOTMODE='Open'>{F}</template>"),
            format!(r#"<template title="x>y" shadowrootmode="open">{F}</template>"#),
            format!(r#"<template data-on='connect:m.f($t,["<template>"])' shadowrootmode='open'>{F}</template>"#),
            format!("<TEMPLATE>{F}</TEMPLATE>{F}"),
            format!("<template>{F}</template >{F}"),
        ] {
            assert_eq!(found(&html).as_deref(), Some(F), "{html}");
        }
        let html = r#"<template><input type="hidden" name="a" data-submit></template><input type="hidden" name="b" data-submit>"#;
        assert_eq!(found(html).as_deref(), Some(r#"<input type="hidden" name="b" data-submit>"#), "the field outside");
    }
}
