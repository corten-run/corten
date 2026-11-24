import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateLatestStable, latestStableSchema, latestStableSources, candidateLatestStableSchema, unsupportedSolidReason } from "./latest-stable.mjs";
import { readLatestStable } from "../client-heavy/build.mjs";
import { candidateDependencies } from "../client-heavy/contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";

const solid1Commit = "6f1bbf0553ec3b60c884bf5855fe8786ca25f1c2";
const inputsAt = (commit) => Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) =>
  [key, execFileSync("git", ["show", `${commit}:${path}`], { cwd: new URL("../../", import.meta.url) })]));
const { policy, manifest, lockfile } = inputsAt(solid1Commit);
const original = { policy, manifest, lockfile };
// The historical v1 record is intentionally preserved, not relabeled v2.
original.policy = Buffer.from(JSON.stringify(JSON.parse(original.policy).legacy));
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

const candidateInputs = () => ({ group: "client-heavy", ...Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) =>
  [key, readFileSync(new URL(`../../${path}`, import.meta.url))])) });
const mutateCandidate = (key, edit) => {
  const input = candidateInputs(), value = JSON.parse(input[key]); edit(value); input[key] = JSON.stringify(value); return input;
};

for (const key of Object.keys(latestStableSources)) for (const value of [undefined, null, {}, 7, "{", new Uint8Array([0xff])])
  test(`candidate input ${key} rejects missing or malformed source ${String(value)}`, () => {
    const result = evaluateLatestStable({ ...candidateInputs(), [key]: value });
    assert.equal(result.valid, false); assert.equal(result.status, "invalid"); assert.ok(result.errors.length > 0);
    assert.deepEqual(result.candidates ?? [], []);
  });

test("prior reviewed v2 bytes still replay without qualifying previously blocked Remix", () => {
  const commit = "10cad96e18436eaa75bef711292eb7ce21f3a17e";
  const prior = { group: "client-heavy", ...Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) =>
    [key, execFileSync("git", ["show", `${commit}:${path}`], { cwd: new URL("../../", import.meta.url) })])) };
  const result = evaluateLatestStable(prior);
  assert.equal(result.schema, candidateLatestStableSchema);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.checkedOn, "2026-11-17");
  assert.equal(result.groupComparisonEligible, false);
  const remix = result.candidates.find((r) => r.app === "remix");
  assert.equal(remix.status, "blocked");
  assert.equal(remix.latestStableEligible, false);
  assert.deepEqual(remix.incompatible, [{ from: "node_modules/@remix-run/test", kind: "dependency",
    package: "esbuild", range: "^0.27.1", resolved: "node_modules/esbuild", version: "0.28.2" }]);
  assert.equal(result.candidates.find((r) => r.app === "solid").status, "unsupported");
  assert.equal(Object.keys(result.observation.packages).length, 13);
  assert.equal(Object.hasOwn(result.observation.packages, "@remix-run/test"), false);
  const current = candidateInputs();
  invalid({ ...current, policy: prior.policy }, "manifest:unreviewed-overrides");
  invalid({ ...prior, policy: current.policy }, "manifest:unreviewed-overrides");
});

test("the pinned prior policy still excludes Solid and cannot be paired with the new install", () => {
  const prior = { group: "client-heavy", ...inputsAt(solid1Commit) };
  const result = evaluateLatestStable(prior);
  assert.equal(result.valid, true);
  const solid = result.candidates.find((r) => r.app === "solid");
  assert.equal(solid.status, "unsupported");
  assert.equal(solid.reason, unsupportedSolidReason);
  assert.equal(solid.latestStableEligible, false);
  assert.equal(Object.hasOwn(result.observation.packages, "@solidjs/compiler"), false);
  invalid({ ...candidateInputs(), policy: prior.policy }, "manifest:babel-preset-solid:non-exact-or-shadowed-root");
});

