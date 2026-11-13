import assert from "node:assert/strict";
import ts from "typescript";
import { bindingFunctionText, bindingHash, indexBindingArtifact, bindingFunctionLocation } from "./binding-artifact.mjs";
import { handlerIntrinsics, validateBindingIdentities } from "./binding-intrinsics.mjs";

const scalar = (type = "unknown", value) => ({ kind: "scalar", type, ...(value === undefined ? {} : { value }) });
const nil = { kind: "null" };
const unwrap = (node) => { while (ts.isParenthesizedExpression(node)) node = node.expression; return node; };
const names = (node) => ts.isIdentifier(node) ? [node.text]
  : (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) ? node.elements.flatMap((e) => ts.isBindingElement(e) ? names(e.name) : []) : [];
const ordinary = (list) => [ts.NodeFlags.Let, ts.NodeFlags.Const].includes(list.flags & ts.NodeFlags.BlockScoped);
const own = (value) => value && !["borrowed", "submit", "function", "unknown"].includes(value.kind)
  && (value.kind !== "union" || value.alternatives.every(own))
  && (value.kind !== "object" || Object.values(value.fields).every(own)) && (value.kind !== "array" || value.items.every(own));
const primitive = (value) => value && (["scalar", "null", "search"].includes(value.kind) || value.kind === "union" && value.alternatives.every(primitive));
const text = (node) => node.getText().replace(/^export\s+(?:default\s+)?/, "");
const truth = (v) => {
  if (v.kind === "union") { const values = v.alternatives.map(truth); return values.every((x) => x === values[0]) ? values[0] : null; }
  return v.kind === "null" ? false : v.kind === "scalar" ? v.value === undefined ? null : Boolean(v.value) : v.kind === "unknown" ? null : true;
};
function join(a, b) {
  if (!a || !b) return { kind: "unknown" };
  if (a.kind !== b.kind) return { kind: "union", alternatives: [a, b] };
  if (a.kind === "array") return { kind: "array", fresh: a.fresh && b.fresh, items: [...a.items, ...b.items] };
  if (a.kind === "object" || a.kind === "borrowed") return { kind: a.kind, fields: Object.fromEntries([...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].map((k) => [k, join(a.fields[k] ?? nil, b.fields[k] ?? nil)])) };
  if (a.kind === "scalar") return scalar(a.type === b.type ? a.type : "unknown", a.value === b.value ? a.value : undefined);
  return JSON.stringify(a) === JSON.stringify(b) ? a : { kind: "unknown" };
}

// Free names are resolved from the mounted function's native scope descriptors.
// This collector deliberately over-collects; an unavailable binding is unknown,
// never permission to use an import's spelling as a purity contract.
export function effectFreeNames(node, handlerSource = null) {
  const declared = new Set(node.parameters?.flatMap((p) => names(p.name)) ?? []), used = new Set();
  const walk = (n) => {
    if (n !== node && ts.isFunctionLike(n) && text(n) === handlerSource) return;
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name)
      names(n.name).forEach((name) => declared.add(name));
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
      && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
      && !(ts.isBindingElement(n.parent) && n.parent.propertyName === n)) used.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node); if (node.name) declared.add(node.name.text);
  return [...used].filter((name) => !declared.has(name) && name !== "undefined");
}

