import ts from "typescript";
import { createHash } from "node:crypto";
import { createBindingArtifact, indexBindingArtifact, bindingHash, bindingFunctionLocation } from "./binding-artifact.mjs";
import { checkBindingEffects } from "./binding-effects.mjs";
import { handlerIntrinsics, requiredBindingIdentities } from "./binding-intrinsics.mjs";

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

function renderExpression(node) {
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isIdentifier(node)
    || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isParenthesizedExpression(node)) return renderExpression(node.expression);
  if (ts.isPropertyAccessExpression(node)) return !node.questionDotToken && renderExpression(node.expression);
  if (ts.isElementAccessExpression(node)) return !node.questionDotToken && renderExpression(node.expression) && renderExpression(node.argumentExpression);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    let callee = node.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isCallExpression(node) && ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken
      && ts.isNumericLiteral(callee.left) && callee.left.text === "0") callee = callee.right;
    return !(node.flags & ts.NodeFlags.OptionalChain) && renderExpression(callee) && (node.arguments ?? []).every(renderExpression);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(renderExpression);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) => ts.isPropertyAssignment(property)
    ? (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) && renderExpression(property.initializer)
    : ts.isShorthandPropertyAssignment(property) ? !property.objectAssignmentInitializer : ts.isSpreadAssignment(property) && renderExpression(property.expression));
  if (ts.isSpreadElement(node)) return renderExpression(node.expression);
  if (ts.isConditionalExpression(node)) return [node.condition, node.whenTrue, node.whenFalse].every(renderExpression);
  if (ts.isBinaryExpression(node)) return !ts.isAssignmentOperator(node.operatorToken.kind)
    && node.operatorToken.kind !== ts.SyntaxKind.CommaToken && renderExpression(node.left) && renderExpression(node.right);
  if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)
    && renderExpression(node.operand);
  return false;
}

function ordinaryDeclarations(list) {
  const kind = list.flags & ts.NodeFlags.BlockScoped;
  return kind === ts.NodeFlags.Let || kind === ts.NodeFlags.Const;
}

