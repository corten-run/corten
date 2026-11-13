import ts from "typescript";
import { createHash } from "node:crypto";

// Read the real mounted React handler and owning component. This does not invoke
// either function, attach an enhancement, or infer a binding from a sent POST.
export function reactHandlerSources(form) {
  const propsKey = Object.keys(form).find((key) => key.startsWith("__reactProps$"));
  const fiberKey = Object.keys(form).find((key) => key.startsWith("__reactFiber$"));
  const handler = propsKey && form[propsKey]?.onSubmit;
  if (typeof handler !== "function" || !fiberKey) return [];
  const handlerSource = Function.prototype.toString.call(handler), candidates = [], seen = new Set();
  for (let fiber = form[fiberKey]; fiber && !seen.has(fiber) && seen.size < 100; fiber = fiber.return) {
    seen.add(fiber);
    const props = fiber.memoizedProps;
    if (typeof fiber.type === "function" && typeof props?.record?.id === "string" && typeof props?.locale === "string") {
      candidates.push({ handlerSource, componentSource: Function.prototype.toString.call(fiber.type), recordId: props.record.id, locale: props.locale,
        action: form.action, base: document.baseURI, basis: "mounted-react-onSubmit-and-owning-fiber-props" });
    }
  }
  return candidates;
}

function functionNode(source) {
  const file = ts.createSourceFile("native-handler.js", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return null;
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return null;
  const expression = ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : statement.expression;
  return ts.isFunctionExpression(expression) || ts.isArrowFunction(expression) ? expression : null;
}

export function discoverReactEndpoint(candidates) {
  for (const candidate of candidates) {
    const component = functionNode(candidate.componentSource), handler = functionNode(candidate.handlerSource);
    if (!component || !handler || !component.parameters[0] || !candidate.componentSource.includes(candidate.handlerSource)) continue;
    const native = { record: { id: candidate.recordId }, locale: candidate.locale }, variables = new Map();
    const parameter = component.parameters[0].name;
    if (ts.isIdentifier(parameter)) variables.set(parameter.text, native);
    else if (ts.isObjectBindingPattern(parameter)) for (const element of parameter.elements) {
      const key = element.propertyName?.text ?? element.name.text;
      if (["record", "locale"].includes(key) && ts.isIdentifier(element.name)) variables.set(element.name.text, native[key]);
    }
    const evaluate = (node) => {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isIdentifier(node) && variables.has(node.text)) return variables.get(node.text);
      if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
      if (ts.isPropertyAccessExpression(node) && ["id", "record", "locale"].includes(node.name.text)) return evaluate(node.expression)?.[node.name.text];
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = evaluate(node.left), right = evaluate(node.right);
        if (typeof left === "string" && typeof right === "string") return left + right;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "encodeURIComponent" && node.arguments.length === 1) {
        const value = evaluate(node.arguments[0]); if (typeof value === "string") return encodeURIComponent(value);
      }
      return undefined;
    };
    const urls = [], fetches = [], shadows = [];
    const visit = (node) => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name) {
        const bindings = (name) => {
          if (ts.isIdentifier(name)) { if (variables.has(name.text) || ["fetch", "encodeURIComponent"].includes(name.text)) shadows.push(node); }
          else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const binding of name.elements) if (ts.isBindingElement(binding)) bindings(binding.name);
        };
        bindings(node.name);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch" && node.arguments.length >= 2
        && ts.isObjectLiteralExpression(node.arguments[1])) {
        const method = node.arguments[1].properties.find((p) => ts.isPropertyAssignment(p) && p.name.text === "method");
        if (method && evaluate(method.initializer) === "POST") {
          const url = evaluate(node.arguments[0]); if (typeof url === "string") { urls.push(url); fetches.push(node); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
    const within = (node, parent) => { for (; node; node = node.parent) if (node === parent) return true; return false; };
    const shadowed = shadows.some((node) => !ts.isCatchClause(node.parent) || fetches.some((call) => within(call, node.parent)));
    if (urls.length !== 1 || shadowed) continue;
    const url = new URL(urls[0], candidate.base), action = new URL(candidate.action);
    if (url.origin !== action.origin || action.pathname !== `/marketplace/${candidate.locale}/${candidate.recordId}`
      || url.pathname !== `/api/marketplace/${candidate.recordId}` || url.searchParams.get("locale") !== candidate.locale
      || [...url.searchParams.keys()].some((key) => key !== "locale")) continue;
    return { path: url.pathname, transport: "fetch", basis: candidate.basis, recordId: candidate.recordId, locale: candidate.locale,
      handlerSha256: createHash("sha256").update(candidate.handlerSource).digest("hex"),
      componentSha256: createHash("sha256").update(candidate.componentSource).digest("hex") };
  }
  return null;
}
