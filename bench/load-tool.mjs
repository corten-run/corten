import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

// Official v2.4.0 image, linux/amd64 manifest, not the moving release tag or index.
export const k6Version = "2.4.0";
export const k6Platform = "linux/amd64";
export const k6Image = "grafana/k6@sha256:70949facc324f13a8903d24ee5b817ff32aca02bda3458389611e6aa4b38a097";

const releaseOf = (versionOutput) => /^k6 v(\d+\.\d+\.\d+)(?:\s|$)/.exec(versionOutput)?.[1];

export function k6Provenance(image, output) {
  assert.match(image?.Id ?? "", /^sha256:[a-f0-9]{64}$/, "missing k6 image ID");
  assert.equal(`${image.Os}/${image.Architecture}`, k6Platform, "wrong k6 platform");
  assert.ok(Array.isArray(image.RepoDigests) && image.RepoDigests.includes(k6Image), "k6 manifest not resolved");
  const versionOutput = output.trim();
  const version = releaseOf(versionOutput);
  assert.equal(version, k6Version, "resolved k6 executable differs from selected release");
  return { image: k6Image, imageId: image.Id, repoDigests: image.RepoDigests, platform: k6Platform, version, versionOutput };
}

// A refusal of saved evidence names this checkout's pin or the differing field, never the saved
// value: assert's diff, and the actual and expected it keeps on the error, would print it.

/** A retained image reference that is not this checkout's pin. Its message names only the pin and a checked commit. */
export class ImagePinRefusal extends Error {
  name = "ImagePinRefusal";
  code = "BENCH_IMAGE_PIN";
}

/** Refuses a retained image other than `pin`. A `verb` adds the hint to replay from the measured commit's checkout. */
export function assertPinned(image, pin, { tool, verb, commit } = {}) {
  if (image === pin) return;
  const measured = typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit) ? `the measured commit ${commit}` : "its measured commit";
  throw new ImagePinRefusal(`retained ${tool} image is not this checkout's pin ${pin}${verb ? `; ${verb} from a checkout of ${measured}` : ""}`);
}

const record = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
// A key is named only when this checkout defines it (`known`): a saved key, however field-like it
// looks, is saved text. A key one side lacks is an unexpected field; a differing value under a key
// the checkout does not name is an unnamed field.
function differingField(actual, expected, path, known) {
  if (record(actual) && record(expected)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const both = Object.hasOwn(actual, key) && Object.hasOwn(expected, key);
      if (both && isDeepStrictEqual(actual[key], expected[key])) continue;
      const name = known.has(key) ? key : both ? "(unnamed field)" : "(unexpected field)";
      const field = path ? `${path}.${name}` : name;
      return both && known.has(key) ? differingField(actual[key], expected[key], field, known) : field;
    }
  }
  return path || "the whole value";
}

/**
 * Refuses unless isDeepStrictEqual holds, naming the first differing field rather than diffing
 * either value. `known` lists the key names this checkout defines; only those are printed, so both
 * operands may be saved evidence.
 */
export function assertSameEvidence(actual, expected, message, path = "", known = []) {
  if (!isDeepStrictEqual(actual, expected)) assert.fail(`${message} at ${differingField(actual, expected, path, new Set(known))}`);
}

/** The fields of k6Provenance's record, which this checkout defines. */
export const k6Fields = Object.freeze(["image", "imageId", "repoDigests", "platform", "version", "versionOutput"]);

/** `replay` ({ verb, commit }) adds the measured-checkout hint to a pin refusal. */
export function verifyK6Provenance(value, replay) {
  assert.ok(value?.platform === k6Platform, "missing/wrong retained k6 platform");
  assertPinned(value.image, k6Image, { ...replay, tool: "k6" });
  // k6Provenance's own checks would keep the saved value on the error.
  const field = (ok, name) => assert.ok(ok, `retained k6 provenance differs at ${name}`);
  field(typeof value.imageId === "string" && /^sha256:[a-f0-9]{64}$/.test(value.imageId), "imageId");
  field(Array.isArray(value.repoDigests) && value.repoDigests.includes(k6Image), "repoDigests");
  field(typeof value.versionOutput === "string" && releaseOf(value.versionOutput.trim()) === k6Version, "versionOutput");
  const expected = k6Provenance({ Id: value.imageId, RepoDigests: value.repoDigests, Os: "linux", Architecture: "amd64" }, value.versionOutput);
  assertSameEvidence(value, expected, "retained k6 provenance differs", "", k6Fields);
}

// The caller's Docker command keeps its timeout, cancellation and logging policy.
export async function describeK6(docker, labels = [], { pullLog } = {}) {
  let image;
  try { image = JSON.parse(await docker(["image", "inspect", k6Image]))[0]; }
  catch {
    await docker(["pull", k6Image], { timeout: 5 * 60 * 1000, ...(pullLog ? { file: pullLog } : {}) });
    image = JSON.parse(await docker(["image", "inspect", k6Image]))[0];
  }
  const output = await docker(["run", "--rm", "--network", "none", ...labels, image.Id, "version"]);
  return k6Provenance(image, output);
}
