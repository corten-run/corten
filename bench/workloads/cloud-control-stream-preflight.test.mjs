import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { guardianSource } from "./cloud-control-runtime.mjs";

// Only the virtual kernel and packet change. The measured guardian executes unchanged.
let fixture = readFileSync("bench/workloads/test-fixtures/control-stream-kernel.py", "utf8").replaceAll("\r\n", "\n");
function replace(before, after) {
  assert.equal(fixture.split(before).length, 2); fixture = fixture.replace(before, after);
}
replace("clock, next_fd = 1000000, 2", "clock, next_fd = 5000000000, 2");
fixture = fixture.replaceAll("json-api", "mixed-production").replaceAll("json-audit", "mixed-audit").replaceAll("/audit-sources", "/mixed-audit-sources");
replace("rows, descriptors, incoming, output, pinned =", `for i in range(argument['count'] - 1):
    value = ('material-%d' % i).encode()
    hashed = hashlib.sha256(value).hexdigest()
    entries.append({'path':'blobs/'+hashed, 'type':'file', 'bytes':len(value), 'sha256':hashed})
    data[folder+'/mixed-audit-sources/blobs/'+hashed] = value
data[folder+'/mixed-audit-subject.json'] = json.dumps({'subjectSha256':subject,'commit':binding['commit'],'sourcesManifest':{'snapshot':{'entries':entries}}}).encode()
stats = 0
rows, descriptors, incoming, output, pinned =`);
replace("def lstat(self): return file_stat(self.value, self.is_dir())", `def lstat(self):
        global clock, stats
        if '/mixed-audit-sources/blobs/' in self.value:
            clock += argument['metadataNs']
            stats += 1
            if mode == 'scan-affinity' and stats == 64: rows[20]['cpus'] = '0-1'
        return file_stat(self.value, self.is_dir())`);
// Ready descriptors do not incur a full select timeout, as in the independent repro.
replace("clock += 100000000", "clock += 500000 if writers or incoming else 50000000");
replace("if mode != 'lost-lease': send('renew', frame['payload'])", "if mode != 'lost-lease' and not (mode == 'scan-lost-lease' and stats >= 64): send('renew', frame['payload'])");
replace("print(json.dumps({'binding': binding,", `observations = [json.loads(line) for line in data[root+'/stream-observations.jsonl'].splitlines()]
times = [int(row['monoNs']) for row in observations]
summary = {'metadataOperations':stats, 'files':sum(v['kind']=='audit-file-end' for v in output),
    'auditEnd':any(v['kind']=='audit-end' for v in output), 'observations':len(times),
    'maximumObservationGapNs':max((b-a for a,b in zip(times,times[1:])), default=0),
    'renewals':json.loads(data[root+'/stream-lease.json'])['renewal']}
print(json.dumps({'preflight':summary,'binding': binding,`);
replace("'frames': [v['kind'] for v in output]", "'frames': [v['kind'] for v in output[:8]]");

function kernel(count, metadataNs, mode = "normal") {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", fixture],
    { cwd: resolve("."), input: JSON.stringify({ source: guardianSource, mode, count, metadataNs }),
      encoding: "utf8", timeout: 12000, maxBuffer: 512 * 1024, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), "");
  const value = JSON.parse(result.stdout);
  return { value, error: value.reason ?? "" };
}

for (const [count, metadataNs] of [[1, 250000], [4183, 0], [4183, 250000]])
  test("shipped guardian completes mixed preflight: " + count + " files, " + metadataNs + " ns/lookup", (t) => {
    const { value, error } = kernel(count, metadataNs), proof = value.preflight;
    t.diagnostic(JSON.stringify(proof));
    assert.equal(error, ""); assert.equal(value.failed, false); assert.equal(value.invalid, false);
    assert.equal(value.terminal, true); assert.ok(value.drain); assert.ok(value.seal); assert.equal(value.auditPublished, true);
    assert.equal(proof.metadataOperations, count * 4); assert.equal(proof.files, count + 1); assert.equal(proof.auditEnd, true);
    assert.ok(proof.observations > 0 && proof.maximumObservationGapNs <= 2000000000);
    assert.ok(proof.renewals > 0);
    if (count > 1) assert.ok(proof.observations > 2 && proof.renewals > 2);
  });

test("cooperative preflight still rejects control affinity change during directory scan", () => {
  const { value, error } = kernel(4183, 250000, "scan-affinity");
  assert.match(error, /control affinity changed/); assert.equal(value.invalid, true); assert.equal(value.terminal, false);
  assert.ok(value.preflight.metadataOperations < 4183, "custody failure must stop the directory scan early");
  assert.equal(value.preflight.auditEnd, false); assert.equal(value.auditPublished, false); assert.equal(value.drain, null);
});

test("cooperative preflight never bypasses lease expiry when the peer stops renewing", () => {
  const { value, error } = kernel(4183, 250000, "scan-lost-lease");
  assert.match(error, /control lease expired/); assert.equal(value.invalid, true); assert.equal(value.terminal, false);
  assert.equal(value.auditPublished, false); assert.equal(value.drain, null);
});
