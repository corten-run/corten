import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import * as provider from "./cloud-provider.mjs";
import { productionMain } from "./cloud-production.mjs";
import { publicError } from "./droplet.mjs";
import { providerDiagnostic, unsentCreate } from "./cloud-options.mjs";
import { accountId, campaign, commit, context, harness as controllerHarness, subject, syntheticDelivery } from "./cloud-fixtures.mjs";
import { settlementControl } from "./test-fixtures/provider-settlement-control.mjs";

const account = ["account", "get", "--output", "json", "--context", "synthetic-worker-context"];
function harness(t, mode = "success", transform = (value) => value, interrupted = () => false, receive = (value) => value, createMode = "dedicated") {
  const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), output = join(root, "observation.json");
  let child, tokenIPC = false, launches = 0;
  const run = provider.providerTransport({ repo: resolve("."), interrupted, createMode, launch(path, args, options) {
    launches++; assert.equal(path, realpathSync(process.execPath)); assert.equal(args.length, 3);
    assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-"]); assert.ok(args[2].endsWith("cloud-provider-worker.mjs"));
    assert.deepEqual(options.execArgv, []); assert.equal(options.stdio[0], "pipe");
    assert.equal(options.stdio[1], "ignore"); assert.equal(options.stdio[2], "ignore");
    assert.ok(!Object.keys(options.env).some((name) => /^(?:NODE_|SSL|OPENSSL|LD_|DYLD_)/i.test(name)));
    child = fork(fileURLToPath(new URL("cloud-provider-test-worker.mjs", import.meta.url)), [mode, output],
      { ...options, env: { ...options.env, NODE_OPTIONS: "--max-old-space-size=128" } });
    const emit = child.emit.bind(child);
    child.emit = (name, ...args) => emit(name, ...(name === "message" ? [receive(args[0]), ...args.slice(1)] : args));
    child.on("message", (value) => { tokenIPC ||= JSON.stringify(value).includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL"); });
    const send = child.send.bind(child); child.send = (message, callback) => send(transform(message), callback);
    return child;
  } });
  t.after(async () => {
    try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); }
    assert.equal(tokenIPC, false); rmSync(root, { recursive: true, force: true });
  });
  return { run, state: () => JSON.parse(readFileSync(output)), get child() { return child; }, get launches() { return launches; } };
}

test("clean worker uses one immutable private credential across account/create/action/list/delete", async (t) => {
  for (const mode of ["success", "scoped-create-link"]) await t.test(mode, async (t) => {
  const h = harness(t, mode);
  assert.equal(JSON.parse((await h.run(account)).stdout).uuid, "synthetic-user-0001");
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
  await h.run(create); await h.run(["compute", "droplet", "list", "--output", "json", ...account.slice(-2)]);
  await h.run(["compute", "droplet", "delete", "123", "--force", ...account.slice(-2)]);
  const state = h.state(); assert.equal(state.consumes, 1); assert.equal(state.requests, 5); assert.equal(h.launches, 1);
  assert.deepEqual(state.calls.map((value) => value.method), ["GET", "POST", "GET", "GET", "DELETE"]);
  assert.equal(state.calls[2].path, "/v2/actions/456", "href hints must never select the action GET path");
  assert.ok(state.calls.every((value) => value.originalCredential));
  await h.run.close(); assert.notEqual(h.child.exitCode, null);
  await assert.rejects(h.run(account));
  });
});

test("worker create mode accepts only its pinned size, region and image; recovery cannot create", async (t) => {
  for (const [createMode, region, allowed, size = "c-8", image = "ubuntu-24-04-x64"] of [["legacy", "sfo2", true], ["dedicated", "sfo3", true],
    ["legacy", "sfo3", false], ["dedicated", "sfo2", false], ["dedicated", "nyc1", false], [null, "sfo3", false], ["sfo3", "sfo3", false],
    ["dedicated-sfo2", "sfo2", true], ["dedicated-sfo2", "sfo3", false], ["dedicated-sfo2", "sfo2", false, "c-16"],
    ["dedicated-lon1", "lon1", true], ["dedicated-blr1", "blr1", true], ["dedicated-lon1", "blr1", false],
    ["dedicated-blr1", "nyc1", false], ["dedicated-blr1", "blr1", false, "c-16"], ["dedicated-lon1", "lon1", false, "c-8", "other-image"],
    ["dedicated-nyc1", "nyc1", false],
    ["c16-generator-v1", "sfo2", true, "c-16"], ["c16-generator-v1", "sfo2", false],
    ["c16-generator-v1", "sfo3", false, "c-16"], ["c16-generator-v1", "lon1", false, "c-16"], ["dedicated", "sfo3", false, "c-16"],
    ["json-c32-generator-v1", "sfo2", true, "c-32"], ["json-c32-generator-v1", "sfo2", false, "c-16"],
    ["json-c32-generator-v1", "sfo3", false, "c-32"], ["json-c16-generator-v1", "sfo2", false, "c-32"]]) {
    await t.test(`${createMode}: ${size}/${region}/${image}`, async (t) => {
      const forged = ["sfo3", "dedicated-nyc1"].includes(createMode);
      if (forged) assert.throws(() => provider.providerTransport({ repo: resolve("."), createMode }), /unknown provider create mode/);
      const h = forged
        ? harness(t, "success", (message) => message.sources ? { ...message, createMode } : message)
        : harness(t, "success", undefined, undefined, undefined, createMode);
      const create = ["compute", "droplet", "create", "corten-bench-groups-r25-0123456789abcdef", "--size", size, "--region", region,
        "--image", image, "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef",
        "--wait", "--output", "json", ...account.slice(-2)];
      if (allowed) {
        assert.equal((await h.run(create)).status, 0);
        const listed = JSON.parse((await h.run(["compute", "droplet", "list", "--output", "json", ...account.slice(-2)])).stdout);
        assert.equal(listed[0].region.slug, region);
        assert.equal(listed[0].size_slug, size);
        const posts = h.state().calls.filter(({ method }) => method === "POST");
        assert.deepEqual(posts.map(({ path }) => path), ["/v2/droplets"]);
      } else {
        await assert.rejects(h.run(create));
        assert.equal(h.state().consumes, 0);
        assert.equal(h.state().requests, 0);
      }
    });
  }
});

