// Functional native HTTP regressions, not a throughput benchmark. Uses an ordinary
// built app image, its production command, a real upstream, and independent reads.
// ALERT_CONTRACT_IMAGE=... ALERT_FRAMEWORK=fastapi|django|spring node --test alert-contract.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { records } from "../../../marketplace/fixtures.mjs";
import { validateRecord } from "../../../marketplace/records.mjs";

const { request } = createRequire(import.meta.url)("playwright");
const framework = process.env.ALERT_FRAMEWORK;
const image = process.env.ALERT_CONTRACT_IMAGE;
assert.ok(["fastapi", "django", "spring"].includes(framework));
assert.ok(image, "ALERT_CONTRACT_IMAGE is required");
const valid = records().item_1;
const rows = ["listings", "offers", "contents", "included_in"];
const schemas = [[], ["categories", 0], ["fields", 0], ["summary"], ...rows.map(key => [key, 0])];
const at = (record, path) => path.reduce((value, key) => value[key], record);

function invalidRecords() {
  const cases = [];
  const add = (label, edit) => {
    const record = structuredClone(valid);
    edit(record);
    assert.throws(() => validateRecord(record, "item_1"), undefined, label);
    cases.push([label, record]);
  };
  for (const path of schemas) {
    for (const key of Object.keys(at(valid, path))) {
      const label = [...path, key].join(".");
      add(`missing ${label}`, r => { delete at(r, path)[key]; });
      add(`wrong type ${label}`, r => { at(r, path)[key] = typeof at(valid, path)[key] === "string" ? 1 : "wrong"; });
    }
    add(`extra key ${path.join(".") || "root"}`, r => { at(r, path).extra = true; });
  }
  for (const key of ["id", "title", "description", "categories", "images", "fields", ...rows])
    add(`null ${key}`, r => { r[key] = null; });
  for (const key of ["badges", "tags", "images", "categories", "fields", ...rows])
    add(`null member ${key}`, r => { r[key].push(null); });
  add("requested ID mismatch", r => { r.id = "item_2"; });
  for (const key of rows) add(`duplicate ${key} ID`, r => { r[key].push(structuredClone(r[key][0])); });
  const numbers = [["summary", "lowest_minor"], ["summary", "count"], ["summary", "quantity"],
    ["listings", 0, "rating_hundredths"], ["listings", 0, "reviews"], ["listings", 0, "quantity"], ["listings", 0, "price_minor"],
    ["offers", 0, "quantity"], ["offers", 0, "price_minor"], ["contents", 0, "quantity"], ["included_in", 0, "quantity"]];
  for (const path of numbers) {
    const key = path.at(-1), parent = path.slice(0, -1);
    const min = key.endsWith("minor") ? -1e9 : 0, max = key === "rating_hundredths" ? 500 : 1e9;
    for (const value of [min - 1, max + 1, 1.5, true])
      add(`numeric ${path.join(".")}=${value}`, r => { at(r, parent)[key] = value; });
  }
  return cases;
}

function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

