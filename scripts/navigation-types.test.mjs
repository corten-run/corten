import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { API } from "typescript/unstable/sync";
import { version } from "typescript";

console.log(`Navigation type probes: TypeScript ${version}`);

// Compile in-memory mistakes inside the runtime: SOURCE is private, so a public
// typing fixture cannot exercise the helper's own annotation without exporting it.
const runtime = fileURLToPath(new URL("../crates/corten/js/corten.js", import.meta.url)).replaceAll("\\", "/");
const config = fileURLToPath(new URL("../jsconfig.json", import.meta.url));
const source = readFileSync(runtime, "utf8");

for (const [where, before, after, code, marker] of [
  ["startedBy source shape", "event.info?.[SOURCE] ??", "event.info?.[SOURCE]?.reviewTypo ??", 2339, "reviewTypo"],
  ["navigate listener source shape", "  const skip =", "  event.info?.[SOURCE]?.reviewTypo;\n  const skip =", 2339, "reviewTypo"],
  ["optional Navigation API", "const navigation = /** @type {Navigation | undefined} */ (window.navigation);",
    "const navigation = /** @type {Navigation | undefined} */ (window.navigation);\nnavigation.currentEntry;", 18048, "navigation.currentEntry"],
]) {
  test(`${where} rejects an unsafe read`, () => {
    assert.equal(source.split(before).length, 2, "the probe must match exactly one runtime expression");
    const changed = source.replace(before, after);
    const position = changed.indexOf(marker, source.indexOf(before));
    const api = new API({ fs: { readFile: (file) => file.replaceAll("\\", "/") === runtime ? changed : undefined } });
    try {
      const snapshot = api.updateSnapshot({ openProjects: [config] });
      try {
        const project = snapshot.getProject(config);
        assert.ok(project, "the runtime's check project must load");
        const errors = project.program.getSemanticDiagnostics(runtime);
        assert.ok(errors.some((error) => error.code === code && error.pos === position),
          `expected TS${code} for ${marker} in ${where}`);
      } finally {
        snapshot.dispose();
      }
    } finally {
      api.close();
    }
  });
}
