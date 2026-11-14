import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import { command, controller, publicError } from "./droplet.mjs";
import { archive, campaign, commit, harness, metadata, subject, syntheticDelivery } from "./cloud-fixtures.mjs";
import { archiveMembers, extractArchive } from "./cloud-local.mjs";
import { parseDropletArgs } from "./cloud-options.mjs";
import { validationLimit } from "./cloud-validation.mjs";

test("core default and unapproved CLI never execute cloud; grammar has no tuning/adapter override", (t) => {
  const h = harness(t), args = ["r21", "--state-dir", h.base, "--collect"];
  assert.equal(parseDropletArgs(args).collect, true);
  for (const tail of [["--apps", "corten"], ["--duration", "15"], ["--provider", "fake"], ["--collect"], ["--commit", commit], ["--detach"]])
    assert.throws(() => parseDropletArgs([...args, ...tail]));
  for (const binary of ["doctl", "ssh", "scp"]) assert.throws(() => command(binary, []), /transport disabled/);
  const r = spawnSync(process.execPath, [resolve("bench/workloads/droplet.mjs"), ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 2); assert.equal(r.stderr.trim(), publicError()); assert.deepEqual(h.calls, []); assert.ok(!existsSync(h.local));
});
test("detach reserves before one create, reconciles a lost response, uploads fixed job and starts once", async (t) => {
  const h = harness(t, { createLost: true, active: true });
  const s = await h.launch().launch(); assert.equal(s.status, "running"); assert.equal(s.fullGroupQualified, false); assert.equal(h.creates, 1);
  assert.equal(h.calls.filter((c) => c[0] === "ssh" && c.at(-1).startsWith("systemctl start")).length, 1);
  assert.equal(h.calls.filter((c) => c[0] === "scp").length, 3);
  const job = readFileSync(join(h.local, "job.sh"), "utf8");
  assert.ok(job.includes(`campaign-entry.mjs' 'r21' --commit '${commit}' --state-dir '/bench/campaign'`));
  assert.ok(!job.includes("--apps")); await assert.rejects(h.launch().launch(), /already reserved/); assert.equal(h.creates, 1);
});
test("ambiguous/missing/crashed create and start acknowledgement loss never launch again", async (t) => {
  for (const flags of [{ createMissing: true }, { createAmbiguous: true }, { createCrash: true }]) {
    const h = harness(t, flags); await assert.rejects(h.launch().launch());
    assert.ok(h.saved().createIntentAt); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    assert.ok(!h.calls.some((c) => c[0] === "ssh")); await assert.rejects(h.launch().launch(), /reserved/);
  }
  const h = harness(t, { startLost: true, active: true }); await assert.rejects(h.launch().launch());
  assert.equal(h.saved().status, "starting"); assert.equal(await h.task().collect(), 3); assert.equal(h.creates, 1);
});
test("preflight dirty/wrong HEAD/source/capacity/busy host rejects before create", async (t) => {
  for (const flags of [{ dirty: true }, { wrongHead: true }, { gitError: true }, { noCapacity: true }]) {
    const h = harness(t, flags); await assert.rejects(h.launch().launch()); assert.equal(h.creates, 0);
  }
  const h = harness(t); h.hosts(); await assert.rejects(h.launch().launch(), /already exists/); assert.equal(h.creates, 0);
});
test("bounded SSH readiness does not power cycle, rerun jobs or force terminate", async (t) => {
  const h = harness(t, { noSsh: true }); await assert.rejects(h.launch().launch(), /SSH unavailable/);
  assert.equal(h.calls.filter((c) => c[0] === "ssh").length, 40); assert.equal(h.creates, 1);
  assert.ok(!h.calls.some((c) => /power|reboot|restart|kill/.test(c.slice(1).join(" "))));
});
test("running collection takes one look, never packs, waits, downloads or deletes", async (t) => {
  const h = harness(t, { active: true }); h.seed(); assert.equal(await h.task().collect(), 3); assert.equal(h.units, 1);
  assert.equal(h.deletes, 0); assert.equal(h.inspections, 0); assert.ok(!h.calls.some((c) => c[0] === "scp"));
});
test("foreign host identity and bad terminal units never permit access/deletion", async (t) => {
  for (const flags of [{ wrongUnit: true }, { missingUnit: true }, { unitError: true }, { livePid: true }, { restart: true }, { listError: true }]) {
    const h = harness(t, flags); h.seed(); await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0);
  }
  for (const change of [(d) => d.id++, (d) => d.name = "foreign", (d) => d.tags.pop(), (d) => d.tags.shift(),
    (d) => d.size_slug = "s-8vcpu-16gb", (d) => d.region.slug = "nyc1", (d) => d.networks.v4[0].ip_address = "192.0.2.11",
    (d) => d.networks.v4.push({ type: "public", ip_address: "192.0.2.12" })]) {
    const h = harness(t); h.seed(); const d = { id: 123, name: h.saved().name,
      tags: ["corten-bench", "corten-bench-groups", h.saved().tag], size_slug: "c-8", region: { slug: "sfo2" }, networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
    change(d); h.hosts([d]); await assert.rejects(h.task().collect());
    assert.equal(h.deletes, 0); assert.ok(!h.calls.some((c) => c[0] === "ssh"));
  }
});
test("terminal blocked native report never becomes qualification, archive kept before confirmed delete", async (t) => {
  const h = harness(t); h.seed(); assert.equal(await h.task().collect(), 1);
  const s = h.saved(); assert.equal(s.fullGroupQualified, false); assert.equal(s.evidenceOutcome, "blocked"); assert.ok(s.destroyedAt);
  assert.ok(existsSync(join(h.local, "results.tgz"))); assert.ok(existsSync(join(h.local, s.evidence, "campaign", "fake.json")));
  assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
});
test("failed terminal job stays failed, even with blocked native validation", async (t) => {
  const h = harness(t, { reportStatus: "failed" }); h.seed(); const entries = metadata(); entries[2].body = "1\n";
  h.setArchive(archive([...entries, { name: "campaign/" }])); assert.equal(await h.task().collect(), 1);
  assert.equal(h.saved().evidenceOutcome, "failed"); assert.equal(h.saved().fullGroupQualified, false);
});

test("malformed raw exit marker bytes preserve terminal host and exact evidence", async (t) => {
  for (const body of [Buffer.from([0xb0, 0x8a]), Buffer.from([0x30, 0x8a]), Buffer.from([0xb0, 0x0a]),
    Buffer.from("0\r\n"), Buffer.from("0\n\0"), Buffer.from("256\n"), Buffer.from("00\n")]) {
    const h = harness(t); h.seed(); const entries = metadata(); entries[2].body = body;
    const bytes = archive([...entries, { name: "campaign/" }, { name: "campaign/fake.json", body: "{}" }]); h.setArchive(bytes);
    await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
    assert.ok(!h.saved().deletionIntentAt); assert.equal(h.saved().fullGroupQualified, false);
    assert.deepEqual(readFileSync(join(h.local, "results.tgz")), bytes);
    assert.deepEqual(readFileSync(join(h.local, h.saved().evidence, "exit-code")), body);
  }
});
test("missing, invalid, unsealed, uncollected, mismatched and fabricated success reports preserve host", async (t) => {
  for (const patch of [{ status: "invalid", error: "private raw value" }, { uncollectedNativeRoots: ["/bench/repo/raw"] }, { commit: "b".repeat(40) },
    { round: "r22" }, { campaign: "r21-x;exit" }, { collectionIntegrity: "unsealed-partial" }, { status: "verified", qualified: true, controllerReady: true }, { deletionAuthorized: true }]) {
    const h = harness(t); h.seed(); await assert.rejects(h.task({ inspect: async () => ({ ...h.report(), ...patch }) }).collect());
    assert.equal(h.deletes, 0); assert.ok(existsSync(join(h.local, "results.tgz")));
  }
  const h = harness(t); h.seed(); await assert.rejects(h.task({ inspect: undefined }).collect(), /validation unavailable/);
  assert.equal(h.deletes, 0); assert.equal(publicError(new Error("private raw value")).includes("private raw value"), false);
});
test("download/pack/hash failures preserve evidence and prevent automatic overwrite", async (t) => {
  for (const flags of [{ packError: true }, { wrongHash: true }, { downloadError: true }, { corrupt: true }]) {
    const h = harness(t, flags); h.seed(); await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0);
    if (!flags.packError) { assert.ok(existsSync(join(h.local, "results.tgz.download"))); await assert.rejects(h.task().collect(), /unrecorded/); }
  }
  for (const filename of ["results.tgz", "results.tgz.download"]) {
    const h = harness(t); h.seed(); writeFileSync(join(h.local, filename), "unexplained"); await assert.rejects(h.task().collect(), /unrecorded/); assert.equal(h.deletes, 0);
  }
});
test("unsafe archive checksum/extensions/links/case/path/parent collisions fail before extraction", async (t) => {
  for (const extra of [[{ name: "campaign/link", type: "2", target: "/root" }], [{ name: "campaign/link", type: "1", target: "host.txt" }],
    [{ name: "campaign/pax", type: "x", body: "path=/root" }], [{ name: "campaign/../escape" }], [{ name: "campaign/con.txt" }],
    [{ name: "campaign/A/x" }, { name: "campaign/a/y" }], [{ name: "campaign/a" }, { name: "campaign/a/x" }], [{ name: "campaign/a" }, { name: "campaign/a" }]]) {
    const h = harness(t), target = join(h.temp, "extract"); mkdirSync(target);
    await assert.rejects(extractArchive(archive([...metadata(), ...extra]), target)); assert.ok(!existsSync(join(target, "run.log")));
  }
  await assert.rejects(archiveMembers(Buffer.from("not gzip")));
  const corrupt = gunzipSync(archive(metadata())); corrupt[0] ^= 1;
  await assert.rejects(archiveMembers(gzipSync(corrupt)), /checksum/);
  await assert.rejects(archiveMembers(gzipSync(gunzipSync(archive(metadata())).subarray(0, -1024))), /incomplete/);
  const trailing = gunzipSync(archive(metadata())); trailing[trailing.length - 1] = 1;
  await assert.rejects(archiveMembers(gzipSync(trailing)), /trailing/);
  for (const index of [124, 148]) {
    const numeric = gunzipSync(archive(metadata())); numeric[index] |= 128;
    if (index === 124) {
      numeric.fill(32, 148, 156);
      const sum = numeric.subarray(0, 512).reduce((a, b) => a + b, 0);
      numeric.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    }
    await assert.rejects(archiveMembers(gzipSync(numeric)), /numeric/);
  }
});
test("GNU long names are bounded and inspected before writing", async (t) => {
  const h = harness(t), name = `campaign/${"x".repeat(110)}`, bytes = archive([...metadata(), { name: "././@LongLink", type: "L", body: `${name}\0` }, { name: "ignored", body: "long" }]);
  const target = join(h.temp, "extract"); mkdirSync(target); await extractArchive(bytes, target); assert.equal(readFileSync(join(target, name), "utf8"), "long");
  await assert.rejects(archiveMembers(archive([...metadata(), { name: "././@LongLink", type: "L", body: "campaign/../escape\0" }, { name: "ignored" }])));
});

