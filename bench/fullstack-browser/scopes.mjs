import ts from "typescript";
import { createHash, randomUUID } from "node:crypto";

const hash = (source) => createHash("sha256").update(source).digest("hex");
const primitives = new Set(["String", "encodeURIComponent"]);

// Reads a mounted callback; it never calls a submit handler or installs one.
export function mountedHandler(app) {
  const form = document.querySelector(".marketplace__alert form");
  if (!form) return null;
  if (app === "nuxt") {
    const key = Object.getOwnPropertySymbols(form).find((value) => value.description === "_vei");
    return key && form[key]?.onSubmit?.value;
  }
  const key = Object.keys(form).find((value) => value.startsWith("__reactProps$"));
  return key && form[key]?.onSubmit;
}

export function parseNativeFunction(source) {
  const file = ts.createSourceFile("native-function.js", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return file.parseDiagnostics.length ? null : file;
}
function visit(node, fn) { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); }
function calls(file) {
  const result = [];
  let root = file.statements[0]?.expression;
  while (root && ts.isParenthesizedExpression(root)) root = root.expression;
  if (!root || !ts.isFunctionLike(root)) return result;
  const scan = (node) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) result.push(node);
    ts.forEachChild(node, scan);
  };
  scan(root);
  return result;
}
function identifiers(node) {
  const names = new Set();
  visit(node, (value) => {
    if (ts.isIdentifier(value) && !(ts.isPropertyAccessExpression(value.parent) && value.parent.name === value)) names.add(value.text);
  });
  return names;
}
function localBindings(reference) {
  const names = new Set();
  const collect = (name) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const value of name.elements) if (ts.isBindingElement(value)) collect(value.name);
    }
  };
  const lexicalScope = (node) => ts.isBlock(node) || ts.isSourceFile(node) || ts.isCatchClause(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCaseBlock(node);
  const scan = (node, root, hoisted) => {
    if (node !== root && ts.isFunctionLike(node)) {
      if (!hoisted && ts.isFunctionDeclaration(node) && node.name) collect(node.name);
      return;
    }
    if (!hoisted && node !== root && lexicalScope(node)) return;
    if (ts.isVariableDeclaration(node) && (!hoisted || ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped))) collect(node.name);
    ts.forEachChild(node, (child) => scan(child, root, hoisted));
  };
  for (let node = reference.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) collect(parameter.name);
      if (node.name && ts.isIdentifier(node.name)) collect(node.name);
      if (node.body) scan(node.body, node.body, true);
    }
    if (lexicalScope(node)) scan(node, node, false);
    if (ts.isCatchClause(node) && node.variableDeclaration) collect(node.variableDeclaration.name);
  }
  return names;
}

// A small, pure expression reader, not eval. Unsupported syntax stays unresolved.
export function resolveNativeURL(node, variables) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return variables.get(node.text);
  if (ts.isPropertyAccessExpression(node) && ["params", "id", "locale"].includes(node.name.text)) return resolveNativeURL(node.expression, variables)?.[node.name.text];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveNativeURL(node.left, variables), right = resolveNativeURL(node.right, variables);
    if (typeof left === "string" && typeof right === "string") return left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = resolveNativeURL(span.expression, variables);
      if (typeof value !== "string") return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && primitives.has(node.expression.text) && node.arguments.length === 1) {
    const value = resolveNativeURL(node.arguments[0], variables);
    if (typeof value === "string") return node.expression.text === "String" ? value : encodeURIComponent(value);
  }
  return undefined;
}

export function scopedDestination(app, value, base, action) {
  if (typeof value !== "string") return null;
  let url, form;
  try { url = new URL(value, base); form = new URL(action, base); } catch { return null; }
  if (url.origin !== form.origin || url.origin !== new URL(base).origin || url.username || url.password || url.hash) return null;
  if (app === "tanstack-start") return /^\/_serverFn\/[a-f0-9]{64}$/.test(url.pathname) && !url.search ? url.pathname : null;
  const match = /^\/marketplace\/(en-US|fr-FR|de-DE)\/(item_[1-9]\d*)$/.exec(form.pathname);
  return app === "nuxt" && match && url.pathname === `/api/marketplace/${match[2]}` && !url.search ? url.pathname : null;
}

