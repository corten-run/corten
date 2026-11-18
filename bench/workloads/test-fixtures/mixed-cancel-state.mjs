// The roster comes from the 9f controller's captured synthetic v1 reservation.
// Only the already-pinned migration identity is reused for the fake mixed host.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mixedWait } from "../cloud-cancellation.mjs";

export function mixedState() {
  const captured = JSON.parse(readFileSync(new URL("./grouped-sfo2-reservation.json", import.meta.url)));
  const { fleetSha256, ...body } = captured.fleet;
  const { round, commit, group, token, id, ip, accountId, context } = mixedWait;
  const provider = { accountId, context };
  const name = `corten-bench-groups-${round}-${token}`, tag = `corten-bench-groups-run-${token}`;
  Object.assign(body, { round, commit, provider });
  Object.assign(body.jobs.find((row) => row.group === group), { token, name, tag });
  const fleet = { ...body, fleetSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  return { ...captured, round, commit, group, token, name, tag, unit: `${name}.service`, fleet,
    selection: { schema: fleet.selection.schema, groups: fleet.selection.groups.filter((row) => row.group === group) },
    status: "running", id, ip, provider, createIntentAt: captured.createdAt, fullGroupQualified: false };
}