for (const [what, edit, error] of [
  ["version", (p) => { p.version = "0.27.7"; }, "archive"],
  ["archive URL", (p) => { delete p.resolved; }, "archive"],
  ["archive integrity", (p) => { delete p.integrity; }, "archive"],
  ["platform declarations", (p) => { delete p.optionalDependencies; }, "dependencies"],
]) test(`the private esbuild requires the reviewed ${what}`, () => {
  invalid(mutateCandidate("lockfile", (p) => edit(p.packages["node_modules/@remix-run/test/node_modules/esbuild"])),
    `lockfile:unreviewed-remix-test-esbuild-${error}`);
});

for (const field of ["resolved", "integrity"]) for (const change of ["missing", "substituted"]) {
  test(`the private esbuild consumer rejects ${change} archive ${field}`, () => {
    invalid(mutateCandidate("lockfile", ({ packages }) => {
      const owner = packages["node_modules/@remix-run/test"];
      if (change === "missing") delete owner[field];
      else owner[field] = packages["node_modules/remix"][field];
    }), "lockfile:unreviewed-remix-test-archive");
  });
}

test("production builder recomputes candidate-specific latest targets without inventing latest-all-transitives or native qualification", () => {
  const input = candidateInputs(), result = evaluateLatestStable(input);
  assert.equal(result.schema, candidateLatestStableSchema); assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result, readLatestStable());
  assert.deepEqual(result.candidates.map((r) => r.app), selectedApps("client-heavy"));
  for (const row of result.candidates) {
    assert.deepEqual(row.roots, row.app === "solid" ? ["@solidjs/compiler", "@solidjs/web", "esbuild", "solid-js"] : candidateDependencies[row.app]);
    assert.equal(row.measurements, null); assert.equal(row.latestStableEligible, true);
    assert.deepEqual(row.blockers, []);
    assert.equal(row.dependencies.some((d) => d.package === "@babel/core" || d.package === "solid-js-legacy"), false);
    assert.equal(row.status, "satisfied");
  }
  const solid = result.candidates.find((r) => r.app === "solid");
  assert.equal(solid.reason, null);
  assert.ok(solid.dependencies.some((d) => d.path === "node_modules/@solidjs/signals" && d.version === "2.0.3"));
  assert.equal(solid.targets.includes("@solidjs/signals"), false);
  assert.equal(result.groupComparisonEligible, false);
  const { packages } = result.observation;
  for (const [name, version] of Object.entries({ "@babel/core": "8.1.3", "@babel/parser": "8.1.3", "solid-js": "2.0.3",
    "@solidjs/web": "2.0.3", "@solidjs/compiler": "2.0.2", vue: "3.5.46", "@vue/compiler-sfc": "3.5.46", svelte: "5.59.1", remix: "3.3.0", "@remix-run/test": "1.2.0" }))
    assert.equal(packages[name].version, version, name);
  const esbuilds = (row) => row.dependencies.filter((d) => d.package === "esbuild");
  const root = { path: "node_modules/esbuild", package: "esbuild", version: "0.28.2" };
  const privateTool = { path: "node_modules/@remix-run/test/node_modules/esbuild", package: "esbuild", version: "0.27.2" };
  for (const row of result.candidates) {
    assert.deepEqual(esbuilds(row), row.app === "remix" ? [privateTool, root] : [root]);
  }
  const vue = result.candidates.find((r) => r.app === "vue");
  assert.ok(vue.dependencies.some((d) => d.package === "@babel/parser" && d.version.startsWith("7.")));
  assert.equal(vue.targets.includes("@babel/parser"), false);
  for (const [key, bytes] of Object.entries(input).filter(([key]) => key !== "group")) assert.equal(result.sources[key].sha256, createHash("sha256").update(bytes).digest("hex"));
  for (const group of groupNames) {
    const evaluated = evaluateLatestStable({ ...input, group }); assert.equal(evaluated.valid, true);
    assert.equal(evaluated.status, group === "client-heavy" ? "blocked" : "not-applicable");
  }
});

