import ts from "typescript";

const CLIENT_ICON_RENDERERS = new Set([
  "renderClientIcon",
  "renderClientIconButton",
  "renderClientIconLink",
]);
const CLIENT_ICON_WRAPPERS = new Set(["renderClientIconButton", "renderClientIconLink"]);

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
  }
  return null;
}

function resolveStringValues(node, declarations, seen = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isParenthesizedExpression(node)) {
    return resolveStringValues(node.expression, declarations, seen);
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveStringValues(node.whenTrue, declarations, seen);
    const whenFalse = resolveStringValues(node.whenFalse, declarations, seen);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = declarations.get(node.text);
    if (!initializer) {
      return null;
    }
    return resolveStringValues(initializer, declarations, new Set([...seen, node.text]));
  }
  return null;
}

export function collectClientIconNames(source, fileName = "setup-flow.js") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const declarations = new Map();
  const names = new Set();

  function collectDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  function collectCalls(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLIENT_ICON_RENDERERS.has(node.expression.text)) {
      const renderer = node.expression.text;
      if (renderer === "renderClientIcon" && CLIENT_ICON_WRAPPERS.has(enclosingFunctionName(node))) {
        ts.forEachChild(node, collectCalls);
        return;
      }

      let iconExpression = node.arguments[0];
      if (renderer !== "renderClientIcon") {
        const input = node.arguments[0];
        if (!input || !ts.isObjectLiteralExpression(input)) {
          throw new Error(`${renderer} must receive an object literal so its icon can be validated at build time.`);
        }
        const iconProperty = input.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === "icon") ||
              (ts.isStringLiteral(property.name) && property.name.text === "icon")),
        );
        iconExpression = iconProperty?.initializer;
      }

      const resolved = iconExpression ? resolveStringValues(iconExpression, declarations) : null;
      if (!resolved || resolved.length === 0) {
        throw new Error(`${renderer} icon must resolve to string literals at build time.`);
      }
      for (const name of resolved) {
        names.add(name);
      }
    }
    ts.forEachChild(node, collectCalls);
  }
  collectCalls(sourceFile);
  return [...names].sort();
}

export function validateClientIconNames(source, allowedNames, fileName = "setup-flow.js") {
  const names = collectClientIconNames(source, fileName);
  const allowed = new Set(allowedNames);
  const unsupported = names.filter((name) => !allowed.has(name));
  if (unsupported.length > 0) {
    throw new Error(`Client icons are missing from the Lucide allow-list: ${unsupported.join(", ")}`);
  }
  return names;
}
