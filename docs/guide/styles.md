# Styles

[Back to the guides](../../README.md#documentation)

Each component's styles are a CSS file next to it, scoped to it at compile time; design tokens
are W3C design-token files; both reach the browser as one cached stylesheet. There is no CSS
build step.

```css
/* src/views/offer_list.css */
.table { font-variant-numeric: tabular-nums; }
.row:hover { background: var(--color-surface-2); }
.row.selected { outline: 2px solid var(--color-accent); }
```

```rust,ignore
#[component(css)]  // #[component(css, js)] with a script too
pub fn OfferList<'a>(offers: &'a [Offer], selected: Option<&'a str>) -> impl Render {
    html! {
        <table class={Table}>
            for o in offers { <tr class={(Row, (selected == Some(&o.id)).then_some(Selected))}>...</tr> }
        </table>
    }
}
```

| You write | Corten checks or generates |
|---|---|
| `offer_list.css` next to `OfferList` | every class prefixed, `.offer-list__row`; every top-level selector must require one of the file's classes. A merge conflict's marker left in the file (`<<<<<<<`, `\|\|\|\|\|\|\|`, `=======` or `>>>>>>>` starting a line, outside comments and strings) does not compile either: a browser would drop the rule it starts |
| `@scope (.list) to (.slot) { li { padding: 0; } }` | the root and limit prefixed as any selector is, `@scope (.offer-list__list) to (.offer-list__slot)`, so the rules reach the list's elements down to a slot and no further. An owned root lets its rules start anywhere (`:scope`, `li`, `> li`) and bounds nested scopes. A root that can start outside the component only filters; the rules under it still need proof of ownership. Classes in the limit are this component's too. A missing root, a pseudo-element outside a forgiving arm, or a prelude other than `(root)` with an optional `to (limit)` does not compile |
| `class={Row}`, `class={[Row, Selected]}` | static markup, `class="offer-list__row"`; a class the file lacks, another component's class, or one of the file's classes written as text (`class="row"`) does not compile |
| `.card` in `Card`'s own stylesheet | `class={Card}` in its markup is the class, `card__card`: name the root class after the component |
| `class={(Row, cond.then_some(Selected), extra)}` | joined when the page renders; `None` adds nothing, an empty list leaves the attribute out |
| a class nothing uses | `warning: constant Hot is never used` (an error under `-D warnings`) |
| `#[component(css)] fn Button(variant: Variant) -> impl ClassList { (Button, variant) }` | a look: a component with no markup, whose classes go on an element the caller writes, `<button class={Button { variant: Variant::Primary }}>`, alone or in a tuple with the caller's own (`class={(Button { .. }, Wide)}`); it counts as rendered where it is used, and takes no script, refs or view ([below](#looks)) |
| `#[component(css = OfferList)]`, `css = super::offers::OfferList` | a helper component shares the owner's stylesheet from any module of the crate that can see the owner, named by its path (not through a `use`) (a screen's panels in files of their own), and its uses count; classes are in scope only in a component, so a plain `fn` that picks a class is a helper component or a `match` in the markup |
| `tokens!("tokens/tokens.resolver.json")` ([design tokens](#design-tokens)) | custom properties (`--space-4`), each theme's changes (`[data-theme="dark"]`, `[data-density="compact"]`), enums (`Space::_4.var()`) and typed utilities, a function per value (`gap_2()` prints `gap-2`, `mx_auto()` `mx-auto`) and per utility for a value chosen as the page renders or per breakpoint: `gap(Responsive::new(Space::_2).md(Space::_4))` prints `gap-2 md:gap-4` |
| `App::components(&[TOKENS, OfferList, ...])` | one `components.css` in the listed order, linked from `<head>` and precached by the PWA; a component rendered but not listed is an error in a debug build (a router test, `cargo run`, `corten dev`) |
| `var(--color-accent)` in a component's stylesheet | a startup error unless a stylesheet on the same pages declares it (the token file, a listed component's, a `.css` file in the static directory, or for an area's component one linked from its area), naming the file and the property; `var(--x, fallback)` is not checked |
| `App::area(\|area\| admin::area(area).components(&[SalesChart, ...]))` | those stylesheets in a file of their own, `sections/admin.css`, linked only from pages at and under `/admin`, and from the patches their handlers answer; a component listed in two places, or tokens in an area, is a startup error, and a page or a patch handler outside the area that renders one is an error in a debug build |

Every comma-separated selector must match only elements the component owns: the element it
styles, or one that element is inside (by a descendant or child combinator), has one of the
file's classes. A sibling of such an element shares what it is inside, so `.list li + li`
compiles, but `+` and `~` from the class's own element lead beside it, so `.list + main` does
not. A [matches-any function](https://www.w3.org/TR/selectors-4/#matches-pseudo) (`:is()` or
`:where()`) counts when every matchable selector in it does. The check ignores some invalid arms,
such as an empty arm, a pseudo-element arm, or one with a leading, trailing or doubled
combinator. It does not remove those arms from the emitted list. A pseudo-element in such an
arm can also be recognized when a comment separates its two colons; a direct pseudo-element
still cannot be an `@scope` root or limit. Malformed strings, malformed unquoted `url()` and
mismatched block delimiters are compile errors anywhere in a sheet. An unquoted `url()` token
is valid in a value, including paths such as `url(a/*b)`, but is still refused in selector
proofs, even in a forgiving arm.
A comment directly between two parts of a selector or an `@scope` prelude is conservatively
refused (apart from the two colons above). Write the intended selector without it: for a
compound selector, write `.list.selected`, not `.list/**/.selected`.
The scoper also refuses a custom property value with a `{ ... }` block at its outer level
rather than treating it as a nested rule. Removing the braces would turn the block's
declarations into real ones, so put such a declaration in the app's `static/style.css`. A block
inside a function or square brackets (`--x: f({ .. })`) is kept as written.
Component class names use ASCII without escapes; a nonbreaking space is part of a
CSS name, not a separator, including in at-rule names, `@scope` roots and limits, and next to
`to`. A non-ASCII at-rule name does not compile; the diagnostic escapes the name so an
invisible character is visible.
`:is(.list, .grid) p`, `:is(.list,) p` and `.list:has(img) p` compile; `:is(.list, main) p`,
`:not(.list) p` and `main:has(.list) p` do not. Classes inside other functions are still
prefixed, but only filter. A nested selector is checked where its `&` stands, so
`.list { :not(&) { .. } }` and `.list { & + main { .. } }` do not compile, while
`.list { p { .. } }` and `.list { > :not(&) { .. } }` do. An unescaped `&` in an invalid
arm can still turn off implicit nesting: write `& :is(main, [foo=&])` (or remove the invalid
arm) if you mean descendants of the parent. The same test decides whether an `@scope` root is
owned, at the top of the file or nested in a rule. A scope without an owned root can still
filter independently anchored style rules, as in
`@scope (body) { @scope (:scope > main) { .list p { .. } } }`. An inner scope under an unowned
outer scope proves ownership for its body only if each root selector requires a positive class
on the root element or an ancestor. Neither `&` nor implicit nesting proves ownership there:
browsers can resolve them through the outer scope rather than the intervening style rule.

A selector that compiled before this check may need its anchor written out:

| Before | After |
|---|---|
| `main:has(.list) p`, meaning the list's paragraphs | `.list p`, or `main .list p` to keep the condition |
| `:not(.list) p` or `:is(.list, main) p` | `.list p` for the component's paragraphs, or the rule in the app's `static/style.css` when it styles the page |
| `.pick:checked + span` | `:where(.cuts) .pick:checked + span`: `:where()` adds no specificity |
| `.list { :not(&) { .. } }` | the rule in the app's `static/style.css`, or `@scope (.list) to (.slot) { .. }` for the list's elements down to a slot |
| `@scope (body) { .list { @scope (&) { p { .. } } } }` | hoist the intended root: `@scope (body) { @scope (.list) { p { .. } } }` |
| `@scope (body) { .list { @scope (main) { p { .. } } } }` | to keep the intended descendant-`main` condition, hoist `@scope (.list main)` inside the outer scope. If the list is itself a `main`, use `@scope (main.list)` instead |
| `.list::before, .list > p { & + p { .. } }` | change the inner selector to `:where(.list) & + p`. The browser ignores the pseudo-element arm when resolving `&`, but the check does not infer that; the anchor adds no specificity |
| `:is(.list, :not(::before)) p` or a similar forgiving list in a scope root or limit | remove the invalid `:not(::before)` arm; the browser already ignores it, but the check does not recognize it as invalid |
| `:nth-child(2 of .list)` | `:nth-child(2 of .list):where(.list)`: write the required class on the subject, without adding specificity |
| `main:has(> :is(.list > p))` | `main:where(.list):has(> :is(.list > p))`: the direct child relationship implies that `main` has the class, but the check does not infer it |
| `:scope > *` in `@scope (main) to (:scope > :not(.list))` | `:scope > :where(.list)`: the limit already excludes the other children, but the check does not infer ownership from limits |

When a rule really is page-wide, move it to `static/style.css`. If you flatten a nested style
rule, substitute the enclosing selector for `&`, wrapping a selector list in `:is(...)`.
In a style rule directly in an `@scope`, `&` refers to the scope root; in a further nested
style rule it refers to the parent style selector. Give the markup a global marker
rather than hard-coding the generated class prefix. For example, `.list { :not(&) { .. } }`
becomes `:not([data-offer-list]) { .. }`, with `data-offer-list` alongside `class={List}`.
For `.list, .grid { & + p { .. } }`, use `:is([data-list], [data-grid]) + p` with the two
global markers. Without `:is(...)`, the comma would make the first marker a separate selector.
For an app with a copied kit stepper, run `corten ui add --merge stepper` with the updated CLI
to upgrade the copy while retaining nonconflicting local edits.

Variants are Rust: `match tone { Tone::Danger => Danger, Tone::Neutral => Neutral }` picks the
class, so adding a variant without a rule does not compile. A component library is a crate that
exports `pub const COMPONENTS: &[Component]`; the app passes it to `App::components`.

A misspelled token (`var(--color-primary-contrast)` where the file has
`--color-primary-foreground`) would make the declaration invalid and the property inherit, which
shows only as a wrong color. So when the app starts (`App::router`, which every test of the app
builds), each `var(--x)` without a fallback in a listed stylesheet must name a property declared
by a stylesheet on the same pages, or it fails with the file and the property. It is a startup
check, not a compile error, because a component's stylesheet compiles without seeing the theme,
which may be another crate's. A property a script sets (`el.style.setProperty`) takes a fallback,
`var(--progress, 0)`.

`static/style.css` holds what belongs to no component: element defaults, fonts (with type a theme
cannot write as a token, such as the kit's `--stat-label-text-transform`) and the layout.
Link it before `<Corten />` in the layout, which links the components' stylesheet, so component
rules win ties. The components' stylesheet starts with `[hidden] { display: none !important }`:
a part hidden with the attribute (`hidden={..}` in markup, `el.hidden = true` from a script)
stays hidden even when one of its classes gives it `display: grid`, which would otherwise win
over the browser's own rule. `hidden="until-found"` is left to the browser, so find-in-page can
still reveal it. A closed popover and a closed `<dialog>` are kept hidden the same way, so a
look that sets `display` (a card) can go on either and is drawn only while it is open; a
`<dialog popover>` shows open either way it is opened. A closing `display` transition
(`transition-behavior: allow-discrete`) plays as it would without the rule, since a transition
outranks `!important`, so animate a close that way: a `@keyframes` animation of `display` is
held at `none`. A closed dialog meant to stay drawn (to fade out) takes the app's own
`!important` rule with more weight than an attribute
(`dialog.fading:not([open],[hidden]) { display: block !important }`, which leaves one with
`hidden` hidden). So does a closed dialog drawn in
place from a breakpoint, a filters rail that is a modal on a phone: in its component's file, inside
the media query, `.filters:not([open],[hidden]) { display: block !important }`. A look for the open
dialog at a width goes under `[open]` (`.modal[open] { display: grid }`), as the kit's dialog and
sheet do. Since nothing fails when a rail is missing (the page answers, the rail is simply not
drawn), `corten dev` warns in the console of each closed dialog or popover that a rule inside
`@media` or `@container` gives a `display`, at the width the page is at or any other. It
normally suggests both rules: the page cannot tell a rail from an open look written without
`[open]`. The suggestion uses a matching class from the resolved selector, including in nested
rules written with `&`. When the check composes an entire `@scope` selector chain, it names
the rule without suggesting a replacement selector that would drop the scope.

The check composes explicit, unlimited `@scope` roots outside style rules. Plain selector-list
members and plain inner roots start below their parent; a leading `>` requires a direct child.
A single `:scope` or `&` can name the root explicitly. In a nested style rule, `&` instead names
the parent style rule's composed selector; that form does not compose `:scope` references.
Declarations on a scope root or its nested style rules use their enclosing selector. Supported
selectors use unescaped ASCII type, class, ID or presence-attribute selectors, `*`, descendant
and child combinators, and `:is()`, `:not()` or `:where()` around one simple type, class, ID or
presence-attribute selector, such as `dialog:not([open])`.

In linked sheets, if any root, limit, nesting parent or rule selector cannot be composed or
read, the check handles the whole rule as before: it treats `@scope` as a grouping rule, keeps ordinary style
nesting and does not use any of the scope bounds. This includes implicit roots, scopes with a
`to` limit, scopes nested in style rules, sheets with `@namespace`, a top-level root referring to
itself, unsupported selectors, selectors over 1,024 characters before or after composition,
and selectors the browser rejects. Rules under `@supports` conditions that `CSS.supports()` rejects
or under `@starting-style` also use only the old match. Unscoped rules are unchanged, including long
selectors.

The check does not evaluate the cascade. Three known limits for closed rails with declarations at
`min-width: 900px` (check at 600px):

- `.rail { display: flex }` and `@scope (.card) { & > * { display: grid !important } }` can suppress the warning for a rail in `.card` even though the override loses to the hiding rule.
- `@scope (.card) { .rail:not(.gone,.pending) { display: flex } }` and `@scope (.other) { .rail { display: grid !important } }` at the same breakpoint can warn for a rail outside both roots: the `:not()` list uses the old flat match, but the override does not.
- `@scope (.card) { :scope > .rail { display: flex } }` and `@scope (.other) { @supports (display: future-layout) { .rail { display: grid !important } } }` can suppress the warning for a rail in `.card`: the override's rejected `@supports` (or `@starting-style`) falls back to the old flat match, which ignores `.other`.

The check also reads the document's adopted stylesheets without changing them or applying
diagnostic styles to the page. It matches ordinary selectors and the supported explicit scopes
described above. In an unscoped, unnested selector list it skips members that refer to `:scope`
or `&`, or whose pseudo-class names contain escapes; other members still match normally.
An unsupported nested selector, an implicit scope root or a `to` limit is not inspected rather
than matched without its bounds. It also skips disabled, namespaced or media-inactive adopted
sheets, rules in unsupported `@supports` or `@starting-style` blocks, and shadow-root styles.
Within an eligible sheet it still checks media and container breakpoints even when inactive.
Adopted rules only add warnings; they do not override the linked-sheet check. A dialog that the
browser already shows does not warn. The check does not inspect which adopted declaration wins
at another width, so a skipped `to`-limited override can leave a warning for a dialog that
actually appears at that breakpoint.
When only areas have stylesheets, each area's file starts with these rules. An app with no
component stylesheet has neither file, so if its `static/style.css` gives a hidden element, a
popover or a dialog a `display` (styling corten-ui's parts there, say), it adds them itself:

```css
[hidden]:where(:not([hidden=until-found i])) { display: none !important; }
[popover]:where(:not(:popover-open, dialog[open])) { display: none !important; }
dialog:where(:not([open], [popover])) { display: none !important; }
```

Inline `style="..."` stays blocked by the CSP; one-off values come from the token utilities, and
a size drawn from data from a custom property ([below](#values-from-data)).

## At-rules

Component CSS matches at-rule names ASCII case-insensitively in both blocks and statements
(`@MEDIA`, `@LAYER`). It supports the block at-rules below; this is a scoping pass, not a
full CSS validator.

| At-rules | What happens |
|---|---|
| `@media`, `@supports`, `@container`, `@layer`, `@starting-style` | Rules checked and classes prefixed as in the surrounding block, including nested declarations. `@media (--md)` names a token breakpoint ([below](#breakpoints)). |
| `@scope` | Root and limit prefixed and rules checked as in the table above; no implicit root. |
| `@property` | Body copied without selector scoping, then required descriptors and syntax checked; registered names and their references prefixed ([values from data](#values-from-data)). Not inside a style rule. |
| `@position-try` | Declaration body copied without selector scoping; the defined name and references in `position-try-fallbacks` and `position-try` declarations in this file prefixed. Not inside a style rule. |
| `@keyframes`, `@font-face`, `@counter-style`, `@font-palette-values`, `@font-feature-values` | Bodies copied without selector checks or class prefixes. Names stay global, including font families and feature-value names; qualify a private name with the component's name yourself. |
| `@page` | A global name starting with the component's name and `-`, written by the author, with the body copied without selector scoping ([printing](#printing)). An unnamed page or an unqualified name does not compile. |

Raw bodies still compact trivia, and references to registered custom
properties are renamed there too. Nested block at-rules inside them are copied raw (font
feature `@styleset`, page margin `@top-left`, and others), not independently selector-checked.
The statement parser copies `@layer base, widgets;` without changing the name's case, and
discards `@charset "utf-8";` in any case (the generated stylesheet is UTF-8). It refuses
unknown statements even inside raw bodies.

`@import` does not compile: imported CSS is not checked or owned by the component. Put it in
`static/style.css`. `@custom-media` does not compile either: the token file defines breakpoints,
and the component names them with `@media (--md)`. Unrecognized rules such as `@namespace`
and `@document` are refused outside raw bodies; use the global stylesheet for them. At-rule
names must match whole names: `@supports_other` and `@layer_other` are not supported.
An `@scope` without a root is refused because its implicit root is outside the component.
Escaped at-rule and class names are not supported.

The compiler and startup check share [CSS Syntax Level 3
tokenization](https://www.w3.org/TR/css-syntax-3/#tokenization). The compiler compacts comments
without turning a token separator into a space: `@supports selector(./**/a)` keeps its
condition, and `@page receipt-slip:/**/first` keeps its pseudo-page. It does not rewrite a URL
payload, even when its function name uses escapes or uppercase letters. At startup, a literal
`var(--name)` read in a declaration or a container size condition must name a property
available to that sheet. This includes declarations directly in `@scope` and in `@page`
margin rules without a prelude. Inside a group directly under `@scope`, put declarations in a
style rule so Chromium doesn't discard them. Strings, URLs and other query preludes aren't
searched. A `var()` with a fallback is optional, including when the name is brace-wrapped
(`var({--name}, var(--fallback))`).
The check is structural, not a validation of property values or of whether a selector matches.

A popup can define a fallback beside its default position, including a corten-ui `MenuButton`
or `ComboBox` styled by this component:

```css
/* actions.css */
@position-try --above { position-area: block-start span-inline-end; }
.menu [role="menu"] {
  inset: auto;
  position-area: block-end span-inline-end;
  position-try-fallbacks: --above, flip-inline;
}
```

`--above` becomes `--actions__above` in the definition and the declaration, including in the
`position-try` shorthand and references before the definition. CSS gives these names a
tree-wide namespace, not one per component ([design Limit 9](../design.md#limit-stylesheet-support));
prefixing prevents two components' options from colliding. Names defined here use `--` followed
by ASCII letters, digits, `-` and `_`, without `__`, as `@property` does; references can use CSS
escapes. The scoping pass does not prefix options defined outside this file. The macro reads
the two declarations' values as CSS tokens and renames an identifier only where the value takes
an option: at its top level, in a `var()`, `env()`, `attr()` or `inherit()` fallback, and in an
`if()` branch's value.
`position-try: var(--choice, --above)` scopes the fallback but does not treat the lookup
`--choice` as an option. A registered property with the same name does not rename an option,
but its `var()` lookup still gets the property prefix. In
`if(style(--above: 1): --above; else: flip-block)`, the condition names a property and the
branch value names an option; each is scoped only if this file defines it in that namespace.
Function calls (`--above()`), anchor names, strings, URLs and other functions' arguments are
not position references. Comments and whitespace are normalized as in other declarations.
In `--externa\6c  flip-block`, the first space terminates the hex escape and the second remains
a separator, so the browser still reads a name and a tactic.
A name that reaches `position-try` through a
custom property's value (`--choice: --above`) is not rewritten, since the macro cannot know where
that value goes; name the option in the declaration itself. Other raw named rules remain global
for compatibility with references from global CSS and font files; a private name should include
the component's name. This does not isolate anchors or change the browser's supported position
descriptors.

## Motion

Motion belongs in the component's stylesheet and script, using browser standards rather than a
framework animation API. Use `transition` for state changes and `@keyframes` for entry or feedback;
put the latter behind `@media (prefers-reduced-motion: no-preference)` when the motion is not needed
to understand the state. A script can mark the element with a typed `data-*` state, force a fresh
animation by removing and restoring that state, and clear it on `animationend` or
`animationcancel`. A changing marker value restarts the animation without forcing layout. When the
component starts lasting work, pass its `signal` to the event listeners and timers so a server patch
that removes the element stops the work.

The deck builder demonstrates this pattern: its drag targets transition their border and shadow,
changed collection rows pulse, and new or changed deck lines enter with a small translate. Its
smoke test checks the markers, not a timing-sensitive screenshot, and the reduced-motion media
query leaves the page's state and accessibility unchanged.

## Values from data

A size or position the page computes (a meter's fill, a bar's length, a mark on a timeline) is a
custom property the component's stylesheet registers with `@property` and reads with `var()`,
set in its markup with `style={..}`. `examples/seller-desk`'s statement draws each set's share of
the stock's value this way:

```css
/* statement_table.css */
@property --share { syntax: "<percentage>"; inherits: false; initial-value: 0%; }
.bar { width: 6rem; background: linear-gradient(to right, var(--accent) var(--share), var(--tint) var(--share)); }
```

```rust,ignore
<span class={Bar} style={SHARE.pct(share)}></span>
```

| You write | Corten checks or generates |
|---|---|
| `@property --share { syntax: "<percentage>"; .. }` | the constant `SHARE: Var<Percentage>` in the component's markup, and `--statement-table__share` where the file names that custom property |
| `SHARE.pct(12.5)`, `GAP.px(4.0)`, `TURN.deg(90.0)`, `SPAN.set(3)` | a method per unit the syntax allows (every CSS unit but `in`, a Rust keyword: an inch is `px(96.0)`) (`<number>`, `<integer>`, `<percentage>`, `<length>`, `<length-percentage>`, `<angle>`, `<time>`); another unit, CSS text (`style={format!(..)}`) or another component's property does not compile, and a number that is not finite sets nothing, so the property keeps its `initial-value` |
| `style={(SHARE.pct(s), nudge.map(|n| GAP.px(n)))}` | one attribute, `data-vars="--statement-table__share:12.5%"`; `None` sets nothing, and with nothing to set there is no attribute |
| an `@property` without `syntax`, `inherits` or `initial-value`, with a `syntax` the browser does not read (`<text>`, a keyword such as `-compact` that starts with `-`), or with a number syntax and an `initial-value` that is not one, or depends on the font or a container (`1em`, `1cqw`), or is a math function (write one value, `6px` rather than `calc(2px * 3)`: the browser drops the rule when a math function does not fit, and checking one would take a CSS math parser) | a compile error: the browser would ignore the rule, or the macro could not tell; another syntax's `initial-value` (`<color>`) is left to the browser |

The prefix applies to the registration, declarations, lookups such as `var(--share)` (including
inside container size queries and `if()` conditions), style queries such as
`@container style(--share: 50%)`, and property lists such as `transition-property: --share`.
A literal `style()` test is also scoped when a substitution supplies it to an `if()` condition:
in a `var()`, `inherit()`, `attr()` or `env()` fallback, a nested `if()` branch value, or a
`random-item()` choice. The same text in an ordinary declaration value is not a test.
This follows the arguments as written, not argument boundaries built by CSS spread syntax.
A same-spelled anchor, container, timeline, view-transition name or font palette keeps its name.
A bare name stored as a custom property's value is not a lookup, nor is the attribute name in
`attr()`. A name computed at runtime, for example one built by a script or supplied by
`attr()`, is not scoped. This also applies to CSS-only lookups such as
`var(var(--missing, --share), 1px)` and `var(if(else: --share), 1px)`: the fallback or branch
supplies the name, so the macro leaves it unchanged. Use `var(--share)` for a scoped lookup.

A full page gets one `<style>` at `<Corten />`, after its stylesheets, with a rule for each
distinct value (`[data-vars="--statement-table__share:12.5%"]{..}`), marked `!important`, as
the runtime's inline values are, so a value from markup wins over the component's rules on a full
page and after a patch alike (an `!important` declaration of a property markup sets does not
compile: one more specific than the block's rule would win on a full page only), and that response's CSP
allows it by its hash in `style-src`. So the page paints with its sizes and no script, no style
attribute is allowed anywhere, and a cached page is still the same bytes (no nonce). Markup a patch,
a client navigation or a `<corten-live>` fragment brings is under the policy the document loaded
with, which allows neither, so the runtime sets those values through the CSSOM
(`el.style.setProperty`), which the policy does not govern, before the browser paints them. A row
`rows()` copies out of a `<template>` gets the server's values for the template's row the same
way, not its own: a script that fills rows draws their sizes itself. The block has the values
written while the page renders: markup rendered ahead (a body that is also a live stream's
fragment) goes in a `corten::Rendered` (`req.rendered(view)`), which keeps them and places them with its markup
(`{body}`, a reference to it); text placed with `raw()` carries none. With debug assertions
and development mode enabled, as in `corten dev`, a full page with a `data-vars` value its
block has no rule for returns a server error. This
includes markup in templates that scripts can copy and live `<noscript>` fallback, but
not fallback inside an inert template. A normal release build does not return that error,
even with `CORTEN_DEV=1`; development mode still serves the browser diagnostics. A property
registered with another syntax (`<color>`, to animate it) is scoped the same way and has
no constant.

The block costs a page that uses it the hash of its text: measured with callgrind (release
build, in process), four meters with three distinct values took a page from 21,911 instructions a
request to 40,115, about 8,400 of it the SHA-256. A page that sets none runs about 130 more than
before. Each distinct value is written twice in the block and once in its attribute, which
compresses well when values repeat; a chart of hundreds of distinct values belongs in SVG
attributes, which need no CSS at all.

An area that allows style attributes, `.policy(|p| p.allow_style_attributes())`
([app guide](app.md#a-policy-for-part-of-the-app)), is for markup the app does not write as
`html!`, such as rich text from a CMS.

## Design tokens

Token files are the W3C Design Tokens format, 2025.10: the files Figma variables, Tokens
Studio, Style Dictionary and Terrazzo read and write, so a design tool's export needs no
converter and the same files can feed iOS and Android builds. A token file holds the values; a
resolver document (`.resolver.json`) puts token files together and gives the themes.
`tokens!("tokens/tokens.resolver.json")` reads a resolver (a file with `resolutionOrder`) and
the files it names, each a path relative to the file that names it (a URL, a scheme, a drive or
an absolute path does not compile; `#/` is a whole file, and `example.json#sets/MySet`, as the
resolver module also writes it, is `#/sets/MySet`; a JSON pointer, like a `{group.token}`
reference, names a token in the tokens put together, as the resolver module resolves aliases
only after the sources are merged, so a later source's value wins; in a source that is part of a
file, a pointer into the part is moved to where the part goes, and one outside it is the value it
names); `tokens!("tokens/base.tokens.json")` reads one token file, for an app with no themes.
Sources merge in order: a later token replaces a token, and groups of one name merge. A group
over a token, or a token over a group with tokens in it, in two sources or in a group and the
group it `$extends`, does not compile, since it would drop the token or the group's tokens; the
token goes in the group as its `$root` (`"card": { "$root": .., "padding": .. }` is `--card` and
`--card-padding`).

```json
{
  "color": {
    "$type": "color",
    "ink": { "$value": { "colorSpace": "srgb", "components": [0.1137, 0.1059, 0.149], "hex": "#1d1b26" } },
    "link": { "$value": "{color.ink}" }
  },
  "space": {
    "$type": "dimension",
    "4": { "$value": { "value": 16, "unit": "px" } }
  },
  "$extensions": {
    "run.corten": {
      "breakpoints": { "md": { "value": 48, "unit": "rem" } },
      "utilities": { "gap": { "property": "gap", "group": "space" } }
    }
  }
}
```

Each top-level group's tokens are a scale: `--color-ink` and `Color::Ink`, `--space-4` and `Space::_4` (the group's own `$root`, below, is not in it). A
nested group joins its names with `-` (`--color-brand-primary`). Names are written as CSS
writes them, so a design tool's `Brand Primary` or `brandPrimary` is `--brand-primary` (and
`BrandPrimary` in Rust); two names that come out the same, `font-size` and `FONT-SIZE`, do not
compile, a letter outside ASCII is an error, and a top-level group (a Rust enum), breakpoint or
utility (a CSS class) starts with a letter. A token at the top of the file, or a top-level
group's `$root` (`--brand`), is a custom property with no enum; a `$root` on the file itself has
no name to give it, so it is an error. Values are written in CSS: an sRGB color whose
`hex` agrees with its components is the hex (a `hex` more than one 8-bit step from them in a
channel does not compile, naming both and the hex the components are; a color written as a
hex alone, `"#1d1b26"` or `{"hex": ..}`, does not compile either, and the error is the object
to write instead), other color spaces are CSS Color 4 (`oklch(..)`,
`color(display-p3 ..)`), and dimensions, durations, shadows, borders, transitions, cubic Béziers,
font families and weights have one CSS value each. A reference stays one: `"{color.ink}"` is
`var(--color-ink)`, so a theme that changes `ink` changes `link` with it. A JSON pointer into a value (`{"$ref":
"#/space/4/$value/value"}`) is the number or text it points at, written where it is used,
following a token that is itself a reference to the one with a value; a pointer is a URI fragment,
so `#/Brand%20Primary` names `Brand Primary`, and a font list names a token by pointer
(`[{"$ref": "#/font/brand/$value"}, "serif"]`), as the schema has it. A circle of references
does not compile, and a chain of more than 256 pointers, or of groups extending one another, is an error (a chain of
aliases, `{a}` naming `{b}`, can be any length), as are a number too large for an `f64` (CSS writes finite numbers), objects and arrays nested
more than 128 deep, and following more than 100,000
JSON pointers, `$extends`, sets and file references in all (a file naming one set twice at each of many levels). A
gradient (it has no direction) and a typography token (it is several properties) have no one CSS
value, so they do not compile; give their parts tokens of their own. A stroke style of dashes and
caps is `dashed`, the closest CSS border style, as the Format module suggests.

The themes are the resolver's modifiers:

```json
{
  "version": "2025.10",
  "sets": { "base": { "sources": [{ "$ref": "base.tokens.json" }] } },
  "modifiers": {
    "theme": {
      "contexts": { "light": [], "dark": [{ "$ref": "dark.tokens.json" }] },
      "default": "light",
      "$extensions": { "run.corten": { "media": { "dark": "(prefers-color-scheme: dark)" } } }
    }
  },
  "resolutionOrder": [{ "$ref": "#/sets/base" }, { "$ref": "#/modifiers/theme" }]
}
```

A modifier's `default` is the values on `:root`; the format lets a modifier leave it out and
asks for an input instead, but a page that chooses no context still needs values, so here it is
required. Each other context's changes apply under
`[data-theme="dark"]` (the modifier's name and the context's, written as CSS names), on the
document or any element inside it, so `dark.tokens.json` holds only the values that change.  The
default context has a rule too, `[data-theme="light"]`, with the default values of what the
others change, so a light panel inside a dark page, or on a system that is dark, is light. A
token that reads one a context changes is declared again under each context, so it follows on an
element too. Breakpoints are wider than 0 and go smallest first, in one unit, or the file does not compile; a
utility's `group` is a top-level group's name as the file writes it (`"Brand Space"`, whose
classes and properties are `brand-space`). A context that defines a
token the defaults lack, or gives one another type, does not compile: the page that chose no
context would have no value for it. Two modifiers' contexts on one element apply in
resolutionOrder, the later winning, and each combination (a chosen default included, whose rule
declares again what its modifier's other contexts change) is checked against what the resolver
gives: two modifiers that change one token, or one that sets a token by value that reads a token
another changes, do not compile. Give each modifier tokens of its own and reference them. The
check resolves each combination, each modifier's attribute absent or one of its contexts, up to
256 of them (two modifiers of up to 15 contexts each, or four of three), and more is an error. `media` lets a context follow the system: the page is dark
when it says `data-theme="dark"`, or when the system is dark and the page chose no theme
(`:where(:root):not([data-theme])` under the condition, with the specificity of one attribute,
as each context's rule has, so a later modifier still wins), with the values written once. `color-scheme`
(which themes form controls and scrollbars) is a property, not a token, so it goes in
`static/style.css` next to the same selectors.

Corten's own settings are under `$extensions`, key `"run.corten"` (corten.run, reversed, as the
format asks of a tool's key): breakpoints and utilities on a token file's root group, `media` on
a modifier. Anywhere else it is an error, and other tools' keys are left alone.

## Breakpoints

A component's stylesheet switches its layout at a breakpoint of the token file by naming it as a
custom media query of Media Queries 5: `@media (--md)` applies from `md` up, where the `md:`
utility classes apply, and `@media not (--md)` below it.

```css
/* phone_list.css */
.list { display: grid; }
@media not (--md) { .list { display: block; } }
```

Browsers do not read custom media queries yet, and a component is compiled without the app's token
file (a kit's may be in a crate several apps share), so each name is written as its width when the
app starts: `@media not (min-width:48rem)`. A component and the utilities beside it then switch at
the one width the token file gives. A name no token file in `App::components` makes stops the app,
naming the stylesheet and the breakpoints there are, and so does a name two token files give
different widths (the kit's theme beside an app's), naming each; two widths for a name no
component names stop nothing. A name no token file can make (a breakpoint is lowercase letters,
digits and `-`, starting with a letter) does not compile, and neither does one not alone in its
parentheses (`(--md)`, joined to others with `and`, `or` or `not`); the stylesheet does not define
one (`@custom-media` does not compile), and an `@property` of the stylesheet's own may not share a
breakpoint's name. A literal width (`@media (max-width: 40rem)`) still works, and does not follow
the theme.

`not (--md)` is false at exactly `md`'s width, as `(--md)` is true there, so the two never both
apply. A rule written `(max-width: 48rem)` applied at 48rem too.

A breakpoint may name another in braces: `"wide": "{md}"` makes `(--wide)` `md`'s width. It makes
no utility classes and no `Responsive` method, which the one it names already has. It names a
breakpoint that has a width, in the same group or in another set of the same resolver (whose sets
merge into one group), never another name; anything else does not compile. It is also the only
way to give one width two names, since each width-made breakpoint must be wider than the one
before it. A stylesheet shared
by several apps (the [kit](kit.md)'s) names the role, where its layout stops being a phone's, and
each app's theme points it at one of its own widths.

## Printing

A page prints with its components' own print rules. An `@media print` block is scoped like any
other, each rule starting at one of the file's classes. A named `@page` gives the paper size to
the elements that ask for it with `page`:

```css
/* src/views/packing_slip.css: PackingSlip, so its classes are packing-slip__* */
@page packing-slip-thermal { size: 4in 6in; margin: 0.15in; }
@page packing-slip-letter { size: letter; margin: 0.5in; }
.slip { break-after: page; }
.thermal .slip { page: packing-slip-thermal; }
.letter .slip { page: packing-slip-letter; }
@media print { .actions { display: none; } }
```

The format the user chose puts one class on the list, so one job prints at one paper size. A
page's name is the whole app's, so a component's starts with the component's own (`@page
packing-slip-thermal`), and an `@page` with no name, which sets every page the app prints, does
not compile in a component's stylesheet: it goes in `static/style.css`, with resets for the
elements no component owns (`main`'s margins). `page` applies to boxes in normal block flow, so
an element that picks a page is not a flex or grid item. A component's stylesheet cannot reach the
layout's header or navigation, so each layout component hides itself with its own `@media print`
rule. corten-ui's `PrintButton` opens the print dialog (wrap it in one of your component's
elements to hide it in print); without a script, the browser's Print command prints the same page.

## Looks

A component that only styles an element the page writes returns its classes instead of markup:

```rust,ignore
#[component(css)]
pub fn Button(variant: Variant) -> impl ClassList {
    let variant = match variant {
        Variant::Primary => Primary,
        Variant::Ghost => Ghost,
    };
    (Button, variant)
}

<button type="submit" class={Button { variant: Variant::Primary }}>"Save"</button>
<a href={url::Home} class={(Button { variant: Variant::Ghost }, Wide)}>"Home"</a>
```

The element is the caller's, so `html!` checks its attributes as always, a script's
`parentElement` and a `:first-child` rule see the page as written, and a `<summary>` or `<li>` can
have the look. Its stylesheet styles the element itself (`.button:hover`, not `.button > :hover`).
A look's fields are its props, written as a struct (`CardHeader {}` for none). Written as an element,
a look does not compile: the compiler says it does not implement `Render`, with a note to write it
as a class, and with children (`<Card>..</Card>`) that it has no field named `children`. A look
has no markup to give a script, refs or a view, so those do not compile on it; a component that
draws structure (a label beside its control) or semantics (a role) renders its element. A widget whose button is
its own takes a `class` (corten-ui's `PrintButton`), `()` for none.

```
use corten::prelude::*;

/// Its stylesheet is badge_list.css: `.list`, `.badge`, `.hot`.
#[component(css)]
fn BadgeList(hot: bool) -> impl ClassList {
    (List, hot.then_some(Hot))
}

let html = html! { <ul class={BadgeList { hot: true }} id="foils"></ul> }.to_html();
assert_eq!(html, r#"<ul class="badge-list__list badge-list__hot" id="foils"></ul>"#);
```

## Utility-first

A page can be styled mostly in its markup, as Tailwind does, from the token file's utilities.
`examples/watchlist` is: its `tokens/base.tokens.json` defines utilities for layout, spacing, color, borders
and type, and `src/theme.rs` names the few combinations it repeats as functions:

```rust,ignore
pub fn card() -> impl ClassList {
    (bg_surface(), border_line(), rounded_lg(), shadow_sm(), p_5())
}

/// A row of items, `space` apart: a value chosen by the caller goes to the utility's function.
pub fn row(space: Space) -> impl ClassList {
    (display_flex(), items_center(), gap(space))
}

<div class={(display_grid(), columns(Responsive::new(Columns::_1).md(Columns::Main)), gap_5())}>
    <section class={card()}>..</section>
</div>
```

Each value of a utility is a function named after its class, so `mx_auto()` is `mx-auto`, as in
Tailwind. The utility's own function, `gap(..)`, is for a value the code chooses (`gap(space)`)
and for one per breakpoint (`Responsive::new(..).md(..)`).

Unlike Tailwind's class strings, a utility the file lacks, a value outside its scale or a
breakpoint it does not define does not compile, and there is no build step or content scan: the
token file generates every class it allows, so the stylesheet holds them all whether a page uses
them or not. Measured on the watchlist: its `components.css` (the tokens' utilities and the price
table's stylesheet) is 16,282 bytes, 2,042 brotli at level 11, against 1,063 brotli for the
card market's tokens and five components; a scale of eight spaces in four breakpoints is 32 classes
per utility, so a utility belongs in the file only when pages use it.

Utilities also cost at render time, where a component's classes do not: `class={Card}` is
static text written when the crate compiles, while `gap(Space::_3)` is a value written as the
page renders. Measured with callgrind (release build, in-process `oneshot`, the difference between
1,200 and 200 requests over 1,000, median of three runs), moving the watchlist's home page to
utilities took it from 45,952 instructions a request to 51,201, with a larger page; a profile put
3,086 of the difference in writing its roughly 60 utility classes. Use
utilities for layout that varies from page to page, and a component's stylesheet for what repeats.
A value's own function (`gap_3()`) is its class as static text, with no match: moving the
watchlist's fixed values to them took its home page from 62,827 instructions a request to 62,162.
A helper that takes a value (`stack(space)`) keeps the utility's function, which costs a match
and keeps the scale's type. An app with the kit's `Stack` and `Cluster` builds such a helper on
them, `(Cluster { gap: Gap::App }, gap(space))`, so the row keeps the kit's layout and dropped
child margins and its gap is the utility's ([kit guide](kit.md)). States a utility cannot
say (hover, focus, the current link) and element defaults stay in `static/style.css`, and a
component with rules of its own (`LivePrices`) keeps its stylesheet. A utility function's
classes are static text chosen by a match, so writing them costs what writing a class does.
`use theme::*` brings in every value's function; an item of the module's own with the same name
hides it.

## Areas

Every page links `components.css`, so a large part of the app that most visitors never open (an
admin console, seller tools) adds its CSS to every first load. An area
([app guide](app.md#areas)) gives that part its routes under one prefix and
a stylesheet of its own:

```rust,ignore
App::new(routes)
    .components(&[TOKENS, Button, OfferList])                              // every page
    .area(|area| admin::area(area).components(&[SalesChart, AuditTable])) // pages at /admin and under it
```

- The server picks a page's stylesheets by its path, from links built at startup: no per-render
  tracking. A page under nested areas (`/admin`, `/admin/reports`) links each, outermost first.
- A client navigation into the area adds the stylesheet to `<head>` and waits for it before
  swapping the page in, so the page never shows unstyled; if it fails to load, the runtime loads
  the page in full. The stylesheet then stays: its rules match only its components' classes.
- A component that pages in several areas render is listed in each of those areas: its rules
  go in a file the areas share (`sections/search+categories.css` for one screen at `/search`
  and `/categories/{slug}`), linked from their pages only, with any other component the same
  areas list. One most pages render belongs in `App::components` instead, and so do tokens,
  which style every page; a component is in one or the other, not both.
- A patch brings the stylesheets of its handler's area, linked after its elements, as a
  navigation's answer does: a `data-patch` form on `/search` whose action is `/items/{slug}/save`
  gets its dialog styled by the `/items` area's stylesheet, which the runtime adds and waits for
  before it puts the patch in place; a second patch or a navigation that links it while it loads
  waits for the same load. List a patch's components where its handler is, as a page's are listed
  where the page is; a debug build checks them against the handler's path.
- A patch answered on a page that already links the stylesheet costs the link's bytes and no
  request (the runtime skips one it has). On a page that lacks it, the page fetches the area's
  stylesheet and the answer waits for it, even when the patch draws none of the area's
  components (one that only removes a row, or draws components from `App::components`): the
  link goes by the handler's path, not by what the patch draws. A handler whose patches mostly
  land outside its area is cheaper routed where its pages are.
- A stylesheet that fails to load leaves the patch in place unstyled, since the patch is a
  write's answer, and the next patch that links it tries again. One that neither loads nor fails
  holds the answer as it holds a navigation, with no timeout of Corten's own, and so holds every
  later answer that links it: each later patch from the area's handlers and each later navigation
  into the area wait on the same load until the page is loaded again.
- The stylesheet is loaded under the policy of the page the patch lands on, not the area's: an
  image or font it loads from a source only `Area::policy` adds is refused on a page outside the
  area. An area stylesheet that needs such a source does not carry over to those patches: add the
  source to the app's policy, or answer them from a handler on the page's side.
- Why the server links by the handler's path rather than being told the page's, and what it
  costs: [design Choice 47](../design.md#choice-patch-brings-area-styles).

Splitting has a price: two files compress worse than one, and entering the area costs a
request. Measured on the item page (release build, brotli at its file level): one
`components.css` is 3,223 bytes, 1,047 brotli. With the item page's four components in an
`/items` area, every page gets 593 bytes brotli and item pages 548 more, so the home page
saves 454 bytes and an item page downloads 94 more, in two requests. Leave everything in
`App::components` until an area's share is large enough to measure on the pages outside it.

The same holds for one page: the home page, or a page whose path is the prefix of other areas
(`/account` above `/account/cart`). An area at its path would link its stylesheet from every page
under it too, so its components go in `App::components`. Measured in the Chase Sets pilot
(release build, brotli): the account page's 3,737 bytes of CSS add 373 bytes to `components.css`,
downloaded once and then cached, where an `/account` area's file would be 837 bytes and one more
render-blocking request on every account screen. A page whose own CSS is tens of KB compressed
would change the numbers; that case gets its own measurement.

Without areas a request costs what it did before (callgrind, the item page in process: the
same instruction counts within run-to-run noise). Writing an area's links costs about 120
instructions a page; the item page's navigation as a whole measured 88,341-88,589 instructions
with an area against 87,249-87,331 without; most of the rest of the difference is in serde_json,
which the area code does not call, and the allocator. Area stylesheets add 126 bytes gzip to the runtime.
