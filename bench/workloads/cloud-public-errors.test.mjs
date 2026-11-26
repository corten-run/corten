import assert from "node:assert/strict";
import test from "node:test";
import { publicError } from "./droplet.mjs";

test("public controller errors retain closed stages and provider detail", () => {
  const error = Object.assign(new Error("SYNTHETIC_PRIVATE_RESPONSE"), {
    controllerStage: "controller-collect",
    providerDiagnostic: { code: "list-response-count", detail: "terminal-count-mismatch" },
  });
  const message = publicError(error);
  assert.ok(message.includes("Controller stage: controller-collect."));
  assert.ok(message.includes("Provider failure: list-response-count (terminal-count-mismatch)."));
  assert.ok(!message.includes(error.message));
  assert.ok(message.includes("Never relaunch."));
  assert.ok(!/success|confirmed|qualified/i.test(message));
});

test("public errors never evaluate accessors or reflect unknown diagnostic values", () => {
  const base = publicError(), raw = "SYNTHETIC_PRIVATE_RESPONSE";
  for (const field of ["controllerStage", "providerDiagnostic", "message", "stack"]) {
    const error = Object.create(null);
    Object.defineProperty(error, field, { get() { throw new Error(raw); } });
    assert.equal(publicError(error), base);
  }
  const inherited = Object.create({ controllerStage: "controller-launch", providerDiagnostic: { code: "account-request" } });
  assert.equal(publicError(inherited), base);
  for (const diagnostic of [{ code: "list-response-count", detail: raw },
    { code: "list-response-count", detail: "terminal-count-mismatch", raw },
    { code: "bootstrap-marker" }, { code: "bootstrap-marker", detail: raw },
    { code: "bootstrap-marker", detail: "local-control-uncertain", raw },
    { code: "bootstrap-marker", get detail() { throw new Error(raw); } },
    { code: "get-http", httpStatus: 499 }, { get code() { throw new Error(raw); } }]) {
    assert.equal(publicError({ controllerStage: raw, providerDiagnostic: diagnostic }), base);
  }
});

test("public error status formatting stays closed and independent of stage validity", () => {
  assert.equal(publicError({ controllerStage: "SYNTHETIC_PRIVATE_RESPONSE", providerDiagnostic: { code: "get-http", httpStatus: 403 } }),
    `${publicError()} Provider failure: get-http (HTTP 403).`);
  assert.equal(publicError({ controllerStage: "provider-settlement" }),
    `${publicError()} Controller stage: provider-settlement.`);
  assert.equal(publicError({ controllerStage: "controller-audit", providerDiagnostic: { code: "account-request" } }),
    `${publicError()} Controller stage: controller-audit. Provider failure: account-request.`);
});

test("public collect replay stages expose no private cause or success claim", () => {
  for (const stage of ["collect-native-replay-start", "collect-native-replay-deadline", "collect-native-replay-interrupted",
    "collect-native-replay-refused", "collect-native-report-refused", "collect-native-evidence-refused"]) {
    assert.equal(publicError(Object.assign(new Error("PRIVATE_NATIVE_REPLAY"), { controllerStage: stage })),
      `${publicError()} Controller stage: ${stage}.`);
  }
});
