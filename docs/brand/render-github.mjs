// Renders the GitHub avatar and social preview from the brand pack's SVGs (#1084).
// Run from the repository root: node docs/brand/render-github.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = new URL("./", import.meta.url);
const svg = (name) => `data:image/svg+xml;base64,${readFileSync(new URL(name, dir)).toString("base64")}`;
const bone = "#EEE8DF";
const ink = "#1C2020";
const rust = "#A84C27";
const tagline = "Fast web apps: Rust on the server, plain JavaScript in the browser, each doing the work it is fastest at.";

const browser = await chromium.launch();
/** @param {number} width @param {number} height @param {string} body @param {string} out */
async function render(width, height, body, out) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;width:${width}px;height:${height}px;background:${bone};display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,'Segoe UI',sans-serif">${body}</body>`,
  );
  await page.waitForLoadState("load");
  await page.screenshot({ path: fileURLToPath(new URL(out, dir)) });
  await page.close();
}
await render(500, 500, `<img src="${svg("corten-weathering-mark.svg")}" style="width:380px">`, "corten-weathering-github-avatar.png");
await render(
  1280,
  640,
  `<img src="${svg("corten-weathering-lockup.svg")}" style="width:720px">` +
    `<p style="margin:40px 0 0;max-width:1000px;color:${ink};font-size:34px;line-height:1.4;text-align:center">${tagline}</p>` +
    `<div style="margin-top:48px;width:120px;height:6px;border-radius:3px;background:${rust}"></div>`,
  "corten-weathering-github-social.png",
);
await browser.close();
