// Rendering fixtures need emitted JavaScript, not the removed transpileModule API.
// Use each app's pinned compiler; this is not the app's type check.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function transpile(source, caller, commonjs = false) {
  const compiler = join(dirname(createRequire(caller).resolve("typescript/package.json")), "bin", "tsc");
  const dir = mkdtempSync(join(tmpdir(), "corten-transpile-"));
  try {
    const file = join(dir, "fixture.tsx");
    writeFileSync(file, source);
    execFileSync(process.execPath, [compiler, "--ignoreConfig", "--noCheck", "--noResolve",
      "--target", "es2022", "--module", commonjs ? "commonjs" : "esnext", "--jsx", "react-jsx",
      "--outDir", join(dir, "out"), file], { stdio: "pipe" });
    return readFileSync(join(dir, "out", "fixture.js"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
