import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { captureHttp, livewireUpdate, livewireRequest, livewireResponse } from "./native-http.mjs";
import { inventory, portFor, recordedInventory } from "./native.mjs";
import { wireEvents, wireSnapshots, wireResources } from "./wire.mjs";

test("native registrations retain missing historical candidates and exact wire bindings", () => {
  for (const app of ["rails", "phoenix", "laravel"]) {
    const port = portFor(app);
    assert.equal(port.directory, app);
    assert.equal(port.wireModule, `./apps/${app}/wire.mjs`);
    assert.ok(portFor(app, "native-feed"));
    const old = inventory("recoverable-live", "bounded", 1);
    assert.equal(old.find(row => row.app === app).implementation, "not-implemented");
    assert.deepEqual(recordedInventory("recoverable-live", old, "bounded", 2), old);
    assert.equal(inventory("recoverable-live").find(row => row.app === app).implementation, "implemented");
  }
});

test("Livewire endpoint matching supports native hashed routes without matching other POSTs", () => {
  for (const path of ["/livewire/update", "/livewire-abc123/update"]) assert.ok(livewireUpdate("http://localhost" + path, "POST"));
  for (const path of ["/parity/publish", "/fake/livewire/update", "/livewire/update/assets"]) assert.equal(livewireUpdate("http://localhost" + path, "POST"), false);
  assert.equal(livewireUpdate("http://localhost/livewire/update", "GET"), false);
});

test("Livewire projection retains original effects and calls but excludes reusable credentials", () => {
  const packet = { kind: "event", disposition: "applied", event: { seq: 1, effectId: "effect", key: "a", op: "remove" } };
  const effects = { html: '<section id="native-screen">native Blade</section>', dispatches: [{ name: "parity", params: { packet } }] };
  const response = JSON.stringify({ components: [{ snapshot: "signed-private-snapshot", effects }] });
  const request = JSON.stringify({ _token: "private-csrf", components: [{ snapshot: "signed-private-snapshot", updates: {}, calls: [{ method: "receive", params: [{ packet }] }] }] });
  assert.deepEqual(livewireResponse(response), { components: [{ effects }] });
  assert.equal(livewireRequest(request).components[0].calls[0].method, "receive");
  assert.doesNotMatch(JSON.stringify([livewireRequest(request), livewireResponse(response)]), /private/);
  assert.deepEqual(wireEvents([{ kind: "native-livewire-response", status: 200, body: livewireResponse(response) }], "laravel-livewire"), [packet.event]);
  assert.deepEqual(wireEvents([{ kind: "response", status: 200, body: response }], "laravel-livewire"), []);
  assert.deepEqual(wireSnapshots([], "laravel-livewire"), []);
});

test("native HTTP capture joins original request/response and awaits actual response bytes", async () => {
  const page = new EventEmitter(), network = [], pending = [];
  captureHttp(page, network, pending, "laravel-livewire");
  const timing = { startTime: 100, requestStart: 1, responseStart: 15, responseEnd: 16 };
  const request = { url: () => "http://localhost/livewire/update", method: () => "POST", timing: () => timing,
    postData: () => JSON.stringify({ _token: "secret-token", components: [{ snapshot: "secret-snapshot", calls: [], updates: {} }] }) };
  page.emit("request", request);
  page.emit("response", { request: () => request, url: request.url, status: () => 200,
    headers: () => ({ "content-type": "application/json", "set-cookie": "secret-cookie" }),
    text: async () => JSON.stringify({ components: [{ snapshot: "secret-snapshot", effects: {} }] }) });
  page.emit("requestfinished", request);
  await Promise.all(pending);
  assert.equal(network[0].requestId, network[2].requestId);
  assert.equal(network[2].kind, "native-livewire-response");
  assert.match(network[2].bodySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(network[3], { kind: "native-http-timing", requestId: network[0].requestId, url: request.url(), timing });
  assert.doesNotMatch(JSON.stringify(network), /secret/);
});

test("Laravel shared resource binding includes original Reverb overflow occupancy", () => {
  const resources = { queueEvents: 2, queuePeak: 2, inventory: { nativeSocketBufferBytes: null } };
  const frame = { kind: "native-websocket-received", response: { opcode: 1, payloadData: JSON.stringify({ event: "delivery", channel: "live." + "a".repeat(64), data: JSON.stringify({ packet: { kind: "overflow", resources } }) }) } };
  assert.deepEqual(wireResources([frame], "laravel-livewire"), [resources]);
});