for (const [field, value] of [
  ["resolved", "https://example.test/signals.tgz"],
  ["integrity", "sha512-other"],
  ["version", "2.0.4"],
  ["dependencies", { "solid-js": "^2.0.3" }],
]) test(`the executable Signals runtime requires published ${field} with the other Solid runtime archives unchanged`, () => {
  invalid(mutateCandidate("lockfile", ({ packages }) => {
    packages["node_modules/@solidjs/signals"][field] = value;
  }), "lockfile:@solidjs/signals:unreviewed-solid-2-archive");
});

test("the executable Signals runtime cannot resolve from a nested install", () => {
  invalid(mutateCandidate("lockfile", ({ packages }) => {
    packages["node_modules/solid-js/node_modules/@solidjs/signals"] = structuredClone(packages["node_modules/@solidjs/signals"]);
  }), "lockfile:@solidjs/signals:ambiguous-resolution");
});

for (const [target, selector, value] of [
  ["linux-x64-gnu", "os", ["win32"]],
  ["linux-x64-gnu", "cpu", ["arm64"]],
  ["linux-x64-gnu", "libc", ["musl"]],
  ["linux-x64-gnu", "libc", undefined],
  ["darwin-arm64", "libc", ["glibc"]],
]) test(`the Solid compiler ${target} binding requires its published ${selector} selector (${value ?? "omitted"})`, () => {
  const name = `@solidjs/compiler-${target}`;
  invalid(mutateCandidate("lockfile", ({ packages }) => {
    const pkg = packages[`node_modules/${name}`];
    if (value === undefined) delete pkg[selector];
    else pkg[selector] = value;
  }), `lockfile:${name}:unreviewed-solid-compiler-binding`);
});

