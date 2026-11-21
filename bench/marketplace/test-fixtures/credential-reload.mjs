import assert from "node:assert/strict";
import { serveProviderWorker } from "../../workloads/cloud-provider-worker.mjs";

// The test transport starts this worker instead of the production stdin entry.
process.stdin.resume();
const A = "fixture-only-private-token-A", B = "fixture-only-private-token-B";
const mode = process.argv[2];
let configured = A, reads = 0;
const host = { id: 123, name: "corten-marketplace-r17",
  tags: ["corten-bench", "corten-marketplace", "corten-marketplace-run-0123456789abcdef"],
  networks: { v4: [{ type: "public", ip_address: "192.0.2.1" }] } };
let live = mode !== "gone";
serveProviderWorker({
  spawn(binary, args) {
    assert.equal(binary, "doctl");
    assert.deepEqual(args.slice(0, 4), ["auth", "token", "--context", "bench"]);
    assert.equal(++reads, 1);
    return { status: 0, stdout: Buffer.from(configured + "\n") };
  },
  async request({ credential, method, path }) {
    if ((mode === "fresh" || mode === "lost") && method === "DELETE") {
      assert.equal(path, "/v2/droplets/123");
      assert.ok(credential === A && live);
      live = false;
      if (mode === "lost") throw new Error("synthetic connection lost after dispatch");
      return { status: 204 };
    }
    assert.equal(method, "GET");
    if (path === "/v2/account") {
      configured = B; // Reload here and the next read sees a different account.
      return { status: 200, value: { account: { team: { uuid: credential === A ? "bench-team" : "other-team" } } } };
    }
    if (path === "/v2/droplets?page=1&per_page=200") {
      const droplets = live && credential === A ? [host] : [];
      return { status: 200, value: { droplets, meta: { total: droplets.length } } };
    }
    assert.equal(path, "/v2/droplets/123");
    configured = A; // The trailing account read would see A again.
    return credential === B || !live ? { status: 404 } : { status: 200, value: { droplet: mode === "resume" ? { id: 123, tags: [] } : host } };
  },
});
