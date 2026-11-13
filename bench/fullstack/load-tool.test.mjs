import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { keepLoadTool } from "./load-tool.mjs";
import { k6Image, k6Platform, k6Version } from "../load-tool.mjs";
import { pack } from "./pack.mjs";

const tool = { image: k6Image, imageId: `sha256:${"a".repeat(64)}`, repoDigests: [k6Image], platform: k6Platform, version: k6Version, versionOutput: "k6 v2.4.0" };
function scratch(work) {
  const dir = mkdtempSync(join(tmpdir(), "corten-tool-metadata-"));
  try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("new legacy rounds record tools, and identical continuation leaves metadata unchanged", () => scratch((dir) => {
  keepLoadTool(dir, tool);
  const before = readFileSync(join(dir, "tools.json"), "utf8");
  assert.deepEqual(JSON.parse(before), { k6: tool });
  keepLoadTool(dir, { ...tool, repoDigests: [...tool.repoDigests, "another/repository@sha256:other"] });
  assert.equal(readFileSync(join(dir, "tools.json"), "utf8"), before);
  for (const key of ["image", "imageId", "platform", "version", "versionOutput"]) assert.throws(() => keepLoadTool(dir, { ...tool, [key]: "different" }), /load tool differs/);
}));

test("unidentified historical and partially completed loads cannot acquire today's identity", () => {
  for (const file of ["summary.json", "summary.partial.json", "instructions.json", "raw.tar.xz", "raw.txt", "fixture/app-fixed.json", "api/app-warmup.json",
    "count-warmup.json", "count-corten-page-1.json", "corten-page-identity-warmup-r1.json", "corten-json-br-vus64-r1-stats.json", "unrecognized-load.json"]) scratch((dir) => {
    mkdirSync(join(dir, "fixture")); mkdirSync(join(dir, "api"));
    writeFileSync(join(dir, file), "historical bytes");
    assert.throws(() => keepLoadTool(dir, tool), /earlier load tool is unknown/);
    assert.equal(readFileSync(join(dir, file), "utf8"), "historical bytes");
  });
});

test("non-load steps do not prevent a first load-tool record", () => scratch((dir) => {
  for (const name of ["cold-start.json", "bytes.json", "build.json", "conformance.json", "browser.json"])
    writeFileSync(join(dir, name), "{}");
  mkdirSync(join(dir, "fixture")); writeFileSync(join(dir, "fixture/passes.json"), "{\"passes\":3}");
  keepLoadTool(dir, tool);
  assert.equal(JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")).k6.version, k6Version);
}));

test("summarizing plain and packed raw output preserves measured tools without inventing historical tools", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const round = `tool-test-${process.pid}-${Date.now()}`;
  const dir = join(here, "results", round);
  mkdirSync(dir);
  const summarize = () => {
    const result = spawnSync(process.execPath, [join(here, "summarize.mjs"), round], {
      encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, BENCH_TIER: "defaults", BENCH_APPS: "corten" },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  };
  try {
    assert.equal(summarize().tools, undefined);
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ k6: tool }));
    assert.deepEqual(summarize().tools, { k6: tool });
    assert.equal(pack(dir), 1);
    assert.deepEqual(summarize().tools, { k6: tool });
  } finally {
    assert.equal(dirname(dir), join(here, "results"));
    rmSync(dir, { recursive: true, force: true });
  }
});
