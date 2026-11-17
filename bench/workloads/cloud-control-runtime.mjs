// Fixed source-bound registration material. Receipt data never selects executable code.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { quote } from "./cloud-transport.mjs";
import source from "./isolated/control-session-source.mjs";

export const guardianSource = source;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const guardianSha256 = hash(guardianSource);
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
  const source = Buffer.from(guardianSource).toString("hex"), argument = Buffer.from(JSON.stringify(request)).toString("hex");
  return request.sequence === 0 ? `/usr/bin/python3 -I -c ${quote(guardianSource)} guard ${quote(argument)} ${quote(source)}`
    : `/usr/bin/python3 -I '/run/corten-bench-control-${request.invocation.token}/helper.py' guard ${quote(argument)}`;
}
export function sftpGuardianCommand(request) {
  const argument = Buffer.from(JSON.stringify(request)).toString("hex");
  return `/usr/bin/python3 -I '/run/corten-bench-control-${request.invocation.token}/helper.py' guard ${quote(argument)}`;
}
export function custodyCommand(token) {
  assert.match(token, /^[a-f0-9]{16}$/);
  return `/usr/bin/python3 -I -c ${quote(guardianSource)} custody '${token}'`;
}
