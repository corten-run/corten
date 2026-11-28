// Fixed source-bound registration material. Receipt data never selects executable code.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { quote } from "./cloud-transport.mjs";
import source from "./isolated/control-session-source.mjs";

export const guardianSource = source;
export const guardianBootstrap = "import sys;length=int(sys.argv[1]);assert 0<length<=8388608;source=sys.stdin.buffer.read(length);assert len(source)==length;sys.argv=['corten-control','guard-stdin',sys.argv[2],source.hex()];exec(compile(source,'<corten-control>','exec'))";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const guardianSha256 = hash(guardianSource);
// A successful bootstrap seal acknowledges this complete, ordered invocation list,
// including the final SSH no-op. A successful unrelated SSH command is not a seal.
export function acknowledgedBootstrapSeal(ledger) {
  const last = ledger.at(-1);
  if (!last || last.code !== 0 || last.request.invocation.channel !== "ssh"
    || last.request.invocation.requestSha256 !== hash("set -euo pipefail\n:\n")
    || last.request.seal?.length !== ledger.length) return false;
  return ledger.every(({ request, localTerminal }, i) => localTerminal === true
    && request.epoch === "bootstrap" && request.sequence === i
    && request.helperSha256 === guardianSha256 && (i === ledger.length - 1 || request.seal === undefined)
    && last.request.seal[i]?.id === request.invocation.id
    && last.request.seal[i]?.sha256 === hash(JSON.stringify(request.invocation)));
}
function helperPath(request) {
  assert.match(request.invocation.token, /^[a-f0-9]{16}$/);
  assert.ok(Number.isSafeInteger(request.sequence) && request.sequence >= 0 && request.sequence < 4096);
  return `/run/corten-bench-control-${request.invocation.token}/helper.py`;
}
export function controlRequest(state, binary, args, timeout, epoch, seal) {
  assert.ok(["ssh", "scp"].includes(binary));
  assert.ok(["bootstrap", "audit-json-api", "audit-mixed-production", "collection"].includes(epoch));
  const invocation = { schema: "benchmark-control-invocation/v1", round: state.round, commit: state.commit, token: state.token,
    id: randomBytes(16).toString("hex"), channel: binary === "ssh" ? "ssh" : "sftp",
    purpose: epoch.startsWith("audit-") ? "audit" : epoch,
    requestSha256: hash(binary === "ssh" ? `set -euo pipefail\n${args.at(-1)}\n` : JSON.stringify(args.slice(-2))), deadlineMs: timeout };
  return { invocation, helperSha256: guardianSha256, epoch, sequence: state.control.ledger.length,
    ...(seal ? { seal: [...seal, invocation].map((v) => ({ id: v.id, sha256: hash(JSON.stringify(v)) })) } : {}) };
}
export function guardianCommand(request) {
  const path = helperPath(request);
  const length = Buffer.byteLength(JSON.stringify(request));
  assert.ok(length > 0 && length <= 8 * 1024 * 1024);
  return request.sequence === 0 ? `/usr/bin/python3 -I -c ${quote(guardianBootstrap)} ${Buffer.byteLength(guardianSource)} ${length}`
    : `/usr/bin/python3 -I ${quote(path)} guard-stdin ${length}`;
}
export function sftpGuardianCommand(request) {
  const path = helperPath(request);
  const argument = Buffer.from(JSON.stringify(request)).toString("hex");
  return `/usr/bin/python3 -I ${quote(path)} guard ${quote(argument)}`;
}
export function controlRegistration(request) {
  assert.ok(["ssh", "sftp"].includes(request.invocation.channel));
  return request.invocation.channel === "ssh" ? { request, command: guardianCommand(request),
    inputPrefix: (request.sequence === 0 ? guardianSource : "") + JSON.stringify(request) }
    : { request, command: sftpGuardianCommand(request) };
}
export function custodyCommand(token) {
  assert.match(token, /^[a-f0-9]{16}$/);
  return `/usr/bin/python3 -I -c ${quote(guardianSource)} custody '${token}'`;
}