for (const [name, key, edit] of [
  ["invented latest", "policy", (p) => { const r = p.observations.packages["solid-js"]; const body = JSON.parse(r.raw); body.version = "3.0.0"; r.raw = JSON.stringify(body); }],
  ["missing raw primary bytes", "policy", (p) => { delete p.observations.packages.react.raw; }],
  ["missing primary package", "policy", (p) => { delete p.observations.packages.react; }],
  ["forged registry URL", "policy", (p) => { p.observations.packages.react.url = "https://example.test/latest"; }],
  ["stale observation relabeled current", "policy", (p) => { p.checkedOn = "2026-11-23"; }],
  ["candidate missing", "policy", (p) => { delete p.candidates.solid; }],
  ["candidate membership changed", "policy", (p) => { p.candidates.react.push("@babel/core"); }],
  ["invented unsupported peer", "policy", (p) => { p.unsupported = { app: "react", reason: unsupportedSolidReason }; }],
  ["unsupported field missing", "policy", (p) => { delete p.unsupported; }],
  ["new compiler source missing", "policy", (p) => { delete p.solid2; }],
  ["new compiler source not exact", "policy", (p) => { p.solid2.raw += " "; }],
  ["unknown schema", "policy", (p) => { p.schema = "benchmark-latest-stable-policy/v3"; }],
  ["manifest alternate version", "manifest", (p) => { p.devDependencies.react = "19.0.0"; }],
  ["manifest alternate resolution", "manifest", (p) => { p.dependencies = { react: "19.3.1" }; }],
  ["forced peer override", "manifest", (p) => { p.overrides = { "@babel/core": "8.1.3" }; }],
  ["former Remix override", "manifest", (p) => { p.overrides = { "@remix-run/test": { esbuild: "$esbuild" } }; }],
  ["lock alternate version", "lockfile", (p) => { p.packages["node_modules/react"].version = "19.0.0"; }],
  ["lock missing dependency", "lockfile", (p) => { delete p.packages["node_modules/react-dom"]; }],
  ["lock duplicate compiler", "lockfile", (p) => { p.packages["node_modules/@solidjs/web/node_modules/@solidjs/compiler"] = structuredClone(p.packages["node_modules/@solidjs/compiler"]); }],
  ["lock duplicate framework", "lockfile", (p) => { p.packages["node_modules/somewhere/node_modules/react"] = { version: "19.3.1" }; }],
  ["unrelated nested esbuild", "lockfile", (p) => { p.packages["node_modules/remix/node_modules/esbuild"] = { version: "0.28.2" }; }],
  ["forged Remix test range", "lockfile", (p) => { p.packages["node_modules/@remix-run/test"].dependencies.esbuild = "^0.28.0"; }],
  ["unreviewed Remix test release", "lockfile", (p) => { p.packages["node_modules/@remix-run/test"].version = "1.2.1"; }],
  ["forged Solid web peer", "lockfile", (p) => { p.packages["node_modules/@solidjs/web"].peerDependencies["solid-js"] = "^1.9.16 || ^2.0.3"; }],
  ["missing native compiler archive checksum", "lockfile", (p) => { delete p.packages["node_modules/@solidjs/compiler-linux-x64-gnu"].integrity; }],
  ["unpublished compiler archive", "lockfile", (p) => { p.packages["node_modules/@solidjs/compiler"].resolved = "https://example.test/compiler.tgz"; }],
  ["unpublished Solid runtime archive", "lockfile", (p) => { p.packages["node_modules/solid-js"].integrity = "sha512-other"; }],
  ["nested Solid runtime", "lockfile", (p) => { p.packages["node_modules/@solidjs/web/node_modules/solid-js"] = { version: "1.9.19" }; }],
  ["tooling parser declaration", "toolingManifest", (p) => { p.devDependencies.semver = "7.8.5"; }],
  ["tooling parser alias", "toolingManifest", (p) => { p.dependencies = { semver: "npm:semver@7.8.6" }; }],
  ["tooling parser forced override", "toolingManifest", (p) => { p.overrides = { semver: "7.8.5" }; }],
  ["tooling parser alternate lock", "toolingLockfile", (p) => { p.packages["node_modules/semver"].version = "7.8.5"; }],
  ["tooling parser alternate integrity", "toolingLockfile", (p) => { p.packages["node_modules/semver"].integrity = "sha512-invented"; }],
  ["tooling parser shadow", "toolingLockfile", (p) => { p.packages["node_modules/unit/node_modules/semver"] = { version: "7.8.6" }; }],
]) test(`candidate policy fails closed on ${name}`, () => {
  const r = evaluateLatestStable(mutateCandidate(key, edit)); assert.equal(r.valid, false); assert.equal(r.status, "invalid");
  assert.equal(r.groupComparisonEligible, false); assert.ok(!r.candidates?.length); assert.ok(r.errors.length > 0);
});

