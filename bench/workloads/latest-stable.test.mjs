import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateLatestStable, latestStableSchema, latestStableSources } from "./latest-stable.mjs";
import { groupNames, selectedApps } from "./registry.mjs";

const original = Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) =>
  [key, readFileSync(new URL(`../../${path}`, import.meta.url))]));
const inputs = () => ({ group: "client-heavy", ...structuredClone(original) });
const changed = (key, edit) => {
  const input = inputs(), value = JSON.parse(Buffer.from(input[key]).toString("utf8"));
  edit(value); input[key] = JSON.stringify(value); return input;
};
const invalid = (input, code) => {
  const result = evaluateLatestStable(input);
  assert.equal(result.valid, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.groupComparisonEligible, false);
  assert.ok(result.errors.includes(code), JSON.stringify(result.errors));
};

test("actual browser sources record the blocked latest target, not a native failure", () => {
  const result = evaluateLatestStable(inputs());
  assert.equal(result.schema, latestStableSchema);
  assert.equal(result.valid, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.groupComparisonEligible, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.targets.length, 1);
  const target = result.targets[0];
  assert.equal(target.package, "@babel/core");
  assert.equal(target.latestStable, "8.1.2");
  assert.equal(target.resolved, "7.29.13");
  assert.equal(target.status, "blocked");
  assert.deepEqual(target.blockers.map(({ package: name, version, peerRange }) => [name, version, peerRange]), [
    ["babel-preset-solid", "1.9.19", "^7.0.0"],
    ["babel-plugin-jsx-dom-expressions", "0.40.14", "^7.20.12"],
  ]);
  assert.equal(result.checkedOn, "2026-11-13");
  for (const item of [target, ...target.blockers]) {
    assert.ok(item.latestSource.startsWith("https://registry.npmjs.org/"));
    assert.ok(item.versionSource.startsWith("https://registry.npmjs.org/"));
  }
  for (const name of ["nativeOutcomes", "apps", "eligible", "readyForLoad", "campaignReady"]) {
    assert.equal(Object.hasOwn(result, name), false);
  }
});