function renderConstructor(node, component, approved) {
  if (!(ts.isCallExpression(node) && !(node.flags & ts.NodeFlags.OptionalChain)
    && approved.has(node.getStart() - component.body.getStart())
    && [2, 3].includes(node.arguments.length) && ts.isStringLiteral(node.arguments[0])
    && ts.isObjectLiteralExpression(node.arguments[1]))) return false;
  const props = node.arguments[1].properties;
  return props.every((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
    && new Set(props.map((p) => p.name.text)).size === props.length;
}

function supportedComponentBody(body) {
  if (!ts.isBlock(body)) return false;
  // This is a declaration-and-render reader, not a component interpreter.
  // In particular, arbitrary executable statements can retain a prop without
  // leaving any reference in the declaration/handler trees we can resolve.
  const statements = body.statements.filter((node) => !ts.isEmptyStatement(node));
  return statements.length > 0 && ts.isReturnStatement(statements.at(-1))
    && renderExpression(statements.at(-1).expression)
    && statements.slice(0, -1).every((node) => ts.isVariableStatement(node) && ordinaryDeclarations(node.declarationList));
}

function directHandlerBinding(handler, component, approved) {
  let value = handler;
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  const parent = value.parent;
  if (ts.isReturnStatement(parent)) return parent.expression === value && parent.parent === component.body;
  if (ts.isVariableDeclaration(parent)) return ts.isIdentifier(parent.name) && parent.initializer === value && parent.parent.parent.parent === component.body;
  if (!ts.isPropertyAssignment(parent) || parent.initializer !== value || parent.name.text !== "onSubmit") return false;
  const props = parent.parent, form = props.parent;
  if (!ts.isObjectLiteralExpression(props) || !renderConstructor(form, component, approved)
    || form.arguments[1] !== props || form.arguments[0].text !== "form") return false;
  // Only the explicit JSX host-element constructor path installs this handler.
  // A props-shaped object inside an arbitrary terminal factory is not a render.
  for (let node = form; node && node !== component; node = node.parent) {
    const owner = node.parent;
    if (ts.isReturnStatement(owner)) return owner.expression === node && owner.parent === component.body;
    if (ts.isParenthesizedExpression(owner) && owner.expression === node
      || ts.isPropertyAssignment(owner) && owner.initializer === node
      || ts.isObjectLiteralExpression(owner) || ts.isArrayLiteralExpression(owner)) continue;
    if (renderConstructor(owner, component, approved) && owner.arguments[1] === node) continue;
    return false;
  }
  return false;
}

function invokedExpression(node) {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node
    || ts.isTaggedTemplateExpression(parent) && parent.tag === node;
}

// Syntax-only controls have no native authority. Production observation always
// requires a separately captured, immutable-artifact-linked proof below.
function syntaxEffects(candidate) {
  const artifact = createBindingArtifact({ imageId: `sha256:${"0".repeat(64)}`, sourceCommit: "0".repeat(40),
    scripts: [{ path: "/syntax-control.js", source: candidate.componentSource }] });
  const index = indexBindingArtifact(artifact), functions = [...index.functions.values()];
  const root = functions.find((f) => f.node.getText() === candidate.componentSource);
  const handler = functions.find((f) => f.node.getText() === candidate.handlerSource);
  if (!root || !handler) return { outcome: "unknown", reason: "Unsupported syntax control" };
  const frames = [root, handler].map((f) => ({ function: f.id, location: { scriptId: "syntax", ...bindingFunctionLocation(f) }, bindings: {} }));
  // Synthetic facts belong only to these syntax controls, never to production
  // observation or a returned native proof.
  const intrinsicIdentities = requiredBindingIdentities.map((label, i) => ({ label, observed: `-1.1.${i + 1}`, snapshot: `-1.1.${i + 1}` }));
  frames[1].bindings = Object.fromEntries(handlerIntrinsics.map((name) => [name, { kind: "intrinsic", name, identity: requiredBindingIdentities.indexOf(name) }]));
  return checkBindingEffects(candidate, artifact, { schema: "native-binding-links/v1", artifactSha256: artifact.sha256,
    component: root.id, handler: handler.id, recordId: candidate.recordId, locale: candidate.locale, frames,
    realmObjectId: "-1.1.100", executionContextId: 1,
    scripts: [{ scriptId: "syntax", path: root.script.path, sha256: root.script.sha256, executionContextId: 1, url: new URL(root.script.path, candidate.base).href }], intrinsicIdentities,
    props: { kind: "borrowed", fields: { record: { kind: "borrowed", fields: { id: { kind: "scalar", type: "string" } } }, locale: { kind: "scalar", type: "string" } } } });
}

export function discoverReactEndpoint(candidates, linked = null, diagnostics = []) {
  for (const candidate of candidates) {
    const component = functionNode(candidate.componentSource), parsedHandler = functionNode(candidate.handlerSource);
    if (!component || !parsedHandler || !component.parameters[0] || !supportedComponentBody(component.body)) continue;
    const matches = [];
    const findHandler = (node) => {
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.getText() === candidate.handlerSource) matches.push(node);
      ts.forEachChild(node, findHandler);
    };
    findHandler(component.body);
    if (matches.length !== 1) continue;
    const handler = matches[0];
    const effects = linked ? checkBindingEffects(candidate, linked.artifact, linked.receipt) : syntaxEffects(candidate);
    if (effects.outcome !== "proved") { diagnostics.push(effects.reason); continue; }
    const approved = new Set(effects.renderCalls);
    // Props describe only the owning component's lexical parameter. A nested
    // function between it and the mounted handler needs independent bindings.
    let nestedOwner = false;
    for (let node = handler.parent; node && node !== component; node = node.parent) if (ts.isFunctionLike(node)) nestedOwner = true;
    if (nestedOwner || !directHandlerBinding(handler, component, approved) || component.asteriskToken || handler.asteriskToken
      || component.parameters[0].initializer || component.parameters[0].dotDotDotToken
      || handler.parameters.some((p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken)) continue;
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
    const protectedName = (name) => variables.has(name) || ["fetch", "encodeURIComponent", "FormData"].includes(name);
    const bindingScope = (node) => {
      if (ts.isFunctionExpression(node)) return node;
      if (ts.isCatchClause(node.parent)) return node.parent;
      const functionScoped = ts.isParameter(node) || ts.isVariableDeclaration(node)
        && ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped);
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isFunctionLike(parent) || !functionScoped && ts.isBlock(parent)) return parent;
      return component;
    };
    const shadows = [], declarations = [];
    const inspectDeclarations = (node) => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) && node.name) {
        declarations.push(node);
        const bindings = (name) => {
          if (ts.isIdentifier(name)) { if (protectedName(name.text)) shadows.push(node); }
          else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const binding of name.elements) if (ts.isBindingElement(binding)) bindings(binding.name);
        };
        if (node !== component.parameters[0]) bindings(node.name);
      }
      ts.forEachChild(node, inspectDeclarations);
    };
    inspectDeclarations(component);
    let handlerValue = handler;
    while (ts.isParenthesizedExpression(handlerValue.parent)) handlerValue = handlerValue.parent;
    if (ts.isVariableDeclaration(handlerValue.parent)) {
      const binding = handlerValue.parent;
      let escaped = false;
      const references = (node) => {
        if (ts.isIdentifier(node) && node.text === binding.name.text && node !== binding.name
          && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
          && !declarations.some((d) => d !== binding && bindsName(d.name, node.text) && within(node, bindingScope(d)))) {
          // A handler value may be returned or installed as onSubmit, not
          // aliased, captured by another closure, or consumed by a factory.
          if (ts.isVariableDeclaration(node.parent) || !directHandlerBinding(node, component, approved)) escaped = true;
        }
        ts.forEachChild(node, references);
      };
      references(component.body);
      if (escaped) continue;
    }
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
      // Reading a field is not the same operation as invoking it with the prop
      // as receiver. No method name, inherited or app-defined, is assumed pure.
      const parent = node.parent, receiver = parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node && invokedExpression(parent);
      if ((within(node, handler) || retainedReference(node) || receiver)
        && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isParenthesizedExpression(node))) {
        const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node
          || ts.isPropertyAssignment(parent) && parent.name === node
          || (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionLike(parent) || ts.isClassDeclaration(parent)) && parent.name === node;
        const value = propertyName ? undefined : evaluate(node);
        if (value && typeof value === "object" && !(ts.isPropertyAccessExpression(parent) && parent.expression === node && !receiver
          && (["id", "record", "locale"].includes(parent.name.text) || !within(node, handler))) && !ts.isParenthesizedExpression(parent)) mutated = true;
      }
      ts.forEachChild(node, inspectBindings);
    };
    inspectBindings(component);
    const eventParameter = handler.parameters[0], eventName = eventParameter?.name.text;
    const eventField = (node, field) => ts.isPropertyAccessExpression(node) && !node.questionDotToken
      && ts.isIdentifier(node.expression) && node.expression.text === eventName && node.name.text === field
      && !declarations.some((d) => d !== eventParameter && within(d, handler)
        && bindsName(d.name, eventName) && within(node.expression, bindingScope(d)));
    const prefixDeclaration = (node) => {
      if (!ordinaryDeclarations(node.parent) || !ts.isIdentifier(node.name) || !node.initializer) return false;
      const value = node.initializer;
      return typeof evaluate(value) === "string" || ts.isNumericLiteral(value)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind)
        || ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "FormData"
          && value.arguments?.length === 1 && eventField(value.arguments[0], "currentTarget");
    };
    const hook = (node, kind) => ts.isIdentifier(node) && effects.hookBindings?.[node.text]?.kind === kind
      && !declarations.some((d) => within(d, handler) && bindsName(d.name, node.text) && within(node, bindingScope(d)))
      ? effects.hookBindings[node.text] : null;
    const boolean = (node) => node.kind === ts.SyntaxKind.TrueKeyword ? true : node.kind === ts.SyntaxKind.FalseKeyword ? false
      : ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && ts.isNumericLiteral(node.operand) ? !Number(node.operand.text) : undefined;
    const refRead = (node) => ts.isPropertyAccessExpression(node) && !node.questionDotToken && node.name.text === "current" && hook(node.expression, "hookRef");
    const prefixExpression = (node, refs) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
        return prefixExpression(node.left, refs) && prefixExpression(node.right, refs);
      if (ts.isCallExpression(node) && !(node.flags & ts.NodeFlags.OptionalChain)) {
        if (!node.arguments.length && eventField(node.expression, "preventDefault")) return true;
        return !!hook(node.expression, "hookSetter") && node.arguments.length === 1 && boolean(node.arguments[0]) !== undefined;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const ref = refRead(node.left), value = boolean(node.right);
        if (ref && value !== undefined) { refs.set(ref.slot, value); return true; }
      }
      return false;
    };
    const prefixStatement = (node, refs) => {
      if (ts.isEmptyStatement(node)) return true;
      if (ts.isVariableStatement(node)) return node.declarationList.declarations.every(prefixDeclaration);
      if (ts.isExpressionStatement(node)) return prefixExpression(node.expression, refs);
      if (ts.isIfStatement(node) && !node.elseStatement && ts.isReturnStatement(node.thenStatement) && !node.thenStatement.expression) {
        let test = node.expression;
        if (ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          if (!prefixExpression(test.left, refs)) return false;
          test = test.right;
        }
        const ref = refRead(test);
        return !!ref && refs.get(ref.slot) === false;
      }
      return false;
    };
    const unconditional = (call) => {
      const prefixes = [];
      for (let node = call; node !== handler; node = node.parent) {
        const parent = node.parent;
        const supported = parent && (parent === handler || ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)
          || ts.isBlock(parent) || ts.isExpressionStatement(parent)
          || ts.isReturnStatement(parent) || ts.isVariableDeclaration(parent) || ts.isVariableDeclarationList(parent) || ts.isVariableStatement(parent)
          || ts.isTryStatement(parent) && node === parent.tryBlock);
        if (!supported) return false;
        if (ts.isVariableDeclarationList(parent) && (!ordinaryDeclarations(parent)
          || parent.declarations.slice(0, parent.declarations.indexOf(node)).some((d) => !prefixDeclaration(d)))) return false;
        if (ts.isBlock(parent)) {
          // Only modeled pre-fetch effects are supported. In particular an
          // unknown alias write, getter read, helper call or await is not pure.
          const index = parent.statements.indexOf(node);
          if (index >= 0) prefixes.push(parent.statements.slice(0, index));
        }
      }
      const refs = new Map(Object.values(effects.hookBindings ?? {}).filter((v) => v.kind === "hookRef").map((v) => [v.slot, v.value.value]));
      return prefixes.reverse().flat().every((statement) => prefixStatement(statement, refs));
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
      componentSha256: createHash("sha256").update(candidate.componentSource).digest("hex"),
      ...(linked ? { bindingProof: { schema: "native-binding-proof/v1", artifactSha256: linked.artifact.sha256,
        candidate, links: linked.receipt, effects } } : {}) };
  }
  return null;
}

export function replayBindingProof(enhancement, artifact) {
  const proof = enhancement?.bindingProof;
  if (!proof || proof.schema !== "native-binding-proof/v1" || proof.artifactSha256 !== artifact?.sha256) return false;
  const replayed = discoverReactEndpoint([proof.candidate], { artifact, receipt: proof.links });
  return Boolean(replayed && bindingHash(JSON.stringify(replayed)) === bindingHash(JSON.stringify(enhancement)));
}
