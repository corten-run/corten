// Copies Corten's stylesheets into every other app, so they all style the same page the same way:
// the app's own sheet (examples/card-market/static/style.css) and the components' sheet Corten
// serves (its tokens and each component's scoped styles, as components.css), byte for byte. Run it
// after card-market's styles change, with Corten built from this tree (cb-corten; only its
// style.css is checked against the tree) running on its catalog port, then rebuild the apps;
// parity.mjs and look.mjs say whether every page still matches.
// Usage: node sync-styles.mjs [corten=http://localhost:18410]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://localhost:18410";
const style = readFileSync(join(here, "../../examples/card-market/static/style.css"), "utf8");
const page = await (await fetch(`${base}/items/item_17`)).text();
const href = page.match(/<link rel="stylesheet" href="([^"]*\/components\.css)"/)?.[1];
if (!href) throw new Error("Corten's item page links no components.css");
const served = await (await fetch(new URL(href, base))).text();
if (style !== await (await fetch(new URL(page.match(/<link rel="stylesheet" href="([^"]*\/style\.css)"/)?.[1] ?? "", base))).text()) {
  throw new Error("the running Corten serves another style.css than examples/card-market/static/style.css: rebuild it");
}
/** Where each app keeps the two sheets; Leptos's cargo-leptos takes one style file, so it gets both in order. */
const places = {
  nextjs: ["app"], "tanstack-start": ["src"], sveltekit: ["src"], "react-router": ["app"], nuxt: ["app"], astro: ["src"],
  django: ["static"], topcoat: ["static"], "axum-maud": ["static"], rails: ["app/assets/stylesheets"], laravel: ["public"], aspnet: ["wwwroot"], spring: ["src/main/resources/static"], phoenix: ["priv/static/css"],
};
for (const [app, [dir]] of Object.entries(places)) {
  writeFileSync(join(here, "apps", app, dir, "style.css"), style);
  writeFileSync(join(here, "apps", app, dir, "components.css"), served);
}
writeFileSync(join(here, "apps/leptos/style/main.css"), style + served);
console.log(`style.css ${style.length} bytes and components.css ${served.length} bytes into ${Object.keys(places).length + 1} apps`);
