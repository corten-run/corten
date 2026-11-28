import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareToolImages } from "./run.mjs";

const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
const version = lock.packages["node_modules/@playwright/test"].version;
const refs = {
  node: "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067",
  checker: `mcr.microsoft.com/playwright:v${version}-noble`,
  edge: "nginx:1.31.10-alpine@sha256:7fc0fb4af7bf006aeb31aea88069976060f8f0a0a86b667126742cc17f4e31ae",
  cert: "alpine/openssl@sha256:6821afa2476e11be343f29275f2ca24291720ff0a7148bd131fd8e314ff26d9e",
};
const ids = Object.fromEntries(Object.keys(refs).map((role, i) => [role, { Id: "sha256:" + String(i + 1).repeat(64) }]));
const inspect = (ref) => ["image", "inspect", ref];
const pull = (ref) => ["pull", ref];

function fakeDocker(initial = [], { failPull } = {}) {
  const local = new Set(initial), calls = [];
  const docker = async (args, options) => {
    calls.push(args);
    const role = Object.keys(refs).find((role) => refs[role] === args.at(-1));
    assert.ok(role, "only official hardening tool references are accepted");
    if (args[0] === "pull") {
      assert.deepEqual(args, pull(refs[role]));
      assert.ok(options.timeout > 0 && options.timeout <= 10 * 60_000, "pull must have a bounded deadline");
      assert.equal(options.settleOnInterrupt, true);
      if (role === failPull) throw new Error("registry unavailable");
      local.add(role);
      return "";
    }
    assert.deepEqual(args, inspect(refs[role]));
    if (!local.has(role)) throw new Error(`No such image: ${refs[role]}`);
    return JSON.stringify([ids[role]]);
  };
  return { docker, calls };
}

for (const [name, initial] of [["empty", []], ["official bootstrap", ["node"]], ["fully stocked", Object.keys(refs)]]) {
  test(`hardening prepares exactly the tool images from the ${name} store`, async () => {
    const { docker, calls } = fakeDocker(initial);
    assert.deepEqual(await prepareToolImages(docker, version), ids);
    assert.deepEqual(calls, Object.entries(refs).flatMap(([role, ref]) =>
      initial.includes(role) ? [inspect(ref)] : [inspect(ref), pull(ref), inspect(ref)]));
  });
}

test("an unsuccessful tool pull aborts preparation without inspecting or pulling later tools", async () => {
  const { docker, calls } = fakeDocker(["node"], { failPull: "checker" });
  await assert.rejects(prepareToolImages(docker, version), /registry unavailable/);
  assert.deepEqual(calls, [inspect(refs.node), inspect(refs.checker), pull(refs.checker)]);
});

test("a successful inspection with invalid identity is not replaced by a pull", async () => {
  const calls = [];
  await assert.rejects(prepareToolImages(async (args) => {
    calls.push(args);
    return JSON.stringify([{ Id: "not an image ID" }]);
  }, version), /invalid hardening tool image: node/);
  assert.deepEqual(calls, [inspect(refs.node)]);
});

test("an acknowledged pull still requires a successful inspection", async () => {
  const calls = [];
  await assert.rejects(prepareToolImages(async (args) => {
    calls.push(args);
    if (args[0] === "pull") return "";
    throw new Error("image still unavailable");
  }, version), /image still unavailable/);
  assert.deepEqual(calls, [inspect(refs.node), pull(refs.node), inspect(refs.node)]);
});
