import assert from "node:assert/strict";
import ts from "typescript";
import { bindingHash } from "./binding-artifact.mjs";

const unwrap = (n) => { while (ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const member = (n, owner, key) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === owner && n.name.text === key;

// Only the native static Turbopack registration envelope. Bodies remain code,
// not inferred-pure modules, and never run in the analyzer.
export function emittedModules(index) {
  const modules = new Map(), factories = [];
  for (const script of index.scripts.values()) {
    if (script.file.statements.length !== 1 || !ts.isExpressionStatement(script.file.statements[0])) continue;
    const call = script.file.statements[0].expression;
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "push" || call.arguments.length !== 1) continue;
    const target = unwrap(call.expression.expression);
    if (!ts.isBinaryExpression(target) || target.operatorToken.kind !== ts.SyntaxKind.BarBarToken || !member(target.left, "globalThis", "TURBOPACK")) continue;
    const init = unwrap(target.right);
    assert.ok(ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken && member(init.left, "globalThis", "TURBOPACK")
      && ts.isArrayLiteralExpression(init.right) && !init.right.elements.length, "Unsupported native module registration target");
    const array = call.arguments[0]; assert.ok(ts.isArrayLiteralExpression(array));
    const rows = array.elements;
    assert.ok(rows[0]?.getText() === '"object"==typeof document?document.currentScript:void 0', "Unsupported native module source slot");
    for (let i = 1; i < rows.length;) {
      const ids = [];
      while (ts.isNumericLiteral(rows[i])) ids.push(rows[i++].text);
      const factory = rows[i++];
      assert.ok(ids.length && factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) && ts.isBlock(factory.body), "Unsupported native module factory slot");
      const entry = script.functions.find((f) => f.node === factory); assert.ok(entry);
      const row = { ...entry, ids, hash: bindingHash(factory.getText()) };
      factories.push(row);
      for (const id of ids) {
        const rows = modules.get(id) ?? []; rows.push(row); modules.set(id, rows);
      }
    }
  }
  return { modules, owner(entry) {
    return factories.filter((m) => m.script.path === entry.script.path && m.start <= entry.start && m.end >= entry.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? null;
  } };
}

// Reviewed source-bound contracts for the immutable React production factories
// emitted by the supported native build. These are code hashes, not symbol names,
// module numbers, version strings, flags supplied by an app, or shape matches.
// JSX reads only own plain props, scalar key/ref and a host/Fragment type. Hooks
// here accept scalar initial values only; function initializers never qualify.
// A changed implementation remains unknown until its contract is reviewed.
const contracts = [
  ["d5918b91bea242c6aa406114b229e4dd41babf419e5a41dd8cf1e9c689165ef3", "5481a46f0780c24b910f1aa72ebd9334172bac63e1a197981770d522a665375c", "jsx"],
  ["bc4d7fa29d1ae5e07142d974a1132993eaa88b603e96470843f302084e769ef6", "4cef9b366d1f8a54619260c5e831a4e92b4434a3e9ab3ea32a314fd663146a93", "state"],
  ["bc4d7fa29d1ae5e07142d974a1132993eaa88b603e96470843f302084e769ef6", "48cdae205ac1268f30176fa97cc9e33c9b85251640498882a4fddf92cf216157", "ref"],
  ["e741881b537423b41e114ea753a48dee40c27ab308abe01bdc33c4542b339899", "5b793b8d32fe8b7b3f10a5af36575fe6f3eb6507e40249ffa807d185e5c58bb9", "dispatch"],
  ["e741881b537423b41e114ea753a48dee40c27ab308abe01bdc33c4542b339899", "5be50026f4ef655a4ca5532457ed2435c193f30ef2f054ca7b336aca15a8cbb4", "reducer"],
];
export function reactContract(entry, modules) {
  const owner = modules.owner(entry); if (!owner) return null;
  return contracts.find(([module, body]) => module === owner.hash && body === bindingHash(entry.node.getText()))?.[2] ?? null;
}

// Initialization-only contracts: canonical React/JSX, Next Head and their static
// interop/process dependencies. This does not permit invoking their arbitrary
// exports with application data. Static imports in these bodies are still closed
// transitively, so substituting a side-effectful dependency is not approved by a
// wrapper's unchanged hash.
export const frameworkInitializers = new Set([
  ...contracts.filter(([, , kind]) => ["jsx", "state", "ref"].includes(kind)).map(([module]) => module),
  "952ca87b8e2b19fee5b61df9a74a500974ead2ea7c3199b2cec0701f59999895",
  "ccbe3afba3e1557904517e13ae5363c2dffd40dce039e43feb9ed6a96192322d",
  "71f835ed057fe6a7a62cdbc3050fa5efdec71de26f563c56293e89f76307f305",
  "7c5fd3a1a978b0e5310d9ae217574887dedcf6f0fb662886ee4c69d748b3e5c6",
  "aaf9b1f6db81e8c3c6d8a71d2fd165da7b3512bff2e49c8b1dbd30cabce86235",
  "04ba1877a3af4b894d08946b41e9ca6cf8296b42d3262090dc2bbfac32f5c4eb",
  "f5577a32528476e525fd413683c487c08cdd2cf799ff93bfca275add6ea04cb3",
  "0df309a17cfd2cfbd9738eef9d73ea5f59aa3081039d26091de8bd5e256d13a3",
  "16427997c400558a5f28d72d87eff9ff4e93fc0af4314c55ecdee0ff228bd1b9",
  "a307d1ea8a62bde455b50027f533ab7f6ee0dbbf7feb6d73a99fac0983547e35",
  "5789b647ecb47e26693679d0cadda1aefdf0f40e82d8ce6daa757b76408cd6d1",
  "f422586bc6313cc39935fc7c3ddba364fa8640d833d9c72be6eaa6c539ac6a09",
]);

// The dispatcher contract also depends on these exact emitted ReactDOM/scheduler
// factories. Do not let unchanged dispatcher text borrow substituted dependencies.
const frameworkClosure = new Set([...frameworkInitializers,
  "e741881b537423b41e114ea753a48dee40c27ab308abe01bdc33c4542b339899",
  "e3c95ea3835cbbb44cf0dcfa0c4070478309ec1540ef0597e408c5c7684d8224",
  "d88f5f050e604f95b68dba1c8917ad1b7941ea9b1b85da86e36f31c3edd4f258",
  "065e07302b6bc15eeca8edb93dab09be9a70d671122ff3dc608e066f0105f40b",
  "925818f92d8c05a1efa776591f364461a510a5641ace5e50daaa265d8bb56aaa",
]);
export function validateFrameworkClosure(entry, modules) {
  const seen = new Set();
  const visit = (factory) => {
    assert.ok(factory && frameworkClosure.has(factory.hash), "Unproved source-bound framework dependency");
    if (seen.has(factory.id)) return; seen.add(factory.id);
    const loader = factory.node.parameters[0].name;
    assert.ok(ts.isIdentifier(loader));
    const scan = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === loader.text && ["i", "r"].includes(node.expression.name.text)) {
        assert.ok(node.arguments.length === 1 && ts.isNumericLiteral(node.arguments[0]), "Unresolved framework dependency");
        const targets = modules.modules.get(node.arguments[0].text); assert.ok(targets?.length, "Framework dependency missing from artifact");
        targets.forEach(visit);
      }
      ts.forEachChild(node, scan);
    };
    scan(factory.node.body);
  };
  visit(modules.owner(entry));
}
