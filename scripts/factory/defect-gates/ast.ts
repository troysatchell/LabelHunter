import ts from "typescript";

/** Parses one source file with parent pointers, which the walkers need. */
export function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
}

/** Visits every node depth-first. */
export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Names the function a node sits inside.
 *
 * Used by the identity hash, so two identical call sites in different
 * functions get different identities. A method name alone is not unique:
 * `A.validate()` and `B.validate()` both name only "validate", so a
 * violation in one class silently reuses the other's identity. A method
 * name is qualified with its enclosing class or object scope for this
 * reason; a plain function or arrow keeps its own name unqualified.
 */
export function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
      return `${enclosingScopeName(current)}.${current.name.text}`;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return "<module>";
}

/**
 * Reads the name of the variable or property a value is directly assigned
 * to, if there is one — `const A = <value>` or `{ A: <value> }`. Null when
 * the value sits somewhere else (an array element, a call argument), which
 * is not itself a name.
 */
function declarationOwnerName(value: ts.Expression): string | null {
  const owner = value.parent;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  if (ts.isPropertyAssignment(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  return null;
}

/**
 * Names the class or object literal a method belongs to.
 *
 * Checked shapes: a named class (`class A { validate() {} }`); an unnamed
 * class expression, named instead from its own declaration owner (`const A
 * = class { validate() {} }`); and an object literal assigned to a name —
 * directly (`const A = { validate() {} }`) or as a property value (`{ A: {
 * validate() {} } }`). Falls back to `<anonymous>` when nothing above names
 * the scope, so the identity still separates same-named methods without
 * crashing on a truly unnamed, unassigned class expression.
 */
function enclosingScopeName(method: ts.MethodDeclaration): string {
  const parent = method.parent;
  if (ts.isClassDeclaration(parent) && parent.name) return parent.name.text;
  if (ts.isClassExpression(parent)) {
    if (parent.name) return parent.name.text;
    return declarationOwnerName(parent) ?? "<anonymous>";
  }
  if (ts.isObjectLiteralExpression(parent)) {
    return declarationOwnerName(parent) ?? "<anonymous>";
  }
  return "<anonymous>";
}

/** The 1-based line of a node. */
export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
