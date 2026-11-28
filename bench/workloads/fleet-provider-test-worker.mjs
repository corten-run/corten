// Fixed test-only fork entry. Production has no option selecting this module.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { serveProviderWorker } from "./cloud-provider-worker.mjs";

const [mode, trace, hostsPath, stateDir, group, userId] = process.argv.slice(2);
assert.equal(process.argv.length, 8);
assert.ok(["success", "overlap", "advertisement", "marker", "provider-failure", "withhold-close", "host-id-mismatch", "late-create",
  "startup-refusal", "catalog-denial", "catalog-count", "catalog-shape", "catalog-pagination", "catalog-disconnect"].includes(mode));
assert.ok(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2);
delete process.env.NODE_OPTIONS;
process.stdin.resume(); // Drain the transport's actual captured bootstrap bytes.
const record = (event) => appendFileSync(trace, `${JSON.stringify({ group, ...event })}\n`);
if (mode === "startup-refusal") { record({ boundary: "before-provider-boot" }); process.exit(2); }
const state = () => JSON.parse(readFileSync(join(stateDir, "groups-r21/state.json")));
const hosts = () => existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath)) : [];
const later = mode === "overlap" && group !== "catalog-page";
let clock = 0, accountsAfterRegions, firstInventoryPage = true;
serveProviderWorker({
  now: () => clock,
  spawn(binary, argv) {
    assert.equal(binary, "doctl"); assert.deepEqual(argv.slice(0, 2), ["auth", "token"]);
    record({ boundary: "synthetic-credential" });
    return { status: 0, stdout: Buffer.from("SYNTHETIC_FLEET_CREDENTIAL\n") };
  },
  connect() { record({ boundary: "forbidden-native-https" }); assert.fail("native HTTPS forbidden"); },
  request({ method, path, body, credential }) {
    assert.equal(credential, "SYNTHETIC_FLEET_CREDENTIAL");
    record({ boundary: "provider", method, path, body });
    if (path === "/v2/regions?page=1&per_page=200") accountsAfterRegions = 0;
    if (path === "/v2/account" && accountsAfterRegions !== undefined && ++accountsAfterRegions === 2 && existsSync(hostsPath + ".late-lock"))
      writeFileSync(readFileSync(hostsPath + ".late-lock", "utf8"), "sibling started during the create account check", { flag: "wx" });
    if (path === "/v2/account") return mode === "provider-failure" ? { status: 403, value: null }
      : { status: 200, value: { account: { uuid: userId,
        droplet_limit: existsSync(hostsPath + ".limit") ? Number(readFileSync(hostsPath + ".limit", "utf8")) : 20 } } };
    if (method === "GET" && path === "/v2/sizes?page=1&per_page=200") {
      if (mode === "catalog-disconnect") process.exit(2);
      if (mode === "catalog-denial") return { status: 403, value: { private: credential } };
      if (mode === "catalog-count") return { status: 200, value: { sizes: [], meta: { total: 1 } } };
      if (mode === "catalog-shape") return { status: 200, value: { sizes: { private: credential } } };
      if (mode === "catalog-pagination") return { status: 200, value: {
        sizes: [{ slug: "c-8", available: true, regions: ["sfo2"] }], meta: { total: 2 },
        links: { pages: { next: "https://api.digitalocean.com/v2/sizes?page=2&per_page=200" } },
      } };
      const sizes = [{ slug: "c-8", available: true, regions: later ? ["lon1"] : ["sfo2", "sfo3"] }];
      if (!later) sizes.push({ slug: "c-16", available: true, regions: ["sfo2"] });
      return { status: 200, value: { sizes, meta: { total: sizes.length } } };
    }
    if (mode === "catalog-pagination" && method === "GET" && path === "/v2/sizes?page=2&per_page=200")
      return { status: 200, value: { sizes: [{ slug: "c-16", available: true, regions: ["sfo2"] }], meta: { total: 3 } } };
    if (method === "GET" && path === "/v2/regions?page=1&per_page=200") {
      const regions = [{ slug: "sfo2", available: true, sizes: later ? [] : ["c-8", "c-16"] },
        { slug: "sfo3", available: true, sizes: later ? [] : ["c-8"] },
        { slug: "lon1", available: true, sizes: later ? ["c-8"] : [] },
        { slug: "blr1", available: true, sizes: [] }];
      return { status: 200, value: { regions, meta: { total: regions.length } } };
    }
    if (method === "GET" && path.startsWith("/v2/droplets?")) {
      if (existsSync(hostsPath + ".census-next")) {
        const match = JSON.parse(readFileSync(hostsPath + ".census-next", "utf8"));
        if (path === "/v2/droplets?page=2&per_page=200") return { status: 200, value: { droplets: [], meta: { total: 1 } } };
        if (firstInventoryPage) {
          firstInventoryPage = false;
          return { status: 200, value: { droplets: [match], meta: { total: 2 },
            links: { pages: { next: "https://api.digitalocean.com/v2/droplets?page=2&per_page=200" } } } };
        }
        return { status: 200, value: { droplets: [{ ...match, name: "renamed", tags: [] }], meta: { total: 1 } } };
      }
      if (existsSync(hostsPath + ".census-first")) {
        const rows = JSON.parse(readFileSync(hostsPath + ".census-first", "utf8"));
        if (firstInventoryPage) {
          firstInventoryPage = false;
          return { status: 200, value: rows };
        }
        return { status: 200, value: { droplets: [], meta: { total: 0 } } };
      }
      const droplets = hosts(); return { status: 200, value: { droplets, meta: { total: droplets.length }, links: {} } };
    }
    if (method === "POST" && path === "/v2/droplets") {
      const saved = state(); assert.equal(saved.status, "creating"); assert.ok(saved.createIntentAt);
      const droplets = hosts(), id = droplets.length + (later ? 102 : 101);
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
      if (mode === "late-create") clock = 24 * 60 * 60 * 1000;
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
