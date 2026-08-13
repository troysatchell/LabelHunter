import { readFileSync } from "node:fs";
import ts from "typescript";
import { enclosingFunctionName, lineOf, parse, walk } from "../ast";
import { violationIdentity } from "../identity";
import type { Finding, RuleContext, RuleMeta } from "../types";

/**
 * `.some` is deliberately excluded — review round 3.
 *
 * Vacuous truth means a check claims a property HOLDS when nothing was
 * examined. `[].every(p)` is `true`. It claims every element satisfied
 * `p`, over zero elements actually checked. That is the defect class
 * this rule names. `[].some(p)` is `false`. It claims "no matching
 * element found." That is the safe, usually correct default for an
 * empty collection. A bare `.some()` call is not a vacuous-truth defect.
 *
 * Known gap, not covered by this rule: a negated `.some()`. The form is
 * `if (!xs.some(bad))`. That form IS a vacuous assertion. "No bad items"
 * holds trivially when there are no items at all. This rule does not
 * detect a negated `.some()`. That gap is recorded here, not silently
 * dropped.
 */
const QUANTIFIERS = new Set(["every", "reduce"]);

const meta: RuleMeta = {
  id: "vacuous-empty-quantifier",
  version: 1,
  scope: "changeset",
  severity: "fail",
  repairability: "assisted",
  registries: [],
  // The commit that lands run.ts and the G11 wiring (TRO-508) — the first
  // commit at which the gate can actually reach this rule. A branch cut
  // before this SHA runs report-only; see decidePin in activation.ts.
  activatedAt: "a9f0c0eee8f912228382024619e58813d76eb93d",
  pinExpiresAfterMainCommits: 25,
  // Two rows were checked and dropped: TRO-474 (resolver-snapshot.ts) and
  // TRO-511 (claim.ts) both guard an empty array with a plain .length
  // check. Neither commit ever calls .every, .some, or .reduce. This rule
  // cannot see a .length guard, so those rows test a different mechanism.
  replayCorpus: [
    {
      ticket: "TRO-464",
      file: "src/server/resolver/response.ts",
      summaryIncludes: "deriveResolvedFields returned",
    },
    {
      ticket: "TRO-464",
      file: "src/server/resolver/queue.ts",
      summaryIncludes: "isResolverResolution accepted a stored row with fields: []",
    },
  ],
};

/**
 * True when the receiver cannot be empty at this call site.
 *
 * Two provable shapes, beyond a non-empty array literal:
 *
 * 1. A preceding early-exit guard, in the same function scope, before the
 *    call — `if (xs.length === 0) return;`. See `hasPrecedingLengthGuard`.
 *    "Preceding" is a position check on source offsets, not a search of
 *    the whole function. A guard written after the call does not count.
 *    "Same function scope" is a scope check: a guard inside a sibling
 *    nested function exits THAT function, not this one, so it does not
 *    count either.
 * 2. An enclosing branch condition that already proves non-emptiness —
 *    `else if (xs.length > 1) { ... xs.every(p) ... }`. The call sits
 *    inside the branch whose own test already establishes the fact. See
 *    `hasEnclosingLengthGuard`.
 */
function isProvablyNonEmpty(
  call: ts.CallExpression,
  receiver: ts.Expression,
  sourceFile: ts.SourceFile,
): boolean {
  // A literal array with at least one element.
  if (ts.isArrayLiteralExpression(receiver) && receiver.elements.length > 0) return true;

  const receiverText = receiver.getText(sourceFile);
  let fn: ts.Node | undefined = receiver.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn || !("body" in fn) || !fn.body) return false;

  if (hasPrecedingLengthGuard(fn.body as ts.Node, receiverText, call, sourceFile)) return true;
  if (hasEnclosingLengthGuard(call, receiverText, sourceFile)) return true;
  return false;
}

/**
 * Walks a node without entering a nested function-like node.
 *
 * `walk` (the shared AST helper) visits everything, which is correct for
 * finding every quantifier call in a file. A guard search is different: a
 * guard inside a sibling nested function guards THAT function's own body,
 * not the outer function the search is scoped to. This walker prunes at
 * the function boundary so such a guard is never counted.
 */
