import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, "../..");
const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=192" };

test("marketplace CLI publishes fresh and previously private fixtures under umask 077", { skip: process.platform === "win32" }, () => {
  const folder = mkdtempSync(join(tmpdir(), "fixture-publication-"));
  try {
    copyFileSync(join(here, "fixtures.mjs"), join(folder, "fixtures.mjs"));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
      process.umask(0o077);
      const generate = () => {
        const child = spawnSync(process.execPath, ['fixtures.mjs'], { encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(statSync('fixtures/marketplace.json').mode & 0o777, 0o644);
        assert.equal(statSync('fixtures').mode & 0o777, 0o711);
        assert.equal(process.umask(), 0o077);
        return readFileSync('fixtures/marketplace.json');
      };
      const fresh = generate();
      writeFileSync('fixtures/private-evidence.json', 'private');
      chmodSync('fixtures', 0o700); chmodSync('fixtures/marketplace.json', 0o600);
      assert.deepEqual(generate(), fresh);
      assert.equal(statSync('fixtures/private-evidence.json').mode & 0o777, 0o600);
    `], { cwd: folder, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  } finally { assert.equal(dirname(folder), tmpdir()); rmSync(folder, { recursive: true, force: true }); }
});

test("all output-root fixture writers use publication without changing their serialized bytes or mount paths", () => {
  for (const [runner, expression] of [
    ["mixed-production", 'writeFixture(join(folder, "marketplace.json"), JSON.stringify(records))'],
    ["hardening", 'writeFixture(join(fixtureDir, "marketplace.json"), JSON.stringify(records(), null, 2) + "\\n")'],
    ["fullstack-browser", 'writeFixture(join(folder, "marketplace.json"), JSON.stringify(records))'],
  ]) {
    const source = readFileSync(join(repo, "bench", runner, "run.mjs"), "utf8");
    assert.ok(source.includes(expression), `${runner} must publish its actual mounted fixture`);
    assert.match(source, /import \{[^}]*\bwriteFixture\b[^}]*\} from "\.\.\/marketplace\/fixtures\.mjs"/);
    assert.ok(!source.includes('writeFileSync(join(folder, "marketplace.json")'), `${runner} must not bypass publication`);
    const mount = runner === "hardening" ? '${fixtureDir}:/fixtures:ro' : '${folder}:/fixtures:ro';
    assert.ok(source.includes(mount), `${runner} must retain its read-only fixture mount root`);
  }
});

// Opt-in composition control: Linux volume storage provides real POSIX modes,
// then the daemon bind-mounts its fixture subdirectories read-only. A Windows
// host bind alone would not reproduce Linux umask or UID permission checks.
test("real non-root Gin and Rails users read published fixtures through read-only Linux bind mounts", {
  skip: process.env.FIXTURE_PUBLICATION_DOCKER_TESTS !== "1", timeout: 120000,
}, () => {
  const id = `fixture-publication-${randomBytes(6).toString("hex")}`;
  const labels = ["--label", "agent.owner=codex", "--label", "agent.task=corten-bench-fixture-publication", "--label", `run.corten.fixture-publication=${id}`];
  const docker = (args, options = {}) => {
    const result = spawnSync("docker", args, { env, encoding: "utf8", windowsHide: true, timeout: 30000, ...options });
    assert.equal(result.status, 0, `${args.slice(0, 3).join(" ")}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const nodeImage = process.env.FIXTURE_PUBLICATION_NODE_IMAGE ?? "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067";
  const images = ["cb-marketplace-gin", "cb-marketplace-rails"].map((tag) => JSON.parse(docker(["image", "inspect", tag]))[0]);
  assert.equal(images[0].Config.User, "nobody"); assert.equal(images[1].Config.User, "1000:1000");
  const tool = JSON.parse(docker(["image", "inspect", nodeImage]))[0].Id;
  let created = false;
  try {
    docker(["volume", "create", ...labels, id]); created = true;
    const root = JSON.parse(docker(["volume", "inspect", id]))[0].Mountpoint;
    docker(["run", "--rm", ...labels, "--network", "none", "--cpus", "1", "--memory", "256m",
      "-e", "NODE_OPTIONS=--max-old-space-size=192", "-v", `${id}:/work`, "-v", `${here}:/source:ro`, tool,
      "sh", "-ec", `umask 077
        mkdir /work/generator
        cp /source/fixtures.mjs /work/generator/fixtures.mjs
        node /work/generator/fixtures.mjs
        node --input-type=module -e '
          import assert from "node:assert/strict";
          import { mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
          import * as fixtures from "/work/generator/fixtures.mjs";
          const plain = JSON.stringify(fixtures.records());
          writeFileSync("/work/generator/fixtures/private-evidence.json", "private");
          mkdirSync("/work/generator/fixtures/private-evidence");
          writeFileSync("/work/generator/fixtures/private-evidence/secret", "private");
          for (const name of ["mixed-production", "hardening", "fullstack-browser"]) {
            const dir = "/work/" + name; mkdirSync(dir);
            const bytes = name === "hardening" ? JSON.stringify(fixtures.records(), null, 2) + "\\n" : plain;
            const file = dir + "/marketplace.json";
            writeFileSync(dir + "/private-evidence.json", "private");
            mkdirSync(dir + "/private-evidence"); writeFileSync(dir + "/private-evidence/secret", "private");
            fixtures.writeFixture(file, bytes);
            assert.equal(readFileSync(file, "utf8"), bytes);
            chmodSync(dir, 0o700); chmodSync(file, 0o600);
            fixtures.writeFixture(file, bytes);
            assert.equal(statSync(file).mode & 0o777, 0o644);
            assert.equal(statSync(dir).mode & 0o777, 0o711);
            assert.equal(statSync(dir + "/private-evidence.json").mode & 0o777, 0o600);
            assert.equal(statSync(dir + "/private-evidence").mode & 0o777, 0o700);
          }
          assert.equal(process.umask(), 0o077);
          writeFileSync("/work/private-after-publication", "private");
          assert.equal(statSync("/work/private-after-publication").mode & 0o777, 0o600);
        '`]);
    for (const [index, image] of images.entries()) {
      for (const subpath of ["generator/fixtures", "mixed-production", "hardening", "fullstack-browser"]) {
        const script = `test "$(id -u)" = "${index === 0 ? 65534 : 1000}"
          awk '$5 == "/fixtures" && $6 ~ /^ro(,|$)/ {found=1} END {exit !found}' /proc/self/mountinfo
          test -s /fixtures/marketplace.json
          cat /fixtures/marketplace.json >/dev/null
          if ls /fixtures >/dev/null 2>&1; then exit 11; fi
          test -e /fixtures/private-evidence.json
          if cat /fixtures/private-evidence.json >/dev/null 2>&1; then exit 12; fi
          if cat /fixtures/private-evidence/secret >/dev/null 2>&1; then exit 13; fi
          if (echo no >>/fixtures/marketplace.json) 2>/dev/null; then exit 14; fi
          echo "uid=$(id -u) read-only fixture readable; directory listing and private evidence denied"`;
        const output = docker(["run", "--rm", ...labels, "--network", "none", "--cpus", "1", "--memory", "128m",
          "--mount", `type=bind,source=${root}/${subpath},target=/fixtures,readonly`, "--entrypoint", "sh", image.Id, "-ec", script]);
        console.log(`${subpath} ${image.Config.User}: ${output}`);
      }
    }
  } finally {
    // A timed-out Docker client can leave its --rm container running.
    const remaining = docker(["ps", "-aq", "--filter", `label=run.corten.fixture-publication=${id}`]);
    if (remaining) docker(["rm", "-f", "-v", ...remaining.split(/\s+/)]);
    if (created) docker(["volume", "rm", id]);
  }
});