for (const profile of (process.env.ALERT_CONTRACT_PROFILES || "defaults,matched").split(",")) {
  test(`${framework}/${profile}: malformed sources cannot commit`, { timeout: 300000 }, async () => {
    let current = valid, fetches = 0;
    const upstream = createServer((req, res) => {
      fetches++;
      assert.equal(req.url, "/marketplace/records/item_1");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(current));
    });
    await new Promise(resolve => upstream.listen(0, "0.0.0.0", resolve));
    const name = `parity-python-java-contract-${framework}-${profile}-${process.pid}`;
    let client, fresh, started = false;
    try {
      const nativeImage = profile === "matched" ? process.env.ALERT_CONTRACT_MATCHED_IMAGE || image : image;
      if (framework === "django" && profile === "matched")
        assert.ok(process.env.ALERT_CONTRACT_MATCHED_IMAGE, "Django requires its native matched build");
      docker("run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=parity-python-java-contract",
        "--cpus=1", "--memory=1g", "--pids-limit=256", "-p", "127.0.0.1::8080", "--add-host=host.docker.internal:host-gateway",
        "-e", `API_BASE=http://host.docker.internal:${upstream.address().port}`, "-e", "MARKETPLACE_SOURCE=api",
        "-e", `PROFILE=${profile}`, "-e", "HOSTS=127.0.0.1,localhost", nativeImage);
      started = true;
      const baseURL = `http://${docker("port", name, "8080/tcp")}`;
      client = await request.newContext({ baseURL, timeout: 10000 });
      fresh = await request.newContext({ baseURL, timeout: 10000 });
      // Readiness is not a qualification gate. Keep this explicit functional-test bound.
      const deadline = Date.now() + 120000;
      while (true) {
        try { if ((await client.get("/api/alerts")).status() === 200) break; } catch {}
        assert.ok(Date.now() < deadline, "native server readiness within 120 seconds");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const page = "/marketplace/en-US/item_1";
      const read = async jar => {
        const response = await jar.get("/api/alerts");
        assert.equal(response.status(), 200);
        assert.match(response.headers()["content-type"], /application\/json/);
        return response.json();
      };
      const form = async jar => {
        const response = await jar.get(page);
        assert.equal(response.status(), 200);
        const token = (await response.text()).match(/name="csrfmiddlewaretoken" value="([^"]+)"/);
        if (framework === "django") assert.ok(token);
        return { email: "contract@example.test", target_price: "12.50", ...(token ? { csrfmiddlewaretoken: token[1] } : {}) };
      };
      const data = await form(client), freshData = await form(fresh);
      assert.equal((await client.post(page, { form: data })).status(), 200);
      const before = await read(client);
      assert.deepEqual(before, [{ item_id: "item_1", email: data.email, target_minor: 1250 }]);
      const failures = [], cases = invalidRecords();
      for (const [label, record] of cases) {
        current = record;
        const count = fetches;
        const existing = await client.post(page, { form: data });
        const existingRows = await read(client);
        const empty = await fresh.post(page, { form: freshData });
        const freshRows = await read(fresh);
        try {
          assert.equal(existing.status(), framework === "fastapi" ? 502 : 500);
          assert.equal(empty.status(), framework === "fastapi" ? 502 : 500);
          assert.deepEqual(existingRows, before);
          assert.deepEqual(freshRows, []);
          assert.equal(fetches - count, 2, "one upstream read per POST, none per readback");
          const cookies = (await fresh.storageState()).cookies;
          assert.ok(!cookies.some(c => ["sessionid", "JSESSIONID", "marketplace_session"].includes(c.name)));
        } catch (error) { failures.push(`${label}: status=${existing.status()}/${empty.status()}, rows=${existingRows.length}/${freshRows.length}: ${error.message.split("\n")[0]}`); }
      }
      console.log(`${framework}/${profile}: ${cases.length} malformed cases; failures=${failures.length}`);
      assert.deepEqual(failures, []);
      // Contract boundaries remain accepted: signed prices, nullables, zero/max
      // counts, rating endpoints, per-list (not global) IDs and unrestricted text.
      current = structuredClone(valid);
      current.title = "\u0000é 漢字 {email}";
      current.subtitle = null;
      current.summary = { lowest_minor: -1e9, count: 0, quantity: 1e9 };
      current.listings[0].rating_hundredths = 0;
      current.listings[1].rating_hundredths = 500;
      current.listings[0].price_minor = 1e9;
      current.offers[0].id = current.listings[0].id;
      validateRecord(current, "item_1");
      assert.equal((await client.post(page, { form: data })).status(), 200);
      assert.deepEqual(await read(client), [...before, ...before]);
      assert.deepEqual(await read(fresh), []);
    } finally {
      await client?.dispose();
      await fresh?.dispose();
      if (started) docker("rm", "-f", "-v", name);
      await new Promise(resolve => upstream.close(resolve));
    }
  });
}
