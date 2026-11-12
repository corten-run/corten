import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { records as catalogRecords } from "../../../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../../../marketplace/fixtures.mjs";
import { catalogServer } from "../../../catalog/upstream.mjs";
import { marketplaceServer } from "../../../marketplace/upstream.mjs";
import { checkJsonApp } from "../../../workloads/json-check.mjs";

// Build target/app.jar with `mvn -B package` first. These are native HTTP checks,
// not production qualification or performance measurements. No profile overrides.
const directory = fileURLToPath(new URL(".", import.meta.url));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
const hostGatewayArgs = (platform) => platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];

test("native Linux Docker gets a host gateway without overriding Desktop host resolution", () => {
  assert.deepEqual(hostGatewayArgs("linux"), ["--add-host", "host.docker.internal:host-gateway"]);
  assert.deepEqual(hostGatewayArgs("win32"), []);
  assert.deepEqual(hostGatewayArgs("darwin"), []);
});

test("native Spring/Jackson passes the shared JSON gate for both payloads and sources", { timeout: 900000 }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "spring-json-gate-"));
  const definitions = [
    { payload: "catalog-v1", path: "catalog", records: catalogRecords(), upstream: catalogServer },
    { payload: "marketplace-v2", path: "marketplace", records: marketplaceRecords(), upstream: marketplaceServer },
  ];
  try {
    for (const definition of definitions) writeFileSync(join(folder, `${definition.path}.json`), JSON.stringify(definition.records));
    for (const definition of definitions) for (const source of ["fixture", "api"]) {
      await t.test(`${definition.payload}/${source}`, { timeout: 210000 }, async () => {
        const server = definition.upstream(definition.records);
        const name = `spring-json-gate-${process.pid}-${definition.path}-${source}`;
        let started = false;
        try {
          await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
          const upstream = `http://127.0.0.1:${server.address().port}`;
          docker("run", "--rm", "-d", "--name", name,
            ...hostGatewayArgs(process.platform),
            "--label", "agent.owner=codex", "--label", "agent.task=corten-bench-spring-json",
            "-p", "127.0.0.1::8080", "-v", `${directory}target:/app:ro`, "-v", `${folder}:/fixtures:ro`,
            "-e", `API_BASE=http://host.docker.internal:${server.address().port}`,
            "-e", `CATALOG_SOURCE=${source}`, "-e", `MARKETPLACE_SOURCE=${source}`,
            "maven:3.9-eclipse-temurin-25", "java", "-jar", "/app/app.jar");
          started = true;
          const port = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", name))["8080/tcp"][0].HostPort;
          const base = `http://127.0.0.1:${port}`;
          const deadline = Date.now() + 150000;
          for (;;) {
            try {
              const response = await fetch(`${base}/api/${definition.path}/${Object.keys(definition.records)[0]}`, { signal: AbortSignal.timeout(2000) });
              await response.arrayBuffer();
              if (response.status === 200) break;
            } catch { /* The native process is still starting. */ }
            assert.ok(Date.now() < deadline, "Spring startup exceeded 150 seconds");
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const observed = [];
          const result = await checkJsonApp({ payload: definition.payload, base, records: definition.records, source, upstream,
            observe: (row) => { observed.push(row); } });
          assert.equal(result.jsonRecords, 500);
          assert.equal(result.missing, true);
          assert.equal(result.readyForLoad, false);
          assert.ok(observed.length > 500);
          t.diagnostic(`${definition.payload}/${source}: ${result.jsonRecords} records; missing JSON; upstream=${JSON.stringify(result.upstream)}`);
        } finally {
          if (started) docker("rm", "-f", "-v", name);
          await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        }
      });
    }
  } finally {
    for (const definition of definitions) unlinkSync(join(folder, `${definition.path}.json`));
    rmdirSync(folder);
  }
});
