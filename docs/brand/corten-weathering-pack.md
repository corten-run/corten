# Corten Weathering logo pack

The mark is three stacked layers that bend upward to the right: a protective weathering surface
over a durable foundation. Every file is traced from `corten-weathering-concept.png`, the source
of truth for the shapes, the wordmark and the colors.

## Palette

Sampled from the concept image.

- Rust (top layer): `#A84C27`
- Deep rust (middle layer): `#753620`
- Charcoal (bottom layer): `#272826`
- Ink (wordmark): `#1C2020`
- Bone (background): `#EEE8DF`

## Assets

- `corten-weathering-mark.svg`: the standalone mark
- `corten-weathering-mark-mono.svg`: the mark in `currentColor`
- `corten-weathering-lockup.svg`: horizontal mark and wordmark
- `corten-weathering-lockup-stacked.svg`: mark above the wordmark, as in the concept
- `corten-weathering-lockup-light.svg`: horizontal lockup for dark backgrounds (bone replaces charcoal and ink)
- `corten-weathering-favicon.svg`: the mark on a bone rounded square
- `corten-weathering-horizontal.png`, `-horizontal-light.png`, `-stacked.png`: transparent PNG exports of the flat lockups
- `corten-weathering-horizontal-textured.png`, `-stacked-textured.png`: the concept's own weathered texture inside the traced shapes
- `corten-weathering-github-avatar.png`: the GitHub organization's avatar, 500 x 500: the mark 380 px wide, centered on Bone
- `corten-weathering-github-social.png`: the repository's social preview, 1280 x 640 on Bone: the horizontal lockup 720 px wide, the README's tagline (without its "and") in Ink, Segoe UI at 34 px, and a 120 x 6 px Rust rule under it

`render-github.mjs` writes both GitHub images from the SVGs with headless Chromium
(`node docs/brand/render-github.mjs`, after `npm ci`). The tagline is live text set in Segoe UI, so run
it on Windows to get the committed preview; elsewhere the browser substitutes a font and the lines
may break differently. The mark and the wordmark are paths and render the same anywhere. Run it after a change to the mark, the
lockup or the tagline, then upload the avatar in the organization's settings and the preview in
the repository's settings (Social preview); neither is read from the repository.

Use the flat SVGs for product UI and documentation. Use the textured PNGs for launch graphics and
editorial presentation.
