# deck-builder

A deck builder: a player's collection of 240 cards on one side, the deck they build from it on the
other. It is the example of a rich client screen: everything a change does on the page happens in
the browser with no round trip, and the deck rules stay on the server. Read it when a screen keeps
state in the browser (selection, drag and drop, undo, a chart drawn from what is on the page) and
saves it as the user works.

| In the browser | How |
|---|---|
| Filter, sort and select the collection | a handler per column; `CollectionRow` reads selection from the live checkbox, which also styles the row |
| Add a card, add the selected ones, type a count | the builder reads the live counts together, applies the change, and draws the deck by card ID before saving |
| Drag a card onto the deck, or a line back out | HTML drag and drop on a grip; the same change |
| Reorder deck lines | drag a deck grip onto another line; the presentation order stays in this page while the server continues to own counts |
| The same moves by keyboard | Space picks up, Left/Right moves between the collection and deck, Up/Down reorders a deck line, Space drops, Escape puts back, each announced |
| Undo and redo | the buttons, Ctrl+Z and Ctrl+Shift+Z; each step is a change, saved like any other |
| The count, the cost curve, the count by kind, the deck list | drawn again from the deck after each change (the curve is SVG bars, no `style`) |
| Autosave | the deck's form, sent one save at a time with the version it was built on (the deck feed's generation and number); the answer is the save note, whose event says what became of it. A save whose answer was lost is sent again with its submit key, and the server answers with what it did |
| A refused change | the page goes back to the saved deck, and its history to what it was then, with the rule's words |
| Another tab's edit | the page follows the saved deck's feed: with nothing unsaved it takes the edit; with a change of its own it offers to keep both or take the other tab's deck |

Without JavaScript the same deck is built with forms: Add and Add selected post the deck with the
cards added, Save posts the counts as typed, and the filter and the column headers are a `GET`
form and links the server answers.

Filter and Save stay visible with scripting enabled. Until the builder starts, the browser
submits the forms natively: successful writes redirect to the saved deck, and a refusal draws
the page with its reason. If a first Save already committed, resending its key with different
or malformed counts shows a conflict and asks the player to re-enter that edit on the saved deck.
Malformed counts that reach the server under a fresh key are still a form error. In the browser,
a partly typed number is invalid even when its form value is empty; native Save blocks it,
whereas deliberately clearing a count still removes the line. Autosave also waits for a valid
form. Editing another count leaves the incomplete number alone; once corrected, both edits can
go in one save. Each send takes the counts actually in the form, even if a previous save was
still on its way when the player corrected a focused field. Add and Add selected also leave an
incomplete number and any selection alone.
An Add can save without touching the count fields. If autosave starts on that same form and reuses
the native save's key, even with a count too large to parse, the server draws the saved deck with a fresh key
instead of offering to merge the edit again. If a count was already edited when the module
started, that document keeps its fields, focus, and native Save. Selections made before startup
stay checked and count toward Add selected; the checkbox for selecting every visible card is
disabled until the module can apply it. With the module running, Filter keeps the page, and a
subsequent native Save returns to that filter. A refusal page displays the reason without
notifying autosave. Only a patch answers a save that the queue sent. It uses the same
`save_note.answered` binding as before. New pages load the note's script with the builder, not
on the first autosave or retry. The smoke test blocks further script fetches and checks recovery
of a lost reply without the live feed; it runs one build, not a deployment across two versions.

## Run it

From this directory:

```sh
corten dev     # http://localhost:3000
```

`corten` is the framework's command (`cargo install corten-cli`).

Or in Docker, from the repository root:

```sh
docker build -f examples/deck-builder/Dockerfile -t corten-deck-builder .
docker run --rm -p 3000:8080 corten-deck-builder
```

`DECK_CARDS` sets how many cards the collection has (240). The deck is kept in memory: a restart
starts again from the starter deck, in a new generation, so a page left open across it is told the
deck changed.

## Where things are

The routes and what each does are in the table at the top of [`src/app.rs`](src/app.rs).

