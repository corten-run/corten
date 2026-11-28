import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { leanApps, leanProfile } from "./contract.mjs";
import { groupDescriptor } from "./group.mjs";
import { checkBoundaryEvidence } from "./raw.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("catalog lean contenders follow the page registry and the runner records the fixed profile", () => {
  assert.deepEqual(leanApps, groupDescriptor("catalog-page").apps);
  assert.equal(leanProfile, "catalog-lean");
  const runner = read("./run.mjs");
  assert.ok(runner.includes("leanProfile: { name: leanProfile, apps: effectiveLeanApps }"));
  assert.ok(runner.includes('leanApps.includes(app) ? ["-e", `PROFILE=${leanProfile}`] : []'));
  assert.match(runner, /"\/results\/checks.json", \.\.\.\(leanApps.includes\(app\) \? \[app\] : \[\]\)/);
  assert.match(read("../../.github/workflows/catalog.yml"), /node bench\/catalog\/run.mjs c1 --apps .* --build --check-only/);
  for (const path of ["../marketplace/run.mjs", "../json-api/run.mjs", "../mixed-production/run.mjs"]) {
    assert.ok(!read(path).includes("catalog-lean"), `${path}: richer workloads do not select the lean profile`);
  }
});

test("Express lean profile uses public no-timer settings and omits ETag work only in that profile", () => {
  const source = read("../fullstack/apps/express/server.mjs");
  assert.ok(source.includes('const catalogLean = process.env.PROFILE === "catalog-lean";'));
  assert.ok(source.includes('if (catalogLean) app.disable("etag");'));
  assert.ok(source.includes('createServer({ headersTimeout: 0, requestTimeout: 0, keepAliveTimeout: 0 }, app)'));
  assert.ok(source.includes('} else if (profile) {'));
  assert.ok(read("../fullstack/apps/express/Dockerfile").includes("ENV NODE_ENV=production"));
  const server = createServer({ headersTimeout: 0, requestTimeout: 0, keepAliveTimeout: 0 });
  assert.equal(server.headersTimeout, 0);
  assert.equal(server.requestTimeout, 0);
  assert.equal(server.keepAliveTimeout, 0);
  assert.equal(server.timeout, 0);
});

test("ASP.NET lean disables rate guards but retains working Kestrel timers and matched limits", () => {
  const source = read("../fullstack/apps/aspnet/Program.cs");
  const lean = source.slice(source.indexOf("if (catalogLean)"), source.indexOf("builder.Services.AddRazorPages();"));
  for (const setting of ["RequestHeadersTimeout", "KeepAliveTimeout"]) assert.ok(!lean.includes(`o.Limits.${setting} =`), `${setting}: retain the native default`);
  for (const setting of ["MinRequestBodyDataRate", "MinResponseDataRate"]) assert.ok(lean.includes(`o.Limits.${setting} = null;`));
  assert.ok(source.includes("if (matched)"));
  assert.ok(source.includes("o.Limits.MaxRequestBodySize = 2 * 1024 * 1024;"));
  assert.ok(source.includes("app.UseRequestTimeouts();"));
});

test("Drogon lean disables supported compression and keeps warning/error logging", () => {
  const source = read("../fullstack/apps/drogon/src/main.cc");
  assert.ok(source.includes('std::string_view(profile) == "catalog-lean"'));
  assert.ok(source.includes("app().enableGzip(false).enableBrotli(false).setLogLevel(trantor::Logger::kWarn);"));
  assert.ok(source.includes(".setThreadNum(cpuCount())"));
  assert.ok(source.includes("catalog::get(id,"));
});

test("Axum catalog-lean stays separate from the matched production layer stack", () => {
  const source = read("../fullstack/apps/axum-maud/src/main.rs");
  assert.match(source, /let matched_profile = profile.as_deref\(\) == Ok\("matched"\)/);
  assert.match(source, /let catalog_lean = profile.as_deref\(\) == Ok\("catalog-lean"\)/);
  assert.ok(source.includes("if matched_profile { matched(router) } else { router }"));
  const catalogPage = source.slice(source.indexOf("async fn catalog_page("), source.indexOf("async fn catalog_json("));
  assert.match(catalogPage, /if !catalog_lean \{\s*return page.into_response\(\);/);
  assert.doesNotMatch(catalogPage, /TimeoutLayer|CompressionLayer|RequestBodyLimitLayer/);
});

test("saved runtime boundaries retain the profile but never unrelated image environment", () => {
  const projected = checkBoundaryEvidence({ Config: { Env: ["PROFILE=catalog-lean", "UNRELATED=private"] },
    State: {}, HostConfig: {}, NetworkSettings: { Networks: {} }, Mounts: [] });
  assert.deepEqual(projected.Config.Env, ["PROFILE=catalog-lean"]);
});
