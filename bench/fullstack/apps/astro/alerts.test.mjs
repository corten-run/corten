import assert from "node:assert/strict";
import test from "node:test";
import { targetMinor, alertMessage } from "./src/lib/marketplace-view.ts";
import { ensureSession, appendAlert, readAlerts } from "./src/lib/alerts.server.ts";

test("opaque sessions preserve insertion order, isolate clients and copy stored rows", async () => {
  const a = ensureSession(undefined), b = ensureSession(undefined);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.notEqual(ensureSession("a".repeat(64)), "a".repeat(64));
  assert.deepEqual(readAlerts(a), []);
  const first = { item_id: "item_1", email: "one@example.test", target_minor: 123450 };
  assert.equal(appendAlert(a, first), a);
  first.email = "not stored";
  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
    assert.equal(appendAlert(a, { item_id: "item_2", email: `user${i}@example.test`, target_minor: i + 1 }), a);
  })));
  const rows = readAlerts(a);
  assert.equal(rows.length, 21);
  assert.equal(rows[0].email, "one@example.test");
  assert.deepEqual(rows.slice(1).map((row) => row.target_minor), Array.from({ length: 20 }, (_, i) => i + 1));
  rows[0].email = "not stored either";
  rows.push(first);
  assert.equal(readAlerts(a).length, 21);
  assert.equal(readAlerts(a)[0].email, "one@example.test");
  assert.deepEqual(readAlerts(b), []);
  assert.deepEqual(readAlerts("invalid"), []);
  assert.deepEqual(readAlerts(undefined), []);
});

test("localized targets produce safe positive integer minor units", () => {
  for (const locale of ["en-US", "fr-FR", "de-DE"]) {
    const local = (text) => locale === "en-US" ? text : text.replace(".", ",");
    for (const [text, minor] of [["70368744177664.01", 7036874417766401], ["90071992547409.91", Number.MAX_SAFE_INTEGER],
      ["0.01", 1], ["1.01", 101], ["0001.20", 120], ["1.005", 101], ["2.005", 201], ["12.505", 1251],
      ["9.995", 1000], ["0.005", 1], ["2.004999", 200], ["70368744177664.015", 7036874417766402],
      ["90071992547409.914", Number.MAX_SAFE_INTEGER]]) {
      assert.equal(targetMinor(locale, local(text)), minor, text);
      const digits = String(minor).padStart(3, "0");
      const price = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
        digits.slice(0, -2) + "." + digits.slice(-2));
      assert.ok(alertMessage(locale, "Synthetic", "exact@example.test", local(text)).includes(price), text);
    }
    for (const text of ["90071992547409.92", "90071992547409.915", "0.001", "0.004999", "1e2", "Infinity", "+1"]) {
      assert.equal(targetMinor(locale, local(text)), null, text);
    }
    assert.equal(targetMinor(locale, locale === "en-US" ? "1234.50" : "1234,50"), 123450);
    for (const target of ["0", "-1", "", "not-a-price", "9999999999999999999999999"]) assert.equal(targetMinor(locale, target), null);
    assert.equal(targetMinor(locale, locale === "en-US" ? "1,234.50" : "1.234,50"), null);
  }
});

test("a full session refuses an append without changing its stored alerts", () => {
  const token = ensureSession(undefined);
  const alert = { item_id: "item_1", email: "capacity@example.test", target_minor: 100 };
  for (let i = 0; i < 1000; i++) appendAlert(token, alert);
  assert.throws(() => appendAlert(token, alert), /Alert capacity exceeded/);
  assert.equal(readAlerts(token).length, 1000);
});

test("expired sessions cannot be adopted and reads never extend their lifetime", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const token = appendAlert(undefined, { item_id: "item_1", email: "expiry@example.test", target_minor: 100 });
  t.mock.timers.tick(3599000);
  assert.equal(readAlerts(token).length, 1);
  t.mock.timers.tick(1001);
  assert.deepEqual(readAlerts(token), []);
  assert.notEqual(ensureSession(token), token);
});