function walkOwnScope(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child)) return;
    walkOwnScope(child, visit);
  });
}

/**
 * True when an `if` mentioning `<receiver>.length` exits before the call,
 * in the same function scope.
 */
function hasPrecedingLengthGuard(
  fnBody: ts.Node,
  receiverText: string,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const callStart = call.getStart(sourceFile);
  let guarded = false;
  walkOwnScope(fnBody, (n) => {
    if (guarded || !ts.isIfStatement(n)) return;
    if (n.getStart(sourceFile) >= callStart) return; // must precede the call, not follow it
    const test = n.expression.getText(sourceFile);
    const mentionsLength =
      test.includes(`${receiverText}.length`) || test.includes(`${receiverText}?.length`);
    if (!mentionsLength) return;
    const exits =
      ts.isReturnStatement(n.thenStatement) ||
      ts.isThrowStatement(n.thenStatement) ||
      (ts.isBlock(n.thenStatement) &&
        n.thenStatement.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s)));
    if (exits) guarded = true;
  });
  return guarded;
}

/** Escapes a string for safe use inside a RegExp literal. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when a length comparison, read as the whole test, guarantees the
 * receiver holds at least one element.
 *
 * Covers `.length > N` (N >= 0), `.length >= N` (N >= 1), and `.length
 * !== 0` / `!= 0`. Not a general arithmetic prover — only the shapes this
 * rule's calibration corpus (`pairing.ts`) has actually shown.
 */
function lengthComparisonProvesNonEmpty(testText: string, receiverText: string): boolean {
  const pattern = new RegExp(
    `${escapeForRegExp(receiverText)}\\??\\.length\\s*(>=|>|!==|!=)\\s*(\\d+)`,
  );
  const match = testText.match(pattern);
  if (!match) return false;
  const n = Number.parseInt(match[2], 10);
  if (match[1] === ">") return n >= 0;
  if (match[1] === ">=") return n >= 1;
  return n === 0; // !== or !=
}

/**
 * True when the call sits inside an `if` (or `else if`) branch whose own
 * condition already proves the receiver non-empty — the `pairing.ts`
 * shape: `else if (xs.length > 1) { ... xs.every(p) ... }`.
 *
 * Climbs from the call to its enclosing `if`, checking that the call sits
 * in that `if`'s own `then` branch. Stops at the function boundary — a
 * branch condition in an outer function does not guard an inner one.
 */
function hasEnclosingLengthGuard(
  call: ts.CallExpression,
  receiverText: string,
  sourceFile: ts.SourceFile,
): boolean {
  let current: ts.Node = call;
  let parent: ts.Node | undefined = call.parent;
  while (parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isIfStatement(parent) && parent.thenStatement === current) {
      const test = parent.expression.getText(sourceFile);
      if (lengthComparisonProvesNonEmpty(test, receiverText)) return true;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * True when a node's own value is read directly at a decision point.
 *
 * Checked shapes:
 * - the whole expression of a `return`
 * - the whole test of an `if`
 * - the whole value of a property assignment (`{ outcome: x }`, or the
 *   shorthand `{ outcome }` — the same sink, two different node kinds)
 * - a bare-statement ternary's condition
 *
 * This check is deliberately shallow. It looks only one level up. It does
 * not climb through a transforming expression. `return t;` is a direct
 * use of `t`. `return t.length;` is not. The number it returns is derived
 * from `t`, but a derived value is not the same decision as the value
 * itself.
 */
function isDirectSinkUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isReturnStatement(parent) && parent.expression === node) return true;
  if (ts.isIfStatement(parent) && parent.expression === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === node) {
    return parent.parent !== undefined && ts.isExpressionStatement(parent.parent);
  }
  return false;
}

/**
 * True when a quantifier's result, assigned to a local variable, is later
 * read as a direct decision value — one hop through that one variable.
 *
 * Bounded on purpose, per review:
 * - only a `const`/`let` with a plain identifier name (no destructuring,
 *   no `var`)
 * - only inside the function that declares it
 * - only one hop — a read that itself only feeds a second variable is not
 *   followed further
 *
 * A variable declared but never read again decides nothing. A zero-read
 * variable is never a sink.
 */
