import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { describeK6, k6Image, k6Platform, k6Provenance, k6Version } from "./load-tool.mjs";
import { readLoad } from "./catalog/contract.mjs";

const image = { Id: `sha256:${"a".repeat(64)}`, RepoDigests: [k6Image], Os: "linux", Architecture: "amd64" };
const versionOutput = "k6 v2.4.0 (commit/dd9395906d, go1.27.3, linux/amd64)";

test("the selected production release resolves to one platform and a verified executable", () => {
  assert.equal(k6Version, "2.4.0");
  assert.equal(k6Platform, "linux/amd64");
  assert.match(k6Image, /^grafana\/k6@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(k6Provenance(image, versionOutput + "\n"), {
    image: k6Image, imageId: image.Id, repoDigests: [k6Image], platform: k6Platform, version: k6Version, versionOutput,
  });
  for (const changed of [{ Id: "latest" }, { Architecture: "arm64" }, { RepoDigests: [] }]) {
    assert.throws(() => k6Provenance({ ...image, ...changed }, versionOutput));
  }
  for (const output of ["", "k6 v2.3.0", "k6 v2.4.0-rc1", "other v2.4.0"]) assert.throws(() => k6Provenance(image, output));
});

test("resolution pulls a missing immutable image and probes its resolved ID without a network", async () => {
  const calls = [];
  let first = true;
  const tool = await describeK6(async (args) => {
    calls.push(args);
    if (args[0] === "image") { if (first) { first = false; throw new Error("missing"); } return JSON.stringify([image]); }
    return args[0] === "run" ? versionOutput : "pulled";
  }, ["--label", "test=owned"]);
  assert.equal(tool.imageId, image.Id);
  assert.deepEqual(calls, [["image", "inspect", k6Image], ["pull", k6Image], ["image", "inspect", k6Image],
    ["run", "--rm", "--network", "none", "--label", "test=owned", image.Id, "version"]]);
  await assert.rejects(describeK6(async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(describeK6(async (args) => args[0] === "image" ? JSON.stringify([image]) : "k6 v1.8.2"), /selected release/);
});

test("all four suites import the shared pin, and legacy cleanup follows it", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["fullstack/ab.mjs", "fullstack/count.mjs", "fullstack/run-ssr.mjs", "catalog/run.mjs", "marketplace/run.mjs", "json-api/contract.mjs"]) {
    const source = readFileSync(join(here, file), "utf8");
    assert.match(source, /(?:import|export) \{[^}]*k6Image[^}]*\} from "\.\.?\/load-tool.mjs"/);
    assert.doesNotMatch(source, /grafana\/k6:/);
  }
  assert.match(readFileSync(join(here, "fullstack/run-all.mjs"), "utf8"), /ancestor=\$\{k6Image\}/);
});

// Explicit opt-in: short protocol/summary probes against a synthetic local HTTP server,
// not adapter qualification, a benchmark, or performance evidence.
test("actual pinned image runs the suites' load scripts with readable legacy summaries", { skip: process.env.K6_IMAGE_CHECK !== "1", timeout: 120_000 }, async () => {
  const labels = ["--label", "agent.owner=codex", "--label", "agent.task=corten-bench-refresh-load-tools"];
  const docker = (args, options = {}) => {
    const r = spawnSync("docker", args, { encoding: "utf8", timeout: options.timeout ?? 30_000, windowsHide: true });
    assert.equal(r.status, 0, r.error?.message ?? r.stderr);
    return r.stdout;
  };
  const tool = await describeK6(docker, labels);
  assert.equal(tool.version, k6Version);
  const dir = mkdtempSync(join(tmpdir(), "corten-load-tool-"));
  const bench = dirname(fileURLToPath(import.meta.url));
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.headers.accept === "application/json" ? "application/json" : "text/html"); res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    // Use async Docker clients while the server answers requests in this process.
    const { execFile } = await import("node:child_process");
    const base = `http://${process.platform === "linux" ? "127.0.0.1" : "host.docker.internal"}:${server.address().port}`;
    for (const [i, script] of ["fullstack/ab-load.js", "fullstack/ssr-load.js", "catalog/load.js", "marketplace/load.js", "json-api/load.js"].entries()) {
      const args = ["run", "--rm", ...labels, ...(process.platform === "linux" ? ["--network", "host"] : []),
        "-v", `${bench}:/bench:ro`, "-v", `${dir}:/out`, "-e", `BASE=${base}`, "-e", "TARGET=json", "-e", "PAYLOAD=catalog-v1",
        "-e", "MODE=closed", "-e", "VUS=1", "-e", "DURATION=1s", "-e", "LOCALE=en-US", tool.imageId,
        "run", "--quiet", "--summary-export", `/out/${i}.json`, `/bench/${script}`];
      await new Promise((resolve, reject) => execFile("docker", args, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(`${script}: ${error.message}\n${stderr}`)) : resolve(stdout)));
      const raw = JSON.parse(readFileSync(join(dir, `${i}.json`), "utf8"));
      const metrics = readLoad(raw);
      assert.ok(metrics.requests > 0, script);
      assert.equal(metrics.failed, 0, script);
      // The legacy fullstack readers use the flattened summary shape directly.
      assert.ok(raw.metrics.http_reqs.count > 0, script);
      assert.ok(Number.isFinite(raw.metrics.http_req_duration["p(99)"]), script);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