test("archive preflight counts all implicit directories before any extraction writes", async (t) => {
  const entries = metadata();
  for (let i = 0; i < 36000; i++) {
    const name = ["campaign", `d${i}`, ...Array(29).fill("x"), "f"].join("/");
    entries.push({ name: "././@LongLink", type: "L", body: `${name}\0` }, { name: "ignored" });
  }
  const bytes = archive(entries); assert.ok(bytes.length < 1024 ** 2); // Over 1.1 million implicit nodes in less than 1 MiB.
  await assert.rejects(archiveMembers(bytes), /tree limit/);
  const h = harness(t), target = join(h.temp, "extract"); mkdirSync(target);
  await assert.rejects(extractArchive(bytes, target), /tree limit/); assert.deepEqual(readdirSync(target), []);
  h.seed(); h.setArchive(bytes); await assert.rejects(h.task().collect(), /tree limit/);
  assert.equal(h.deletes, 0); assert.equal(h.inspections, 0); assert.ok(!h.saved().extractionAttempts);
  assert.ok(!h.saved().deletionIntentAt); assert.deepEqual(readFileSync(join(h.local, "results.tgz")), bytes);
});

test("archive preflight retains the exact 100000-node boundary when locally lowered", async () => {
  const entries = metadata();
  for (let i = 0; i < 1587; i++) {
    const name = ["campaign", `d${i}`, ...Array(61).fill("x"), "f"].join("/");
    entries.push({ name: "././@LongLink", type: "L", body: `${name}\0` }, { name: "ignored" });
  }
  // root + metadata + campaign + 1587 * (62 directories + file) + 14 files
  for (let i = 0; i < 14; i++) entries.push({ name: `campaign/f${i}` });
  assert.equal((await archiveMembers(archive(entries), undefined, { nodes: 100000 })).entries, 1604);
  await assert.rejects(archiveMembers(archive([...entries, { name: "campaign/one-too-many" }]), undefined, { nodes: 100000 }), /tree limit/);
});