function reachesSinkThroughVariable(declaration: ts.VariableDeclaration, sourceFile: ts.SourceFile): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.BlockScoped)) return false;

  let fn: ts.Node | undefined = declaration.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn || !("body" in fn) || !fn.body) return false;

  const name = declaration.name.text;
  const declarationEnd = declaration.getEnd();
  let hit = false;
  walk(fn.body as ts.Node, (n) => {
    if (hit) return;
    if (!ts.isIdentifier(n) || n === declaration.name || n.text !== name) return;
    if (n.getStart(sourceFile) <= declarationEnd) return; // only a later read
    if (isDirectSinkUse(n)) hit = true;
  });
  return hit;
}

/**
 * True when the call's result drives a program decision.
 *
 * A ternary used as a bare statement decides by side effect, not by value —
 * `p ? doA() : doB();` is the same decision as an if/else, so it is a sink.
 * Otherwise a ternary's condition is not itself a sink. What matters is
 * where its value goes next, so the walk passes through it and keeps
 * looking. This stops a display-only ternary (its value only builds a
 * string) from counting as a decision, while a ternary that feeds a
 * return, an outer ternary condition, or a property assignment still does.
 *
 * A result assigned to a local variable is also traced, one hop, through
 * `reachesSinkThroughVariable` — see that function for the exact bounds.
 */
function reachesDecisionSink(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = call;
  let child: ts.Node = call;
  while (current?.parent) {
    child = current;
    current = current.parent;
    if (ts.isReturnStatement(current)) return true;
    if (ts.isIfStatement(current) && current.expression === child) return true;
    if (ts.isConditionalExpression(current) && current.condition === child) {
      // A ternary used as a bare statement decides by side effect, not by value.
      // Its branches are the decision, so it is a sink.
      if (current.parent && ts.isExpressionStatement(current.parent)) return true;
      // Otherwise the ternary only passes a value along. Keep climbing.
      continue;
    }
    if (ts.isPropertyAssignment(current)) return true;
    if (ts.isVariableDeclaration(current) && current.initializer === child) {
      return reachesSinkThroughVariable(current, sourceFile);
    }
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function checkSource(filePath: string, text: string, _ctx: RuleContext): Finding[] {
  const sourceFile = parse(filePath, text);
  const findings: Finding[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const name = node.expression.name.text;
    if (!QUANTIFIERS.has(name)) return;

    // Exemption, not an allowlist entry — review round 3. A seeded
    // .reduce(fn, seed) cannot be vacuous. The seed IS the defined result
    // for an empty collection. An unseeded .reduce(fn) is still checked
    // below. It throws on an empty collection. That is a real defect this
    // rule should catch.
    if (name === "reduce" && node.arguments.length >= 2) return;

    const receiver = node.expression.expression;
    if (isProvablyNonEmpty(node, receiver, sourceFile)) return;
    if (!reachesDecisionSink(node, sourceFile)) return;

    const fnName = enclosingFunctionName(node);
    findings.push({
      ruleId: meta.id,
      ruleVersion: meta.version,
      file: filePath,
      line: lineOf(sourceFile, node),
      identity: violationIdentity(meta.id, filePath, fnName, node.getText(sourceFile)),
      message:
        `.${name}() decides a program outcome over a collection that may be empty. ` +
        `An empty collection makes .${name}() vacuously true. Guard the empty case, ` +
        `or state explicitly what empty means.`,
      repairability: meta.repairability,
      exemptedBy: null,
    });
  });

  return findings;
}

// Named before export: an anonymous default export cannot be re-imported
// under a stable name by tooling that inspects the module graph.
const vacuousEmptyQuantifier = {
  meta,
  checkSource,
  check(ctx: RuleContext): Finding[] {
    return ctx.files.flatMap((absolute) => {
      const relative = absolute.startsWith(ctx.repoRoot)
        ? absolute.slice(ctx.repoRoot.length + 1)
        : absolute;
      return checkSource(relative, readFileSync(absolute, "utf8"), ctx);
    });
  },
};

export default vacuousEmptyQuantifier;
