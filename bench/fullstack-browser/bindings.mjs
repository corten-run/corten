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
    const component = functionNode(candidate.componentSource), parsedHandler = functionNode(candidate.handlerSource);
    if (!component || !parsedHandler || !component.parameters[0]) continue;
    const matches = [];
    const findHandler = (node) => {
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.getText() === candidate.handlerSource) matches.push(node);
      ts.forEachChild(node, findHandler);
    };
    findHandler(component.body);
    if (matches.length !== 1) continue;
    const handler = matches[0];
    // Props describe only the owning component's lexical parameter. A nested
    // function between it and the mounted handler needs independent bindings.
    let nestedOwner = false;
    for (let node = handler.parent; node && node !== component; node = node.parent) if (ts.isFunctionLike(node)) nestedOwner = true;
    if (nestedOwner || component.asteriskToken || handler.asteriskToken || component.parameters[0].initializer || component.parameters[0].dotDotDotToken) continue;
    const native = { record: { id: candidate.recordId }, locale: candidate.locale }, variables = new Map();
    const parameter = component.parameters[0].name;
    if (ts.isIdentifier(parameter)) variables.set(parameter.text, native);
    else if (ts.isObjectBindingPattern(parameter)) for (const element of parameter.elements) {
      const key = element.propertyName?.text ?? element.name.text;
      if (["record", "locale"].includes(key) && ts.isIdentifier(element.name) && !element.initializer && !element.dotDotDotToken) variables.set(element.name.text, native[key]);
    }
    const bindsName = (name, text) => ts.isIdentifier(name) ? name.text === text
      : (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) && name.elements.some((e) => ts.isBindingElement(e) && bindsName(e.name, text));
    const within = (node, parent) => { for (; node; node = node.parent) if (node === parent) return true; return false; };
    const protectedName = (name) => variables.has(name) || ["fetch", "encodeURIComponent"].includes(name);
    const bindingScope = (node) => {
      if (ts.isFunctionExpression(node)) return node;
      if (ts.isCatchClause(node.parent)) return node.parent;
      const functionScoped = ts.isParameter(node) || ts.isVariableDeclaration(node)
        && ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped);
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isFunctionLike(parent) || !functionScoped && ts.isBlock(parent)) return parent;
      return component;
    };
    const shadows = [];
    const inspectDeclarations = (node) => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) && node.name
        && node !== component.parameters[0]) {
        const bindings = (name) => {
          if (ts.isIdentifier(name)) { if (protectedName(name.text)) shadows.push(node); }
          else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const binding of name.elements) if (ts.isBindingElement(binding)) bindings(binding.name);
        };
        bindings(node.name);
      }
      ts.forEachChild(node, inspectDeclarations);
    };
    inspectDeclarations(component);
    const evaluate = (node) => {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isIdentifier(node) && variables.has(node.text)) {
        if (shadows.some((declaration) => bindsName(declaration.name, node.text) && within(node, bindingScope(declaration)))) return undefined;
        return variables.get(node.text);
      }
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
    const urls = [], fetches = [];
    const writesBinding = (node) => {
      while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
      if (ts.isIdentifier(node)) return protectedName(node.text);
      if (ts.isObjectLiteralExpression(node)) return node.properties.some((p) => ts.isPropertyAssignment(p) ? writesBinding(p.initializer)
        : ts.isShorthandPropertyAssignment(p) ? writesBinding(p.name) : ts.isSpreadAssignment(p) && writesBinding(p.expression));
      if (ts.isArrayLiteralExpression(node)) return node.elements.some(writesBinding);
      if (ts.isSpreadElement(node)) return writesBinding(node.expression);
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) return writesBinding(node.left);
      return false;
    };
    const retainedReference = (node) => {
      // A component-local alias can be captured by the handler even though its
      // declaration is outside the handler body. Do not attempt alias/escape
      // analysis through initializers, assignments or another closure.
      for (let parent = node.parent; parent && parent !== component; parent = parent.parent) {
        if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionLike(parent) || ts.isPropertyDeclaration(parent)
          || ts.isBinaryExpression(parent) && ts.isAssignmentOperator(parent.operatorToken.kind)) return true;
      }
      return false;
    };
    let mutated = false;
    const inspectBindings = (node) => {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind) && writesBinding(node.left)
        || (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
          && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && writesBinding(node.operand)
        || ts.isDeleteExpression(node) && writesBinding(node.expression)
        || (ts.isForInStatement(node) || ts.isForOfStatement(node)) && writesBinding(node.initializer)) mutated = true;
      // Supported property reads do not retain the prop object. Other uses in
      // the handler or a component-scope retained reference are unsupported.
      if ((within(node, handler) || retainedReference(node))
        && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isParenthesizedExpression(node))) {
        const parent = node.parent, propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node
          || ts.isPropertyAssignment(parent) && parent.name === node
          || (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionLike(parent) || ts.isClassDeclaration(parent)) && parent.name === node;
        const value = propertyName ? undefined : evaluate(node);
        if (value && typeof value === "object" && !(ts.isPropertyAccessExpression(parent) && parent.expression === node
          && (["id", "record", "locale"].includes(parent.name.text) || !within(node, handler))) && !ts.isParenthesizedExpression(parent)) mutated = true;
      }
      ts.forEachChild(node, inspectBindings);
    };
    inspectBindings(component);
    const unconditional = (call) => {
      for (let node = call; node !== handler; node = node.parent) {
        const parent = node.parent;
        const supported = parent && (parent === handler || ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)
          || ts.isCallExpression(parent) && !(parent.flags & ts.NodeFlags.OptionalChain) || ts.isBlock(parent) || ts.isExpressionStatement(parent)
          || ts.isReturnStatement(parent) || ts.isVariableDeclaration(parent) || ts.isVariableDeclarationList(parent) || ts.isVariableStatement(parent)
          || ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken || ts.isTryStatement(parent) && node === parent.tryBlock);
        if (!supported) return false;
        if (ts.isBlock(parent)) {
          // No control-flow interpretation: a prior return/throw/branch/loop
          // makes reachability unsupported rather than a guessed executed call.
          const index = parent.statements.indexOf(node);
          if (index >= 0 && parent.statements.slice(0, index).some((s) => !ts.isExpressionStatement(s) && !ts.isVariableStatement(s) && !ts.isEmptyStatement(s))) return false;
        }
      }
      return true;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch" && node.arguments.length >= 2
        && ts.isObjectLiteralExpression(node.arguments[1]) && unconditional(node)) {
        const properties = node.arguments[1].properties;
        const methods = properties.filter((p) => ts.isPropertyAssignment(p) && p.name.text === "method");
        if (methods.length === 1 && evaluate(methods[0].initializer) === "POST"
          && properties.every((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))) {
          const url = evaluate(node.arguments[0]); if (typeof url === "string") { urls.push(url); fetches.push(node); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
    const shadowed = shadows.some((node) => fetches.some((call) => within(call, bindingScope(node))));
    if (urls.length !== 1 || shadowed || mutated) continue;
    let url, action;
    try { url = new URL(urls[0], candidate.base); action = new URL(candidate.action); } catch { continue; }
    if (url.origin !== action.origin || action.pathname !== `/marketplace/${candidate.locale}/${candidate.recordId}`
      || url.pathname !== `/api/marketplace/${candidate.recordId}` || url.searchParams.get("locale") !== candidate.locale
      || [...url.searchParams.keys()].some((key) => key !== "locale")) continue;
    return { path: url.pathname, transport: "fetch", basis: candidate.basis, recordId: candidate.recordId, locale: candidate.locale,
      handlerSha256: createHash("sha256").update(candidate.handlerSource).digest("hex"),
      componentSha256: createHash("sha256").update(candidate.componentSource).digest("hex") };
  }
  return null;
}