test("strict worker grammar/source handshake refuses URL/sequence/context changes without fallback", async (t) => {
  for (const kind of ["url", "sequence", "source", "extra", "context"]) await t.test(kind, async (t) => {
    const h = harness(t, "success", (message) => {
      if (kind === "source" && message.sources) return { ...message, sources: message.sources.map((value) => ({ ...value, sha256: "0".repeat(64) })) };
      if (message.schema !== "cloud-provider-action/v1") return message;
      if (kind === "url") return { ...message, args: ["GET", "https://synthetic.invalid"] };
      if (kind === "sequence") return { ...message, sequence: 9 };
      if (kind === "extra") return { ...message, providerURL: "https://synthetic.invalid" };
      return message;
    });
    if (kind === "context") { await h.run(account); await assert.rejects(h.run([...account.slice(0, -1), "synthetic-other-context"])); }
    else await assert.rejects(h.run(account), (error) => error.controlTreeUncertain === true);
    assert.equal(h.state().consumes, kind === "context" ? 1 : 0);
    assert.equal(h.state().requests, kind === "context" ? 1 : 0);
    assert.equal(h.launches, 1); await assert.rejects(h.run(account));
  });
});

test("provider response reflecting a token never crosses IPC", async (t) => {
  const h = harness(t, "reflect"); await assert.rejects(h.run(account), (error) => error.controlUncertain === true);
  assert.equal(h.state().consumes, 1); assert.equal(h.state().requests, 1);
});

test("failed-native absolute DELETE expiry crosses real worker IPC unchanged and expired actions never dispatch", async (t) => {
  const deletion = ["compute", "droplet", "delete", "123", "--force", ...account.slice(-2)];
  const expires = Date.now() + 60000;
  let received;
  const good = harness(t, "success", (message) => {
    if (message.schema === "cloud-provider-action/v1") received = message.deleteProofExpiresAtMs;
    return message;
  });
  assert.equal((await good.run(deletion, 120000, false, expires)).status, 0);
  assert.equal(received, expires); assert.equal(good.state().calls.filter((v) => v.method === "DELETE").length, 1);
  const unsent = harness(t, "success");
  assert.deepEqual(await unsent.run(deletion, 120000, true, Date.now() - 1),
    { status: 1, stdout: "", stderr: "", deleteNotDispatched: true });
  assert.equal(unsent.state().requests, 0);
  const foreign = harness(t, "success", undefined, undefined, message => message.sequence === 1
    ? { ...message, result: { status: 1, stdout: "", stderr: "", deleteNotDispatched: true } } : message);
  await assert.rejects(foreign.run(account, 120000, true), error => error.controlTreeUncertain === true);
  for (const value of [Date.now() - 1, Date.now() + 120000, null, "expired"]) {
    const bad = harness(t, "success", (message) => message.schema === "cloud-provider-action/v1"
      ? { ...message, deleteProofExpiresAtMs: value } : message);
    await assert.rejects(bad.run(deletion, 120000, false, Date.now() + 60000));
    assert.equal(bad.state().calls.filter((v) => v.method === "DELETE").length, 0);
  }
  const read = harness(t, "success", (message) => message.schema === "cloud-provider-action/v1"
    ? { ...message, deleteProofExpiresAtMs: Date.now() + 60000 } : message);
  await assert.rejects(read.run(account)); assert.equal(read.state().requests, 0);
});