test("full path, component and depth checks happen before writing, shared parents count once", async (t) => {
  const h = harness(t), target = join(h.temp, "extract"); mkdirSync(target);
  const long = (name) => [{ name: "././@LongLink", type: "L", body: `${name}\0` }, { name: "ignored" }];
  const nearLimit = ["campaign", ...Array(15).fill("x".repeat(255)), "x".repeat(240)].join("/");
  assert.ok(nearLimit.length <= 4096 && Buffer.byteLength(join(target, nearLimit)) > 4096);
  for (const name of [`campaign/${"x".repeat(256)}`, ["campaign", ...Array(64).fill("x")].join("/"),
    nearLimit]) {
    await assert.rejects(extractArchive(archive([...metadata(), ...long(name)]), target), /path|component/);
    assert.deepEqual(readdirSync(target), []);
  }
  await extractArchive(archive([...metadata(), { name: "campaign/a/f" }, { name: "campaign/a/", type: "5" }, { name: "campaign/a/g" }]), target);
  assert.deepEqual(readdirSync(join(target, "campaign/a")), ["f", "g"]);
});
test("tampered archive/tree/hardlink evidence or validator mutation cannot permit deletion", async (t) => {
  for (const tamper of ["archive", "tree", "hardlink", "symlink"]) {
    const h = harness(t, { activeAfterDownload: true }); h.seed(); await assert.rejects(h.task().collect(), /became active/);
    h.flags.activeAfterDownload = false; const s = h.saved(), file = join(h.local, s.evidence, "run.log");
    if (tamper === "archive") writeFileSync(join(h.local, "results.tgz"), "changed");
    if (tamper === "tree") writeFileSync(file, "changed");
    if (tamper === "hardlink") linkSync(file, join(h.temp, "alias"));
    if (tamper === "symlink") { unlinkSync(file); symlinkSync(join(h.local, "results.tgz"), file); }
    await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0);
  }
  const h = harness(t); h.seed(); await assert.rejects(h.task({ inspect: async ({ folder }) => { writeFileSync(join(folder, "fake.json"), "mutated"); return h.report(); } }).collect(), /mutated/);
  assert.equal(h.deletes, 0);
});
test("delete cancellation/errors/lost acknowledgement never issue a second deletion", async (t) => {
  const cancel = harness(t); cancel.seed(); let checks = 0;
  await assert.rejects(cancel.task({ interrupted: () => ++checks > 1 }).collect()); assert.equal(cancel.deletes, 0);
  for (const flags of [{ deleteError: true }, { deleteUnconfirmed: true }, { deleteLost: true }]) {
    const h = harness(t, flags); h.seed(); await assert.rejects(h.task().collect()); assert.ok(h.saved().deletionIntentAt);
    assert.ok(!h.saved().destroyedAt); assert.ok(existsSync(join(h.local, "results.tgz")));
    if (flags.deleteLost) assert.equal(await h.task().collect(), 1); else await assert.rejects(h.task().collect(), /uncertain/);
    assert.equal(h.deletes, 1);
  }
});
test("cancellation immediately after final terminal look preserves host and no delete intent", async (t) => {
  const h = harness(t); h.seed(); let units = 0;
  h.flags.hook = (binary, args) => { if (binary === "ssh" && args.at(-1).startsWith("systemctl show") && ++units === 2) h.flags.cancelled = true; };
  await assert.rejects(h.task().collect(), /cancelled/); assert.equal(h.deletes, 0); assert.ok(!h.saved().deletionIntentAt);
  assert.ok(h.saved().evidenceSha256 && existsSync(join(h.local, "results.tgz")));
});
test("crash after extraction reservation retains partial evidence and retry uses fresh destination", async (t) => {
  const h = harness(t); h.seed();
  await assert.rejects(h.task({ interrupted: () => { const s = h.saved(); return s.extractionAttempts?.length > 0 && !s.evidence; } }).collect(), /cancelled/);
  const partial = h.saved().extractionAttempts[0]; assert.ok(existsSync(join(h.local, partial, "run.log"))); assert.equal(h.deletes, 0);
  assert.equal(await h.task().collect(), 1); const s = h.saved();
  assert.equal(s.extractionAttempts.length, 2); assert.notEqual(s.evidence, partial); assert.ok(existsSync(join(h.local, partial, "run.log")));
});
test("unknown/tampered state fields and missing reservation state block all access", async (t) => {
  for (const change of [(s) => s.selection.groups.pop(), (s) => s.fullGroupQualified = true, (s) => s.complete = true,
    (s) => s.id = "124\n", (s) => s.ip = "192.0.2.11\n", (s) => delete s.createIntentAt, (s) => delete s.ip,
    (s) => s.evidence = "../outside", (s) => s.destroyedAt = new Date().toISOString()]) {
    const h = harness(t); h.seed(); h.change(change); await assert.rejects(h.task().collect()); assert.equal(h.calls.length, 0);
  }
  const h = harness(t); mkdirSync(h.local); await assert.rejects(h.launch().launch(), /reserved/); assert.equal(h.creates, 0);
  const other = harness(t); mkdirSync(join(other.base, "groups-r20")); await assert.rejects(other.launch().launch()); assert.equal(other.creates, 0);
});
test("round/base aliases, state hardlinks and interrupted state writes reject without cloud calls", async (t) => {
  const h = harness(t);
  assert.throws(() => controller({ round: "r21", stateDir: join(h.repo, "state"), collect: true }, { repo: h.repo }), /disjoint/);
  symlinkSync(h.repo, join(h.temp, "alias"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => controller({ round: "r21", stateDir: join(h.temp, "alias", "state"), collect: true }, { repo: h.repo }), /disjoint/);
  h.seed(); linkSync(h.statePath, join(h.temp, "state-alias")); await assert.rejects(h.task().collect(), /regular/); assert.equal(h.calls.length, 0);
  const broken = harness(t); broken.seed(); writeFileSync(`${broken.statePath}.tmp`, "crashed save"); await assert.rejects(broken.task().collect(), /EEXIST/); assert.equal(broken.deletes, 0);
});
test("live and crashed process locks have no takeover, and concurrent collect makes no calls", async (t) => {
  const h = harness(t); h.seed(); const lock = join(h.local, "operation.lock");
  const child = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}),{flag:'wx'});process.send('locked');process.on('message',()=>process.exit(0));", lock],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
  try { await assert.rejects(h.task().collect(), /EEXIST/); assert.equal(h.calls.length, 0); }
  finally { child.send("exit"); await new Promise((resolve) => child.once("exit", resolve)); }
  await assert.rejects(h.task().collect(), /EEXIST/); assert.equal(h.calls.length, 0); assert.ok(existsSync(lock));
  const other = harness(t); other.seed(); let unblock;
  const pending = other.task({ inspect: () => new Promise((r) => { unblock = () => r(other.report()); }) }).collect();
  // collect reaches its first asynchronous validator with the exclusive lock held.
  while (!unblock) await new Promise((r) => setImmediate(r));
  const count = other.calls.length; await assert.rejects(other.task().collect(), /EEXIST/); assert.equal(other.calls.length, count);
  unblock(); // Later validation calls must not block this fake process.
  other.flags.cancelled = true; await assert.rejects(pending); assert.equal(other.deletes, 0);
  const launch = harness(t); writeFileSync(join(launch.base, ".groups-launch.lock"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(launch.launch().launch(), /EEXIST/); assert.equal(launch.calls.length, 0); assert.ok(!existsSync(launch.local));
});

