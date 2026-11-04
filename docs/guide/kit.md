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
| `corten ui add <name>..`, `--all` | each component's files in `src/ui/`, `pub mod <name>;` and the component in `src/ui.rs`'s `COMPONENTS`, laid out as rustfmt does (the module in name order, before the next one's attributes and comments, with the attributes every module there has when it has two or more, such as `#[rustfmt::skip]`, never a `#[path]`; a `src/ui.rs` whose next module has an attribute over several lines is not laid out, and the command names each `pub mod` and entry to add by hand); for a component that styles a corten-ui widget, `corten-ui` in `Cargo.toml` from where `corten` comes (next to a local `corten`, the same Git repository and revision, else this command's release; for a workspace member whose `corten` is `corten.workspace = true` or `{ workspace = true }`, `corten-ui` from the workspace in the same form, and in the workspace's `[workspace.dependencies]` beside its `corten` when it has none) and `.components(corten_ui::COMPONENTS)` on the `App`, unless a file of the crate lists it already. A file that exists is refused, before anything is written, unless `--force` (which replaces it) or `--merge` (which takes the kit's changes since the copy and keeps the app's edits, marking a line both changed between `<<<<<<< this copy` and `>>>>>>> the kit`, and then failing, as git does, until the app resolves them; it refuses a copy without the stamp or from a kit newer than the command, and needs rustfmt to lay out a Rust file as the app does); so is a component the app has by the same name with a stylesheet of its own (a `Field` in `src/layout.rs`), naming the file, since the two would style one class prefix and the program would not link |
| `corten ui diff [name]..` | nothing: for each copied file (of the components named, or all of `src/ui/`), whether the app edited it and whether the kit changed it since the copy, each as its own unified diff from the kit's text the copy was made from: the app's edits, then the kit's changes. A copy `corten fmt` laid out with the app's `rustfmt.toml` is not edited. A file the kit changed and the app did not is the kit's to replace (`corten ui add --force`); one both changed takes `corten ui add --merge` |

Each file starts with the version of the command that copied it and a hash of the file as written
(`// corten ui 0.1.0: button 71f206bc167066a1`). The hash names the kit's text the copy was made
from: the command carries that text for every hash a kit file has had, so `corten ui diff` and
`corten ui add --merge` have the copy's base whichever kit it came from. A file without the line, or
with a hash from a kit newer than the command, is compared with the kit whole. The files are
embedded in the `corten` binary, so adding one needs no network, and a component is the one the
command's version ships.

## Theme

The token names are shadcn/ui's, so a theme made for it maps one variable to one token:
`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`,
`--accent`, `--destructive` (each with a `-foreground` for the text on it), `--border`,
`--input`, `--ring` and `--radius`, and three tones for status that shadcn/ui leaves to the app,
`--info`, `--success` and `--warning` (each with a `-foreground`), which `Badge` and `Alert`
use. They are tokens at the top of the file, so each is a custom property with no Rust enum, and
none has a scale's name (`--color-accent`, `--radius-sm`), so the kit's theme and an app's can
be on one page without one replacing the other's values; only a token of the app's whose property has
one of these names would be the same property: `card` at the top of a file, a `card` group's
`$root`, or `muted.foreground` (`--muted-foreground`). Status tones have no `-soft` token: an
alert's tinted background is the tone mixed into `--card` in its stylesheet (`color-mix`), as
`destructive`'s is, so a theme sets one color per tone. To bring a theme over, write each of its
colors into `ui.tokens.json` (`:root`'s) and `ui-dark.tokens.json` (`.dark`'s) as the [styles
guide](styles.md#design-tokens) writes colors (sRGB with its hex, or `oklch`); the startup check
fails, naming the file and property, if a component reads one the theme lacks. The kit's own
look is warm grays with a weathering-steel orange as `--primary` and `--ring`. Its text meets
WCAG AA contrast in both themes, which a test of `corten ui` checks: each `-foreground` on its
color, each tone on a card (an alert's text) and the muted text on the page and on a card 4.5:1,
and `--input` (a field's border) 3:1 on the page.

Sizes are tokens too, so a theme changes them in one place and the copied files stay the kit's:
`--control-height` (a button, field, select, menu button or page link of the default size; 2.25rem),
`--control-height-sm` and `--control-height-lg` (2rem and 2.5rem: a small button and a tab, a
large button), `--control-padding` (the inline padding of a field, a small button and a tab;
.75rem), `--control-font-size` (the text of a field, select, combobox, textarea, tab, page link, menu
button and a default or large button, not a small one's, which stays .8125rem; .875rem),
`--control-width-sm`, `--control-width-md` and `--control-width-lg` (`ControlWidth`'s widths; 8, 16
and 24rem), `--card-padding` (a card's
padding and the gap between its parts; 1.5rem) and `--card-heading-font-size` (a card's heading; 1rem).
A 44 px touch target for buttons, fields, selects, menu buttons, page links and tabs is
`control-height`, `control-height-sm` and `control-height-lg` at 2.75rem (`"control-height": { "$type": "dimension",
"$value": { "value": 2.75, "unit": "rem" } }`). The tokens do not reach a menu item, a combobox
option, a checkbox, radio or switch label, a slider, a meter's bar or a Stats figure (whose padding
is its own, not `--card-padding`), which keep their own sizes, nor the labels and items whose text
stays .875rem; a compact density is a modifier context of the app's that
sets the tokens lower. A size is the same in both themes, so `ui-dark.tokens.json` has none.

An app set up by an older kit has a theme without the newer tokens: `corten ui add` names each
one a component it copies reads and the app declares nowhere (not in its theme or a stylesheet
under `static/`), and the app does not start until each is declared. A size comes with the kit's
line to add; a color the kit's theme lacks, with the kit's light and dark lines; one an app's own
theme lacks, by name, to give as a reference to one of the app's colors so it follows its dark
theme too.

A focused field's ring is a box shadow, which forced colors (Windows High Contrast) does not
paint, so each text control and menu item also has a transparent outline that forced colors
paints in the system's color: a field shows its focus in either, and so does a combobox's
highlighted option, which keeps the focus in the field.

### An app's own theme

An app whose `tokens!` theme has colors when it runs `corten ui init` keeps it, and the components
read their tokens from it: `init` reads the theme's files and writes `src/ui.rs` with no tokens of
the kit, and names the tokens the components read that the theme lacks. (A theme with no colors, a
spacing scale alone, gets the kit's theme beside it, as an app with none does. With several
`tokens!` themes, the first with colors that `init` finds is the one it reads.) Declare each at the top of the app's token file, most as a reference to a token
the app has, so it follows the app's other themes (dark, a density) with nothing more:

```json
{
  "color": { "$type": "color", "surface": { "$value": { "colorSpace": "srgb", "components": [1, 1, 1], "hex": "#ffffff" } } },
  "card": { "$type": "color", "$value": "{color.surface}" }
}
```

The app does not start while a component reads a token no stylesheet declares, and the error names
the stylesheet and the token, so a missing one is found at the first run.

When a token the components read has the name of one of the theme's groups (a `radius` group for
`--radius-sm`), `init` says so: the group's `$root` is the group's own property, so
`"radius": { "$root": { "$value": "{radius.md}" }, "sm": .. }` declares `--radius` and keeps
`--radius-sm`. The same goes for a theme that writes the kit's sizes as a group (`"card": {
"padding": .. }`) beside the kit's set, whose `card` is a color: a token and a group of one name
do not compile, so the color goes in the group as its `$root` (with its own `$type`, since a
group's `$type` would make every size in it a color). A theme `init` cannot read (a file its resolver names
is missing) is reported, and nothing is written; `--kit-theme` takes the kit's theme instead,
beside the app's.

A utility over the kit's tokens, a text color for each tone (`fg_success()`), lists them as its
values, which gives it a Rust enum as a group does:

```json
"$extensions": {
  "run.corten": {
    "utilities": {
      "fg": { "property": "color", "values": { "muted": "var(--muted-foreground)", "success": "var(--success)", "warning": "var(--warning)" } }
    }
  }
}
```

on the token file's root, as the [styles guide](styles.md#design-tokens) places utilities.

## Components

A component that only styles an element is a look ([styles guide](styles.md#looks)): its classes go
on the element the app writes, `<button class={Button { .. }}>`, so `html!` checks the element's
attributes as it checks any (`type`, `disabled`, `href={url::Home}`, `name={f.email}`,
`on:click`, `commandfor`), the element can be the one the page needs (a card as a `<section>`,
an `<li>` or a patch target, a badge with a `title`), and the page has no element of the kit's
around it, so a script's `parentElement` and a `:first-child` rule see the page as written. A
component that draws structure (a field's label and hint, a checkbox's label) or semantics (an
alert's role) renders its elements. A corten-ui widget whose button is its own takes the look as
its `class` (`<CopyButton .. class={Button { .. }} />`).

```rust,ignore
use crate::ui::{button::*, card::*, field::*, input::*};

<section class={Card {}}>
    <header class={CardHeader {}}><h2>"Sign in"</h2><p>"Use the email you registered with."</p></header>
    <div class={CardContent {}}>
        <Field id={e.id(f.email)} label="Email" hint="" error={e.message(f.email)}>
            <input class={Input {}} type="email" required {..e.control(f.email)}>
        </Field>
    </div>
    <footer class={CardFooter {}}>
        <button class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}>"Sign in"</button>
        <a class={Button { variant: ButtonVariant::Link, size: ButtonSize::Md }} href={url::Reset}>"Forgot it?"</a>
    </footer>
</section>
```

A look's name is a plain noun (`Progress`, `Table`, `Stats`), which an app's domain may have too
(a job's `struct Progress`). The two meet only in a file that uses both. Imported by name, the
compiler refuses the second (E0252); with the kit's glob import (`progress::*`), the app's name
wins without a word and the error is on the app's type (`struct batches::Progress has no field
named size`, E0560; E0659 first if both are globs). That file imports the kit's under another name, or writes its module's path,
and the classes stay the kit's (`progress__progress`), since they follow the component, not the
name:

```rust,ignore
use crate::batches::Progress;
use crate::ui::progress::{Progress as KitProgress, ProgressSize};

<progress class={KitProgress { size: ProgressSize::Md }} max={steps} value={done}></progress>
// or, with no import: class={crate::ui::progress::Progress { size: ProgressSize::Md }}
```

`corten ui add` names each type the app declares with the name of a component or prop type it
adds, as a note (a name imported from another crate is not seen); nothing is refused, since the
two do not meet until a file uses both.

Each component's keyframes start with its own name (`dialog-in`), as an `@page` name does, since
they are the whole page's.

| Component | Renders | Variants |
|---|---|---|
| `Button` | a look: the classes of the app's `<button>` or `<a>` (`class={Button { variant, size }}`) | `ButtonVariant`: `Primary`, `Secondary`, `Outline`, `Ghost`, `Destructive`, `Link`; `ButtonSize`: `Sm`, `Md`, `Lg`, `Icon` |
| `Icon` | an `<svg>` of one of Lucide's icons (ISC; the set's license is in the copied file) at the text's size (1em) and in its color, its lines drawn by `icon.css`, so it follows the theme, a hover and a disabled button: `<Icon glyph={icon::TRASH} />`. Each glyph is a constant, so a name the set lacks does not compile, and the page fetches nothing. The app adds one in a module of its own, so the copied `icon.rs` stays as the kit wrote it and takes the kit's updates without `--merge`: it copies the elements inside a Lucide `<svg>` into a constant, `pub const PACKAGE: Glyph = Glyph::new(r#"<path d=".."/>"#);`. A glyph whose fill says something (a rated star, a saved heart) is made with `Glyph::filled`, which fills it in the text's color too wherever it is drawn; whether a glyph fills is part of the glyph, not of the place that draws it, so the empty star is never drawn filled. A `Glyph` takes only a `&'static str`, as it is placed in the page as written, so text a request brought does not compile (only text the app keeps for the life of the process, leaked or in a static, would, as it would through `raw` itself). `Glyph::new(svg)` makes a glyph in lines, `Glyph::filled(svg)` a filled one. It is `aria-hidden`: the control carries the name (its text, an `aria-label` on the app's `<button>` or `<a>`, `VisuallyHidden` text where the kit draws the element), and an icon that says something on its own has text beside it. In a `ButtonSize::Icon` button it is centered; beside text, the button's gap spaces it and it sits on the text's middle. The kit's own marks (a menu's and an accordion's chevron, `Pagination`'s arrows, `Steps`' check and cross) stay drawn by their stylesheets, so a piece needs no other piece and a page writes no markup for them | |
| `Badge` | a look: the classes of the app's label element (`<span class={Badge { tone, emphasis }} title={..}>`); each tone and emphasis meets WCAG AA in both themes, which the kit's test checks | `BadgeTone`: `Neutral`, `Primary`, `Info`, `Success`, `Warning`, `Destructive`; `BadgeEmphasis`: `Solid`, `Soft`, `Outline` |
| `Card`, `CardHeader`, `CardAction`, `CardContent`, `CardFooter`, `CardPanel`, `CardCompact` | looks: a surface and its parts, on the app's elements (`<section class={Card {}}>`, `<header class={CardHeader {}}>`); the heading and description in the header are the app's (`<h2>` or `<h3>`, as the page's outline needs, then `<p>`), and controls after the heading in a `CardAction` (`<div class={CardAction {}}>`) sit at the end of its row, wrapping under it when there is no room. A card around one block of content with no header or footer is one element, `<section class={CardPanel {}}>`: the surface and its padding on every side, with no layout, so the element's own class (a row of filters) or a `Stack` lays it out (a grid of the app's there gives its columns `minmax(0, 1fr)`, as `CardContent`'s one column is, so a wide table in a wrapper scrolls rather than widening the card); `CardCompact` beside either (`class={(Card {}, CardCompact {})}`) is a denser card on a page that has roomy ones too (a theme sets every card's with `--card-padding`). Since a card's content column is no wider than the card, in a row that does not wrap a card can be narrower than its content, so let such a row wrap (`Cluster`) or give the card a `min-width` | |
| `Alert` | a box whose role follows its variant, so a screen reader interrupts only for what needs the user now: `role="alert"` for `Warning` and `Destructive` (read at once when a patch brings it in), `role="status"` for `Success` (read politely; one brought in with its text is not read by every screen reader, so the result of an action is a toast, corten-ui's `Toaster`), none for `Neutral` and `Info` (read in the page's order) | `AlertVariant`: `Neutral`, `Info`, `Success`, `Warning`, `Destructive` |
| `Field` | a `<label for={id}>` naming the control: for a form field `e.id(f.email)` (`e` from `errors.within(FormId)`, or `Within::none(FormId)` for a form whose fields never have a message), which `{..e.control(f.email)}` writes on the control with its `name` and ARIA; otherwise a `#[derive(Id)]` type (a corten-ui widget takes `QtyId::NAME`). Then the control (a kit control or a corten-ui widget, its parts in one row), the hint (its id `HintId(&id)`, which `e.control(..).hint()` names in the control's description; give it always, as an empty hint describes nothing, or a corten-ui widget's `attrs` names it; a hint with text its control does not name is an error in a debug build), then the server's message for the field (`error={e.message(f.email)}`), drawn destructive; `""` draws none | |
| `Input`, `Textarea`, `Select`, `Slider` | looks: the classes of the app's `<input>`, `<textarea>`, `<select>` or `<input type="range">` (`class={Input {}}`), with the destructive border once the user has edited an invalid value (`:user-invalid`) or the server marked it (`aria-invalid`, which `e.aria(field)` writes); `Select` styles the open list where the browser has `appearance: base-select`. In a `Field` each control fills the field's row (a corten-ui `ComboBox` too), and a field is never wider than its column: in a column narrower than its control, an input, select, textarea or `ComboBox` (its select too, before its script runs) shrinks with it, while a `Stepper` keeps its width and full-size buttons (in a box sized to its smallest content, a table squeezed below its content, give the column a width); outside one an `Input` or `Select` has the browser's natural width (a select its widest option's), so a search box sits beside its button, while a `Textarea` fills its container | |
| `InputGroup`, `Adornment` | a text `<input>` with something inside its border: `InputGroup` is the look of a `<span>` around the input, which draws the box, its ring while the input has focus and its invalid and disabled states, and the input inside keeps its `Input` look without its own border; `<Adornment>"$"</Adornment>` is a sign or unit before or after the input, hidden from a screen reader, so the label or hint says it ("Lowest offer (USD)"); a button inside is a `Button` after the input (`Sm`, or `Icon` with hidden text), kept within the border. A unit beside corten-ui's `NumberField` is the `Stepper`'s `StepperUnit`, since a group holds a plain `<input>`; a click on an adornment does not focus the input, as on any element beside one. In a `Field` the input keeps the field's id and the group fills the row; `ControlWidth` goes on the group. A password's show and hide button is the app's: its script sets the input's `type` and the button's `aria-pressed` | |
| `ControlWidth` | a look beside an input's, select's or textarea's (`class={(Input {}, ControlWidth { width: Width::Md })}`): the theme's `--control-width-*`, never wider than its container, and a field's row grows the control only up to it (a postal code); `Full` fills the container. A widget's own parts (a `ComboBox`'s input, which fills its container, or in a row takes 12rem) are out of its reach | `Width`: `Sm`, `Md`, `Lg`, `Full` |
| `Checkbox`, `Switch` | a `<label>` with the `<input type="checkbox">` inside and its text after; a switch is `role="switch"` on the checkbox, so it posts as one, and only a checkbox with the role is drawn as a switch (one without it is a checkbox to a screen reader, so it is left to the browser's own checkbox look); `Checkbox` leaves a `role="switch"` input to the browser's own look, as it belongs in `Switch` | |
| `RadioGroup`, `Radio` | a `<fieldset>` with its `<legend>`, and each `<input type="radio">` with its text | |
| `Separator` | an `<hr>` | `Orientation`: `Horizontal`, `Vertical` |
| `Skeleton` | a placeholder's shape, hidden from screen readers, still under `prefers-reduced-motion` | `SkeletonShape`: `Line`, `Block`, `Circle` |
| `Table` | the look of the `<table>` inside it; `layout={TableLayout::Scroll}` scrolls sideways when it is wider than the page, positioned so what a cell places absolutely (an icon button's `VisuallyHidden` text) scrolls with it, also inside a wrapper (corten-ui's `ShownFor`, an app's `<div>`) in a card's content or a dialog, whose one column is no wider than they are; `SortHeader` a column header whose link sorts by it, its arrow drawn from the header's `aria-sort`, so a script that sorts the rows in place sets `aria-sort` and the arrow follows; `on:sort` is the link's click handler, `None::<Handler>` where the server sorts, or the page's typed call naming the column where a script sorts in place (`on:sort={js::sortBy(event, target, rows, By::Total)}`); `layout={TableLayout::Stack}`, for a table read a row at a time, makes each row a block of its cells on a phone (40rem, as the kit's other parts; elsewhere it scrolls as `Scroll` does), each cell led by the `CellLabel` in it (`<td><CellLabel>"Buyer"</CellLabel>{buyer}</td>`), with the rest of the cell beside it, where text wraps and each element starts a line as wide as it is on a wide screen, so a `Button` or a pill stays its size (wrap text and an element in one `<span>` to keep them on one); a row header (`<th scope="row">`) is laid out the same, and so is a number's cell (`TableNumeric`), its label and number at the start of their columns like every other cell's, and a cell without a label is a block of its content. The column headers are drawn as a row when they hold a link or button (a `SortHeader`, so the table sorts by touch) and hidden otherwise. It stays a table to a screen reader, which names each cell from its header and skips the label (checked in Chromium's accessibility tree; Firefox and WebKit are not checked by the smoke). Each column's name is written twice, in its header and its cells' labels | |
| `Meter` | a look: the classes of the app's `<meter>` (`class={Meter {}}`), named by a label as any control, its value as text the app formats in `aria-valuetext` (an amount, not "12375"); a plain measure in the primary color, and with `low` or `high` the state the browser works out, in the success, warning or destructive color, each 3:1 against the track in both themes (the kit's test); under forced colors, the fill in the system's highlight color on an outlined track, every state alike (no system color means good or bad), so an app whose state matters says it in words beside the meter, as color alone does not tell a status; progress through a task is a `<progress>` with `Progress` | |
| `Progress` | a look: the classes of the app's `<progress>` (`class={Progress { size: ProgressSize::Md }}`), named by a label as any control; the track in the border color and the fill in the primary color, as the meter's, so it follows the theme in both schemes. With no `value` (how far along is not known yet) a band of the fill moves across the track, and stripes fill it under reduced motion. Under forced colors the track is outlined and the fill drawn in the system's highlight color. The text inside is what a browser without the element shows | `ProgressSize`: `Md`, `Sm` (half the height, for a bar nested under another) |
| `Stats`, `Stat` | a look on the app's `<dl>` (`class={Stats { surface: StatsSurface::Cards }}`), as many figures to a row as fit and two on a phone, a figure never broken across lines (its card is at least as wide as it, so a long one takes a row of its own, and a card alone on a row takes its width), and each figure a term and its descriptions (`<Stat label="Late" value={late} note="Past the ship-by date" tone={..} />`), so a screen reader reads the label with the value; `note=""` draws none. The `<dl>` is the app's, so figures that update are a patch of it, by its id. `StatsSurface::Cards` draws each figure as a card of its own; a summary inside a card takes `StatsSurface::Plain`, its figures on the card with no surface, lined up with its text | `StatTone`: `Neutral`, `Info`, `Success`, `Warning`, `Destructive`; `StatsSurface`: `Cards`, `Plain` |
| `StatusDot` | a dot in a status's color, hidden from screen readers (`aria-hidden`), before the words that name the status, as in a badge (`<span class={Badge { .. }}><StatusDot tone={..} />"Open"</span>`): color alone does not tell the status | `StatusTone`: `Neutral`, `Info`, `Success`, `Warning`, `Destructive` |
| `VisuallyHidden` | a look: text a screen reader reads and the page does not draw (`<span class={VisuallyHidden {}}>"More actions for "{buyer}</span>`), for the name of an icon control whose element the kit draws (a `MenuButton`'s trigger; a `<button>` of the app's, as a `ButtonSize::Icon` one, takes `aria-label`), a legend the layout does not show, a busy region's words; text no one should read is `hidden`, and a mark that only decorates is `aria-hidden="true"`. It is placed against the nearest positioned element, so a box of the app's that scrolls sideways around it is `position: relative`, or the text can widen the page (the kit's `Table` and `NavBar` links are) | |
| `Stack`, `Cluster` | looks: the app's element lays its children out in a column (`Stack`) or a row that wraps (`Cluster`), `gap` apart, the browser's default block margins on the children dropped (with no specificity, so an app's rule that names the element or a class, as `static/style.css`'s do, still sets its margin), so the kit's components carry no outer margin and a screen needs no rule to space them; a stack's children take its width (a button too, so put one in a `Cluster`). An app styled from its own token utilities spaces with its `gap` utility instead ([styles guide](styles.md#utility-first)), so its screens follow its scale | `Gap`: `Xs`, `Sm`, `Md`, `Lg`, `Xl` (.25 to 2rem, the values the kit's components space their own parts with: one scale for the kit, literals like theirs until a theme can set them, [#561 Kit control heights, spacing and type are literals, so a theme cannot give every control a 44 px touch target without editing each copied file](https://github.com/todd-skelton/corten/issues/561)) |
| `NavBar`, `NavBrand`, `NavSections`, `NavActions` | looks: the bar across the top of every page on the app's `<header>` (`class={NavBar {}}`), the app's name (`NavBrand`), a `<nav>` of section links (`NavSections`) written with `req.nav`, `req.nav_section` or `req.nav_of`, whose `aria-current="page"` marks the current one and stays right after a client navigation, and actions at the end (`NavActions`). On a phone (40rem and narrower) the links take a row of their own under the name and actions, the bar's width; the keyboard still reaches the links before the actions drawn above them. A row wider than the bar scrolls sideways, with no script: a shadow at the edge with more past it, and a thin scrollbar for a mouse and under forced colors (which drop the shadows); a touch screen shows only the shadows. The bar is the theme's card colors, and its name, links, current link's underline, focus rings and shadows are all drawn from that pair: a class of the app's on the `<header>` recolors it by setting `--card` and `--card-foreground` (a pair at least 4.5:1), not `background`, which the shadows' covers would not follow. A `Ghost` or `Outline` `Button` among the actions reads the page's `--foreground` and `--accent`, so on a recolored bar it takes a class of the app's that sets those (and `--accent-foreground` and `--ring`) from the bar's pair, with `--accent` and `--accent-foreground` at least 4.5:1, and an `Outline` one `--background` and `--input` too, its fill and border. Put the pages used most first, since the current link is not scrolled into view. It does not fold its links into a menu, which would write each twice; an app that wants one puts them in a `Popover` | |
| `Steps`, `Step` | a workflow's steps or what happened to something: a `<nav>` named by `label` around their `<ol>` (a `Timeline`, which goes nowhere, is the `<ol>` named by `label`; put a heading above it too, as not every screen reader reads a list's name) (`<Steps label="Listing" layout={StepsLayout::Row} steps={&[Step { label, description, link, state }, ..]} />`), each a link to its step's page or its name as text with `link: None`, counted, with an optional line under its name (`description`, outside the link). `StepsLayout::Row` is one row that wraps, for steps the user moves through, where under 40rem a description is read and not shown; `StepsLayout::Timeline` is one step per row down the page with a line between the marks, for a history (a payout, an order), where each description (a time, a reference, why it failed) is shown at every width. Its state is written, not worked out from its place: `Done` draws a check mark in place of the number, `Current` writes `aria-current="step"`, `Blocked` draws `!` in the warning color for a step that cannot start until something before it is fixed (say what on the page, since in a row a phone does not show a description), `Failed` draws a cross in the destructive color for a step that ran and went wrong, and `Done`, `Todo`, `Blocked` and `Failed` carry the words a screen reader hears after the name and the page does not show (`StepState::Done("(done)")`), the only way it learns the state, so give every one. A skipped step is a `Todo`, and a finished workflow is every step `Done` | `StepState`: `Done(words)`, `Current`, `Todo(words)`, `Blocked(words)`, `Failed(words)`; `StepsLayout`: `Row`, `Timeline` |
| `Breadcrumb` | a `<nav>` of typed links to the pages above (`Crumb { label, link: &url::Sets }`), then the page, `aria-current="page"` | |
| `Pagination` | a `<nav>` of links to a list's pages, each from `link(n)`, a typed route; the first, the last and two each side of the current page, Previous and Next disabled at the ends | |
| `Avatar` | a person's picture over their initials, which show while it loads and when there is none; `alt` names the person on the picture, or on the avatar (`role="img"`) when there is none | |
| `Dialog`, `DialogHeader`, `DialogFooter` | the look of a `<dialog>` (`<dialog class={Dialog { size: DialogSize::Md }}>`), its `::backdrop`, its header (`<div class={DialogHeader {}}>`, its first element, a `<div>` since a `<header>` there is the page's banner landmark: the heading, then the controls the app writes at its end, a `command="close"` button or a link for a dialog the address opens) and its actions (`<div class={DialogFooter {}}>`); `size` is the most of a wide window it takes, and on a narrow one it is the window's width less 2rem; one taller than the window scrolls with its header held at the top; a button opens it with `command="show-modal" commandfor={..}` and closes it with `command="close"`, with no script | `DialogSize`: `Sm`, `Md`, `Lg`, `Xl` (24, 32, 48, 64rem) |
| `Sheet`, `SheetHeader` | the same, sliding in from an edge of the window (`<dialog class={Sheet { side: Side::Right(SheetWidth::Md) }}>`); a side sheet's width goes with its side, as a sheet across the top or bottom is the window's width; one longer than the window scrolls with its `SheetHeader` held at the top | `Side`: `Top`, `Right(SheetWidth)`, `Bottom`, `Left(SheetWidth)`; `SheetWidth`: `Sm`, `Md`, `Lg`, `Xl` (20, 24, 32, 40rem, at most 85% of the window) |
| `Popover` | the look of a `popover` element (`<div class={Popover {}} popover>`), opened by `popovertarget`, under its button where the browser has anchor positioning | |
| `Tip` | a look for corten-ui's `Tooltip` (`<Tooltip id={SettingsTipId} class={Tip {}}>"Settings"</Tooltip>`): a small box in the page's colors reversed, above the control that showed it, below it when there is no room, with a border under forced colors. The control writes `interestfor={SettingsTipId}` and `aria-labelledby` (an icon-only control, whose name it is) or `aria-describedby` (a hint beside its name). A tooltip holds a name or a hint, and without a script it shows only in Chromium (a screen reader reads it everywhere), so an icon-only control's icon is one whose meaning shows (a close mark, an arrow out), and what a user must read to act (a field's error, a price's reason) is on the page, or in a `Popover` a click opens, which a phone opens too | |
| `Accordion` | the look of each `<details name>` (`<details class={Accordion {}} name="faq">`), which open one at a time, and find-in-page opens the one with the match | |
| `Tabs`, `Segmented`, `Stepper`, `Checkboxes`, `DropdownMenu`, `Combobox`, `Toasts` | the look of corten-ui's `TabGroup`, `ChoiceGroup`, `NumberField`, `CheckboxGroup`, `MenuButton`, `ComboBox` and `Toaster` inside them, by role and state (`[role="tab"][aria-selected="true"]`, `[role="radio"][aria-checked="true"]`, `[role="menu"]:popover-open`, `[role="option"][data-highlighted]`); `Toasts` places the toaster at the bottom right, and a `StepperUnit` before a `NumberField` sits beside its input. `DropdownMenu { trigger }` draws its trigger as a name in an outline button with a chevron (`MenuTrigger::Text`) or as a square ghost icon button with none (`MenuTrigger::Icon`, a row's ⋮ menu: the icon the kit's `Icon` (`icon::ELLIPSIS_VERTICAL`), `aria-hidden`, its name `VisuallyHidden` text, as corten-ui's `MenuButton` takes no `aria-label`). `corten ui add` makes the app depend on `corten-ui` and list `corten_ui::COMPONENTS`; every corten-ui widget the user sees drawn has one (the kit's test fails for one that has none) | `MenuTrigger`: `Text`, `Icon` |
| `SegmentedLinks` | a look: the segmented control on the app's `<nav>` of links, each a view the server renders (a filter, an order), the current one `aria-current="page"`: navigation, where a `ChoiceGroup` is a choice within the page. It needs nothing of corten-ui's, but it is in the `segmented` piece with `Segmented`, so `corten ui add segmented` adds the dependency for both | |
| `SegmentedRadios`, `SegmentedRadio` | the segmented control on native radio buttons: a `<fieldset>` with its legend (`<SegmentedRadios legend={Legend::Shown("Label size")}>`), each choice the app's `<input type="radio">` in a `<SegmentedRadio label="Letter">`. A form sends the choice and CSS can read it (`:has(:checked)`), which neither does for a `ChoiceGroup`'s options; it needs no script. The inputs are hidden under their labels, still focused and moved by the arrow keys; the checked one's label is raised, the focused one ringed, a disabled fieldset or input drawn disabled, and under forced colors the checked one outlined. `Legend::Hidden` keeps the legend for a screen reader only, for a choice its place on the page explains. It is in the `segmented` piece, so `corten ui add segmented` also makes the app depend on corten-ui, which these radios do not use | `Legend`: `Shown(text)`, `Hidden(text)` |

Variants are Rust enums matched to the stylesheet's classes, so a variant without a rule does
not compile, and every prop is written where the component or look is used, as for any component
([views](views.md)). The classes are static text chosen by a `match`: a page pays for joining two
or three of them, not for any lookup. No component has a script: each works without
JavaScript and under the CSP, with no `style=`, and the labels they show (Previous, Next, a
legend) are the app's, in its language.

Every component is in use in the [ui-gallery](../../examples/ui-gallery) example, built from the
kit's own files, and its browser test (`examples/ui-gallery/smoke.mjs`) runs them in Chromium and
WebKit, with and without JavaScript. The [seller-desk](../../examples/seller-desk) example is
an app styled with the kit: five components copied and unedited, and the theme's tokens
set to the app's palette and radius in light and dark.

## The app's own stylesheet

The template links `static/style.css` before `<Corten />`, which links the components'
stylesheet, so a kit rule wins a tie. Most looks weigh one class on a control, or one class and an
element (`.button`, `.radio > input`); a few weigh two (`.tabs [role="tab"]`), and an
attribute or a state adds to any (`.input[aria-invalid="true"]`, `.primary:hover`,
`.checkbox > input:not([role="switch"])`). So
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
