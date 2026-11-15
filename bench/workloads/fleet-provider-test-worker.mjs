// Fixed test-only fork entry. Production has no option selecting this module.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { serveProviderWorker } from "./cloud-provider-worker.mjs";

const [mode, trace, hostsPath, stateDir, group, userId] = process.argv.slice(2);
assert.equal(process.argv.length, 8);
assert.ok(["success", "advertisement", "marker", "provider-failure", "withhold-close", "host-id-mismatch"].includes(mode));
assert.ok(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2);
delete process.env.NODE_OPTIONS;
process.stdin.resume(); // Drain the transport's actual captured bootstrap bytes.
const record = (event) => appendFileSync(trace, `${JSON.stringify({ group, ...event })}\n`);
const state = () => JSON.parse(readFileSync(join(stateDir, "groups-r21/state.json")));
const hosts = () => existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath)) : [];
serveProviderWorker({
  spawn(binary, argv) {
    assert.equal(binary, "doctl"); assert.deepEqual(argv.slice(0, 2), ["auth", "token"]);
    record({ boundary: "synthetic-credential" });
    return { status: 0, stdout: Buffer.from("SYNTHETIC_FLEET_CREDENTIAL\n") };
  },
  connect() { record({ boundary: "forbidden-native-https" }); assert.fail("native HTTPS forbidden"); },
  request({ method, path, body, credential }) {
    assert.equal(credential, "SYNTHETIC_FLEET_CREDENTIAL");
    record({ boundary: "provider", method, path, body });
    if (path === "/v2/account") return mode === "provider-failure" ? { status: 403, value: null }
      : { status: 200, value: { account: { uuid: userId, droplet_limit: 20 } } };
    if (method === "GET" && path.startsWith("/v2/droplets?")) {
      const droplets = hosts(); return { status: 200, value: { droplets, meta: { total: droplets.length }, links: {} } };
    }
    if (method === "POST" && path === "/v2/droplets") {
      const saved = state(); assert.equal(saved.status, "creating"); assert.ok(saved.createIntentAt);
      const droplets = hosts(), id = droplets.length + 101;
      const droplet = { id, name: body.name, tags: body.tags, size_slug: body.size, region: { slug: body.region },
        networks: { v4: [{ type: "public", ip_address: `192.0.2.${id - 100}` }] } };
      writeFileSync(hostsPath, JSON.stringify([...droplets, { ...droplet, id: mode === "host-id-mismatch" ? id + 100 : id }]));
      if (mode === "host-id-mismatch") return { status: 202, value: { droplet,
        links: { actions: [{ id: id + 1000, rel: "create", href: `https://api.digitalocean.com/v2/actions/${id + 1000}` }] } } };
      return { status: 202, value: { droplet: { ...droplet, unused: "SYNTHETIC_FLEET_CREDENTIAL" },
        links: { actions: [{ id: id + 1000, rel: ["delete", "SYNTHETIC_FLEET_CREDENTIAL"],
          href: { arbitrary: true, uri: "https://SYNTHETIC_FLEET_CREDENTIAL@foreign.invalid/v2/actions/999" } }] } } };
    }
    if (method === "GET" && /^\/v2\/droplets\/\d+$/.test(path))
      return { status: 200, value: { droplet: hosts().find((row) => row.id === Number(path.split("/").at(-1))) } };
    if (method === "GET" && /^\/v2\/actions\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      return { status: 200, value: { action: { id, type: "create", resource_id: id - 1000, resource_type: "droplet", status: "completed" } } };
    }
    assert.fail("unexpected synthetic REST operation");
  },
});
if (mode === "withhold-close") {
  const listeners = process.listeners("message");
  for (const listener of listeners) process.off("message", listener);
  process.on("message", (message) => {
    if (message?.schema === "cloud-provider-close/v1") { record({ boundary: "withheld-close" }); return; }
    for (const listener of listeners) listener(message);
  });
}
