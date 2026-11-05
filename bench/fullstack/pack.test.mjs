// Tests for pack.mjs: node --test bench/fullstack/pack.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { ARCHIVE, KEPT, pack, packed, rawOf } from "./pack.mjs";

/** Folders the tests made, removed when they end. */
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const temp = (/** @type {string} */ name) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  made.push(dir);
  return dir;
};

/** A round's folder: the summaries, two apps' raw files in a folder each, counts and a log. */
const round = () => {
  const dir = temp("pack-");
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
  assert.deepEqual(packed(dir), ["api", "count-corten-page-0.json", "fixture"]);
  assert.equal(pack(dir), 4);
  assert.deepEqual(readdirSync(dir).sort(), ["build.json", "commit.txt", "host.txt", ARCHIVE, "run.log", "summary.json"].sort());
  const out = temp("unpacked-");
  assert.equal(spawnSync("tar", ["-xJf", join(dir, ARCHIVE), "-C", out]).status, 0);
  assert.equal(readFileSync(join(out, "fixture", "deep", "nextjs-fixed-cpu.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(out, "count-corten-page-0.json"), "utf8"), "[1,2]");
  assert.equal(rawOf(dir) === dir, false, "a packed round is read from its archive");
  assert.equal(readFileSync(join(rawOf(dir), "api", "corten-fixed.json"), "utf8"), '{"rps":1}');
  assert.equal(pack(dir), 0, "a packed round has nothing more to pack");
});

test("a round without its summary is not packed", () => {
  const dir = round();
  unlinkSync(join(dir, "summary.json"));
  assert.throws(() => pack(dir), /no summary\.json/);
  assert.ok(existsSync(join(dir, "api", "corten-fixed.json")) && !existsSync(join(dir, ARCHIVE)));
});

test("a file the archive does not list is kept, with every other one", () => {
  const dir = round();
  // A tar that writes the archive but lists one file fewer than it was given.
  const tar = (/** @type {string[]} */ args) => {
    const r = spawnSync("tar", args, { encoding: "utf8" });
    return args[0] === "-tJf" ? { ...r, stdout: r.stdout.split("\n").filter((l) => !l.trim().endsWith("count-corten-page-0.json")).join("\n") } : r;
  };
  assert.throws(() => pack(dir, tar), /lacks 1 file\(s\), so none was removed: count-corten-page-0\.json/);
  for (const file of ["count-corten-page-0.json", "api/corten-fixed.json", "fixture/deep/nextjs-fixed-cpu.json"]) assert.ok(existsSync(join(dir, file)), file);
  assert.ok(!existsSync(join(dir, ARCHIVE)), "the archive that lacked a file is removed");
  assert.equal(pack(dir), 4, "and the round packs again");
});

test("an archive tar could not finish is removed, so the round packs again", () => {
  const dir = round();
  // A tar that writes the archive and then exits 1, as GNU tar does when a file changed.
  const tar = (/** @type {string[]} */ args) => ({ ...spawnSync("tar", args, { encoding: "utf8" }), status: args[0] === "-cJf" ? 1 : 0 });
  assert.throws(() => pack(dir, tar), /tar could not write raw\.tar\.xz/);
  assert.ok(!existsSync(join(dir, ARCHIVE)) && existsSync(join(dir, "api", "corten-fixed.json")));
  assert.equal(pack(dir), 4);
});

test("a round that keeps only its summaries is not read as if it had no runs", () => {
  const dir = temp("kept-");
  writeFileSync(join(dir, "summary.json"), "{}");
  writeFileSync(join(dir, "raw.txt"), "git archive ..");
  assert.throws(() => rawOf(dir), /keeps only its summaries; bring its raw files back first/);
  mkdirSync(join(dir, "api"));
  writeFileSync(join(dir, "api", "corten-fixed.json"), "{}");
  assert.equal(rawOf(dir), dir, "brought back, the files are read where they are");
  assert.equal(pack(dir), 1);
  assert.ok(existsSync(join(dir, "raw.txt")), "and its note stays");
});

test("files beside an archive are refused, not packed over it", () => {
  const dir = round();
  pack(dir);
  writeFileSync(join(dir, "count-corten-page-1.json"), "[3]");
  assert.throws(() => pack(dir), /has raw\.tar\.xz already and files beside it \(count-corten-page-1\.json\)/);
});

test("the files the bench README says a round keeps are the ones pack.mjs keeps", () => {
  const readme = readFileSync(join(import.meta.dirname, "README.md"), "utf8");
  const item = readme.slice(readme.indexOf("## What the repository keeps")).split("\n2. ")[0];
  const named = [...item.matchAll(/`([a-z-]+\.(?:json|txt|log))`/g)].map((m) => m[1]);
  assert.deepEqual(new Set(named), KEPT);
});
