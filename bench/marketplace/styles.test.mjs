import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { apps } from "./contract.mjs";
test("all twenty adapters ship exactly the canonical marketplace CSS", () => {
  const paths = { corten: "../../marketplace/corten/static", aspnet: "wwwroot", django: "static", phoenix: "priv/static/css", rails: "app/assets/stylesheets", spring: "src/main/resources/static", sveltekit: "static", laravel: "public", leptos: "public", "axum-maud": "static", topcoat: "static", gin: "static", drogon: "static", fastapi: "static", express: "static" };
  const canonical = readFileSync(new URL("./marketplace.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  for (const app of apps) {
    const relative = app === "corten" ? "./corten/static/marketplace.css" : `../fullstack/apps/${app}/${paths[app] ?? "public"}/marketplace.css`;
    assert.equal(readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("\r\n", "\n"), canonical, app);
  }
});