test("exact source byte identities are reproducible without mutating inputs", () => {
  const input = inputs(), before = structuredClone(input);
  const first = evaluateLatestStable(input);
  assert.deepEqual(input, before);
  assert.deepEqual(first, evaluateLatestStable(input));
  for (const [key, bytes] of Object.entries(original)) {
    assert.deepEqual(first.sources[key], {
      path: latestStableSources[key], bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const formatted = { ...input, policy: JSON.stringify(JSON.parse(original.policy), null, 4) + "\r\n" };
  const other = evaluateLatestStable(formatted);
  assert.equal(other.status, "blocked");
  assert.notEqual(other.sources.policy.sha256, first.sources.policy.sha256);
  first.targets[0].blockers.length = 0;
  assert.equal(evaluateLatestStable(input).targets[0].blockers.length, 2);
});

for (const key of Object.keys(original)) {
  for (const missing of [undefined, null, {}, 7]) test(`${key}: reject missing/non-source input ${JSON.stringify(missing)}`, () => {
    invalid({ ...inputs(), [key]: missing }, `${key}:missing-source`);
  });
  for (const malformed of ["{", Buffer.from([0xff])]) test(`${key}: reject malformed JSON/UTF-8 ${String(malformed)}`, () => {
    invalid({ ...inputs(), [key]: malformed }, `${key}:invalid-json`);
  });
}

for (const [name, edit] of [
  ["remove target", (p) => p.targets.pop()],
  ["remove preset blocker", (p) => p.targets[0].blockers.shift()],
  ["remove plugin blocker", (p) => p.targets[0].blockers.pop()],
  ["clear blockers", (p) => { p.targets[0].blockers = []; }],
  ["claim satisfied", (p) => { p.targets[0].status = "satisfied"; }],
  ["lower target", (p) => { p.targets[0].latestStable = "7.29.13"; }],
  ["change resolved", (p) => { p.targets[0].resolved = "8.1.2"; }],
  ["change scope", (p) => { p.targets[0].groups = []; }],
  ["change date", (p) => { p.checkedOn = "2026-11-14"; }],
  ["change metadata URL", (p) => { p.targets[0].latestSource = "https://example.test/latest"; }],
]) test(`policy integrity: ${name}`, () => invalid(changed("policy", edit), "policy:unreviewed-record"));

for (const [name, edit, error] of [
  ["missing root", (l) => { delete l.packages[""]; }, "lockfile:invalid-shape"],
  ["old lock schema", (l) => { l.lockfileVersion = 2; }, "lockfile:invalid-shape"],
  ["root versions", (l) => { l.packages[""].devDependencies.esbuild = "0.0.0"; }, "lockfile:root-devDependencies-mismatch"],
  ["root optional map", (l) => { l.packages[""].optionalDependencies = { fake: "1.0.0" }; }, "lockfile:root-optionalDependencies-mismatch"],
  ["missing core", (l) => { delete l.packages["node_modules/@babel/core"]; }, "lockfile:@babel/core:version-mismatch"],
  ["forced core 8", (l) => { l.packages["node_modules/@babel/core"].version = "8.1.2"; }, "lockfile:@babel/core:version-mismatch"],
  ["missing preset", (l) => { delete l.packages["node_modules/babel-preset-solid"]; }, "lockfile:babel-preset-solid:version-mismatch"],
  ["missing plugin", (l) => { delete l.packages["node_modules/babel-plugin-jsx-dom-expressions"]; }, "lockfile:babel-plugin-jsx-dom-expressions:version-mismatch"],
  ["preset peer removed", (l) => { delete l.packages["node_modules/babel-preset-solid"].peerDependencies; }, "lockfile:babel-preset-solid:peer-mismatch"],
  ["plugin peer widened", (l) => { l.packages["node_modules/babel-plugin-jsx-dom-expressions"].peerDependencies["@babel/core"] = "^7 || ^8"; }, "lockfile:babel-plugin-jsx-dom-expressions:peer-mismatch"],
  ["plugin edge removed", (l) => { delete l.packages["node_modules/babel-preset-solid"].dependencies; }, "lockfile:compiler-dependency-mismatch"],
  ["nested plugin shadows root", (l) => { l.packages["node_modules/babel-preset-solid/node_modules/babel-plugin-jsx-dom-expressions"] = { version: "0.50.0" }; }, "lockfile:babel-plugin-jsx-dom-expressions:ambiguous-resolution"],
]) test(`actual lock evidence: ${name}`, () => invalid(changed("lockfile", edit), error));

test("manifest changes cannot retain a matching current-target claim", () => {
  invalid(changed("manifest", (p) => { p.devDependencies["@babel/core"] = "8.1.2"; }), "manifest:target-version-mismatch");
  invalid(changed("manifest", (p) => { p.devDependencies["babel-preset-solid"] = "1.10.0-beta.0"; }), "manifest:compiler-version-mismatch");
  const input = inputs(), pkg = JSON.parse(original.manifest), lock = JSON.parse(original.lockfile);
  pkg.devDependencies["@babel/core"] = lock.packages[""].devDependencies["@babel/core"] = "8.1.2";
  lock.packages["node_modules/@babel/core"].version = "8.1.2";
  invalid({ ...input, manifest: JSON.stringify(pkg), lockfile: JSON.stringify(lock) }, "manifest:target-version-mismatch");
});

test("all nine groups and every contender stay visible, with no global launch decision", () => {
  const before = groupNames.map((group) => [group, selectedApps(group)]);
  assert.equal(before.length, 9);
  for (const [group] of before) {
    const result = evaluateLatestStable({ ...inputs(), group });
    assert.equal(result.valid, true);
    assert.equal(result.status, group === "client-heavy" ? "blocked" : "not-applicable");
    assert.equal(result.groupComparisonEligible, group === "client-heavy" ? false : null);
  }
  assert.deepEqual(groupNames.map((group) => [group, selectedApps(group)]), before);
  assert.deepEqual(selectedApps("client-heavy"), ["corten", "react", "vue", "solid", "svelte", "remix"]);
  const unaffected = evaluateLatestStable({ group: "json-api", policy: original.policy });
  assert.equal(unaffected.status, "not-applicable");
  assert.deepEqual(unaffected.targets, []);
  assert.deepEqual(Object.keys(unaffected.sources), ["policy"]);
  invalid({ ...inputs(), group: "typo" }, "group:unknown");
  invalid({ policy: original.policy }, "group:unknown");
  invalid({ group: "json-api" }, "policy:missing-source");
  invalid(undefined, "policy:missing-source");
  invalid(null, "policy:missing-source");
  invalid("not source input", "policy:missing-source");
});