test("cancellation bounds a stalled inspection but retains the lock while it may still run", async (t) => {
  const h = harness(t); h.seed(); let release;
  const pending = h.task({ inspect: () => new Promise((r) => { release = () => r(h.report()); }) }).collect();
  const observed = pending.then(() => "resolved", () => "rejected");
  while (!release) await new Promise((r) => setImmediate(r));
  h.flags.cancelled = true;
  try {
    assert.equal(await Promise.race([observed, new Promise((r) => setTimeout(() => r("pending"), 250))]), "rejected");
    assert.ok(existsSync(join(h.local, "operation.lock"))); assert.equal(h.deletes, 0); assert.ok(!h.saved().deletionIntentAt);
    const count = h.calls.length; h.flags.cancelled = false;
    await assert.rejects(h.task().collect(), /EEXIST/); assert.equal(h.calls.length, count);
  } finally { release(); await observed; }
  await new Promise((r) => setImmediate(r));
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.equal(h.deletes, 0);
});

test("fixed validation deadline preserves archive/host and lock despite late rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness(t); h.seed(); let rejectInspection;
  const pending = h.task({ inspect: () => new Promise((_, reject) => { rejectInspection = reject; }) }).collect();
  const observed = assert.rejects(pending, /validation unavailable/);
  while (!rejectInspection) await new Promise((r) => setImmediate(r));
  assert.equal(typeof rejectInspection, "function");
  t.mock.timers.tick(validationLimit - 1); await Promise.resolve();
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.equal(h.deletes, 0);
  t.mock.timers.tick(1); await observed;
  const calls = h.calls.length, before = readFileSync(h.statePath);
  assert.ok(h.saved().archiveSha256 && h.saved().evidenceSha256); assert.ok(!h.saved().deletionIntentAt);
  rejectInspection(new Error("synthetic-private-value")); await new Promise((r) => setImmediate(r));
  assert.deepEqual(readFileSync(h.statePath), before); assert.equal(h.calls.length, calls); assert.equal(h.deletes, 0);
  await assert.rejects(h.task().collect(), /EEXIST/); assert.equal(h.calls.length, calls);
});
test("JSON audit needs explicit approved exact subject, live ownership and one durable delivery attempt", async (t) => {
  const h = harness(t, { active: true }); h.seed(); const path = join(h.temp, "delivery.json");
  const delivery = syntheticDelivery();
  writeFileSync(path, JSON.stringify(delivery));
  const options = { collect: undefined, deliverAudit: path, campaign, approveSubject: subject };
  assert.throws(() => h.task({}, { ...options, approveSubject: undefined }), /approved subject/);
  await assert.rejects(h.task({}, { ...options, approveSubject: "e".repeat(64) }).deliverAudit(), /cannot approve/);
  assert.equal(await h.task({}, options).deliverAudit(), 3); assert.equal(h.saved().auditIntents["json-api"].subjectSha256, subject);
  await assert.rejects(h.task({}, options).deliverAudit(), /already attempted/); assert.equal(h.deletes, 0);
});
test("JSON audit collision, transfer cancellation and terminal host preserve intent/evidence", async (t) => {
  for (const flags of [{ active: false }, { active: true, auditCollision: true }, { active: true, cancelAt: (binary) => binary === "scp" }]) {
    const h = harness(t, flags); h.seed(); const path = join(h.temp, "delivery.json");
    writeFileSync(path, JSON.stringify(syntheticDelivery()));
    await assert.rejects(h.task({}, { collect: undefined, deliverAudit: path, campaign, approveSubject: subject }).deliverAudit());
    assert.equal(h.deletes, 0);
    if (flags.cancelAt) { assert.ok(h.saved().auditIntents["json-api"]); assert.ok(existsSync(join(h.local, "json-audit-delivery.json"))); }
  }
});
