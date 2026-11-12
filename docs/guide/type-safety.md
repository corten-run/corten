# Type safety

[Back to the guides](../../README.md#documentation)

Every value that crosses from Rust to the browser or to an agent is defined once, in Rust, and
checked on the other side.

| Seam | How it is checked |
|---|---|
| Handler to markup | `html!` is Rust: a missing field or prop is a compile error |
| Page to document | `req.page` takes a `Document`: markup that starts with `<html>`, with one `<title>`, one `<Corten />` and one `<main>` outside any `for`, `if` or `match`, or a layout component; a page that is only a fragment does not compile |
| Links to routes | `#[derive(Route)]`: the router, every link, `req.redirect` and a nav link (`req.nav`) use the same struct, and in a `#[corten::routes]` module a route without a handler, or a handler a request cannot call, does not compile (the error is at the handler's name in `#[route(..)]`, and a second one names the argument no request can fill); a path as text does not compile where it is given to `req.redirect` or a current-page check (a URL outside the app is an explicit `Uri`), to a `&dyn Href` prop, or to the test client, nor in `html!` as an element's URL attribute written as text or as one string literal in braces (`href="/items"`, `href={"/items"}`, `action="/watch"`, `src="/logo.svg"`, `https:/items`; a fragment, a full URL, `mailto:` and `//host` compile, and a path on this origin the app does not route is a `Uri`). Any other expression in braces is not checked (`href={format!(..)}`, a tuple), nor is a spread, a component's prop, a relative path (`items/7`) or a URL inside another attribute's text (a meta refresh's `content`). A place on a page is `route.at(Id)` (on the same page, `Id.fragment()`), made from the element's id type, so the link and the element cannot differ |
| Markup to handlers | `#[component(js)]` reads the script's JSDoc when the crate compiles: `js::name` exists only for an export, and each argument (a ref, typed by the tag it is on; `event`, `target`, `signal`, `scope`; a value) must match its `@param` type; a call to a handler whose parameter has a type no argument is checked against (a JSON shape other than a generated declaration, or an element or event in a shape such as `HTMLElement \| null` or `MouseEvent \| KeyboardEvent`) does not compile, and only `unknown` takes any argument |
| Typed events | `#[event]` structs: `on:Name` must name one, and `Types::components` declares its class in `corten/events` with the fields' types |
| Markup to stylesheet | `#[component(css)]`: `class={Name}` is a constant from the component's own CSS file |
| Tokens to views | `tokens!`: scales are enums, each utility value a function (`mx_auto()`), and utilities take values per breakpoint |
| Tokens to stylesheets | at startup: a `var(--x)` without a fallback must be declared by a stylesheet on the same pages, and a breakpoint an `@media` rule names (`not (--sm)`) must be made by a token file in `App::components`, at one width (a component's stylesheet compiles without the theme, so the compiler cannot check either; a breakpoint name no token file can make does not compile) |
| Text to catalogs | `messages!`: every locale has every key with the same arguments |
| Form to handler | `#[derive(Fields)]` names are `FieldName`s, the only key `name=`, `Errors` and corten-ui's fields take, and the same derive reads the post by those names (it implements serde's `Deserialize`, so a form type derives nothing else) |
| Handler to JSON client | `Json<T>` and `req.screen` take a `ToJson`; `#[derive(ToJson)]` reads `#[serde(...)]` and refuses one it cannot write as serde does (`flatten` of anything but a derived struct, `serialize_with`), so what it writes is what serde reads back |
| Another service's JSON to a page | `corten::json::from_slice` takes a `FromJson`; `#[derive(FromJson)]` reads `#[serde(...)]` and refuses one it cannot read as serde does (`flatten`, `deserialize_with`), and writes the type's `Deserialize` from the same reading, which reads whatever its reader gives up on (serde's derive beside it does not compile) |
| Server to script | `corten::types::Types::new().add::<Row>().components(COMPONENTS).sync(path)` in a test writes TypeScript declarations and fails while they are stale (line endings aside, so a Windows checkout with CRLF is not); `corten check` then fails in every script that reads an old name (it runs TypeScript's `tsc` over `src/` and `static/`, and fails when the app has scripts and `tsc` is not installed, unless told `--no-script-types`) |
| Feed rows to their key | `#[derive(Row)]` (`corten::feed::Row`): a row's key is the field marked `#[row(id)]`, so renaming it moves the key with it; a row with none, two, an id that is not text, a serde attribute that makes the id's JSON differ from `id()` or puts another member under its key (a flattened field's members aside), a tuple struct, or a row that is not `Clone`, `Serialize`, `Send`, `Sync` and `'static` (a generic one, where a feed of it is built) does not compile |
| Server to agent | tool input and output schemas generated from the structs by `#[derive(FromJson)]` and `#[derive(ToJson)]` (feature `agent`) |

Untyped rows are `unknown`, not `any`. The full table, and what is not checked, is
in [Surfaces](../architecture.md#types-across-seams).

## Checking handler calls

Nothing is generated between markup and script: the call is checked against the script itself.

```js
// offer_list.js
/** @param {HTMLTableSectionElement} rows @param {HTMLTemplateElement} rest @param {HTMLButtonElement} button */
export function showAll(rows, rest, button) { /* .. */ }
```

```rust,ignore
let (rows, rest) = refs();
// <tbody ref={rows}>, <template ref={rest}>
<button on:click={js::showAll(rows, rest, target)}>     // compiles
<button on:click={js::showAll(rest, rows, target)}>     // error: the handler takes an HTMLTableSectionElement, and this is an HTMLTemplateElement
<button on:click={js::show_all(rows, rest, target)}>    // error: no function show_all in js
```

Every parameter needs a JSDoc type; an untyped one is a compile error that names it.

## Generating the script types

A test in the app writes the TypeScript declarations its scripts read (feed rows, typed
events), and fails while the committed file is stale:

```rust,ignore
#[test]
fn script_types_match_the_server() {
    corten::types::Types::new()
        .add::<Stock>()
        .components(views::COMPONENTS)
        .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
}
```

### Where the types come from

`#[derive(ToJson)]` describes the JSON it writes (`corten::json::schema::ToJsonSchema`) and
`#[derive(FromJson)]` the JSON it reads (`FromJsonSchema`), each from the same reading of
`#[serde(..)]` that lays out or reads the bytes, so a rename, a skipped field or a tag cannot be
written one way and declared another. The declarations above come from the written side; an MCP
tool's `inputSchema` from the read side and its `outputSchema` from the written side. Each is
JSON Schema (draft 2020-12): a doc comment is the `description` (and a first line starting with
`#` the `title`), a named type is a `$ref` into `$defs`, and a field with `#[serde(default)]`
carries its `default`. The schemas are compiled only with feature `types` (which `agent` turns on).

A derived type compiles with a field of any type serde writes or reads, since many are never
described. Describing one whose field, at any depth, has a type with no schema panics naming that
type: in the test that calls `Types::sync`, or at startup for a tool. Derive `ToJson` (or
`FromJson`) on the type (a `Fields` or `UrlValue` type has its read schema already), or, for another
crate's type, implement the trait for a `#[serde(transparent)]` newtype around it (a newtype that is
a tool's whole output implements `ToJson` by hand as well, `serde_json::to_writer(&mut *out,
&self.0).expect(..)`, writing exactly one JSON object: an output that is or holds a `ToJson`
written by hand is parsed before it is sent, so one that is not one object is the tool's internal
error, logged with the tool's name, and a debug build answers it with a 500 naming the tool; a
newtype that is a tool's whole input takes `impl corten::FromJson for T {}` beside its
`Deserialize`). In a generic type, a field type that has a schema only under a bound the type does
not declare (`Cow<'a, [T]>` needs `T: Clone`) is named the same way: add the bound to the type's where clause. A type a root names
directly (`Types::add`, a tool's input or output, an event's field) without a schema does not
compile. Rust's own types that serde writes have one (strings, numbers, `NonZero*`, lists, sets,
maps, tuples, `Option`, `Box`/`Rc`/`Arc`/`Cow`, `Duration`, `SystemTime`, paths and addresses,
`serde_json`'s values and `RawValue`, Corten's `Raw` and `Day`). The read side describes what
`FromJson` reads, so an enum with data in a tool's input, which `FromJson` does not take, has no
read schema: implement `FromJsonSchema` for it by hand (and, when it is the whole input, which a
tool bounds on `FromJson`, add `impl corten::FromJson for T {}` beside its `Deserialize`). A
declaration is named after the Rust type; a `#[serde(rename)]` on the type does not change its JSON,
and does not change the name.
