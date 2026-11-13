// Offline validation only. Never runs Docker, Git, a browser or the native runner.
import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rawSchema, replayCatalog } from "./raw.mjs";

const full = (value, pattern) => typeof value === "string" && pattern.exec(value)?.[0] === value;
export function savedReader(folder) {
  assert.equal(typeof folder, "string");
  assert.ok(!/^[\\/]{2}|^[\\/]\\|^\\\//.test(folder), "network paths refused");
  const root = resolve(folder);
  // Check every parent before traversing: realpath alone would follow junctions.
  const anchor = parse(root).root;
  let cursor = anchor;
  for (const part of relative(anchor, root).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe evidence parent");
  }
  assert.equal(realpathSync(root).toLowerCase(), root.toLowerCase(), "evidence root redirects");
  const files = new Map();
  let bytes = 0;
  let entries = 0;
  function walk(dir, prefix = "", depth = 0) {
    assert.ok(depth <= 24, "evidence tree too deep");
    const names = readdirSync(dir);
    const lower = new Set();
    for (const name of names) {
      assert.ok(++entries <= 30000, "too many evidence entries");
      assert.ok(/^[A-Za-z0-9_.-]+$/.test(name) && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), "unsafe evidence name");
      assert.ok(!lower.has(name.toLowerCase()), "case-colliding evidence"); lower.add(name.toLowerCase());
      const file = join(dir, name), key = `${prefix}${name}`;
      const stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), "linked evidence refused");
      if (stat.isDirectory()) walk(file, `${key}/`, depth + 1);
      else {
        assert.ok(stat.isFile() && stat.nlink === 1, "special/hardlinked evidence refused");
        assert.ok(stat.size <= 64 * 2 ** 20 && (bytes += stat.size) <= 2 ** 31, "evidence bytes exceed limit");
        files.set(key, stat);
      }
    }
  }
  walk(root);
  function readText(key) {
    assert.ok(!isAbsolute(key) && key.split("/").every((s) => s !== "." && s !== ".."), "unsafe evidence key");
    const saved = files.get(key);
    if (!saved) throw Object.assign(new Error("required native observation missing"), { missing: true });
    let parent = root;
    for (const part of key.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "evidence parent changed");
    }
    assert.equal(realpathSync(join(root, key)).toLowerCase(), join(root, key).toLowerCase(), "evidence path redirects");
    const fd = openSync(join(root, key), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const now = fstatSync(fd);
      assert.ok(now.isFile() && now.nlink === 1 && now.dev === saved.dev && now.ino === saved.ino && now.size === saved.size && now.mtimeMs === saved.mtimeMs, "evidence changed during validation");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  }
  return { readText, readJson: (key) => JSON.parse(readText(key)) };
}

export function validateSaved({ folder, round, commit }) {
  // Do not echo invalid operator inputs into a log.
  if (!full(round, /c[1-9]\d{0,8}/) || !full(commit, /[a-f0-9]{40}/)) return { status: "invalid", complete: false, errors: ["invalid catalog identity"] };
  try {
    const reader = savedReader(folder);
    const summary = reader.readJson("summary.json");
    assert.equal(summary.round, round, "round differs");
    assert.equal(summary.commit, commit, "commit differs");
    if (summary.savedEvidence === undefined) return { status: "blocked", complete: false, errors: ["native raw evidence version absent; historical summary is not qualification"] };
    assert.equal(summary.savedEvidence.schema, rawSchema, "unsupported native evidence schema");
    const report = replayCatalog(summary, reader, commit);
    return { status: "verified", complete: true, round, commit, report,
      scope: "native saved evidence replay; host isolation and independent source audit are separate campaign gates" };
  } catch (error) {
    return { status: error.missing || error.code === "ENOENT" ? "blocked" : "invalid", complete: false,
      errors: [error.missing ? "required native observation missing" : "native evidence invalid or contradictory"] };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder, round, commit, ...extra] = process.argv.slice(2);
  const result = extra.length ? { status: "invalid", complete: false, errors: ["invalid arguments"] } : validateSaved({ folder, round, commit });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "verified" ? 0 : result.status === "blocked" ? 2 : 1;
}
