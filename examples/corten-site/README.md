# corten-site

Corten's own site, served by Corten. It is one page: a core sample through the mark's three
layers and out the far side. The page is the demonstration: it shows no sample code, only itself
working, and a strip along the bottom of the window counts what it has cost the reader's browser.
Read it for a page of content rather than an app: sections as components, each with its
stylesheet, six of them with a script, and tests that hold what the page says to where it comes
from.

```sh
cargo run --release -p corten-site    # http://localhost:3000
```

Or as the image the smoke test runs against, from the repository root:

```sh
docker build -f examples/corten-site/Dockerfile -t corten-site .
docker run --rm -p 18488:8080 corten-site
node examples/corten-site/smoke.mjs http://localhost:18488
```

[`deploy/`](deploy/README.md) is how it is hosted: one binary behind nginx on one small machine,
shipped by a workflow on every change, with the machine itself made from the configuration in
`deploy/infra/`.

| Part | What it says | What it shows |
|---|---|---|
| Surface | finished HTML, plain JavaScript next to the component | a link that reloads the page with every script blocked (`?scripts=off`: one more Content-Security-Policy, which the browser enforces), the page's components with the script each has or has not, and 1,000 server-rendered samples the browser puts in order with no request (`wall.js`), or the server does where no script runs (`?wall=sorted`) |
| Seam | no strings where server and browser meet | one component, the wall, as its three files cut to the lines where they meet, with each name one gives another marked and followed between them, and the whole files behind a disclosure with every shared name marked (`apart.rs`; the server marks one, `apart.js` follows the rest); this site's source broken five ways with the compiler's answers (radio buttons and `:has()`, no script); one form answered as a patch or as a page (`POST /strike`), whose patch tells the plate behind the page it was struck (a typed event, `PlateStruck`) |
| Steel | Rust underneath, one server for every surface | the server's own readings over `<corten-live>` (`GET /live/works`), with the memory it holds, the machine it is on and how much of its CPU and memory is in use (the whole machine's, or of the limits a container or a systemd unit holds the server to), where the system counts them; the response the page was sent, read back header by header with what each default is for, and the same address answering JSON (`answer.js`, `req.screen`); the program's size |
| Certificate | every claim has a number | round r16 on the server, all eighteen apps; three rows of round browser-4 against four frameworks; where Corten trails; each with its conditions |
| After | whether to pick it | what it fits and does not, its limits today, what it is against the reader's other choices, the README's quick start, the order its values decide in |
| The strip | what the page costs | the server's time for this request (`Server-Timing`, set by the `Timed` middleware), the requests and bytes of the load and of everything since, from the browser's own timings (`ledger.js`) |
| Far side | where to go next | the tagline, the name's origin and the links out |

The bar and the footer are the layout's, outside `<main>`, so every page has them.

Each part names the standards it is built on (`looks::Built`): they are the thread through the
page, since what it shows working is the browser's and HTTP's own, with Corten's types on it.

## The plate

The plate behind the page is one fragment shader on a fixed canvas (`src/world.js`): weathered
patina, the oxide under it, bare steel stained next to a rusting layer and tempered past that,
and patina again on the far side, with the tagline stamped into the surface. No line is drawn
between two layers: over a stretch of the plate the rustier one thins to patches and then to
specks along the runs rain takes, as the whole plate does in time when the page opens. The patina
is drawn after photographs of weathering steel: a fine grain of newer rust on an orange-brown
ground, in bands down the plate. When the page opens the plate weathers as such a plate does
over a few years, in five and a half seconds: grey mill scale, rust in specks along the runs
rain takes, the whole plate bright and uneven, then deeper and more even. The bare steel is
ground across the plate, and throws the pointer's light out in a bar across its hairlines. That
light is held under a ceiling of luminance over the steel's section, rust that reaches into it
included, so the dimmest small type set straight on the plate there, the amber of its code,
keeps 4.5 to 1 over every pixel under it; a strike's glow is not held to it, and is over in
four and a half seconds. The plate is drawn
again only when the page scrolls, the pointer moves, a plate is struck or the window changes,
and it moves by whole pixels of its canvas, so its grain does not shimmer as the page scrolls.

