import assert from "node:assert/strict";

// Official v2.4.0 image, linux/amd64 manifest, not the moving release tag or index.
export const k6Version = "2.4.0";
export const k6Platform = "linux/amd64";
export const k6Image = "grafana/k6@sha256:70949facc324f13a8903d24ee5b817ff32aca02bda3458389611e6aa4b38a097";

export function k6Provenance(image, output) {
  assert.match(image?.Id ?? "", /^sha256:[a-f0-9]{64}$/, "missing k6 image ID");
  assert.equal(`${image.Os}/${image.Architecture}`, k6Platform, "wrong k6 platform");
  assert.ok(Array.isArray(image.RepoDigests) && image.RepoDigests.includes(k6Image), "k6 manifest not resolved");
  const versionOutput = output.trim();
  const version = /^k6 v(\d+\.\d+\.\d+)(?:\s|$)/.exec(versionOutput)?.[1];
  assert.equal(version, k6Version, "resolved k6 executable differs from selected release");
  return { image: k6Image, imageId: image.Id, repoDigests: image.RepoDigests, platform: k6Platform, version, versionOutput };
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