| Piece | File |
|---|---|
| The routes, the save (version, submit key, rules), the deck's feed | [`src/app.rs`](src/app.rs) |
| The collection and the deck rules, which only the server applies | [`src/cards.rs`](src/cards.rs) |
| The layout, and the screen in the order the address asks for | [`src/views.rs`](src/views.rs) |
| The builder: its markup, its script (every change, autosave, moves, the collection) and its styles | [`src/views/deck_builder.rs`](src/views/deck_builder.rs), [`src/views/deck_builder.js`](src/views/deck_builder.js), [`src/views/deck_builder.css`](src/views/deck_builder.css) |
| A collection row and a deck line | [`src/views/collection_row.rs`](src/views/collection_row.rs), [`src/views/deck_line.rs`](src/views/deck_line.rs) |
| The save note, whose patch tells the builder what became of a save | [`src/views/save_note.rs`](src/views/save_note.rs), [`src/views/save_note.js`](src/views/save_note.js) |

Its browser test, which also times the screen: [`smoke.mjs`](smoke.mjs).

### Byte comparison

Measured on 2026-11-28 with Chromium 159.0.8154.6 over loopback HTTP, with a fresh Windows app
process (240 cards) and browser context for every sample. Each of the three readings per build
and save mode was identical. The merge base is `1b9c1b0dd8348228f705b240cd44b74027469292`; the
pre-repair checkout is `582018fce979cfdd097a3df0b2b027bcb3b691ba`. The acknowledgement repair
was measured at `78da3d55ee708c9cbfddcb90ed698e4a1cd972a4`, then remeasured alongside the
count-validation follow-up.

| Bytes | Merge base | Before acknowledgement repair | Acknowledgement repair | Count validation |
|---|---:|---:|---:|---:|
| Startup HTML body | 164,146 | 161,100 | 161,100 | 161,487 |
| `deck_builder.js` body | 21,805 | 22,690 | 22,857 | 23,192 |
| All startup script bodies (11 / 10 / 10 / 10) | 90,972 | 91,288 | 91,455 | 91,790 |
| Startup exchange: HTML and scripts | 271,217 | 267,175 | 267,342 | 268,064 |
| First autosave exchange: POST and any acknowledgement script | 1,707 | 3,451 | 1,727 | 1,727 |
| First native Save exchange: POST, 303, redirected GET and its response | 169,406 | 166,360 | 166,360 | 166,747 |

Both saves changed Gravel Sprite's count from 3 to 2. The scripted save left the edited field to
trigger autosave; before the repair its `200` patch led to a separate 1,744-byte script exchange.
After the repair that request is gone, while the patch body grew from 93 to 112 bytes. The native
Save ran with JavaScript off, starting at `/?q=oracle` and returning to that filter with the saved
count. Exchange totals include HTTP request and response headers and bodies as reported by
Playwright, not transport framing. Startup excludes styles, images and feed traffic; save totals
exclude the page open before the save and its subresources. The validation follow-up adds
387 bytes to the HTML and 335 bytes to the startup script; the first autosave exchange is
unchanged, and the added bytes in the native Save exchange are in the redirected page.

For the multi-field edit repair, a fresh Chromium context loaded the unfiltered deck from a
fresh app process once per build. Against `152b7c9b7`, startup HTML went from 161,562 to
161,546 bytes; the 11 startup script bodies went from 92,128 to 92,857 bytes, all of the
increase in `deck_builder.js` (23,127 to 23,856). These are decoded body sizes, not timings.

### Native save receipt cost

Measured on 2026-11-28 with optimized Rust 1.99.1 on Windows (Core i9-10885H). The comparison
uses the merge base above (no snapshot) and the receipt logic at `ad5cf36d7`, unchanged by
the deployment fix. Both run `Builder::save` with native drafts, prebuilt decks and submit keys,
against the same 240-card collection. Each batch makes 4,096 distinct saves with alternating
legal decks, then replays each key and its original deck. The in-process timings include the
mutex, feed write and receipt work but not form decoding, HTTP, or page rendering.

