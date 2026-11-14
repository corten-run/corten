import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cpuSettings } from "./contract.mjs";
import { upstreamImage } from "./raw.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("native Gin catalog parity survives private fixture generation and private build-context modes", {
  skip: process.env.CATALOG_GIN_DOCKER_TESTS !== "1", timeout: 20 * 60 * 1000,
}, async (t) => {
  const id = `catalog-gin-permissions-${randomBytes(6).toString("hex")}`;
  const labels = ["--label", "agent.owner=codex", "--label", "agent.task=corten-r21-catalog-fix", "--label", `run.corten.catalog.permissions-test=${id}`];
  const image = `${id}:test`, volume = `${id}-data`, network = `${id}-net`;
  const folder = mkdtempSync(join(tmpdir(), `${id}-`));
  const active = new Set();
  const docker = (args, options = {}) => {
    const result = spawnSync("docker", args, { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
    assert.equal(result.status, 0, `${args.slice(0, 3).join(" ")}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim();
  };
  const create = (name, args, options) => {
    active.add(name);
    return docker(["run", "--name", name, ...labels, ...args], options);
  };
  const mount = (subpath) => ["--mount", `type=volume,src=${volume},dst=/fixtures,volume-subpath=${subpath},readonly`];
  const remove = (name) => { docker(["rm", "-f", "-v", name]); active.delete(name); };
  let volumeCreated = false, networkCreated = false, imageCreated = false;
  try {
    docker(["volume", "create", ...labels, volume]); volumeCreated = true;
    docker(["network", "create", ...labels, network]); networkCreated = true;
    // The Linux filesystem, not a Docker Desktop host bind, must carry 0700/0600.
    // Keep the private context untouched; only generated public inputs may be opened.
    create(`${id}-context`, ["--network", "none", "-v", `${volume}:/work`, "-v", `${repo}:/repo:ro`, upstreamImage,
      "sh", "-ec", "cp -R /repo/bench/fullstack/apps/gin /work/context; find /work/context -type d -exec chmod 700 {} +; find /work/context -type f -exec chmod 600 {} +; mkdir /work/generator; cp /repo/bench/catalog/fixtures.mjs /work/generator/fixtures.mjs; umask 077; node /work/generator/fixtures.mjs"]);
    const archive = spawnSync("docker", ["cp", `${id}-context:/work/context/.`, "-"], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(archive.status, 0, archive.stderr?.toString());
    docker(["build", "-t", image, "-"], { input: archive.stdout, timeout: 10 * 60 * 1000 }); imageCreated = true;
    assert.equal(docker(["image", "inspect", image, "--format", "{{.Config.User}}"]), "nobody");
    const checkerVersion = JSON.parse(readFileSync(join(repo, "package.json"))).devDependencies["@playwright/test"];
    const checkerImage = `mcr.microsoft.com/playwright:v${checkerVersion}-noble`;
    const cpus = cpuSettings(process.env);
    const upstream = `${id}-upstream`;
    create(upstream, ["-d", "--network", network, ...cpus.api.args, "--memory", "512m", ...mount("generator/fixtures"), "-v", `${join(repo, "bench")}:/bench:ro`, upstreamImage, "node", "/bench/catalog/upstream.mjs"]);
    for (const source of ["fixture", "api"]) await t.test(source, async () => {
      const name = `${id}-${source}`, checker = `${name}-check`;
      const apiBase = `http://${upstream}:8080`;
      try {
        create(name, ["-d", "--network", network, ...cpus.app.args, "--memory", "1g", ...mount("generator/fixtures"),
          "-e", `CATALOG_SOURCE=${source}`, "-e", "CATALOG_FIXTURE_PATH=/fixtures/catalog.json", "-e", `API_BASE=${apiBase}`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`, image]);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(JSON.parse(docker(["inspect", name]))[0].State.Running, true, docker(["logs", name]));
        // Same native profile, quotas, timeout, checker and eight browser gates as run.mjs.
        // Retry readiness only; no request, style or functional gate is bypassed.
        const readiness = "const until=Date.now()+120000;while(true){try{const r=await fetch('http://127.0.0.1:8080/catalog/record_1',{signal:AbortSignal.timeout(1000)});await r.arrayBuffer();if(r.status===200)break}catch{}if(Date.now()>until)throw Error('not ready in 120s');await new Promise(r=>setTimeout(r,100))}";
        create(checker, ["--network", `container:${name}`, ...cpus.load.args, "--memory", "2g", "--shm-size", "1g", "-v", `${repo}:/repo:ro`, "-v", `${folder}:/results`,
          "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", checkerImage, "sh", "-ec", `node --input-type=module -e '${readiness.replaceAll("'", "'\\''")}'\nexec node /repo/bench/catalog/check.mjs http://127.0.0.1:8080 ${source} ${apiBase} /results/${source}.json`], { timeout: 17 * 60 * 1000 });
        const result = JSON.parse(readFileSync(join(folder, `${source}.json`), "utf8"));
        assert.equal(result.jsonRecords, 500); assert.equal(result.profiles.length, 8);
        assert.ok(result.profiles.every((p) => p.forms && p.related && p.styles));
        if (source === "api") assert.deepEqual(result.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
        console.log(`${source}: ${result.jsonRecords} JSON records, ${result.pages} checked pages, ${result.profiles.length} browser profiles; native parity passed`);
      } finally {
        for (const n of [checker, name]) if (active.has(n)) remove(n);
      }
    });
  } finally {
    for (const name of [...active].reverse()) remove(name);
    if (imageCreated) docker(["image", "rm", image]);
    if (networkCreated) docker(["network", "rm", network]);
    if (volumeCreated) docker(["volume", "rm", volume]);
    assert.equal(docker(["ps", "-a", "--filter", `label=run.corten.catalog.permissions-test=${id}`, "--format", "{{.ID}}"]), "");
    assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true });
  }
});
