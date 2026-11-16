import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const recordSchema = "native-fullstack-browser/v2";
export const cellRecordName = (app, index) => `cell-${app}-${index}`;

export function saveSummary(folder, summary) {
  assert.equal(summary.schema, recordSchema);
  for (const cells of Object.values(summary.cells)) for (const cell of cells) if (cell.evidence !== null) {
    const ref = cell.evidence;
    assert.ok(isDeepStrictEqual(Object.keys(ref).sort(), ["bytes", "path", "sha256"])
      && /^[a-f0-9]{64}$/.test(ref.sha256) && ref.path === `native-evidence/blobs/${ref.sha256}`
      && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= 64 * 1024, "Raw observations must be retained before summary save");
  }
  const text = JSON.stringify(summary, null, 2) + "\n";
  assert.ok(Buffer.byteLength(text) <= 32 * 1024 ** 2, "Summary exceeds bounded JSON parser budget");
  writeFileSync(join(folder, "summary.json.tmp"), text); renameSync(join(folder, "summary.json.tmp"), join(folder, "summary.json"));
}

export function retainCell(store, app, index, cell) {
  return { ...cell, evidence: cell.evidence === null ? null : store.recordJSON(cellRecordName(app, index), cell.evidence) };
}

// A reader resolves exactly one cell at a time. The summary remains the complete
// outcome inventory, not a second inline copy of all raw observations.
export function cellReader(summary, reader) {
  assert.equal(summary.schema, recordSchema);
  assert.equal(reader.manifest.schema, "native-browser-evidence/v3");
  return (cell, app) => {
    if (cell.evidence === null) return cell;
    const index = summary.cells[app].indexOf(cell);
    assert.ok(index >= 0 && isDeepStrictEqual(cell.evidence, reader.manifest.records[cellRecordName(app, index)]), "Cell evidence root binding differs");
    return { ...cell, evidence: reader.json(cell.evidence) };
  };
}