export function checkBindingEffects(candidate, artifact, receipt) {
  const renderCalls = new Set(), derivation = [], stack = new Set(); let operations = 0;
  const fail = (message) => { throw new Error(message); };
  try {
    const index = indexBindingArtifact(artifact);
    assert.equal(receipt?.schema, "native-binding-links/v1");
    assert.equal(receipt.artifactSha256, artifact.sha256);
    const root = index.functions.get(receipt.component), mounted = index.functions.get(receipt.handler);
    assert.ok(root && mounted && root.script.path === mounted.script.path
      && mounted.start >= root.start && mounted.end <= root.end, "Mounted handler is not owned by the linked component");
    assert.equal(bindingFunctionText(root), candidate.componentSource);
    assert.equal(bindingFunctionText(mounted), candidate.handlerSource);
    assert.equal(receipt.recordId, candidate.recordId); assert.equal(receipt.locale, candidate.locale);
    validateBindingIdentities(receipt, candidate.base);
    const frames = new Map(receipt.frames.map((f) => [f.function, f]));
    assert.equal(frames.size, receipt.frames.length, "Duplicate function scope frame");
    const scripts = new Map(receipt.scripts.map((s) => [s.scriptId, s]));
    assert.equal(scripts.size, receipt.scripts.length, "Duplicate emitted script link");
    for (const frame of frames.values()) {
      const script = scripts.get(frame.location?.scriptId);
      assert.ok(script && script.sha256 === index.scripts.get(script.path)?.sha256, "Callable script hash is not artifact-bound");
      assert.equal(index.locate(script.path, frame.location.lineNumber, frame.location.columnNumber).id, frame.function, "Scope frame/function location mismatch");
      const expected = bindingFunctionLocation(index.functions.get(frame.function));
      assert.equal(frame.location.lineNumber, expected.lineNumber, "Native function line differs");
      assert.equal(frame.location.columnNumber, expected.columnNumber, "Native function column differs");
    }
    assert.ok(frames.has(root.id) && frames.has(mounted.id), "Mounted function native locations unavailable");
    const intrinsicBinding = (value, name) => {
      assert.ok(value?.kind === "intrinsic" && value.name === name && Number.isInteger(value.identity)
        && receipt.intrinsicIdentities[value.identity]?.label === name, `Unproved lexical intrinsic binding ${name}`);
    };
    const inspectTransport = (node) => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && handlerIntrinsics.includes(node.expression.text))
        intrinsicBinding(frames.get(mounted.id).bindings[node.expression.text], node.expression.text);
      ts.forEachChild(node, inspectTransport);
    };
    inspectTransport(mounted.node);
    const modules = new Map();
    const cachedValues = [];
    const importTarget = (entry, name) => {
      const statement = entry.script.file.statements.find((s) => ts.isImportDeclaration(s)
        && (s.importClause?.name?.text === name || s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
          && s.importClause.namedBindings.elements.some((p) => p.name.text === name)));
      if (!statement) return null;
      assert.ok(ts.isStringLiteral(statement.moduleSpecifier), "Unresolved static import");
      const module = index.scripts.get(new URL(statement.moduleSpecifier.text, `https://binding.invalid${entry.script.path}`).pathname);
      assert.ok(module, "Import target missing from emitted artifact");
      const spec = statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements.find((p) => p.name.text === name) : null;
      let exported = spec ? spec.propertyName?.text ?? spec.name.text : "default";
      const alias = module.file.statements.filter(ts.isExportDeclaration).flatMap((s) => s.exportClause && ts.isNamedExports(s.exportClause) ? s.exportClause.elements : [])
        .find((p) => p.name.text === exported);
      if (alias) exported = alias.propertyName?.text ?? alias.name.text;
      const declaration = module.file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === exported);
      if (declaration) return module.functions.find((f) => f.node === declaration)?.id;
      const variable = module.file.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations])
        .find((d) => ts.isIdentifier(d.name) && d.name.text === exported);
      if (variable?.initializer) {
        let value = variable.initializer;
        if (ts.isIdentifier(value)) {
          const fn = module.file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === value.text);
          if (fn) value = fn;
        }
        return module.functions.find((f) => f.node === value)?.id ?? null;
      }
      return null;
    };
    const decode = (value) => {
      if (!value) return { kind: "unknown" };
      if (value.kind === "function") {
        const entry = index.functions.get(value.function); assert.ok(entry, "Callable is outside the emitted artifact");
        return { kind: "function", node: entry.node, entry, environment: null };
      }
      if (value.kind === "object" || value.kind === "borrowed") return { ...value, fields: Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, decode(v)])) };
      if (value.kind === "array") return { ...value, items: value.items.map(decode) };
      if (value.kind === "intrinsic") intrinsicBinding(value, value.name);
      if (["scalar", "null", "intrinsic", "cache", "intl"].includes(value.kind)) return { ...value };
      return { kind: "unknown" };
    };
    const property = (object, key) => {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("Unsupported prototype property");
      if (["object", "borrowed"].includes(object.kind)) return object.fields[key] ?? nil;
      if (object.kind === "array" && key === "length") return scalar("number");
      if (object.kind === "array" && /^\d+$/.test(key)) return object.items[Number(key)] ?? object.items[0] ?? { kind: "unknown" };
      if (object.kind === "intrinsic" && object.name === "Intl" && ["NumberFormat", "PluralRules"].includes(key)) return { kind: "intrinsic", name: `Intl.${key}` };
      return fail(`Unproved property receiver ${object.kind}.${key}`);
    };
    const bind = (pattern, value, env) => {
      if (ts.isIdentifier(pattern)) { env.set(pattern.text, value); return; }
      if (ts.isObjectBindingPattern(pattern)) {
        for (const p of pattern.elements) {
          if (p.dotDotDotToken || p.propertyName && !ts.isIdentifier(p.propertyName) && !ts.isStringLiteral(p.propertyName)) fail("Unsupported destructuring key/rest");
          let item = property(value, p.propertyName?.text ?? p.name.text);
          if (p.initializer) { const fallback = expression(p.initializer, env); if (item.kind === "null") item = fallback; }
          bind(p.name, item, env);
        }
        return;
      }
      if (ts.isArrayBindingPattern(pattern)) {
        if (value.kind !== "array") fail("Unproved iterable destructuring");
        pattern.elements.forEach((p, i) => { if (ts.isOmittedExpression(p)) return; if (p.dotDotDotToken || p.initializer) fail("Unsupported iterable rest/default"); bind(p.name, value.items[i] ?? { kind: "unknown" }, env); });
        return;
      }
      fail("Unsupported binding pattern");
    };
    const moduleEnvironment = (entry) => {
      if (modules.has(entry.script.path)) return modules.get(entry.script.path);
      const env = new Map(); modules.set(entry.script.path, env);
      // Module-level code has its own effect boundary. Bundler registration,
      // arbitrary initializers, exports with getters and dynamic imports are not
      // silently reduced to a list of function declarations.
      for (const s of entry.script.file.statements) {
        if (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) {
          if (ts.isImportDeclaration(s) && !s.importClause) fail("Unproved side-effect import");
          if (s.moduleSpecifier) {
            assert.ok(ts.isStringLiteral(s.moduleSpecifier), "Unresolved module specifier");
            const path = new URL(s.moduleSpecifier.text, `https://binding.invalid${entry.script.path}`).pathname;
            const imported = index.scripts.get(path); assert.ok(imported, "Import is outside emitted artifact");
            moduleEnvironment({ script: imported, id: `module:${imported.sha256}` });
          }
          continue;
        }
        if (ts.isEmptyStatement(s)) continue;
        if (ts.isFunctionDeclaration(s)) { if (s.name) env.set(s.name.text, { kind: "function", node: s, entry: entry.script.functions.find((f) => f.node === s), environment: env }); }
        else if (ts.isVariableStatement(s) && ordinary(s.declarationList)) {
          for (const d of s.declarationList.declarations) { if (!d.initializer) fail("Uninitialized module binding"); bind(d.name, expression(d.initializer, env, entry), env); }
        } else if (ts.isExportAssignment(s)) expression(s.expression, env, entry);
        else fail("Unsupported emitted module initializer");
      }
      return env;
    };
    const resolve = (name, env, entry) => {
      if (env.has(name)) return env.get(name);
      if (name === "undefined") return nil;
      const lexical = [...frames.values()].filter((f) => {
        const outer = index.functions.get(f.function);
        return outer?.script.path === entry.script.path && outer.start <= entry.start && outer.end >= entry.end && f.bindings[name];
      }).sort((a, b) => (index.functions.get(a.function).end - index.functions.get(a.function).start)
        - (index.functions.get(b.function).end - index.functions.get(b.function).start));
      const linked = frames.get(entry.id)?.bindings?.[name] ?? lexical[0]?.bindings[name];
      if (linked) {
        if (linked.kind === "function") {
          const target = importTarget(entry, name);
          if (target) assert.equal(linked.function, target, "Native callable differs from its emitted import/export binding");
        }
        if (linked.kind === "cache") {
          const module = moduleEnvironment(entry);
          const value = module.get(name);
          if (value?.kind !== "cache") fail("Cache lacks source-bound initializer");
          for (const actual of linked.values ?? []) {
            const decoded = decode(actual); if (!own(decoded)) fail("Cache contains borrowed/unproved retained state");
            cachedValues.push(decoded);
          }
          value.observed = cachedValues;
          return value;
        }
        return decode(linked);
      }
      const module = modules.get(entry.script.path);
      if (module?.has(name)) return module.get(name);
      if (["Map", "URLSearchParams", "FormData", "String", "encodeURIComponent", "Intl"].includes(name)
        && receipt.intrinsicIdentities.some((r) => r.label === name && r.observed && r.snapshot)) return { kind: "intrinsic", name };
      return fail(`Unresolved callable/data binding ${name}`);
    };
    const invoke = (fn, args) => {
      if (fn.kind !== "function") fail("Unresolved or unsupported callee");
      const { node, entry } = fn;
      if (!entry || stack.has(node) || stack.size >= 24 || node.asteriskToken || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) fail("Unsupported recursive/async render call");
      moduleEnvironment(entry);
      const env = new Map(fn.environment ?? []);
      node.parameters.forEach((p, i) => {
        if (p.dotDotDotToken) fail("Unsupported render rest parameter");
        const fallback = p.initializer ? expression(p.initializer, env, entry) : nil;
        bind(p.name, args[i] ?? fallback, env);
      });
      stack.add(node);
      try {
        const result = ts.isBlock(node.body) ? statements(node.body.statements, env, entry).value ?? nil : expression(node.body, env, entry);
        derivation.push({ function: entry.id, result: result.kind }); return result;
      } finally { stack.delete(node); }
    };
    const statements = (list, env, entry) => {
      const returns = [];
      for (const s of list) {
        if (ts.isEmptyStatement(s)) continue;
        if (ts.isVariableStatement(s) && ordinary(s.declarationList)) {
          for (const d of s.declarationList.declarations) bind(d.name, d.initializer ? expression(d.initializer, env, entry) : nil, env);
        } else if (ts.isReturnStatement(s)) { returns.push(s.expression ? expression(s.expression, env, entry) : nil); }
        else if (ts.isExpressionStatement(s)) expression(s.expression, env, entry);
        else if (ts.isIfStatement(s)) {
          const condition = expression(s.expression, env, entry);
          const yes = new Map(env), no = new Map(env);
          const a = statements(ts.isBlock(s.thenStatement) ? s.thenStatement.statements : [s.thenStatement], yes, entry);
          const b = s.elseStatement ? statements(ts.isBlock(s.elseStatement) ? s.elseStatement.statements : [s.elseStatement], no, entry) : {};
          // Check both paths, then join conservatively. A fresh array on one
          // branch cannot make a borrowed array on the other branch sortable.
          const known = truth(condition), selected = known === true ? yes : known === false ? no : null;
          for (const key of env.keys()) env.set(key, selected ? selected.get(key) : join(yes.get(key), no.get(key)));
          if (known !== false && a.value) returns.push(a.value);
          if (known !== true && b.value) returns.push(b.value);
        } else if (ts.isBlock(s)) { const nested = statements(s.statements, new Map(env), entry); if (nested.value) returns.push(nested.value); }
        else fail(`Unsupported effect statement ${ts.SyntaxKind[s.kind]}`);
      }
      return { value: returns.length ? returns.reduce(join) : undefined };
    };
    const expression = (input, env, entry = root) => {
      if (++operations > 25000) fail("Effect grammar operation bound exceeded");
      const node = unwrap(input);
      if (node === mounted.node) return { kind: "submit" };
      if (ts.isStringLiteralLike(node)) return scalar("string", node.text);
      if (ts.isNumericLiteral(node)) return scalar("number", Number(node.text));
      if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return scalar("boolean", node.kind === ts.SyntaxKind.TrueKeyword);
      if (node.kind === ts.SyntaxKind.NullKeyword) return nil;
      if (ts.isIdentifier(node)) return resolve(node.text, env, entry);
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const target = entry.script.functions.find((f) => f.node === node);
        return { kind: "function", node, entry: target, environment: new Map(env) };
      }
      if (ts.isArrayLiteralExpression(node)) return { kind: "array", fresh: true, items: node.elements.map((n) => expression(n, env, entry)) };
      if (ts.isObjectLiteralExpression(node)) {
        const fields = {};
        for (const p of node.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) {
            if (["__proto__", "prototype", "constructor"].includes(p.name.text)) fail("Unsupported object prototype key");
            fields[p.name.text] = expression(p.initializer, env, entry);
          }
          else if (ts.isShorthandPropertyAssignment(p) && !p.objectAssignmentInitializer) fields[p.name.text] = resolve(p.name.text, env, entry);
          else if (ts.isSpreadAssignment(p)) {
            const value = expression(p.expression, env, entry);
            if (value.kind !== "object") fail("Unproved object spread/getters"); Object.assign(fields, value.fields);
          } else fail("Unsupported property key/accessor/method");
        }
        return { kind: "object", fields };
      }
      if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return property(expression(node.expression, env, entry), node.name.text);
      if (ts.isElementAccessExpression(node) && !node.questionDotToken && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)))
        return property(expression(node.expression, env, entry), node.argumentExpression.text);
      if (ts.isElementAccessExpression(node) && !node.questionDotToken) {
        const key = expression(node.argumentExpression, env, entry);
        if (!primitive(key) || key.value === undefined) fail("Unresolved computed data key");
        return property(expression(node.expression, env, entry), String(key.value));
      }
      if (ts.isConditionalExpression(node)) {
        const condition = expression(node.condition, env, entry);
        const a = expression(node.whenTrue, new Map(env), entry), b = expression(node.whenFalse, new Map(env), entry);
        return truth(condition) === true ? a : truth(condition) === false ? b : join(a, b);
      }
      if (ts.isBinaryExpression(node)) {
        if (ts.isAssignmentOperator(node.operatorToken.kind)) {
          if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(node.left) || !env.has(node.left.text)) fail("Write to borrowed/nonlocal state");
          const value = expression(node.right, env, entry); env.set(node.left.text, value); return value;
        }
        if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) fail("Unsupported render sequence");
        const a = expression(node.left, env, entry), b = expression(node.right, env, entry);
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return truth(a) === true ? b : truth(a) === false ? a : join(a, b);
        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return truth(a) === true ? a : truth(a) === false ? b : join(a, b);
        if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return a.kind === "null" ? b : a.kind === "unknown" ? join(a, b) : a;
        if (!primitive(a) || !primitive(b)) fail("Unproved object coercion");
        return scalar(node.operatorToken.kind === ts.SyntaxKind.PlusToken && (a.type === "string" || b.type === "string" || a.kind === "search" || b.kind === "search") ? "string" : "number");
      }
      if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
        const value = expression(node.operand, env, entry);
        if (node.operator !== ts.SyntaxKind.ExclamationToken && !primitive(value)) fail("Unproved unary coercion");
        return node.operator === ts.SyntaxKind.ExclamationToken ? scalar("boolean", truth(value) === null ? undefined : !truth(value)) : scalar("number");
      }
      if (ts.isNewExpression(node)) {
        const ctor = expression(node.expression, env, entry), args = (node.arguments ?? []).map((n) => expression(n, env, entry));
        if (ctor.kind !== "intrinsic") fail("Unresolved constructor");
        if (ctor.name === "Map" && !args.length) return { kind: "cache", value: nil };
        if (ctor.name === "URLSearchParams" && args.length === 1 && own(args[0])) return { kind: "search" };
        if (["Intl.NumberFormat", "Intl.PluralRules"].includes(ctor.name) && args.every(own)) return { kind: "intl", type: ctor.name };
        fail("Unsupported constructor effects");
      }
      if (ts.isCallExpression(node) && !node.questionDotToken) {
        let callee = unwrap(node.expression);
        // Native compiler output uses (0, namespace.member) to drop a receiver.
        if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken && ts.isNumericLiteral(callee.left) && callee.left.text === "0") callee = callee.right;
        const args = node.arguments.map((n) => expression(n, env, entry));
        if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken) {
          const receiver = expression(callee.expression, env, entry), method = callee.name.text;
          if (receiver.kind === "array" && ["map", "filter", "slice", "sort"].includes(method)) {
            if (method === "slice") { if (!args.every(primitive)) fail("Unproved slice coercion"); return { ...receiver, fresh: true }; }
            if (args.length !== 1 || args[0].kind !== "function" || method === "sort" && !receiver.fresh) fail("Unproved array callback/freshness");
            const items = receiver.items.length ? receiver.items : [{ kind: "unknown" }];
            const output = items.map((item) => invoke(args[0], method === "sort" ? [item, item] : [item, scalar("number")]));
            return { kind: "array", fresh: true, items: method === "map" ? output : receiver.items };
          }
          if (receiver.kind === "scalar" && receiver.type === "string" && method === "startsWith" && args.length === 1 && primitive(args[0])) return scalar("boolean");
          if (receiver.kind === "intl" && ["format", "select"].includes(method) && args.length === 1 && primitive(args[0])) return scalar("string");
          if (receiver.kind === "cache" && method === "get" && args.length === 1 && primitive(args[0])) {
            if (!receiver.observed?.length) return receiver.value;
            return receiver.observed.reduce(join);
          }
          if (receiver.kind === "cache" && method === "set" && args.length === 2 && primitive(args[0]) && own(args[1])) { receiver.value = args[1]; return receiver; }
        }
        const fn = expression(callee, env, entry);
        if (fn.kind === "intrinsic" && fn.name === "encodeURIComponent" && args.length === 1 && primitive(args[0])) return scalar("string");
        const result = invoke(fn, args);
        if (result.kind === "object" && args[0]?.kind === "scalar" && args[1]?.kind === "object") renderCalls.add(node.getStart() - root.node.body.getStart());
        return result;
      }
      fail(`Unsupported effect expression ${ts.SyntaxKind[node.kind]}`);
    };
    const env = new Map(), props = decode(receipt.props);
    assert.equal(props.kind, "borrowed");
    props.fields.locale = scalar("string", candidate.locale);
    if (props.fields.record?.fields) props.fields.record.fields.id = scalar("string", candidate.recordId);
    root.node.parameters.forEach((p, i) => { if (p.dotDotDotToken || p.initializer || i > 0) fail("Unsupported component parameters"); bind(p.name, props, env); });
    assert.ok(ts.isBlock(root.node.body), "Unsupported component body");
    moduleEnvironment(root);
    const rendered = statements(root.node.body.statements, env, root).value;
    const installed = (value) => {
      if (!value || value.kind === "unknown" || value.kind === "function") fail("Unproved render value or escaping render callback");
      if (value.kind === "object" || value.kind === "borrowed") Object.values(value.fields).forEach(installed);
      if (value.kind === "array") value.items.forEach(installed);
      if (value.kind === "union") value.alternatives.forEach(installed);
    };
    installed(rendered);
    return { outcome: "proved", renderCalls: [...renderCalls], artifactSha256: artifact.sha256,
      derivationSha256: bindingHash(JSON.stringify(derivation)), derivation, operations };
  } catch (error) { return { outcome: "unknown", reason: error.message }; }
}
