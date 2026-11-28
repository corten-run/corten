// The benchmark harness's only entry to the classic TypeScript compiler API (createSourceFile,
// forEachChild, transpileModule): the bench package's install (bench/package.json). The explicit
// path never falls back to the root's TypeScript 7, whose package has no classic API, and the
// cloud validator's loader maps this same path to its pinned, captured bytes.
const install = "the benchmark harness needs the classic TypeScript compiler from bench/package.json: run npm --prefix bench ci";
let ts;
try { ts = (await import("./node_modules/typescript/lib/typescript.js")).default; }
catch (error) { throw error?.code === "ERR_MODULE_NOT_FOUND" ? new Error(install) : error; }
if (!["createSourceFile", "forEachChild", "transpileModule"].every((name) => typeof ts?.[name] === "function") || ts.ScriptTarget?.Latest === undefined)
  throw new Error(install);
export default ts;
