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
  assert.ok(runner.includes("leanProfile: { name: leanProfile, apps: leanApps }"));
  assert.ok(runner.includes('leanApps.includes(app) ? ["-e", `PROFILE=${leanProfile}`] : []'));
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

test("ASP.NET lean disables supported Kestrel time/rate guards without changing matched limits", () => {
  const source = read("../fullstack/apps/aspnet/Program.cs");
  const lean = source.slice(source.indexOf("if (catalogLean)"), source.indexOf("builder.Services.AddRazorPages();"));
  for (const setting of ["RequestHeadersTimeout", "KeepAliveTimeout"]) assert.ok(lean.includes(`o.Limits.${setting} = Timeout.InfiniteTimeSpan;`));
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

test("Axum remains its existing lean router, not the matched production layer stack", () => {
  const source = read("../fullstack/apps/axum-maud/src/main.rs");
  assert.ok(source.includes('std::env::var("PROFILE").as_deref() == Ok("matched")'));
  assert.ok(source.includes("if profile { matched(router) } else { router }"));
});

test("saved runtime boundaries retain the profile but never unrelated image environment", () => {
  const projected = checkBoundaryEvidence({ Config: { Env: ["PROFILE=catalog-lean", "UNRELATED=private"] },
    State: {}, HostConfig: {}, NetworkSettings: { Networks: {} }, Mounts: [] });
  assert.deepEqual(projected.Config.Env, ["PROFILE=catalog-lean"]);
});
