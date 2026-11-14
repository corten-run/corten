import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createBindingArtifact } from "./binding-artifact.mjs";

// Copy public emitted bytes from a stopped, immutable native image. Never run a
// candidate, rebuild its code with a different compiler, or accept page metadata.
export async function bindingArtifactFromImage(command, { imageId, sourceCommit, task, owned = null }) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(task, /^browser-[a-f0-9-]+$/);
  const scratch = mkdtempSync(join(tmpdir(), "native-binding-")); let container;
  try {
    container = owned ? await owned.create(`${task}-binding`, [], imageId, [], { role: "artifact", app: "nextjs", case: null })
      : await command("docker", ["create", "--pull=never", "--label", "agent.owner=codex", "--label", `agent.task=${task}`, imageId]);
    assert.match(container, /^[a-f0-9]{64}$/);
    if (owned) await owned.copy(container, scratch);
    else await command("docker", ["cp", `${container}:/app/.next/static`, scratch]);
    const root = join(scratch, "static"), scripts = [];
    const walk = (directory) => {
      const stat = lstatSync(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Aliased emitted artifact directory");
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name), s = lstatSync(path);
        assert.ok(!s.isSymbolicLink(), "Emitted artifact symlink refused");
        if (s.isDirectory()) walk(path);
        else if (name.endsWith(".js") || name.endsWith(".mjs")) {
          assert.ok(scripts.length < 256, "Emitted artifact exceeds supported file bound");
          assert.ok(s.isFile() && s.nlink === 1 && s.size <= 8 * 1024 * 1024, "Unsupported emitted artifact file");
          scripts.push({ path: "/_next/static/" + relative(root, path).split(sep).join("/"), source: readFileSync(path, "utf8") });
        }
      }
    };
    walk(root); assert.ok(scripts.length, "No emitted native scripts found");
    return createBindingArtifact({ imageId, sourceCommit, scripts });
  } finally {
    try { if (container) { if (owned) await owned.remove(container); else await command("docker", ["rm", "-f", "-v", container]); } }
    finally {
      assert.equal(dirname(realpathSync(scratch)), realpathSync(tmpdir()), "Scratch cleanup escaped its allocated temporary parent");
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
