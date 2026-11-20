// TypeScript 7 parses through its native API rather than createSourceFile(). Keep the
// source virtual so checks of fixture text never write files or read an app's config.
// The API is unstable, held to the exact compiler pin: docs/design.md#choice-handlers-checked-where-called.
import { resolve, basename } from "node:path";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { version } from "typescript";

console.log(`TypeScript AST checks: ${version}`);

/**
 * @template T
 * @param {string} file
 * @param {string} text
 * @param {(source: import("typescript/unstable/ast").SourceFile) => T} inspect
 * @returns {T}
 */
export function parse(file, text, inspect) {
  return parseFiles([{ file, text }], (_file, _text, source) => inspect(source))[0];
}

/**
 * Parse a scan in one native process and snapshot, keeping files with the same basename distinct.
 * @template T
 * @param {{ file: string, text: string }[]} files
 * @param {(file: string, text: string, source: import("typescript/unstable/ast").SourceFile) => T} inspect
 * @returns {T[]}
 */
export function parseFiles(files, inspect) {
  const root = resolve("work", "typescript-parser").replaceAll("\\", "/");
  const config = `${root}/tsconfig.json`;
  const paths = files.map(({ file }, index) => `${index}/${basename(file)}`);
  const api = new API({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({ compilerOptions: { allowJs: true, noLib: true, types: [] }, files: paths }),
      ...Object.fromEntries(files.map(({ text }, index) => [`${root}/${paths[index]}`, text])),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      return files.map(({ file, text }, index) => {
        const parsed = project?.program.getSourceFile(`${root}/${paths[index]}`);
        if (!parsed) throw new Error(`TypeScript did not parse ${file}`);
        return inspect(file, text, parsed);
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