A pixel pays for the layer it is in: every texture read names its level, so each layer's
branch is one the GPU can skip. Where one layer gives way to the next a pixel pays more: for
what seeds the specks, and for both layers where a speck of one lies in the other or, in the
middle three tenths of the stretch, where the relief of both is eased together. A frame with
such a stretch across it took a tenth to a sixth longer than one with the line that was drawn
there before: 8.1, 6.7 and 6.7 ms for the three at `209231071` against 7.4, 6.1 and 6.1 at
`5e18ffb7e`, at 1440 by 900 on one workstation's GPU through Direct3D, and 10, 13 and 17% longer
when a review timed the same two commits itself. Frames that come late lower the plate's
resolution, and where the browser has only a software renderer, no WebGL 2 or no JavaScript,
each layer has a flat color and the page reads the same (`data-flat`). A lost context is
restored when the browser gives it back. With reduced motion the plate is drawn weathered,
still, and does not follow the pointer.

There are no font files: the display face is the DIN already on the reader's machine
(Bahnschrift on Windows, DIN Condensed on Apple systems, Roboto Condensed on Android, a narrow
sans on a Linux desktop), the text face the system's.

## Kept true

Tests tie what the page says to where it comes from, so one cannot change without the other:

- the certificate's numbers to the README and `docs/performance.md` (`src/cert.rs`): every app of
  the server round, the rows it draws of the browser round, what it says of the rows it leaves
  out, and where Corten trails, worked out from the numbers;
- the components the page counts, and which of them have a script, to every `#[component]` and
  script in `src/` (`src/surface.rs`);
- the three files, whole and cut, to the files line for line, and each marked name to its other end
  (`src/apart.rs`);
- the quick start to the README's (`src/after.rs`);
- what it says in prose of a round's conditions, the release, the toolchain, browser support and
  the runtime's size to the sentence of `docs/performance.md`, the README, `docs/design.md` or the
  manifest it comes from (`src/held.rs`);
- the headers it lists to the headers a request is answered with (`src/lib.rs`);
- each compiler answer in the seam exhibit to the source as it is: the line it cites is that line
  of the file, with the one change shown (`src/cuts.rs`);
- the strike handler shown on the page to the handler (`src/lib.rs`, `src/seam.rs`);
- the page's JSON to the page's own constants;
- `types/app.d.ts`, the declarations the scripts are type-checked against, to the Rust types
  (`script_types_match_the_server` rewrites it).

Change a number in the README or `docs/performance.md` first, then in `src/cert.rs`. The
compiler output in the seam exhibit (`src/cuts.rs`) was captured from real builds of this crate
with the one line broken as shown: `cargo build -p corten-site` from the repository's root, on
Linux. An edit that moves a cited line fails the test there until the answer is captured again.

`smoke.mjs` runs the page in Chromium, Firefox and WebKit: with its scripts, with them blocked
by the page's own switch, and with scripting off; and on a touch screen in Chromium. A browser
under test has no GPU and keeps the flat layers, so in Chromium the test also has its software
renderer build the plate's shader and draw it, and reads the plate at both ends of the steel's
section, a window's height from where its type may begin, weathered and with the light where
reduced motion leaves it: it fails if a pixel there is brighter than the type's contrast allows,
or if the section's padding would let type nearer its ends than the light is held from.

## Serving it

| Variable | What it sets |
|---|---|
| `PORT`, `HOSTS` | as for any Corten app: the port, and the host names it answers to |
| `PUBLIC_ORIGIN` | the site's own address (`https://example.com`), for the picture and address a shared link shows and for the command the page prints |
| `HTTPS` | `1` when the site is served over HTTPS at its own host name: browsers are told to keep using it, for a year and on every subdomain (HSTS) |
| `MAX_CONNECTIONS` | the most connections held at once (4096); every open page holds one for its live stream |
| `CORTEN_SITE_MACHINE` | what the page adds after the machine's own count of its CPUs and memory, such as the size's name and price; the count itself is read from the system (Linux), and the page says nothing of the machine where it cannot be |
| `CORTEN_SITE_HEAT` | at build time, the commit the site says it was built from, where the build has no git checkout |

Corten speaks HTTP/1.1, and every open page holds a stream, so put a proxy or CDN that speaks
HTTP/2 in front of it ([deploying](../../docs/guide/deploy.md)).
