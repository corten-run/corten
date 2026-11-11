// @ts-check
// The service worker `corten::pwa` generates, run with the browser's service worker globals
// stubbed: which requests it answers from its cache and which it leaves to the network (#1133).
// The worker is a template in pwa.rs that `Pwa::worker_js` fills in; this reads it from there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const START = 'const WORKER_TEMPLATE: &str = r#"';
const source = readFileSync(new URL("../crates/corten/src/pwa.rs", import.meta.url), "utf8");
const from = source.indexOf(START);
const to = source.indexOf('\n"#;', from);
const template = from >= 0 && to > from ? source.slice(from + START.length, to) : "";

/** The worker as `worker_js` fills it, for an app whose versioned files are under `/assets/`. */
const worker = template
  .replace("__IMPORTS__", "")
  .replace("__CACHE__", '"corten-v1"')
  .replace("__OFFLINE__", '"/offline"')
  .replace("__PRECACHE__", "[]")
  .replace("__NETWORK_ONLY__", '["/api/"]')
  .replace("__CACHED__", '["/assets/", "/corten/"]');

/** Runs the worker and returns a function that sends it a fetch event and says what it did. */
function load() {
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  const fetched = [];
  const self = {
    location: { origin: "https://shop.example" },
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ listener) => (listeners[type] ??= []).push(listener),
  };
  const context = {
    self,
    URL,
    Response,
    caches: { match: async () => undefined, open: async () => ({ put: async () => {} }) },
    fetch: async (/** @type {any} */ request) => {
      fetched.push(request);
      return new Response("bytes", { headers: { "cache-control": "public, max-age=31536000, immutable" } });
    },
  };
  vm.runInNewContext(worker, context);
  /** Whether the worker answers `request` itself (`respondWith`) rather than leaving it. */
  return (/** @type {{url: string, destination?: string, headers?: Record<string, string>, mode?: string}} */ init) => {
    const request = {
      method: "GET",
      mode: init.mode ?? "no-cors",
      url: `https://shop.example${init.url}`,
      destination: init.destination ?? "",
      headers: new Headers(init.headers ?? {}),
    };
    let answered = false;
    const event = { request, respondWith: () => (answered = true), waitUntil: () => {}, preloadResponse: Promise.resolve(undefined) };
    for (const listener of listeners.fetch ?? []) listener(event);
    return answered;
  };
}

test("the worker template is found in pwa.rs and every placeholder is filled", () => {
  assert.ok(template.includes('self.addEventListener("fetch"'), "WORKER_TEMPLATE moved or changed shape in pwa.rs");
  assert.doesNotMatch(worker, /__[A-Z_]+__/);
});

test("a versioned file is answered from the worker's cache", () => {
  const answers = load();
  assert.equal(answers({ url: "/assets/abc123/app.css", destination: "style" }), true);
  assert.equal(answers({ url: "/assets/abc123/grading/condition.vtt", destination: "track" }), true, "a caption file is cached like any versioned file");
  assert.equal(answers({ url: "/assets/abc123/grading/poster.jpg", destination: "image" }), true, "a poster is cached like any versioned file");
});

test("a range, or the video or audio a player loads, is left to the network", () => {
  const answers = load();
  assert.equal(answers({ url: "/assets/abc123/grading/condition.mp4", headers: { range: "bytes=100-199" } }), false, "the cache cannot hold a 206");
  assert.equal(answers({ url: "/assets/abc123/grading/condition.mp4", destination: "video" }), false, "storing it would download the whole video");
  assert.equal(answers({ url: "/assets/abc123/sound.m4a", destination: "audio" }), false);
});

test("other requests are not touched", () => {
  const answers = load();
  assert.equal(answers({ url: "/api/items" }), false, "a network-only prefix");
  assert.equal(answers({ url: "/items/1" }), false, "not a versioned file");
});
