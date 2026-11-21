import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { API } from "typescript/unstable/sync";

// The scripts of compile_fail doctests that TypeScript refuses too, which jsconfig.json leaves
// out: each is compiled here with jsconfig.json's options and has exactly its one error, and
// with the fix written in, none.
const scripts = [
  {
    file: "crates/corten/src/undeclared_feed.js",
    code: 2304, // Cannot find name.
    marker: "FeedUrl<Level>",
    at: "FeedUrl<".length,
    fixed: ['/** @import { FeedUrl } from "corten" */', '/** @import { FeedUrl } from "corten" */\n/** @typedef {import("./types/app").Level} Level */'],
  },
];

const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const config = `${root}jsconfig.json`;
const repo = JSON.parse(readFileSync(config, "utf8"));

test("jsconfig.json leaves out exactly the scripts checked here", () => {
  assert.deepEqual([...(repo.exclude ?? [])].sort(), scripts.map((s) => s.file).sort());
});

/** The errors TypeScript gives `file`, compiled alone with jsconfig.json's options, as `text`. @param {string} file @param {string} text */
function errors(file, text) {
  const path = `${root}${file}`;
  const alone = JSON.stringify({ compilerOptions: repo.compilerOptions, include: [file] });
  const api = new API({
    fs: {
      readFile: (name) => {
        const at = name.replaceAll("\\", "/");
        return at === config ? alone : at === path ? text : undefined;
      },
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      assert.ok(project, "the script's check project must load");
      return [...project.program.getSyntacticDiagnostics(path), ...project.program.getSemanticDiagnostics(path)];
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

for (const { file, code, marker, at, fixed } of scripts) {
  const text = readFileSync(`${root}${file}`, "utf8");
  test(`${file} is refused by TypeScript for its one error`, () => {
    assert.equal(text.split(marker).length, 2, "the marker must match exactly once");
    const found = errors(file, text).map((e) => [e.code, e.pos]);
    assert.deepEqual(found, [[code, text.indexOf(marker) + at]]);
  });
  test(`${file} with the fix written in has no error`, () => {
    assert.equal(text.split(fixed[0]).length, 2, "the fix must apply exactly once");
    assert.deepEqual(errors(file, text.replace(fixed[0], fixed[1])).map((e) => [e.code, e.pos]), []);
  });
}