test("bounded create classifications survive real worker IPC and cached teardown to public output", async (t) => {
  for (const [mode, diagnostic, requests] of [
    ["post-link-shape", { code: "create-link-shape" }, 1],
    ["post-link-count", { code: "create-link-count" }, 1],
    ["post-link-id", { code: "create-link-id" }, 1],
    ["post-invalid-action-id", { code: "create-link-id" }, 1],
    ["first-action-invalid", { code: "create-action-response" }, 2],
    ["pending-create", { code: "create-action-pending" }, 2],
    ["first-action-http-failure", { code: "create-action-http", httpStatus: 403 }, 2],
  ]) await t.test(mode, async (t) => {
    const h = harness(t, mode);
    const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
      "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
    const check = (error) => {
      assert.equal(error.controlTreeUncertain, true); assert.equal(error.controlUncertain, true);
      assert.deepEqual(error.providerDiagnostic, diagnostic);
      const output = publicError(error);
      assert.ok(output.includes(`Provider failure: ${diagnostic.code}`));
      assert.equal(output.includes("HTTP 403"), diagnostic.httpStatus === 403);
      assert.ok(!`${output}${error.stack}${JSON.stringify(error)}`.includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL"));
      return true;
    };
    await assert.rejects(h.run(create, 500), check);
    await assert.rejects(h.run.close(), check); await assert.rejects(h.run.close(), check);
    assert.equal(h.state().requests, requests); assert.equal(h.launches, 1);
    assert.ok(h.child.exitCode !== null || h.child.signalCode !== null);
  });
});

test("closed census predicate diagnostics survive real worker IPC and cached teardown", async (t) => {
  for (const predicate of ["shape", "total", "id", "duplicate", "links", "pages", "next", "count", "bounds"]) await t.test(predicate, async (t) => {
    const h = harness(t, `list-${predicate}`), diagnostic = { code: `list-response-${predicate}`,
      ...(predicate === "count" ? { detail: "terminal-count-mismatch" } : {}) };
    const check = (error) => {
      assert.equal(error.controlTreeUncertain, true); assert.equal(error.controlUncertain, true);
      assert.deepEqual(error.providerDiagnostic, diagnostic);
      assert.equal(publicError(error), `${publicError()} Provider failure: ${diagnostic.code}${diagnostic.detail ? ` (${diagnostic.detail})` : ""}.`);
      assert.ok(!`${publicError(error)}${error.stack}${JSON.stringify(error)}`.includes("SYNTHETIC_ONLY_DIAGNOSTIC_CREDENTIAL"));
      return true;
    };
    await assert.rejects(h.run(["compute", "droplet", "list", "--output", "json", ...account.slice(-2)], predicate === "count" ? 200000 : 1000), check);
    await assert.rejects(h.run.close(), check); await assert.rejects(h.run.close(), check);
    const state = h.state(); assert.equal(state.requests, predicate === "count" ? 100 : 1);
    assert.equal(state.consumes, 1); assert.equal(h.launches, 1);
    assert.ok(state.calls.every((call) => call.method === "GET" && call.path === "/v2/droplets?page=1&per_page=200"));
    assert.ok(h.child.exitCode !== null || h.child.signalCode !== null);
  });
});

test("unknown, extra or non-table IPC diagnostic values fail closed without public reflection", async (t) => {
  const raw = "SYNTHETIC_RAW_BODY";
  for (const result of [{ code: raw }, { code: "create-link", raw }, { code: "create-action-http", httpStatus: raw },
    { code: "create-action-http", httpStatus: 499 }, { code: "create-link", httpStatus: 403 }, ["create-link"],
    { code: "create-link-href", raw }, { code: "create-link-id", httpStatus: 403 }, { code: "create-link-private" },
    { code: "list-response-next", raw }, { code: "list-response-count", httpStatus: 403 }, { code: "list-response-private" },
    { code: "create-link-href", detail: raw }, { code: "create-link-href", detail: { raw } },
    { code: "create-link-href", detail: "foreign-origin", raw }, { code: "create-link-href", detail: "foreign-origin", httpStatus: 403 },
    { code: "get-http", httpStatus: 404, detail: "foreign-origin" }, { code: "list-response-count", detail: "foreign-origin" }]) {
    const h = harness(t, "reflect", undefined, undefined, (message) => message.ok === false ? { ...message, result } : message);
    await assert.rejects(h.run(account), (error) => {
      assert.equal(error.controlUncertain, true); assert.equal(error.providerDiagnostic, undefined);
      assert.ok(!publicError(error).includes(raw)); return true;
    });
    assert.equal(h.launches, 1);
  }
});

test("public errors only format the closed diagnostic table, never native error fields or getters", () => {
  const raw = "SYNTHETIC_RAW_BODY", base = publicError();
  const native = Object.assign(new Error(raw), { code: raw, status: 403, body: raw });
  assert.equal(publicError(native), base);
  for (const value of [null, { code: raw }, { code: "create-link", raw }, { code: "create-action-http", httpStatus: 499 },
    { code: "create-link", httpStatus: 403 }, { get code() { throw new Error(raw); } }]) {
    assert.equal(providerDiagnostic(value), undefined);
    assert.equal(publicError(Object.assign(native, { providerDiagnostic: value })), base);
  }
  Object.defineProperty(native, "providerDiagnostic", { get() { throw new Error(raw); } });
  assert.equal(publicError(native), base);
  assert.deepEqual(providerDiagnostic({ code: "create-action-http", httpStatus: 403 }), { code: "create-action-http", httpStatus: 403 });
});

test("permitted HTTP failure carries only its diagnostic and leaves the worker usable", async (t) => {
  const h = harness(t, "first-action-http-failure");
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
  assert.deepEqual(await h.run(create, 1000, true), { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-action-http", httpStatus: 403 } });
  assert.equal((await h.run(account)).status, 0); await h.run.close();
  assert.equal(h.state().consumes, 1); assert.equal(h.launches, 1);
});

test("supported lifecycle real worker retains one private credential through known create refusals and recovery GET", async (t) => {
  for (const [mode, code] of [["post-link-shape", "create-link-shape"], ["post-link-count", "create-link-count"],
    ["post-link-id", "create-link-id"], ["post-invalid-action-id", "create-link-id"],
    ["first-action-invalid", "create-action-response"]]) await t.test(mode, async (t) => {
    const h = harness(t, mode), suffix = account.slice(-2);
    const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
      "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...suffix];
    assert.deepEqual(await h.run(create, 1000, true), { status: 1, stdout: "", stderr: "", providerDiagnostic: {
      code } });
    assert.equal((await h.run(account)).status, 0);
    const rows = JSON.parse((await h.run(["compute", "droplet", "list", "--output", "json", ...suffix])).stdout);
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 123);
    const exact = JSON.parse((await h.run(["compute", "droplet", "get", "123", "--output", "json", ...suffix])).stdout);
    assert.equal(exact.length, 1); assert.equal(exact[0].id, 123);
    await h.run.close();
    const state = h.state(); assert.equal(state.consumes, 1); assert.equal(h.launches, 1);
    assert.ok(state.calls.every((call) => call.originalCredential));
    assert.equal(state.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(state.calls.some((call) => call.method === "DELETE"), false);
    assert.ok(h.child.exitCode !== null || h.child.signalCode !== null);
  });
});

test("pre-create census worker preserves the census fields, refuses other modes and never retakes", async (t) => {
  const suffix = account.slice(-2), hash = (text) => createHash("sha256").update(text).digest("hex");
  const census = (name, tag) => ["compute", "droplet", "list", "--pre-create-census", `${hash(name)}:${hash(tag)}`, "--output", "json", ...suffix];
  const list = census("saved-name", "saved-tag");
  await t.test("complete projection", async (t) => {
    const h = harness(t), name = "corten-bench-groups-r21-0123456789abcdef";
    const tags = ["corten-bench", "corten-bench-groups", "corten-bench-groups-run-0123456789abcdef"];
    await h.run(["compute", "droplet", "create", name, "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
      "--ssh-keys", "42", "--tag-names", tags.join(","), "--wait", "--output", "json", ...suffix]);
    assert.deepEqual(JSON.parse((await h.run(list)).stdout), { complete: true, rows: [{ id: 123, name, tags,
      size_slug: "c-8", region: { slug: "sfo3" }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } }] });
    assert.deepEqual(h.state().calls.filter(({ path }) => path.startsWith("/v2/droplets?")).map(({ path }) => path),
      ["/v2/droplets?page=1&per_page=200"]);
  });
  await t.test("incomplete or malformed reply", async (t) => {
    for (const mode of ["list-converges", "list-next", "list-last", "list-shape"]) {
      const h = harness(t, mode);
      assert.deepEqual(JSON.parse((await h.run(list)).stdout), { complete: false, rows: [] });
      assert.equal((await h.run(account)).status, 0, "the same worker can bracket the reply");
      assert.deepEqual(h.state().calls.map(({ path }) => path), ["/v2/droplets?page=1&per_page=200", "/v2/account"]);
      await h.run.close();
    }
  });
  await t.test("independently checkable sightings survive a malformed field", async (t) => {
    const h = harness(t, "list-partial");
    assert.deepEqual(JSON.parse((await h.run(list)).stdout), { complete: false,
      rows: [{ id: 123, name: "saved-name" }] });
    assert.deepEqual(JSON.parse((await h.run(census("unrelated-name", "saved-tag"))).stdout), { complete: false,
      rows: [{ id: 124, tags: ["saved-tag"] }] });
  });
  await t.test("a sighting beyond an absence bound is not discarded", async (t) => {
    const h = harness(t, "list-oversized");
    const value = JSON.parse((await h.run(census("unrelated-name", "saved-tag"))).stdout);
    assert.deepEqual(value, { complete: false, rows: [{ id: 201, tags: ["saved-tag"] }] });
    assert.deepEqual(h.state().calls.map(({ path }) => path), ["/v2/droplets?page=1&per_page=200"]);
  });
  await t.test("a compact sighting crosses IPC even when the input nearly fills the HTTP limit", async (t) => {
    const h = harness(t, "list-ipc-bound");
    const value = JSON.parse((await h.run(census("unrelated-name", "saved-tag"))).stdout);
    assert.deepEqual(value, { complete: false, rows: [{ id: 201, tags: ["saved-tag"] }] });
    assert.deepEqual(h.state().calls.map(({ path }) => path), ["/v2/droplets?page=1&per_page=200"]);
  });
  await t.test("missing or malformed targets never issue a request", async (t) => {
    for (const targets of [[], ["not-a-digest"], [list[4], list[4]]]) {
      const h = harness(t, "success");
      await assert.rejects(h.run([...list.slice(0, 4), ...targets, ...list.slice(5)]));
      assert.equal(h.state().requests, 0);
    }
  });
  await t.test("no create mode", async (t) => {
    const h = harness(t, "success", undefined, undefined, undefined, null);
    await assert.rejects(h.run(list));
    assert.equal(h.state().requests, 0);
  });
});

test("provider-errored create crosses real worker IPC with only its exact IDs and leaves the worker usable", async (t) => {
  const h = harness(t, "first-action-errored"), suffix = account.slice(-2);
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...suffix];
  assert.deepEqual(await h.run(create, 1000, true), { status: 1, stdout: '[{"id":123,"actionId":456}]', stderr: "",
    providerDiagnostic: { code: "create-action-errored" } });
  assert.deepEqual(await h.run(["compute", "droplet", "get", "123", "--output", "json", ...suffix], 1000, true),
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } });
  assert.deepEqual(JSON.parse((await h.run(["compute", "droplet", "list", "--output", "json", ...suffix])).stdout), []);
  // The absence census is its own fixed command across the same worker.
  assert.deepEqual(JSON.parse((await h.run(["compute", "droplet", "list", "--single-response", "--output", "json", ...suffix])).stdout), []);
  await h.run.close();
  const state = h.state(); assert.equal(state.consumes, 1); assert.equal(h.launches, 1);
  assert.ok(state.calls.every((call) => call.originalCredential));
  assert.equal(state.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(state.calls.some((call) => call.method === "DELETE"), false);
});

