import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const jsonSources = (summary) => ({ commit: summary.commit, files: Object.entries(summary.producer.sources)
  .map(([name, sha256]) => ({ path: `bench/json-api/${name}`, sha256 })) });

// The fixture store retains superseded versions for mutation tests. A reader
// needs only the version referenced by this summary. k6 writes its own files.
export function saveJsonFixture(fixture, folder) {
  const saved = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.path === "string" && fixture.artifacts.has(value.path) && !saved.has(value.path)) {
      saved.add(value.path);
      writeFileSync(join(folder, value.path), fixture.artifacts.get(value.path));
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(fixture.summary);
  writeFileSync(join(folder, "summary.json"), JSON.stringify(fixture.summary));
}