test("the Remix test package cannot fall back to the incompatible root esbuild", () => {
  const r = evaluateLatestStable(mutateCandidate("lockfile", (p) => {
    delete p.packages["node_modules/@remix-run/test/node_modules/esbuild"];
  }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  const remix = r.candidates.find((row) => row.app === "remix");
  assert.equal(remix.latestStableEligible, false);
  assert.deepEqual(remix.incompatible, [{ from: "node_modules/@remix-run/test", kind: "dependency",
    package: "esbuild", range: "^0.27.1", resolved: "node_modules/esbuild", version: "0.28.2" }]);
  assert.ok(r.candidates.filter((row) => !["remix", "solid"].includes(row.app)).every((row) => row.latestStableEligible));
});

test("Remix still needs the observed latest root bundler even with a compatible private tool", () => {
  const input = mutateCandidate("manifest", (p) => { p.devDependencies.esbuild = "0.28.1"; });
  const lock = JSON.parse(input.lockfile);
  lock.packages[""].devDependencies.esbuild = "0.28.1";
  lock.packages["node_modules/esbuild"].version = "0.28.1";
  input.lockfile = JSON.stringify(lock);
  const r = evaluateLatestStable(input);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  const remix = r.candidates.find((row) => row.app === "remix");
  assert.deepEqual(remix.incompatible, []);
  assert.deepEqual(remix.blockers, ["not-latest-stable:esbuild"]);
  assert.equal(remix.latestStableEligible, false);
});

test("an actual shared compiler consumer remains blocked instead of borrowing another candidate's disposition", () => {
  const r = evaluateLatestStable(mutateCandidate("lockfile", (p) => { p.packages["node_modules/scheduler"].dependencies = { "@babel/core": "^7.0.0" }; }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  const react = r.candidates.find((row) => row.app === "react");
  assert.ok(react.dependencies.some((d) => d.package === "@babel/core"));
  assert.ok(react.blockers.includes("not-latest-stable:@babel/core"));
  assert.equal(react.status, "blocked"); assert.equal(react.latestStableEligible, false);
});

for (const [range, version, satisfied] of [
  ["^0.28.0", "0.28.2", true], ["^0.28.0", "0.29.0", false],
  ["~1.2.0", "1.2.9", true], ["~1.2.0", "1.3.0", false],
  ["1.2.x", "1.2.3", true], ["1.2 - 2.3", "2.3.99", true],
  [">=1 <2 || ^3.0.0", "3.2.0", true], [">=1 <2 || ^3.0.0", "2.5.0", false],
  ["*", "1.2.3-beta.1", false], ["^1.2.3-beta.1", "1.2.3-beta.2", true],
  ["1.2.3", "1.2.3+build.9", true],
]) test(`resolved dependency uses npm range semantics: ${range} / ${version}`, () => {
  const result = evaluateLatestStable(mutateCandidate("lockfile", (lock) => {
    lock.packages["node_modules/scheduler"].dependencies = { "range-control": range };
    lock.packages["node_modules/range-control"] = { version };
  }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const react = result.candidates.find((row) => row.app === "react");
  assert.equal(react.latestStableEligible, satisfied); assert.equal(react.status, satisfied ? "satisfied" : "blocked");
  assert.equal(react.incompatible.some((edge) => edge.package === "range-control"), !satisfied);
});

for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const optionalPeer of kind === "peerDependencies" ? [false, true] : [false]) {
    test(`resolved ${kind} edge${optionalPeer ? " (optional peer)" : ""} is never excused by optionality or shadow resolution`, () => {
      const result = evaluateLatestStable(mutateCandidate("lockfile", (lock) => {
        const scheduler = lock.packages["node_modules/scheduler"];
        scheduler[kind] = { "range-control": "^1.0.0" };
        if (optionalPeer) scheduler.peerDependenciesMeta = { "range-control": { optional: true } };
        lock.packages["node_modules/range-control"] = { version: "1.5.0" };
        lock.packages["node_modules/scheduler/node_modules/range-control"] = { version: "2.0.0" };
      }));
      assert.equal(result.valid, true, JSON.stringify(result.errors));
      const react = result.candidates.find((row) => row.app === "react");
      assert.equal(react.status, "blocked"); assert.equal(react.latestStableEligible, false);
      assert.equal(react.incompatible[0].resolved, "node_modules/scheduler/node_modules/range-control");
      assert.equal(react.incompatible[0].range, "^1.0.0");
    });
  }
}

test("absent optional edges are permitted, but invalid ranges never become a compatible dependency", () => {
  const missing = evaluateLatestStable(mutateCandidate("lockfile", (lock) => {
    Object.assign(lock.packages["node_modules/scheduler"], { optionalDependencies: { "absent-optional": "^1.0.0" },
      peerDependencies: { "absent-peer": "^1.0.0" }, peerDependenciesMeta: { "absent-peer": { optional: true } } });
  }));
  assert.equal(missing.valid, true); assert.equal(missing.candidates.find((row) => row.app === "react").status, "satisfied");
  for (const range of ["npm:range-control@1.0.0", "file:../other", "workspace:*", "not-a-range"]) {
    const invalid = evaluateLatestStable(mutateCandidate("lockfile", (lock) => {
      lock.packages["node_modules/scheduler"].optionalDependencies = { "range-control": range };
    }));
    assert.equal(invalid.valid, false); assert.equal(invalid.candidates.length, 0);
  }
});
