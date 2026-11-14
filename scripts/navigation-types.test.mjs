import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { API } from "typescript7/unstable/sync";
import { version } from "typescript7";

console.log(`Navigation type probes: TypeScript ${version} (typescript7)`);

// Compile in-memory mistakes inside the runtime: SOURCE is private, so a public
// typing fixture cannot exercise the helper's own annotation without exporting it.
const runtime = fileURLToPath(new URL("../crates/corten/js/corten.js", import.meta.url)).replaceAll("\\", "/");
const config = fileURLToPath(new URL("../jsconfig.json", import.meta.url));
const source = readFileSync(runtime, "utf8");

for (const [where, before, after] of [
  ["startedBy", "event.info?.[SOURCE] ??", "event.info?.[SOURCE]?.reviewTypo ??"],
  ["navigate listener", "  const skip =", "  event.info?.[SOURCE]?.reviewTypo;\n  const skip ="],
]) {
  test(`${where} rejects an unknown property of the navigation source`, () => {
    assert.equal(source.split(before).length, 2, "the probe must match exactly one runtime expression");
    const changed = source.replace(before, after);
    const position = changed.indexOf("reviewTypo");
    const api = new API({ fs: { readFile: (file) => file.replaceAll("\\", "/") === runtime ? changed : undefined } });
    try {
      const snapshot = api.updateSnapshot({ openProjects: [config] });
      try {
        const project = snapshot.getProject(config);
        assert.ok(project, "the runtime's check project must load");
        const errors = project.program.getSemanticDiagnostics(runtime);
        assert.ok(errors.some((error) => error.code === 2339 && error.pos === position),
          `expected TS2339 for reviewTypo in ${where}; an any-typed info would accept it`);
      } finally {
        snapshot.dispose();
      }
    } finally {
      api.close();
    }
  });
}