test("create-errored IPC output outside an allowed create or with any other shape fails closed", async (t) => {
  const suffix = account.slice(-2), identity = '[{"id":123,"actionId":456}]';
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...suffix];
  const errored = (stdout = identity, code = "create-action-errored") => ({ status: 1, stdout, stderr: "", providerDiagnostic: { code } });
  for (const [args, allowFail, result] of [
    [account, true, errored()], [["compute", "droplet", "get", "123", "--output", "json", ...suffix], true, errored()],
    [create, false, errored()], [create, true, errored("")], [create, true, errored('[{"id":123}]')],
    [create, true, errored('[{"id":123,"actionId":456,"raw":"SYNTHETIC_RAW_BODY"}]')], [create, true, errored('[{"id":0,"actionId":456}]')],
    [create, true, errored(' [{"id":123,"actionId":456}]')], [create, true, errored(identity, "create-action-response")],
    [create, true, { ...errored(), stderr: "SYNTHETIC_RAW_BODY" }],
  ]) {
    const h = harness(t, "success", undefined, undefined, (message) => message.sequence === 1 && message.ok ? { ...message, result } : message);
    await assert.rejects(h.run(args, 1000, allowFail), (error) => error.controlTreeUncertain === true);
  }
});

test("a pending-create envelope crosses IPC only on a rejected, permitted create with two canonical IDs", async (t) => {
  const suffix = account.slice(-2), ids = { dropletId: "123", actionId: "456" };
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...suffix];
  const rejected = (pendingCreate) => (message) => message.sequence === 1
    ? { schema: message.schema, nonce: message.nonce, sequence: 1, ok: false, result: null, pendingCreate } : message;
  const positive = harness(t, "success", undefined, undefined, rejected(ids));
  await assert.rejects(positive.run(create, 1000, true), (error) => error.controlTreeUncertain === true
    && JSON.stringify(error.pendingCreate) === JSON.stringify(ids));
  for (const [name, args, allowFail, receive] of [
    ["account command", account, true, rejected(ids)], ["create without permission to fail", create, false, rejected(ids)],
    ["leading zero", create, true, rejected({ ...ids, dropletId: "0123" })], ["numeric ID", create, true, rejected({ ...ids, actionId: 456 })],
    ["zero ID", create, true, rejected({ ...ids, dropletId: "0" })], ["unsafe ID", create, true, rejected({ ...ids, dropletId: "9007199254740993" })],
    ["extra key", create, true, rejected({ ...ids, raw: "SYNTHETIC_RAW_BODY" })],
    ["successful reply", create, true, (message) => message.sequence === 1 ? { ...message, pendingCreate: ids } : message],
  ]) {
    const h = harness(t, "success", undefined, undefined, receive);
    await assert.rejects(h.run(args, 1000, allowFail), (error) => error.controlTreeUncertain === true && error.pendingCreate === undefined, name);
  }
});

