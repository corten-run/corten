// Tests for pack.mjs: node --test bench/fullstack/pack.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ARCHIVE, KEPT, pack, packed } from "./pack.mjs";

/** A round's folder: the summaries, two apps' raw files in a folder each, counts and a log. */
const round = () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  for (const name of ["summary.json", "commit.txt", "host.txt", "build.json"]) writeFileSync(join(dir, name), `{"${name}":1}`);
  mkdirSync(join(dir, "api"));
  mkdirSync(join(dir, "fixture", "deep"), { recursive: true });
  writeFileSync(join(dir, "api", "corten-fixed.json"), '{"rps":1}');
  writeFileSync(join(dir, "api", "corten-fixed.log"), "k6 log");
  writeFileSync(join(dir, "fixture", "deep", "nextjs-fixed-cpu.json"), "{}");
  writeFileSync(join(dir, "count-corten-page-0.json"), "[1,2]");
  writeFileSync(join(dir, "run.log"), "all done\n");
  return dir;
};

test("the summaries stay as files and everything else goes in the archive, which brings it back", () => {
  const dir = round();
  assert.deepEqual(packed(dir), ["api", "count-corten-page-0.json", "fixture", "run.log"]);
  assert.equal(pack(dir), 5);
  assert.deepEqual(readdirSync(dir).sort(), ["build.json", "commit.txt", "host.txt", ARCHIVE, "summary.json"].sort());
  const out = mkdtempSync(join(tmpdir(), "unpacked-"));
  assert.equal(spawnSync("tar", ["-xJf", join(dir, ARCHIVE), "-C", out]).status, 0);
  assert.equal(readFileSync(join(out, "fixture", "deep", "nextjs-fixed-cpu.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(out, "run.log"), "utf8"), "all done\n");
  assert.equal(pack(dir), 0, "a packed round has nothing more to pack");
});

test("a round without its summary is not packed", () => {
  const dir = round();
  unlinkSync(join(dir, "summary.json"));
  assert.throws(() => pack(dir), /no summary\.json/);
  assert.ok(existsSync(join(dir, "run.log")) && !existsSync(join(dir, ARCHIVE)));
});

test("a file the archive does not list is kept, with every other one", () => {
  const dir = round();
  // A tar that writes the archive but lists one file fewer than it was given.
  const tar = (/** @type {string[]} */ args) => {
    const r = spawnSync("tar", args, { encoding: "utf8" });
    return args[0] === "-tJf" ? { ...r, stdout: r.stdout.split("\n").filter((l) => !l.trim().endsWith("run.log")).join("\n") } : r;
  };
  assert.throws(() => pack(dir, tar), /lacks 1 file\(s\), so none was removed: run\.log/);
  for (const file of ["run.log", "api/corten-fixed.json", "fixture/deep/nextjs-fixed-cpu.json"]) assert.ok(existsSync(join(dir, file)), file);
});

test("files beside an archive are refused, not packed over it", () => {
  const dir = round();
  pack(dir);
  writeFileSync(join(dir, "run.log"), "a second run");
  assert.throws(() => pack(dir), /has raw\.tar\.xz already and files beside it: run\.log/);
});

test("what the README and tests read stays a file", () => {
  for (const name of ["summary.json", "commit.txt", "skipped.txt", "conformance.json"]) assert.ok(KEPT.has(name), name);
});
