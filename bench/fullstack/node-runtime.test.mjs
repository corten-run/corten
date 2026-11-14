import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repo = new URL("../../", import.meta.url);
const bookworm = "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1";
const alpine = "node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5";
const source = (path) => readFileSync(new URL(path, repo), "utf8");

test("Node application build and production stages share the verified stable runtime", () => {
  const apps = ["astro", "express", "nextjs", "nuxt", "react-router", "sveltekit", "tanstack-start"];
  const files = [...apps.map((app) => `bench/fullstack/apps/${app}/Dockerfile`),
    "bench/fullstack/apps/sveltekit/Dockerfile.marketplace"];
  for (const file of files) {
    const images = [...source(file).matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
    assert.equal(images.length, file.includes("express/") ? 1 : 2, file);
    assert.deepEqual(images, images.map(() => bookworm), file);
  }
});

test("eligible benchmark helpers use exact stable image digests", () => {
  const files = ["bench/catalog/run.mjs", "bench/catalog/cleanup.test.mjs", "bench/json-api/contract.mjs",
    "bench/marketplace/raw-contract.mjs", "bench/live/run.mjs", "bench/nodelay/run.mjs",
    "bench/fullstack/apps/django/qualify-production.mjs",
    ...["alloc-faults", "conform", "flood-memory", "harden", "run-all"].map((name) => `bench/fullstack/${name}.mjs`)];
  for (const file of files) {
    const images = [...source(file).matchAll(/\bnode:\d[^"'\s]*/g)].map((match) => match[0]);
    assert.ok(images.length > 0, file);
    for (const image of images) assert.ok([bookworm, alpine].includes(image), `${file}: ${image}`);
  }
});