test("supported lifecycle real worker GET404 is explicit absence and does not poison the credential worker", async (t) => {
  const h = harness(t), get = ["compute", "droplet", "get", "123", "--output", "json", ...account.slice(-2)];
  assert.deepEqual(await h.run(get, 1000, true), { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "get-http", httpStatus: 404 } });
  assert.equal((await h.run(account)).status, 0); await h.run.close();
  assert.equal(h.state().consumes, 1); assert.equal(h.state().requests, 2); assert.equal(h.launches, 1);
  assert.ok(h.state().calls.every((call) => call.method === "GET" && call.originalCredential));
});

test("supported lifecycle GET failure or malformed grammar never becomes absence in real IPC", async (t) => {
  for (const kind of ["http503", "404-not-allowed", "id", "unsafe-integer", "url", "suffix"]) await t.test(kind, async (t) => {
    const h = harness(t, kind === "http503" ? "get-http-failure" : "success");
    const get = ["compute", "droplet", "get", { id: "01", "unsafe-integer": "9007199254740992", url: "https://foreign.invalid" }[kind] ?? "123", "--output", "json", ...account.slice(-2)];
    if (kind === "suffix") get.splice(4, 2, "--url", "https://foreign.invalid");
    await assert.rejects(h.run(get, 1000, kind !== "404-not-allowed"), (error) => error.controlUncertain === true);
    assert.equal(h.state().requests, ["http503", "404-not-allowed"].includes(kind) ? 1 : 0);
    assert.equal(h.launches, 1);
  });
});