| Measured, before to after | Five distinct cards | Forty distinct cards |
|---|---:|---:|
| Allocations or reallocations, all new saves | 61,473 to 65,569 | 82,115 to 86,211 |
| Allocations or reallocations, all exact replays | 0 to 0 | 0 to 0 |
| Requested receipt-store heap bytes retained (4,096 keys) | 696,336 to 1,155,088 | 696,336 to 3,448,848 |
| Median new save, ns per operation | 7,571 to 7,502 | 19,857 to 26,203 |
| Median exact replay, ns per operation | 1,044 to 1,438 | 5,008 to 7,399 |

The allocator counts are from a separate pass from the timing. Dropping the whole receipt store
measures its requested heap bytes, not process RSS. The snapshot adds one allocation per new
native key, and at this occupancy the store adds 112 bytes per key with five cards or 672 with
forty. The inline receipt grows from 16 to 32 bytes, including for scripted keys, which do not
allocate a snapshot. The times are medians of 12 batches per version with alternating order on a
shared workstation, not latency guarantees: five-card new-save batches ranged from 4,912 to
11,300 ns/op before and 5,674 to 13,612 after; the forty-card after-save range was 20,108 to
81,302. The five-card save does not show a resolved speedup. The receipt buys an exact same-deck
retry even after another tab changes the saved deck; a changed retry gets a conflict instead.

## Nested Preview

Open **Deck list** for two independent preview owners, Plan A and Plan B. Each switches between
an editor and summary. The editor has a real draft-notes child and disclosure grandchild; both
branches contain an export child with the kit's ID-based CopyButton. Typed IDs keep labels,
descriptions and copy targets separate across instances and branches. Draft notes survive a
switch in the owner; the removed children's editing timers, disclosure and copy feedback do not.
The server renders a usable editor and export even without scripts.

`view(host, View, template)` is the framework API for one replaceable branch. It returns a generated
view, adopting the current root by its server-rendered ID or cloning another branch. The existing
`keep`, typed events and `signal` still supply all state and lifecycle behavior. It adds no client
renderer or child-prop synchronization. See [`preview-smoke.mjs`](preview-smoke.mjs) for the
three-engine regression tests and [`preview-bench.mjs`](preview-bench.mjs) for the comparison
against app-owned DOM switching on the same nested trees.

### Evaluation

The nested example supports a small framework API, not a second component model. App-owned
switching is short until it must also adopt server markup without losing focus, follow an
external replacement, reject ID collisions, forbid cloned scripts and apply template CSS
variables under the CSP. `view` centralizes those rules; existing components, events, `keep`
and `signal` still own composition, state and cleanup. Removed branches are discarded rather
than cached, and durable state must be explicitly restored by the owner.

Measured on 2026-11-06 in Chromium against the same connected trees at `fc09b98d`, six alternating
rounds of 60 switches gave medians of 0.37 ms for the helper (round range 0.34-0.39 ms) and 0.29 ms
for app-owned switching (0.28-0.42 ms). The ranges overlap and the app runs vary more than the
medians differ. These are operation times, excluding asynchronous lifecycle work and layout;
the app comparison omits the general safety checks. There is no speed claim.

The minified view helper grows by 833 bytes, or 320 gzip bytes (1,829 to 2,149). Every page that
already loads the view module pays that cost, even if it does not call `view`; the main runtime
is unchanged. The complete two-preview example adds 9,753 raw document bytes, about 852 gzip
bytes, 1,965 gzip bytes of loaded JavaScript and 82 gzip bytes of CSS versus the original deck
builder at `62eb57f7`. Document gzip is the median of six alternating nonce-normalized responses
(baseline 11,858.5 bytes, range 11,856-11,861; example 12,710.5, range 12,707-12,713); assets are
compressed individually. This is the cost of the demonstration as well as the helper, not the
API alone.

`view` is a narrow framework primitive exercised by this example and its regression tests.
Keep child-prop synchronization, branch caches, automatic ID rewriting and a reactive
renderer out. The benefit is one maintained safety boundary shared by applications, while plain
HTML, explicit updates and ordinary component cancellation remain the defaults.
