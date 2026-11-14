// TypeScript 7 parses through its native API rather than createSourceFile(). Keep the
// source virtual so checks of fixture text never write files or read an app's config.
// The API is unstable, held to the exact compiler pin: docs/design.md#choice-handlers-checked-where-called.
import { resolve, basename } from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";

/**
 * @template T
 * @param {string} file
 * @param {string} text
 * @param {(source: import("typescript/unstable/ast").SourceFile) => T} inspect
 * @returns {T}
 */
export function parse(file, text, inspect) {
  const root = resolve("work", "typescript-parser").replaceAll("\\", "/");
  const config = `${root}/tsconfig.json`;
  const source = `${root}/${basename(file)}`;
  const api = new API({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({ compilerOptions: { allowJs: true, noLib: true, types: [] }, files: [basename(file)] }),
      [source]: text,
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const parsed = snapshot.getProject(config)?.program.getSourceFile(source);
      if (!parsed) throw new Error(`TypeScript did not parse ${file}`);
      return inspect(parsed);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