test("supported lifecycle IPC rejects an unpermitted status1 or non404 GET failure result", async (t) => {
  for (const kind of ["not-allowed", "wrong-status", "wrong-code"]) await t.test(kind, async (t) => {
    const diagnostic = kind === "wrong-code" ? { code: "create-http", httpStatus: 404 } : { code: "get-http", httpStatus: 503 };
    const h = harness(t, "success", undefined, undefined, (message) => message.ok && message.sequence > 0
      ? { ...message, result: { status: 1, stdout: "", stderr: "", providerDiagnostic: diagnostic } } : message);
    const args = kind === "not-allowed" ? account : ["compute", "droplet", "get", "123", "--output", "json", ...account.slice(-2)];
    await assert.rejects(h.run(args, 1000, kind !== "not-allowed"), (error) => error.controlUncertain === true);
    assert.equal(h.launches, 1);
  });
});

test("supported lifecycle real worker count convergence passes its third observation and closes normally", async (t) => {
  const h = harness(t, "list-converges");
  assert.equal(JSON.parse((await h.run(["compute", "droplet", "list", "--output", "json", ...account.slice(-2)], 5000)).stdout).length, 0);
  assert.equal((await h.run(account)).status, 0); await h.run.close();
  assert.equal(h.state().requests, 4); assert.equal(h.state().consumes, 1); assert.equal(h.launches, 1);
});

test("unused arbitrary create metadata never crosses real IPC or selects requests", async (t) => {
  for (const mode of ["post-link-rel", "post-link-href-variant", "post-link-href-type", "arbitrary-create-hints"]) await t.test(mode, async (t) => {
    const h = harness(t, mode);
    const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
      "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
    assert.deepEqual(await h.run(create, 1000, true), { status: 0, stdout: '[{"id":123}]', stderr: "" });
    assert.equal((await h.run(account)).status, 0); await h.run.close();
    assert.equal(h.state().requests, 3); assert.equal(h.state().consumes, 1);
    assert.deepEqual(h.state().calls.map(({ method, path }) => [method, path]), [["POST", "/v2/droplets"], ["GET", "/v2/actions/456"], ["GET", "/v2/account"]]);
  });
});

test("success IPC cannot smuggle diagnostics, unknown fields or nonempty failed output", async (t) => {
  for (const result of [
    { status: 0, stdout: "", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 403 } },
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "SYNTHETIC_RAW_BODY" } },
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 499 } },
    { status: 1, stdout: "SYNTHETIC_RAW_BODY", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 403 } },
    { status: 1, stdout: "", stderr: "", providerDiagnostic: { code: "create-http", httpStatus: 403 }, raw: "SYNTHETIC_RAW_BODY" },
  ]) {
    const h = harness(t, "success", undefined, undefined, (message) => message.ok && message.result?.status === 0 ? { ...message, result } : message);
    await assert.rejects(h.run(account), (error) => {
      assert.equal(error.controlTreeUncertain, true); assert.equal(error.providerDiagnostic, undefined);
      assert.ok(!publicError(error).includes("SYNTHETIC_RAW_BODY")); return true;
    });
    assert.equal(h.launches, 1);
  }
});

test("cancellation at the create transport boundary never sends an action to the worker", async (t) => {
  let cancelled = false;
  const h = harness(t, "success", undefined, () => cancelled);
  await h.run(account);
  cancelled = true;
  const create = ["compute", "droplet", "create", "corten-bench-groups-r21-0123456789abcdef", "--size", "c-8", "--region", "sfo3", "--image", "ubuntu-24-04-x64",
    "--ssh-keys", "42", "--tag-names", "corten-bench,corten-bench-groups,corten-bench-groups-run-0123456789abcdef", "--wait", "--output", "json", ...account.slice(-2)];
  assert.equal(await h.run(create, 60000, true), unsentCreate);
  await h.run.close();
  assert.deepEqual(h.state().calls.map(({ method }) => method), ["GET"]);
});

test("deadline and cancellation reap an unsettled worker, preserve uncertainty and never retry", async (t) => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancel" : "deadline", async (t) => {
    let interrupted = false;
    const h = harness(t, "hang", undefined, () => interrupted);
    const running = h.run(account, cancel ? 5000 : 100);
    const timer = cancel ? setTimeout(() => { interrupted = true; }, 300) : undefined;
    try { await assert.rejects(running, (error) => error.controlTreeUncertain === true && error.controlUncertain === true); }
    finally { clearTimeout(timer); }
    assert.ok(h.child.exitCode !== null || h.child.signalCode !== null); assert.equal(h.launches, 1);
    await assert.rejects(h.run(account));
  });
});

