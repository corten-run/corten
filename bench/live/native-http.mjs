import { createHash } from "node:crypto";

const digest = (body) => createHash("sha256").update(body).digest("hex");
export const livewireUpdate = (url, method) => method === "POST" && /^\/livewire(?:\/|-).*update$/.test(new URL(url).pathname);

// Retain original effects and calls, never reusable CSRF tokens, cookies or signed snapshots.
export function livewireRequest(body) {
  const value = JSON.parse(body);
  return { components: value.components.map(({ snapshot, calls, updates }) => ({
    snapshotSha256: digest(snapshot), calls, updates,
  })) };
}
export const livewireResponse = (body) => ({ components: JSON.parse(body).components.map(({ effects }) => ({ effects })) });

export function captureHttp(page, network, pending, wire) {
  const identities = new WeakMap();
  let serial = 0;
  page.on("request", (request) => {
    const requestId = `http-${++serial}`; identities.set(request, requestId);
    const body = request.postData(), native = wire === "laravel-livewire" && livewireUpdate(request.url(), request.method());
    network.push({ kind: "request", requestId, at: performance.now(), method: request.method(), url: request.url(),
      body: native ? JSON.stringify(livewireRequest(body)) : body,
      ...(native ? { bodySha256: digest(body), bodyBytes: Buffer.byteLength(body) } : {}) });
  });
  page.on("response", (response) => {
    const request = response.request(), requestId = identities.get(request);
    const observation = { kind: "response", requestId, at: performance.now(), url: response.url(), status: response.status(),
      headers: Object.fromEntries(Object.entries(response.headers()).filter(([key]) => key.toLowerCase() !== "set-cookie")) };
    network.push(observation);
    if (wire === "laravel-livewire" && livewireUpdate(response.url(), request.method())) {
      const entry = { kind: "native-livewire-response", requestId, url: response.url(), status: response.status() };
      network.push(entry);
      pending.push(response.text().then((body) => {
        entry.bodySha256 = digest(body); entry.bodyBytes = Buffer.byteLength(body);
        entry.body = livewireResponse(body);
      }).catch(error => { entry.bodyError = error.message; }));
    } else if (response.headers()["content-type"]?.includes("application/json")) {
      pending.push(response.text().then(body => { observation.body = body; }, error => { observation.bodyError = error.message; }));
    }
  });
}

export async function captureHtml(page, wire) {
  if (wire !== "laravel-livewire") return page.content();
  return page.evaluate(() => {
    const html = document.documentElement.cloneNode(true);
    html.querySelectorAll("[wire\\:snapshot]").forEach(node => node.removeAttribute("wire:snapshot"));
    html.querySelectorAll('meta[name="csrf-token"], script:not([src])').forEach(node => node.remove());
    return "<!doctype html>" + html.outerHTML;
  });
}
