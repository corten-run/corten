# Forms

## A form that patches part of the page

```rust
#[derive(serde::Deserialize, Fields)]
struct GreetForm { name: String }

fn home_page(req: &Req, name: &str) -> impl Document {
    let f = GreetForm::FIELDS;
    html! {
        <Layout req={req} title="Home">
            <form method="post" action={url::Greet} data-patch>
                <input name={f.name} required>
                <button>"Greet me"</button>
            </form>
            <Greeting name={name} />
        </Layout>
    }
}

#[derive(Id)]
struct GreetingId;

#[component]
fn Greeting(name: &str) -> impl Patch {
    html! { <p id={GreetingId} aria-live="polite">if !name.is_empty() { "Hello, "{name}"!" }</p> }
}

async fn greet(req: Req, Form(form): Form<GreetForm>) -> HtmlResult {
    // With JavaScript the runtime swaps #greeting; without, the whole page. The page closure
    // runs only then, so a patch never loads the page's data.
    req.patch_or(Greeting { name: &form.name }, || async { req.page(home_page(&req, &form.name)) }).await
}
```

A patch may hold several top-level elements; each replaces the element with the same `id`, so
each needs one, a `#[derive(Id)]` type: `req.patch` and `req.invalid` take a `Patch`, and a view
whose top level has text, an element without an id or an id written as text does not compile. A
component a patch sends is rooted at the element with the id and declared `-> impl Patch`. Fields
the user edited (after the form was sent), the files chosen in a file input (until a successful
answer to the form that sent them) and the focus carry over to the new markup, so a patch can
include the form the user is typing in, and a refusal can mark a file input invalid.
After a write that should change the URL, use `req.redirect(&Route)` instead. To come back to
the element the user acted on, redirect to `route.at(RowId(&id))` (the route with `#row-7`,
from the element's `#[derive(Id)]`); a link within the page, such as an error summary's link to
its field, is `href={FieldId.fragment()}`. Never format a `#fragment` by hand.
To send the same form to another handler (a first write that sets a guest's cookie, then writes
as the guest), `req.resend_to(&to)`: a 307 the browser and a `data-patch` form's fetch follow
with the same body. Never rewrite `req.redirect`'s 303 into a 307 by hand. Writes only, `to`
`OnSite`; the handler at `to` cannot assume the cookie arrived.
To say what the write did on the page it lands on, `req.redirect_with_notice(&to, "Batch 3517
deleted.")`, read once there by `req.notice()` (the layout's `Toaster { toast: Toast { message:
req.notice(), failed: false }, failed, .. }`; after a navigation the runtime dispatches `corten:notice` and the
toaster takes it). Render it
once, in the layout: a full load shows it only where the page renders it. Its `failed` text is
what it says when a `data-patch` submit gets no answer (`corten:error`); a screen that says that
itself calls `preventDefault()` on the event. An action with no form to draw again (a button)
that did not do what was asked answers its refusal (below: `Conflict`, `Gone`, `Upstream`, by why)
with `req.invalid(&errors, Toast { message: errors.form(), failed: true }, page)`, a layout that
takes the answer's `Toast` drawing it in the page: marked and kept like the failed text. `to` is a
page of the app (`OnSite`: a route, `route.at(id)`, `Local`, a `#[derive(Href)]` enum of those).
Never add a route field (`?deleted=3517`, `?done=saved`) only to carry a message. It works over a
plain `http://` LAN origin too (Corten sees the write's `Origin` and drops `Secure`); do not keep
query fields for that.

## Files

A form with `<input type="file">` posts `multipart/form-data` (`enctype="multipart/form-data"`).
Name the input with a `Files` field of the form struct and take `Upload<T>`, never `Form` (it
answers 415) or a raw body with a parser of your own:

```rust
#[derive(serde::Deserialize, Fields)]
struct NewListing { title: String, photos: Files }   // <input type="file" name={f.photos} multiple>

async fn create(req: Req, mut upload: Upload<NewListing>) -> HtmlResult {
    let f = NewListing::FIELDS;
    upload.limit(60 << 20);                     // the whole body (2 MiB unless set), before reading
    let mut errors = Errors::new();
    while let Some(mut file) = upload.next_file().await? {
        if !file.is(f.photos) { continue }      // skipped, not stored
        match file.bytes_up_to(10 << 20).await? {   // or file.chunk() to stream it on
            Some(bytes) => { /* keep it */ }
            None => errors.add(f.photos, "Each photo can be up to 10 MB."),
        }
    }
    let input = upload.fields().await?;         // the text fields, by Form's rules
    ..
}
```

A body over `upload.limit` makes every read return `UploadError::TooLarge` (`?`: a 413 and the
error page). To answer it in the form, put the reads in one `async` block returning
`Result<_, UploadError>` and match `Err(UploadError::TooLarge { .. })` once; never compare
statuses or check `Content-Length` by hand.

Types, counts and per-file sizes are the handler's checks, reported with `errors.add(f.photos, ..)`
so the form is drawn again with the message beside the input.

To serve an upload back, read its type from its first bytes (never `file.content_type()`, which is
the client's word) and return `corten::Media::new("image/png", bytes)`. At a URL that names the
bytes (a hash), return `Public::immutable(answer)` so every cache keeps it for a year; its handler
cannot read who is asking. A download names its file with `.attachment("cards.csv")` (or
`.inline(..)` to show it), which escapes the name; never set `Content-Disposition` yourself.
Link to it with `download` (`data-reload` for an `inline` file), so the runtime does not fetch
it on hover and again on click. Never build the response by hand. An export too large to hold
is `Media::stream(type, chunks)` (a stream of `Result<Bytes, E>`, chunks of some kilobytes;
`Media::stream_sized` with an exact length for a progress bar): read what can fail first (the
first page of rows), since a failure after it starts ends the download, not with an error page.
Never use `Relay` for the app's own file. A download that may be
refused returns `corten::Result<PageOr<Media>>` (`PageOr<Relay>` for a relayed file) and
answers the page with why, or a redirect, with `.into()`; never relay a redirect of the app's own.
Its form is a plain `method="post"` form: a file answered to a `data-patch` submit is not saved.

## Checkboxes and lists

`Form` and a route's `Params` read a key sent several times into a `Vec`. A `bool` or `Vec` field needs
`#[serde(default)]` (`#[derive(Fields)]` does not compile without it), because the browser sends
nothing for an unchecked box:

```rust
#[derive(serde::Deserialize, Fields)]
struct ArchiveInput {
    #[serde(default)]
    ids: Vec<String>,   // one <input type="checkbox" name={f.ids} value={id}> per row
    #[serde(default)]
    notify: bool,       // a checkbox: "on" when checked
}
```

Never join values into one field with commas in a script; give each box the name. A box outside
the form joins it with `form={ArchiveFormId}` (a `#[derive(Id)]` type). A required list is a
validation message (`errors.add(f.ids, ..)` when empty), not a missing field; wrap the boxes in
`corten_ui::CheckboxGroup` (`missing=".."`) so the browser says so before sending. A blank field is
`None` for an `Option`. A typed route's list field writes `?condition=nm&condition=lp`, which
its `Params` reads back.

## Groups and rows

A group several forms share (an address) is its own `Fields` struct, put in a form with
`#[fields(group)] ship_to: Address` (posted `ship_to.street`, named `f.ship_to.street`); never
`#[serde(flatten)]`, which does not compile. Rows of the same fields (an editable table, line
items) are `#[fields(rows)] #[serde(default)] lines: BTreeMap<Key, Line>`, and a row's field is
`f.lines.at(&key).qty` (posted `lines[key].qty`), in markup and in `errors.add`. Never post
rows as parallel `Vec` columns: the key joins a row's values and gives each row's field its own
error. A key type is a `RowKey`: text, an integer, or a `#[derive(UrlValue)]` enum without
`alias` or `other`. A group is never an `Option`; one a form may leave out is `Option` fields
and `#[serde(default)]`. One plain
value per key (a count per SKU) is `#[fields(map)] #[serde(default)] counts: BTreeMap<Sku, u32>`,
a field per key: `f.counts.at(&sku)`, posted `counts[sku]`.

## Validation

Validate on the server into `Errors`, keyed by `FieldName`, never by string. A `FieldName` carries
its field's type (`FieldName<Condition>`), so pass a typed control (`Picker::new`, `Number::new`,
`RequiredWhen`, `SubmitKey::field`) the field it is for, and a widget its id as an `Id`
(`Number::new(e.id(f.qty), f.qty, ..)`), never text. A number the user types is
`qty: Entry<u32>`, read with its `Bounds` (`QTY.read(&input.qty)`, `None` for the field's
message) and drawn again with `value={&input.qty}`; a typed `qty: u32` is only for a number a
page writes itself, since one that does not read is the error page. A value the app stores and
draws back into a number field must be one its `Bounds` hold (a ported screen's `min`/`step`
never ran under `fetcher.submit`), or the browser will not send the form; `corten dev` names
such a control in the console. A helper that takes a name of any field is generic over it
(`fn hint<T>(f: FieldName<T>)`), and a list of several fields' names takes `.untyped()`:

```rust
pub fn check(t: Msg, input: &AlertInput) -> Result<f64, Errors> {
    let mut errors = Errors::new();
    if !input.email.contains('@') {
        errors.add(AlertInput::FIELDS.email, t.alert_invalid_email());
    }
    let price: f64 = input.target_price.trim().parse().unwrap_or(f64::NAN);
    if !price.is_finite() || price <= 0.0 {
        errors.add(AlertInput::FIELDS.target_price, t.alert_invalid_price());
    }
    errors.into_result(price)
}
```

The form component shows them next to each field, read within the id of the element a refusal
replaces (so two forms with a field of the same name have different message ids):

```rust
let e = form.errors.within(AlertFormId);
// in html!:
<input type="email" name={f.email} value={form.email} required {..e.aria(f.email)}>
{e.message(f.email)}
```

A field with a hint of its own gives the hint's id to the spread,
`{..e.aria(f.email).hint(&EmailHintId)}`, never a second `aria-describedby` on the tag (the
browser keeps only the first, and `html!` refuses it).

A labelled control takes its id from the field, not a `#[derive(Id)]` of its own:
`<label for={e.id(f.email)}>` and `<input {..e.control(f.email)}>` (its `id`, `name` and ARIA;
`.hint()` adds the hint, whose id is `corten::form::HintId(&e.id(f.email))`). With the kit's
`Field`, `id={e.id(f.email)}`, and the control takes `.hint()` always: the field writes its hint's
element even when `hint=""`, an empty hint describes nothing, and a hint with text that its
control does not name in `aria-describedby` is an error in a debug build (a corten-ui widget
names it in its `attrs`). A form with no `Errors` (its fields never get a message) takes
`let e = Within::none(FormId);`, never an empty `Errors` made for it. Use it in place of
`e.aria(..)`, never beside it (that does not compile), and only for a field's one control: radios
or checkboxes sharing a field keep
`name={f.size}` and their own ids; each checkbox takes `{..e.aria(f.size)}`, and radios put it
on a `role="radiogroup"` element around them, never on each radio (ARIA does not allow
`aria-invalid` on a radio). `e.aria(..).hint(&EmailHintId)` stays for a control whose id
is a `#[derive(Id)]` of its own.

A refusal that belongs to no field (a cross-field rule, or the backend saying no) is
`errors.add_form(text)`, shown once at the top of the form with `{form.errors.form_message()}`,
or, in the UI kit's look, `<FormAlert errors={&form.errors} emphasis={..} />`: never
`form_message()` inside an `Alert`, since each is an alert and a screen reader may read both.
Never attach it to an arbitrary field, and never pass it beside `Errors` in a separate prop: data
clients and agents only see what is in `Errors`. A refusal for a stale state (another save came
first, a step out of order, or another request acting on it now) is
`errors.refuse(Refusal::Conflict, text)`, a 409 from `req.invalid`; a service the handler calls that
failed (a carrier, a payment provider) is `Refusal::Upstream`, a 502 with the form drawn again;
never set a status on the response by hand. An action with no form to draw again answers the
refusal with a failed `Toast` instead (the toaster paragraph above). Make such a form `data-patch` (a download is the
exception: a plain post whose refusal redirects to the page with the reason). A field helper several
forms share takes `e: &corten::Within<'_, I>`.

A write only the submission identifies (placing an order, sending a message) takes a
`submit: SubmitKey` field, drawn with `{SubmitKey::field(f.submit)}`; the app stores the key with
the write and answers a repeat with the first outcome. The runtime keeps the key until the submit
has an answer below 500, then renews it. An MCP write tool of that kind takes the same field in
its input struct (`submit: SubmitKey`, required, no doc comment), stored per caller and tool
since the agent makes it, a repeat with other arguments refused (`ToolError::Refused`); a write
idempotent without one is `Tools::idempotent_tool`. A key does not keep two submissions apart: work on
something the app's data already names that must not run twice (postage for an order) takes, for
each item inside `signal.finish(..)`, a lock in the shared store, a check under it of what is done
already, and commits the item's record with it; it refuses with `Refusal::Conflict` (the form
showing the current state) while another request holds the lock; a provider that fails or times
out ends the batch, whose bought items are committed, and answers `Refusal::Upstream`, and a batch
that stops for time redirects back with a notice. A
provider call whose record is lost is covered by the provider's idempotency key, made from what is
bought rather than the submission. A lock in a static holds in one process only. A lock that
must come before a `REPEATABLE READ` snapshot is a session lock, taken on a connection set to
`close_on_drop()` first: a dropped handler would otherwise return the connection, lock and all, to
the pool.