test("parent disconnect reaps its idle credential worker", async (t) => {
  const h = harness(t); await h.run(account);
  const exit = once(h.child, "exit"); h.child.disconnect();
  let timer;
  try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned worker did not exit")), 2000); })]); }
  finally { clearTimeout(timer); }
  assert.notEqual(h.child.exitCode, null);
});

test("controller exposes no direct credential-taking REST constructor", () => {
  assert.equal(provider.restRequest, undefined);
});

test("pinned collect retires a refused create through the actual worker without another POST", async (t) => {
  const h = controllerHarness(t, { missingUnit: true }), w = harness(t, "post-invalid-action-id", undefined, undefined, undefined, "legacy");
  const run = (binary, args, timeout, allowFail) => binary === "doctl" ? w.run(args, timeout, allowFail) : h.run(binary, args, timeout, allowFail);
  await assert.rejects(h.launch({ run }).launch(), /create completion/);
  assert.equal(h.saved().status, "preparing"); assert.equal(h.saved().id, "123");
  assert.equal(h.calls.some(([binary]) => binary === "ssh" || binary === "scp"), false);
  assert.equal(await h.pinnedUnused({ run }).collect(), 1);
  assert.equal(h.saved().status, "retired"); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().archiveSha256, undefined); assert.equal(h.saved().validation, undefined);
  assert.equal(await h.pinnedUnused({ run }).collect(), 1);
  assert.equal(w.state().consumes, 1);
  assert.equal(w.state().calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(w.state().calls.filter(({ method }) => method === "DELETE").length, 1);
  assert.ok(w.state().calls.filter(({ path }) => path === "/v2/droplets/123").length > 1);
});

test("approved productionMain reaps the actual clean worker and retains locks for uncertain create", async (t) => {
  for (const mode of ["success", "hang-create", "withhold-close", "post-invalid-action-id", "first-action-http-failure", "zero-resource-create", "create-http-failure"]) await t.test(mode, async (t) => {
  const h = controllerHarness(t, { active: true }), workers = [];
  let approval;
  const interrupted = () => {
    if (mode !== "hang-create" || !workers[1]) return false;
    try { return workers[1].state().calls.some((value) => value.method === "POST"); } catch { return false; }
  };
  const deps = { ...settlementControl(t, h), repo: h.repo, interrupted, sleep: async () => {}, inspect: async () => h.report(),
    write(value) { approval = JSON.parse(value).approvalSha256; },
    providerFactory({ interrupted, createMode }) { const w = harness(t, mode, undefined, interrupted, undefined, createMode); workers.push(w); return w.run; } };
  const args = ["r21", "--state-dir", h.base, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  assert.equal(await productionMain([...args, "--print-approval"], deps), 3);
  assert.equal(workers[0].launches, 0);
  const launched = productionMain([...args, "--approve-reviewed-merged-ready", approval], deps);
  const completed = ["success", "zero-resource-create"].includes(mode);
  if (completed) assert.equal(await launched, 3);
  else await assert.rejects(launched, (error) => {
    assert.equal(error.controlTreeUncertain === true, ["hang-create", "withhold-close"].includes(mode));
    if (mode === "post-invalid-action-id") {
      assert.deepEqual(error.providerDiagnostic, { code: "create-link-id" });
      assert.ok(publicError(error).includes("Provider failure: create-link-id"));
    }
    if (mode === "create-http-failure") {
      assert.deepEqual(error.providerDiagnostic, { code: "create-http", httpStatus: 422 });
      assert.ok(publicError(error).includes("Provider failure: create-http (HTTP 422)."));
    }
    return true;
  });
  const worker = workers[1]; assert.equal(worker.state().consumes, 1);
  assert.equal(worker.state().calls.filter((value) => value.method === "POST").length, 1);
  const unboundFailure = ["hang-create", "create-http-failure"].includes(mode);
  const knownFailure = ["post-invalid-action-id", "first-action-http-failure"].includes(mode);
  assert.equal(h.saved().status, unboundFailure ? "creating" : knownFailure ? "preparing" : "running");
  if (completed || mode === "withhold-close") {
    assert.equal(h.saved().control.monitor.phase, "closed");
    assert.ok(h.saved().control.sealed.includes("bootstrap"));
  }
  if (unboundFailure || knownFailure) {
    assert.equal(Object.hasOwn(h.saved(), "id"), knownFailure);
    assert.equal(h.calls.some(([binary]) => binary === "ssh" || binary === "scp"), false);
    if (mode !== "first-action-http-failure") assert.equal(worker.state().calls.filter(({ path }) => path === "/v2/actions/456").length, 0);
  }
  if (mode === "first-action-http-failure" || mode === "zero-resource-create")
    assert.equal(worker.state().calls.filter(({ path }) => path === "/v2/actions/456").length, mode === "zero-resource-create" ? 2 : 1);
  assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null);
  if (["hang-create", "withhold-close"].includes(mode)) {
    assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
  } else {
    assert.equal(existsSync(join(h.local, "operation.lock")), false); assert.equal(existsSync(join(h.base, ".groups-launch.lock")), false);
  }
  });
});