export async function inspectScopedBinding(cdp, app, base, action) {
  const group = `native-binding-${randomUUID()}`, trace = [], seen = new Set();
  const call = async (id, declaration) => (await cdp.send("Runtime.callFunctionOn", {
    objectId: id, functionDeclaration: declaration, returnByValue: true, silent: true,
  })).result?.value;
  const source = (id) => call(id, "function(){return Function.prototype.toString.call(this)}");
  const binding = async (id, name) => {
    const properties = await cdp.send("Runtime.getProperties", { objectId: id, ownProperties: true });
    const scopes = properties.internalProperties?.find((entry) => entry.name === "[[Scopes]]")?.value?.objectId;
    if (!scopes) return null;
    const list = await cdp.send("Runtime.getProperties", { objectId: scopes, ownProperties: true });
    for (const slot of list.result.filter((entry) => /^\d+$/.test(entry.name)).slice(0, 8)) {
      if (!slot.value?.objectId) continue;
      const values = await cdp.send("Runtime.getProperties", { objectId: slot.value.objectId, ownProperties: true });
      const value = values.result.find((entry) => entry.name === name)?.value;
      if (value) return value;
    }
    return null;
  };
  const walk = async (id, depth, edge = {}) => {
    if (!id || seen.has(id) || depth > 3 || seen.size >= 24) return null;
    seen.add(id);
    const text = await source(id);
    if (typeof text !== "string" || text.includes("[native code]")) return null;
    const file = parseNativeFunction(text);
    if (!file) return null;
    const sha256 = hash(text);
    trace.push({ sha256, depth, ...edge });
    const nativeURL = await call(id, 'function(){return typeof this.url==="string"?this.url:null}');
    const serverPath = app === "tanstack-start" ? scopedDestination(app, nativeURL, base, action) : null;
    if (serverPath) return { path: serverPath, transport: "fetch", basis: "mounted-handler-call-graph-native-server-function-url", trace: [...trace] };
    const posts = calls(file).filter((node) => node.arguments.length > 1 && ts.isObjectLiteralExpression(node.arguments[1])
      && node.arguments[1].properties.every(ts.isPropertyAssignment)
      && node.arguments[1].properties.some((property) => property.name.text === "method" && ts.isStringLiteralLike(property.initializer) && property.initializer.text === "POST"));
    for (const post of posts) {
      const locals = localBindings(post);
      if (app !== "nuxt" || !ts.isIdentifier(post.expression) || locals.has(post.expression.text)) continue;
      const names = identifiers(post.arguments[0]);
      if ([...names].some((name) => locals.has(name))) continue;
      const variables = new Map();
      for (const name of names) {
        if (primitives.has(name)) continue;
        const value = await binding(id, name);
        if (value?.type === "string") variables.set(name, value.value);
        else if (value?.objectId) variables.set(name, await call(value.objectId,
          'function(){return {params:{id:typeof this.params?.id==="string"?this.params.id:null,locale:typeof this.params?.locale==="string"?this.params.locale:null}}}'));
      }
      const path = scopedDestination(app, resolveNativeURL(post.arguments[0], variables), base, action);
      const callee = await binding(id, post.expression.text);
      if (path && callee?.type === "function") return { path, transport: "fetch", basis: "mounted-vue-handler-native-closure-route",
        requestFunctionSha256: hash(await source(callee.objectId)), trace: [...trace] };
    }
    for (const node of calls(file)) {
      if (!ts.isIdentifier(node.expression) || localBindings(node).has(node.expression.text) || primitives.has(node.expression.text) || node.expression.text === "fetch") continue;
      const value = await binding(id, node.expression.text);
      if (value?.type === "function") {
        const result = await walk(value.objectId, depth + 1, { parentSha256: sha256, callee: node.expression.text });
        if (result) return result;
      }
    }
    return null;
  };
  try {
    const remote = await cdp.send("Runtime.evaluate", {
      expression: `(${mountedHandler.toString()})(${JSON.stringify(app)})`, objectGroup: group, returnByValue: false, silent: true,
    });
    const observed = remote.result?.type === "function" ? await walk(remote.result.objectId, 0) : null;
    return { binding: observed, trace, reason: observed ? null : "No supported endpoint resolved from the mounted native handler" };
  } finally { await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }); }
}
