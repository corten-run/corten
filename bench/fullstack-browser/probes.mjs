import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readStore } from "./journey.mjs";

export function missingAction(action, itemId) {
  const match = /^(\/marketplace\/(?:en-US|fr-FR|de-DE)\/|\/api\/marketplace\/)(item_[1-9]\d*)$/.exec(action);
  assert.ok(match && match[2] === itemId, "native missing-record POST endpoint not discoverable");
  return match[1] + "item_missing";
}

// These are actual HTTP rejection probes, with native CSRF fields in memory and
// the browser's API cookie jar. They do not claim to test browser SameSite policy.
export async function mutationProbes({ browser, context, page, base, profile, readback }) {
  const evidence = { observer: randomUUID(), via: "same-cookie-native-http", before: null, otherContext: null, attempts: [], failures: [] };
  let other;
  try {
    const form = page.locator(".marketplace__alert form");
    const native = await form.evaluate((f) => ({ action: new URL(f.action).pathname, method: f.method.toUpperCase(),
      fields: [...new FormData(f)].filter(([, value]) => typeof value === "string") }));
    assert.equal(native.method, "POST");
    const accepted = profile.steps.find((s) => s.kind === "accepted-write");
    const fields = Object.fromEntries(native.fields);
    fields.email = `rejected-${profile.key}@example.test`; fields.target_price = accepted.input.target_price;
    evidence.before = await readStore(base, readback, context.request);
    assert.equal(evidence.before.outcome, "read", "independent readback required for mutation probes");
    other = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    evidence.otherContext = { before: await readStore(base, readback, other.request), after: null };
    assert.deepEqual(evidence.otherContext.before.alerts, [], "a separate native session starts nonempty");
    const specs = [
      { kind: "cross-site-origin", path: native.action, headers: { origin: "https://attacker.invalid" }, statuses: [400, 403, 419] },
      { kind: "cross-site-fetch-metadata", path: native.action, headers: { origin: base, "sec-fetch-site": "cross-site" }, statuses: [400, 403, 419] },
      { kind: "no-record", path: missingAction(native.action, profile.steps.at(-1).itemId), headers: { origin: base }, statuses: [404] },
    ];
    for (const spec of specs) {
      const row = { kind: spec.kind, path: spec.path, method: "POST", input: { email: fields.email, target_price: fields.target_price }, status: null, readback: null, failure: null };
      evidence.attempts.push(row);
      try {
        const response = await context.request.post(base + spec.path, { form: fields, headers: spec.headers, maxRedirects: 0, timeout: 15000 });
        row.status = response.status(); await response.body();
        // Read even if the rejection status is wrong, so a mutated store survives
        // in the evidence rather than being hidden behind the status assertion.
        row.readback = await readStore(base, readback, context.request);
        assert.deepEqual(row.readback.alerts, evidence.before.alerts, "rejected native POST mutated the store");
        assert.ok(spec.statuses.includes(row.status), `native ${spec.kind} returned HTTP ${row.status}`);
      } catch (e) { row.readback ??= e.readback ?? null; row.failure = e.message; evidence.failures.push(`${spec.kind}: ${e.message}`); }
    }
    evidence.otherContext.after = await readStore(base, readback, other.request);
    assert.deepEqual(evidence.otherContext.after.alerts, [], "native alert state crossed browser contexts");
  } catch (e) { evidence.failures.push(e.message); }
  finally { if (other) await other.close(); }
  return evidence;
}
