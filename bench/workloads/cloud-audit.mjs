// Fixed remote inbox protocol, no executable code or path accepted from audit JSON.
import assert from "node:assert/strict";
import { full } from "./cloud-options.mjs";
import { digest } from "./cloud-local.mjs";
import { roundName } from "./cloud-contract.mjs";
import { descriptor } from "../json-api/contract.mjs";
import { selectedApps } from "./registry.mjs";

export function auditProtocol(group = "json-api") {
  assert.ok(["json-api", "mixed-production"].includes(group), "unsupported native audit group");
  const mixed = group === "mixed-production", prefix = mixed ? "mixed" : "json";
  const members = mixed ? selectedApps(group).map((app) => ({ app, key: "mixed-native-source" }))
    : descriptor().apps.flatMap((app) => descriptor().cases.map(({ key }) => ({ app, key })));
  return { group, prefix, members, schema: `benchmark-${prefix}-audit-delivery/v1`,
    bundleSchema: mixed ? "mixed-native-source-audits/v1" : "json-api-native-audits/v1" };
}

export function auditDelivery(bytes, options) {
  const protocol = auditProtocol(options.auditGroup);
  full(options.approveSubject, /[a-f0-9]{64}/, "explicit operator-approved subject required");
  assert.ok(bytes.length <= 16 * 1024 ** 2, "audit delivery limit");
  const data = JSON.parse(bytes);
  assert.equal(data.schema, protocol.schema);
  assert.equal(data.subjectSha256, options.approveSubject, "JSON cannot approve its own subject");
  assert.equal(data.review?.subjectSha256, options.approveSubject);
  assert.equal(data.review?.decision, "approved"); assert.deepEqual(data.review?.findings, []);
  assert.ok(typeof data.review?.reviewer === "string" && data.review.reviewer.trim());
  assert.ok(Number.isFinite(Date.parse(data.review?.reviewedAt)));
  assert.equal(data.bundle?.schema, protocol.bundleSchema);
  assert.ok(Array.isArray(data.bundle?.receipts), "native audit receipts array required");
  const actual = data.bundle.receipts.map((r) => ({ app: r.identity?.app, key: r.identity?.key }));
  const sorted = (rows) => [...rows].sort((a, b) => `${a.app}/${a.key}`.localeCompare(`${b.app}/${b.key}`));
  assert.deepEqual(protocol.group === "json-api" ? sorted(actual) : actual,
    protocol.group === "json-api" ? sorted(protocol.members) : protocol.members, "complete native audit selection required");
  return { group: protocol.group, campaign: options.campaign, subjectSha256: options.approveSubject, sha256: digest(bytes) };
}
export function auditProgram(state, intent, publish = false) {
  const { group, prefix, schema, bundleSchema } = auditProtocol(intent.group);
  roundName(state.round);
  full(state.commit, /[a-f0-9]{40}/, "measured commit");
  full(state.token, /[a-f0-9]{16}/, "ownership token");
  full(intent.campaign, new RegExp(`${state.round}-[a-f0-9]{16}`), "audit campaign");
  for (const key of ["subjectSha256", "sha256"]) full(intent[key], /[a-f0-9]{64}/, key);
  // The journal is written atomically by the live campaign, not by the delivery.
  return `const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict'),c=require('node:crypto');
const root='/bench/campaign', id='${intent.campaign}', dir=p.join(root,id);
function physical(d){a.equal(fs.realpathSync(d),d);a.ok(fs.lstatSync(d).isDirectory()&&!fs.lstatSync(d).isSymbolicLink());}
function read(f){const s=fs.lstatSync(f);a.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&s.size<=16777216);return fs.readFileSync(f);}
physical(root);physical(dir);
const reservation=JSON.parse(read(p.join(root,'.host-attempt.json'))),plan=JSON.parse(read(p.join(dir,'plan.json')));
a.equal(reservation.id,id);a.equal(reservation.commit,'${state.commit}');a.equal(plan.round,'${state.round}');a.equal(plan.commit,'${state.commit}');a.equal(reservation.campaignSha256,plan.campaignSha256);
const names=fs.readdirSync(dir).filter(n=>/^\\d{5}-[a-z-]+\\.json$/.test(n)).sort();a.ok(names.length);
const status=JSON.parse(read(p.join(dir,names.at(-1)))).status,subject=JSON.parse(read(p.join(dir,'${prefix}-audit-subject.json')));
a.equal(status.campaign,id);a.equal(status.round,plan.round);a.equal(status.campaignSha256,plan.campaignSha256);a.equal(status.state,'blocked-review-needed');a.equal(status.auditGroup,'${group}');a.equal(status.auditInbox,id+'/${prefix}-audit-delivery.json');a.equal(status.${group === "mixed-production" ? "mixedAuditSubjectSha256" : "auditSubjectSha256"},'${intent.subjectSha256}');a.equal(subject.subjectSha256,'${intent.subjectSha256}');a.equal(subject.schema,'benchmark-${prefix}-audit-subject/v1');a.equal(subject.commit,plan.commit);a.equal(subject.campaignSha256,plan.campaignSha256);
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v!==null&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const {subjectSha256,...body}=subject;a.equal(c.createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'),subjectSha256);
${publish ? `const stage='/bench/cloud-${prefix}-audit-${state.token}.json',target=p.join(dir,'${prefix}-audit-delivery.json');
const bytes=read(stage);a.equal(c.createHash('sha256').update(bytes).digest('hex'),'${intent.sha256}');a.equal(fs.lstatSync(stage).mode&63,0);
const data=JSON.parse(bytes);a.equal(data.schema,'${schema}');a.equal(data.subjectSha256,subjectSha256);a.equal(data.review.subjectSha256,subjectSha256);a.equal(data.review.decision,'approved');a.deepEqual(data.review.findings,[]);a.equal(data.bundle.schema,'${bundleSchema}');
const expected=${group === "mixed-production" ? "subject.requests.map(r=>r.identity)" : "subject.identities"},actual=data.bundle.receipts.map(r=>r.identity);
a.ok(Array.isArray(expected));a.equal(actual.length,expected.length);
const keys=new Set();for(let i=0;i<actual.length;i++){const value=actual[i],key=value.app+'/'+value.key;a.ok(!keys.has(key));keys.add(key);const wanted=${group === "mixed-production" ? "expected[i]" : "expected.find(v=>v.app===value.app&&v.key===value.key)"};a.deepEqual(canonical(value),canonical(wanted));}
a.equal(fs.lstatSync(target,{throwIfNoEntry:false}),undefined,'inbox collision');
const moved=require('node:child_process').spawnSync('mv',['-T','--no-clobber','--',stage,target],{timeout:10000,stdio:'ignore'});
a.equal(moved.status,0);a.equal(fs.lstatSync(stage,{throwIfNoEntry:false}),undefined,'inbox collision');a.equal(c.createHash('sha256').update(read(target)).digest('hex'),'${intent.sha256}');` : ""}
console.log('${intent.subjectSha256}');`;
}
export function auditScript(state, intent, publish = false) {
  const script = auditProgram(state, intent, publish);
  return `node -e '${script.replaceAll("'", "'\\''")}'`;
}