A press while the form's write is pending waits for its answer, then goes out from the form as
the answer left it (found by its `id`: give a form a patch redraws one), after a 2xx or a 422.
A refusal (409, 410), a 5xx, an answer the runtime does not draw, a redirect or no answer drops
it, and the user sends it again. Steps that
each count (a count's + and -) keep their own ordered queue in the component's script.

The handler answers a failed check with `req.invalid`. It replies 422 with the form as a patch for
the runtime, a Problem Details document (`application/problem+json`, `{"title","status","detail","fields","form"}`) for JSON clients, or the whole page for a browser without
JavaScript. The page closure runs only in that last case, so put the expensive loads inside it:

```rust
let price = match check(t, &form) {
    Ok(price) => price,
    Err(errors) => {
        let view = AlertFormView { errors, ..AlertFormView::from(&form) };
        let page = || async { req.page(item_page(&req, &load(&id).await?, view.clone())) };
        return req.invalid(&view.errors, AlertForm { t, form: view.clone() }, page).await;
    }
};
```

When the form itself needs a read (the record as it is now), use
`req.invalid_with(&errors, |form| async { let r = read().await?; form.draw(View { r: &r }) }, page)`,
never a branch on `req.mode`: each side runs only for its mode, and JSON clients (feature `json`)
still get Problem Details.

Keep the HTML attributes (`required`, `type="email"`, `inputmode`) too: the browser checks them
first, and the server check is the one that counts. A field required only for some values of
another goes in `corten_ui::RequiredWhen` (`control={f.kind} values={&[Kind::Partial]}`), never a
script of the app's, and the handler checks the same rule. A field with a fixed set of values
(a select, radios, a `corten_ui::ComboBox`) is a `#[derive(UrlValue, Deserialize)]` enum in the form
struct, and the markup writes its variants (`value={Kind::Partial}`, `Choice { value: Kind::Partial, .. }`),
not their words as strings.
