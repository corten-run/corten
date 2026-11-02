# The UI kit

[Back to the guides](../../README.md#documentation)

`corten-ui` is headless: it gives the browser's missing widgets their behavior and leaves their
look to the app. The kit is that look, ready-made: theme tokens and styled components that
`corten ui` copies into the app as source, so the app owns them, edits them like its own code, and
the framework keeps no styled API to version. The components are ordinary `#[component(css)]`s
and the tokens an ordinary `tokens!` file, so nothing here is a second way to write a view.

```sh
corten ui init            # the theme tokens and src/ui.rs
corten ui add button card # src/ui/button.rs, button.css, card.rs, card.css
corten ui list            # every component the kit has
corten ui diff            # how the copies differ from this command's kit
```

Each command works out every change first and writes them all or none: each file is written
beside its place first (`.<name>.corten-ui`, refused if the app has a file by that name), and
only when all are written does each take its place; when one cannot, those placed before it are
put back, so running it again starts over (a file that cannot be put back is named). It adds
`corten-ui` from where `corten` comes only when `corten`'s line in `Cargo.toml` says so on
that line, or takes it from the workspace (then editing the workspace's `Cargo.toml` too when its
`corten` line says so); otherwise it says to add it by hand, naming the manifest.

| Command | Writes |
|---|---|
| `corten ui init` | `tokens/ui.tokens.json` (light), `tokens/ui-dark.tokens.json` and `tokens/ui.resolver.json` (the theme modifier, following the system when the page chose no theme), `src/ui.rs` (the tokens and the `COMPONENTS` list), the page's colors at the end of `static/style.css` (unless it sets `color-scheme` already, when it says what to add); `pub mod ui;` among the crate root's `mod` lines (`src/lib.rs`, else `src/main.rs`) and `.components(ui::COMPONENTS)` on the crate's one `App::new(..)` line, in whichever file builds the `App` (`crate::ui::COMPONENTS` from another module). An app with colors of its own (a `tokens!` theme with a color token) keeps them: `init` writes only `src/ui.rs`, without the kit's tokens, and names the tokens the components read that the theme lacks ([below](#an-apps-own-theme)); `corten ui init --kit-theme` writes the kit's theme beside it instead. A binary that builds its `App` beside a `src/lib.rs` is told to add the line by hand. It refuses to run twice, and says what to do by hand when it cannot place a line |
| `corten ui add <name>..`, `--all` | each component's files in `src/ui/`, `pub mod <name>;` and the component in `src/ui.rs`'s `COMPONENTS`, laid out as rustfmt does; for a component that styles a corten-ui widget, `corten-ui` in `Cargo.toml` from where `corten` comes (next to a local `corten`, the same Git repository and revision, else this command's release; for a workspace member whose `corten` is `corten.workspace = true` or `{ workspace = true }`, `corten-ui` from the workspace in the same form, and in the workspace's `[workspace.dependencies]` beside its `corten` when it has none) and `.components(corten_ui::COMPONENTS)` on the `App`, unless a file of the crate lists it already. A file that exists is refused, before anything is written, unless `--force` (which replaces it) or `--merge` (which takes the kit's changes since the copy and keeps the app's edits, marking a line both changed between `| `Table` | the look of the `<table>` inside it, scrolling sideways when it is wider than the page; `SortHeader` a column header whose link sorts by it, its arrow drawn from the header's `aria-sort`, so a script that sorts the rows in place sets `aria-sort` and the arrow follows | |

Each file starts with the version of the command that copied it and a hash of the file as written
| `Stats`, `Stat` | a look on the app's `<dl>` (`class={Stats {}}`), as many figures to a row as fit and two on a phone, a figure never broken across lines (its card is at least as wide as it, so a long one takes a row of its own, and a card alone on a row takes its width), and each figure a term and its descriptions (`<Stat label="Late" value={late} note="Past the ship-by date" tone={..} />`), so a screen reader reads the label with the value; `note=""` draws none. The `<dl>` is the app's, so figures that update are a patch of it, by its id | `StatTone`: `Neutral`, `Info`, `Success`, `Warning`, `Destructive` |
| `StatusDot` | a dot in a status's color, hidden from screen readers (`aria-hidden`), before the words that name the status, as in a badge (`<span class={Badge { .. }}><StatusDot tone={..} />"Open"</span>`): color alone does not tell the status | `StatusTone`: `Neutral`, `Info`, `Success`, `Warning`, `Destructive` |
| `Stack`, `Cluster` | looks: the app's element lays its children out in a column (`Stack`) or a row that wraps (`Cluster`), `gap` apart, the browser's default block margins on the children dropped (with no specificity, so an app's rule that names the element or a class, as `static/style.css`'s do, still sets its margin), so the kit's components carry no outer margin and a screen needs no rule to space them; a stack's children take its width (a button too, so put one in a `Cluster`). An app styled from its own token utilities spaces with its `gap` utility instead ([styles guide](styles.md#utility-first)), so its screens follow its scale | `Gap`: `Xs`, `Sm`, `Md`, `Lg`, `Xl` (.25 to 2rem, the values the kit's components space their own parts with: one scale for the kit, literals like theirs until a theme can set them, [#561 Kit control heights, spacing and type are literals, so a theme cannot give every control a 44 px touch target without editing each copied file](https://github.com/todd-skelton/corten/issues/561)) |
| `Breadcrumb` | a `<nav>` of typed links to the pages above (`Crumb { label, link: &url::Sets }`), then the page, `aria-current="page"` | |
| `Pagination` | a `<nav>` of links to a list's pages, each from `link(n)`, a typed route; the first, the last and two each side of the current page, Previous and Next disabled at the ends | |
| `Avatar` | a person's picture over their initials, which show while it loads and when there is none; `alt` names the person on the picture, or on the avatar (`role="img"`) when there is none | |
| `Dialog`, `DialogFooter` | the look of a `<dialog>` (`<dialog class={Dialog {}}>`), its `::backdrop` and its actions (`<div class={DialogFooter {}}>`); a button opens it with `command="show-modal" commandfor={..}` and closes it with `command="close"`, with no script | |
| `Sheet` | the same, sliding in from an edge of the window (`<dialog class={Sheet { side: Side::Right }}>`) | `Side`: `Top`, `Right`, `Bottom`, `Left` |
| `Popover` | the look of a `popover` element (`<div class={Popover {}} popover>`), opened by `popovertarget`, under its button where the browser has anchor positioning | |
| `Accordion` | the look of each `<details name>` (`<details class={Accordion {}} name="faq">`), which open one at a time, and find-in-page opens the one with the match | |
| `Tabs`, `Segmented`, `Stepper`, `Checkboxes`, `DropdownMenu`, `Combobox`, `Toasts` | the look of corten-ui's `TabGroup`, `ChoiceGroup`, `NumberField`, `CheckboxGroup`, `MenuButton`, `ComboBox` and `Toaster` inside them, by role and state (`[role="tab"][aria-selected="true"]`, `[role="radio"][aria-checked="true"]`, `[role="menu"]:popover-open`, `[role="option"][data-highlighted]`); `Toasts` places the toaster at the bottom right, and a `StepperUnit` before a `NumberField` sits beside its input. `corten ui add` makes the app depend on `corten-ui` and list `corten_ui::COMPONENTS`; every corten-ui widget the user sees drawn has one (the kit's test fails for one that has none) | |
| `SegmentedLinks` | a look: the segmented control on the app's `<nav>` of links, each a view the server renders (a filter, an order), the current one `aria-current="page"`: navigation, where a `ChoiceGroup` is a choice within the page. It needs nothing of corten-ui's, but it is in the `segmented` piece with `Segmented`, so `corten ui add segmented` adds the dependency for both | |

Variants are Rust enums matched to the stylesheet's classes, so a variant without a rule does
not compile, and every prop is written where the component or look is used, as for any component
([views](views.md)). The classes are static text chosen by a `match`: a page pays for joining two
or three of them, not for any lookup. No component has a script: each works without
JavaScript and under the CSP, with no `style=`, and the labels they show (Previous, Next, a
legend) are the app's, in its language.

Every component is in use in the [ui-gallery](../../examples/ui-gallery) example, built from the
kit's own files, and its browser test (`examples/ui-gallery/smoke.mjs`) runs them in Chromium and
WebKit, with and without JavaScript. The [seller-desk](../../examples/seller-desk) example is
an app styled with the kit: four components copied and unedited, and the theme's tokens
set to the app's palette and radius in light and dark.

## The app's own stylesheet

The template links `static/style.css` before `<Corten />`, which links the components'
stylesheet, so a kit rule wins a tie. Most looks weigh one class on a control, or one class and an
element (`.button`, `.checkbox > input`); a few weigh two (`.tabs [role="tab"]`), and an
attribute or a state adds to any (`.input[aria-invalid="true"]`, `.primary:hover`). So
`static/style.css`'s element defaults (`button { .. }`, `input { .. }`) give way to a look for
what the look sets, and still apply to what it does not (`text-transform` on a `Button`).

A default that weighs more than the look's rule wins over it on a kit control: an attribute or a
state beside the element, or an ancestor's class (`button[data-primary]` and
`input[type="number"]` over `.button` and `.input`, `.sidebar a` over a link drawn as a
`Button`). Which to write depends on what the rule is for:

1. A rule for the app's own elements (its sidebar's links) goes in the stylesheet of the
   component that draws them, on a class of its own (`class={NavLink}`), which the kit's
   controls do not have, so it reaches only them.
2. A rule meant only as a default for every element of a kind keeps its weight to the element by
   putting the rest in `:where(..)`, which weighs nothing. It then gives way to a look, and to
   the app's other defaults that weigh more than an element (`a[href]`, `a:hover`):

```css
button:where([data-primary]) { background: teal; }
input:where([type="number"]) { border-color: teal; }
```

Each gives way on what the look sets, as these do; a property the look does not set still applies
(`text-align` on a kit `Input`).

A table's cells and a `Stack`'s or `Cluster`'s children are the exception: their rules weigh
nothing on purpose, so the app's `td { .. }` or a margin it gives an element sets them. Putting
`static/style.css` in a cascade layer instead would reverse that, as every unlayered kit rule
would then win over it, those included.

## Size

The kit's CSS goes into `components.css` with the app's own, one cached file. Measured on a new
app with every component added (`corten ui add --all`) and nothing of its own but the starter's
counter: 35,239 bytes, 5,331 with brotli at level 11 and 6,050 with gzip at level 9, the theme's
tokens included. An app pays for the components it adds, and `corten ui add` adds one at a time.

A kit several apps share lives in a library crate of the workspace (`corten ui init` and `corten ui
add` run in it, and say what a library leaves to do by hand). There, `ui::COMPONENTS` lists every
component any app added, so an app that lists it serves the CSS of all of them. Each app lists the
tokens and the components it renders instead, `.components(&[ui::TOKENS, ui::button::Button,
ui::card::Card])`, and `corten_ui::COMPONENTS` too when one of them styles a corten-ui widget
(`Tabs`, `DropdownMenu`, `Combobox`, `Toasts`). Under `corten dev`, a page that renders a
component the app does not list fails and names it, so a list that falls behind shows on the first
visit; the tokens render nothing, so a missing `ui::TOKENS` shows instead as the app refusing to
start, naming a token a listed stylesheet reads that none declares.
