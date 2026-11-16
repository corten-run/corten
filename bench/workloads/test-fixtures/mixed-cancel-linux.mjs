// Synthetic Linux only. Run in a disposable, networkless container with /src
// read-only and a private /bench tmpfs. Never point this harness at a host job.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { remoteFiles } from "../cloud-remote.mjs";
import { fleetPlan, reservation } from "../cloud-contract.mjs";
import { groupNames } from "../registry.mjs";
import { mixedCancelProgram, mixedWait } from "../cloud-cancellation.mjs";

assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
assert.equal(sha256Original(), "6761ceed230fa12b6f45e4fe7a8fd7a4ef709b6db0d8028c1100e5e44f9ecdbf", "original measured campaign blob changed");
function sha256Original() { return createHash("sha256").update(readFileSync("/proof/old-campaign.mjs")).digest("hex"); }
assert.equal(existsSync("/bench/campaign"), false, "exclusively owned fresh synthetic /bench required");
assert.equal(spawnSync("stat", ["-f", "-c", "%T", "/bench"], { encoding: "utf8" }).stdout.trim(), "tmpfs");
const alarm = setTimeout(() => { console.error("synthetic harness bounded timeout"); process.exit(1); }, 90000);
alarm.unref();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x);
const hash = (v) => sha(canonical(v));
const git = (args) => {
  const r = spawnSync("git", ["-C", "/bench/repo", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
mkdirSync("/bench/repo", { recursive: true, mode: 0o700 }); mkdirSync("/bench/campaign", { mode: 0o700 });
symlinkSync("/src/bench", "/bench/repo/bench"); // Only untracked harness imports, not source-hash equivalence.
writeFileSync("/bench/repo/sentinel.txt", "synthetic source bytes\n", { mode: 0o600 });
git(["init", "--quiet"]); git(["add", "sentinel.txt"]);
git(["-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "synthetic"]);
const commit = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]);
const provider = { accountId: mixedWait.accountId, context: mixedWait.context };
const tokens = Object.fromEntries(groupNames.map((g, i) => [g, g === mixedWait.group ? mixedWait.token : String(i + 1).padStart(16, "0")]));
const fleet = fleetPlan({ round: "r21", commit: mixedWait.commit, token: "f".repeat(16), tokens, provider, sshKey: "42" });
const state = { ...reservation({ round: "r21", commit: mixedWait.commit, token: mixedWait.token, group: mixedWait.group, fleet }),
  status: "running", id: mixedWait.id, ip: mixedWait.ip, provider, fullGroupQualified: false };
const controls = remoteFiles(state);
const entry = controls["job.sh"].trimEnd().split("\n").at(-1).replace(mixedWait.commit, commit);
assert.ok(entry.startsWith("node 'bench/workloads/isolated/campaign-entry.mjs' 'r21' --commit "));
const prefix = controls["job.sh"].slice(0, controls["job.sh"].indexOf("trap finish EXIT\n") + "trap finish EXIT\n".length);
assert.ok(prefix.includes("timeout 600 /bin/bash /bench/pack.sh || true; exit"));
const job = `${prefix}cd /bench/repo\n${entry}\n`;
writeFileSync("/bench/job.sh", job, { mode: 0o600 });
writeFileSync("/bench/pack.sh", controls["pack.sh"], { mode: 0o600 });
writeFileSync("/bench/control-unit.txt", controls[state.unit], { mode: 0o600 });
const body = { schema: "benchmark-isolated-group-campaign/v1", round: "r21", commit, order: ["mixed-production"],
  bindings: [{ request: { group: "mixed-production" }, validation: { artifactRoot: "bench/mixed-production/results/synthetic-cancel-never-run" }, coverage: {} }] };
const plan = { ...body, campaignSha256: hash(body) };
writeFileSync("/bench/fixture-plan.json", JSON.stringify(plan));
writeFileSync("/bench/setup.mjs", `import assert from 'node:assert/strict';
import os from 'node:os';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as evidence from '/src/bench/workloads/isolated/evidence.mjs';
import { deploymentSha256 } from '/src/bench/workloads/deployments.mjs';
const plan=JSON.parse(readFileSync('/bench/fixture-plan.json'));
os.availableParallelism=()=>8;
globalThis.__cancelFixtureMocks=new Map();
const mock={module(path,{exports}){globalThis.__cancelFixtureMocks.set(pathToFileURL(path).href,exports);}};
registerHooks({load(url,context,next){
  if(url==='file:///src/bench/workloads/isolated/campaign.mjs')return {format:'module',source:readFileSync('/proof/old-campaign.mjs','utf8'),shortCircuit:true};
  const value=globalThis.__cancelFixtureMocks.get(url);
  if(value)return {format:'module',source:'const e=globalThis.__cancelFixtureMocks.get('+JSON.stringify(url)+');'+Object.keys(value).map(k=>'export const '+k+'=e.'+k+';').join(''),shortCircuit:true};
  return next(url,context);
}});
mock.module('/src/bench/workloads/isolated/campaign-contract.mjs',{exports:{
  campaignRounds:round=>{assert.equal(round,'r21');return {'mixed-production':'w21'};},exact:()=>assert.fail('unused audit contract'),
  validateCampaign:p=>assert.deepEqual(p,plan), bindCampaign:()=>assert.fail('all-group forbidden'),
  bindGroupCampaign:input=>{assert.deepEqual(input,{round:'r21',commit:plan.commit,group:'mixed-production'});return plan;},
  freeze:v=>v, jsonPhase:()=>assert.fail('JSON forbidden'),mixedPhase:()=>assert.fail('native execution forbidden')
}});
mock.module('/src/bench/workloads/isolated/worker.mjs',{exports:{verifyWorkingSources:b=>assert.deepEqual(b,plan.bindings[0]),matchesWorkingSource:()=>assert.fail('unused native operation')}});
mock.module('/src/bench/workloads/isolated/host-observation.mjs',{exports:{observeHost:()=>({containers:[]}),verifyHostBoundary:()=>{},dockerRead:()=>assert.fail('Docker forbidden')}});
mock.module('/src/bench/workloads/isolated/mixed-staging.mjs',{exports:{
  prepareMixedAudit(p,repo,dir){mkdirSync(dir);for(const app of ${JSON.stringify(state.selection.groups[0].apps)})writeFileSync(dir+'/'+app+'.txt','synthetic context '+app);
    const sourcesManifest={snapshot:evidence.tree(dir)};
    const body={schema:'benchmark-mixed-audit-subject/v1',commit:p.commit,campaignSha256:p.campaignSha256,sourcesManifest};
    return {...body,subjectSha256:deploymentSha256(body)};},
  replayMixedSubject:()=>assert.fail('audit replay forbidden'),validateMixedDelivery:()=>assert.fail('approval forbidden'),validateMixedRun:()=>assert.fail('measurement forbidden')
}});
`);
const child = spawn("/bin/bash", ["/bench/job.sh"], { cwd: "/bench", stdio: "ignore", env: { PATH: process.env.PATH, HOME: "/nonexistent",
  NODE_OPTIONS: "--preserve-symlinks-main --import=/bench/setup.mjs" } });
const completion = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
let reservationData, event, subject, dir;
for (let i = 0; i < 300; i++) {
  await delay(50);
  if (existsSync("/bench/campaign/.host-attempt.json")) {
    reservationData = JSON.parse(readFileSync("/bench/campaign/.host-attempt.json")); dir = `/bench/campaign/${reservationData.id}`;
    if (existsSync(`${dir}/00002-mixed-review-needed.json`)) {
      event = JSON.parse(readFileSync(`${dir}/00002-mixed-review-needed.json`));
      subject = JSON.parse(readFileSync(`${dir}/mixed-audit-subject.json`)); break;
    }
  }
  assert.equal(child.exitCode, null, readFileSync("/bench/run.log", "utf8"));
}
assert.ok(event, "genuine entry did not reach synthetic review wait");
const cfg = { ...mixedWait, unit: state.unit, commit, tree, campaign: reservationData.id, campaignSha256: plan.campaignSha256,
  subjectSha256: subject.subjectSha256, waitAt: event.at, wrapperPid: child.pid,
  files: { "job.sh": sha(job), "pack.sh": sha(controls["pack.sh"]), "control-unit.txt": sha(controls[state.unit]) } };
writeFileSync("/bench/fixture-config.json", JSON.stringify(cfg));
writeFileSync("/bench/program.py", mixedCancelProgram(state));
writeFileSync("/bench/run-proof.py", `import json, os, pathlib, subprocess, sys, time, urllib.request
from types import SimpleNamespace
fixture_mode=sys.argv[1]
cfg=json.load(open('/bench/fixture-config.json'))
program=open('/bench/program.py').read()
loads=json.loads
first=True
def fixture_loads(raw,*args,**kwargs):
    global first
    if first:
        first=False
        return cfg
    return loads(raw,*args,**kwargs)
json.loads=fixture_loads
original_run=subprocess.run
def run(args,**kwargs):
    if args[:2]==['systemctl','show']:
        result=dict(Id=cfg['unit'],LoadState='loaded',FragmentPath='/etc/systemd/system/'+cfg['unit'],ActiveState='active',SubState='running',Restart='no',NRestarts='0',Job='',MainPID=str(cfg['wrapperPid']),ExecMainCode='0',ExecMainStartTimestamp=cfg['unitStart'],ControlGroup='/system.slice/'+cfg['unit'])
        if fixture_mode=='restart': result['Restart']='always'
        if fixture_mode=='wrong-wrapper': result['MainPID']='1'
        if fixture_mode=='unit-job': result['Job']='123'
        return SimpleNamespace(stdout=('\\n'.join(k+'='+v for k,v in result.items())+'\\n').encode())
    return original_run(args,**kwargs)
subprocess.run=run
class Metadata:
    status=200
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,n): return (cfg['id'] if fixture_mode!='foreign-host' else '123').encode()
urllib.request.build_opener=lambda *args:SimpleNamespace(open=lambda *args,**kwargs:Metadata())
read_text=pathlib.Path.read_text
def text(path,*args,**kwargs):
    if str(path).endswith('/cgroup') and str(path).startswith('/proc/'):
        return '0::/system.slice/'+('foreign.service' if fixture_mode=='foreign-cgroup' else cfg['unit'])+'/supervisor\\n'
    return read_text(path,*args,**kwargs)
pathlib.Path.read_text=text
read_bytes=pathlib.Path.read_bytes
def data(path,*args,**kwargs):
    value=read_bytes(path,*args,**kwargs)
    if str(path).endswith('/environ'):
        # Only the harness's Node module mocks, not a production permission.
        value=b'\\0'.join(v for v in value.split(b'\\0') if not v.startswith(b'NODE_OPTIONS='))
    if fixture_mode=='wrong-argv' and str(path).endswith('/cmdline'): value=b'not-the-owned-job\\0'
    return value
pathlib.Path.read_bytes=data
if fixture_mode=='expired':
    time.time=lambda:__import__('datetime').datetime.fromisoformat(cfg['deadline'].replace('Z','+00:00')).timestamp()+1
if fixture_mode=='stale-anchor':
    calls=0
    def monotonic():
        global calls
        calls+=1
        return 0 if calls==1 else 31
    time.monotonic=monotonic
if fixture_mode=='exited-pidfd':
    pidfd_open=os.pidfd_open
    dead=original_run(['true'],check=True)
    # An exited real child fd must refuse even while the numeric target is live.
    proc=subprocess.Popen(['sleep','0.01'])
    fd=pidfd_open(proc.pid);proc.wait()
    calls=0
    def pidfd(pid,*args):
        global calls
        calls+=1
        return fd if calls==2 else pidfd_open(pid,*args)
    os.pidfd_open=pidfd
exec(compile(program,'actual-mixed-cancel-program','exec'))
`);
const proofs = [];
for (const mode of ["restart", "wrong-wrapper", "unit-job", "foreign-host", "foreign-cgroup", "wrong-argv", "expired", "stale-anchor", "exited-pidfd"]) {
  const r = spawnSync("python3", ["/bench/run-proof.py", mode], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(r.status, 0, mode); assert.equal(existsSync("/bench/mixed-cancel-intent.json"), false, mode);
  assert.equal(child.exitCode, null); proofs.push(`${mode}:refused-before-intent`);
}
const source = readFileSync("/bench/repo/sentinel.txt"); writeFileSync("/bench/repo/sentinel.txt", "changed\n");
assert.notEqual(spawnSync("python3", ["/bench/run-proof.py", "changed-source"], { timeout: 15000 }).status, 0);
writeFileSync("/bench/repo/sentinel.txt", source); proofs.push("changed-source:refused-before-intent");
writeFileSync("/bench/mixed-cancel-intent.json", "synthetic prior attempt\n", { mode: 0o600, flag: "wx" });
assert.notEqual(spawnSync("python3", ["/bench/run-proof.py", "prior-intent"], { timeout: 15000 }).status, 0);
assert.equal(readFileSync("/bench/mixed-cancel-intent.json", "utf8"), "synthetic prior attempt\n");
assert.equal(child.exitCode, null); unlinkSync("/bench/mixed-cancel-intent.json"); proofs.push("prior-intent:refused-without-signal");
const r = spawnSync("python3", ["/bench/run-proof.py", "positive"], { encoding: "utf8", timeout: 15000 });
assert.equal(r.status, 0, r.stderr);
const ack = JSON.parse(r.stdout); assert.equal(ack.signaled, true); assert.equal(ack.pid, reservationData.pid);
const terminal = await Promise.race([completion, delay(10000).then(() => { throw new Error("wrapper did not settle"); })]);
assert.deepEqual(terminal, { code: 2, signal: null }); assert.equal(readFileSync("/bench/exit-code", "utf8"), "2\n");
const result = JSON.parse(readFileSync(`${dir}/campaign-result.json`));
assert.equal(result.status.state, "preserved-uncertain"); assert.equal(result.status.outcomes[0].outcome, "not-run");
assert.equal(result.deletionAuthorized, false); assert.equal(result.wholeHostTerminal, "parent-must-observe");
assert.deepEqual(result.status.uncollectedNativeRoots, []);
assert.equal(existsSync(`${dir}/mixed-audit-delivery.json`), false); assert.equal(existsSync(`${dir}/mixed-native-audits.json`), false);
mkdirSync("/bench/extracted");
assert.equal(spawnSync("tar", ["-xzf", "/bench/results.tgz", "-C", "/bench/extracted"], { timeout: 10000 }).status, 0);
assert.equal(sha(readFileSync(`${dir}/campaign-result.json`)), sha(readFileSync(`/bench/extracted/campaign/${reservationData.id}/campaign-result.json`)));
for (const app of state.selection.groups[0].apps)
  assert.equal(readFileSync(`/bench/extracted/campaign/${reservationData.id}/mixed-audit-sources/${app}.txt`, "utf8"), `synthetic context ${app}`);
assert.notEqual(spawnSync("python3", ["/bench/run-proof.py", "repeat"], { timeout: 15000 }).status, 0);
for (const args of [["--test", "/src/bench/workloads/cloud-cancellation.test.mjs"],
  ["--experimental-test-module-mocks", "--test", "/src/bench/workloads/test-fixtures/mixed-cancel-controller.mjs"]]) {
  const tests = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000, cwd: "/src", env: { PATH: process.env.PATH, HOME: "/nonexistent",
    GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: "/src", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } });
  process.stdout.write(tests.stdout); process.stderr.write(tests.stderr); assert.equal(tests.status, 0, "focused Linux guards failed");
}
clearTimeout(alarm);
console.log(JSON.stringify({ schema: "synthetic-mixed-cancel-linux-proof/v1", programSha256: sha(readFileSync("/bench/program.py")),
  originalCampaignSha256: sha(readFileSync("/proof/old-campaign.mjs")),
  wrapperPrefixSha256: sha(prefix), originalPackSha256: sha(controls["pack.sh"]), terminal, allNineContextsArchived: true,
  actualEntryAndCampaignStop: true, rawExit: 2, auditApprovalCreated: false, deletionAuthorized: false,
  negativeControls: [...proofs,"repeat:refused"],
  fixtureBoundaries: ["synthetic Git repository and wait identity", "original 9f campaign.mjs loaded unchanged; mocked preparation/host observation only; actual createCampaign.stop",
    "mocked systemctl, metadata and process cgroup; real proc ancestry/argv/starttime/uid, pidfds and one signal", "harness-only NODE_OPTIONS omitted from process-environment view"],
  cleanup: "container --rm disposes private capped /bench; no provider, SSH, keys, Docker socket or native benchmark" }));