test("unlisted future executable imports are denied before evaluation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), directory = join(root, "bench", "workloads"), marker = join(root, "synthetic-executed.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of provider.providerFiles) {
    const target = resolve(directory, name); mkdirSync(resolve(target, ".."), { recursive: true });
    copyFileSync(fileURLToPath(new URL(name, new URL("./", import.meta.url))), target);
  }
  writeFileSync(join(directory, "synthetic-unlisted.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(2);\n`);
  appendFileSync(join(directory, "cloud-provider-engine.mjs"), "\nimport './synthetic-unlisted.mjs';\n");
  const staged = await import(pathToFileURL(join(directory, "cloud-provider.mjs")).href), run = staged.providerTransport({ repo: root });
  try { await assert.rejects(run(account)); }
  finally { try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); } }
  assert.equal(existsSync(marker), false);
});

test("entry snapshot cannot execute a disk replacement after the parent's final hash", async (t) => {
  for (const mode of ["ordinary", "replace-entry"]) await t.test(mode, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), directory = join(root, "bench", "workloads"), marker = join(root, "synthetic-entry-executed.json");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of provider.providerFiles) {
      const target = resolve(directory, name); mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(fileURLToPath(new URL(name, new URL("./", import.meta.url))), target);
    }
    // Test-only source dependency, never a production flag/IPC override. The
    // actual native entry/IPC/load gate run, with no possible real store access.
    writeFileSync(join(directory, "cloud-provider-engine.mjs"), `export function createProviderEngine() { return async () => ({ status: 0, stdout: JSON.stringify({uuid:'synthetic-entry-positive'}), stderr:'' }); }\n`);
    const staged = await import(pathToFileURL(join(directory, "cloud-provider.mjs")).href);
    const run = staged.providerTransport({ repo: root, ...(mode === "replace-entry" ? { launch(program, args, options) {
      const entry = args[0] === "--input-type=module" ? args[2] : program;
      writeFileSync(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(2);\n`);
      return args[0] === "--input-type=module" ? spawn(program, args, options) : fork(program, args, options);
    } } : {}) });
    try {
      if (mode === "ordinary") assert.equal(JSON.parse((await run(account)).stdout).uuid, "synthetic-entry-positive");
      else await assert.rejects(run(account), (error) => error.controlTreeUncertain === true);
    } finally { try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); } }
    assert.equal(existsSync(marker), false, "replaced bootstrap disk bytes must never execute");
  });
});

test("settlement remains inside the operation lock for collect early returns, errors and audit actions", async (t) => {
  for (const mode of ["running-collect", "terminal-collect", "error-collect", "audit", "error-audit"]) await t.test(mode, async (t) => {
    const h = controllerHarness(t, { ...(mode === "running-collect" ? { active: true } : {}),
      ...(mode === "error-collect" ? { listError: true } : {}), ...(mode === "error-audit" ? { auditCollision: true } : {}) }); h.seed();
    let settled = 0;
    const task = h.task({ settle: async () => {
      settled++; assert.ok(existsSync(join(h.local, "operation.lock")));
      throw Object.assign(new Error("synthetic teardown uncertainty"), { controlTreeUncertain: true });
    } }, mode.includes("audit") ? { collect: undefined, deliverAudit: join(h.temp, "synthetic-delivery.json"), campaign, approveSubject: subject } : {});
    if (mode.includes("audit")) writeFileSync(join(h.temp, "synthetic-delivery.json"), JSON.stringify(syntheticDelivery()));
    await assert.rejects(mode.includes("audit") ? task.deliverAudit() : task.collect(), (error) => error.controlTreeUncertain === true);
    assert.equal(settled, 1); assert.ok(existsSync(join(h.local, "operation.lock")));
  });
});

test("every executable dependency is bound before any changed dependency can run", async (t) => {
  const dependencies = ["../catalog/droplet-contract.mjs", "../catalog/contract.mjs", "../catalog/group.mjs", "../fullstack/passes.mjs",
    "../fullstack/inventory.mjs", "../marketplace/contract.mjs", "registry.mjs"];
  for (const dependency of dependencies) await t.test(dependency, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cloud-diagnostic-test-")), directory = join(root, "bench", "workloads"), marker = join(root, "synthetic-executed.json");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of new Set([...provider.providerFiles, ...dependencies])) {
      const target = resolve(directory, name); mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(fileURLToPath(new URL(name, new URL("./", import.meta.url))), target);
    }
    const staged = await import(pathToFileURL(join(directory, "cloud-provider.mjs")).href);
    appendFileSync(resolve(directory, dependency), `\nimport { writeFileSync as __syntheticClosureMarkerWrite } from 'node:fs';\n__syntheticClosureMarkerWrite(${JSON.stringify(marker)}, '{}'); process.exit(2);\n`);
    const run = staged.providerTransport({ repo: root });
    try { await assert.rejects(run(account)); }
    finally { try { await run.close(); } catch (error) { assert.equal(error.controlTreeUncertain, true); } }
    assert.equal(existsSync(marker), false, "unbound executable bytes must never run");
  });
});
