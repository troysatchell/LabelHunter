import { readFileSync } from "node:fs";
import ts from "typescript";
import { enclosingFunctionName, lineOf, parse, walk } from "../ast";
import { violationIdentity } from "../identity";
import type { Finding, RuleContext, RuleMeta } from "../types";

/**
 * `.some` is deliberately excluded — review round 3.
 *
 * Vacuous truth means a check claims a property HOLDS when nothing was
 * examined. `[].every(p)` is `true`: it claims every element satisfied
 * `p`, over zero elements actually checked. That is the defect class this
 * rule names. `[].some(p)` is `false`: it claims "no matching element
 * found," which is the safe, usually correct default for an empty
 * collection. A bare `.some()` call is not a vacuous-truth defect.
 *
 * Known gap, not covered by this rule: the NEGATED form, `if
 * (!xs.some(bad))`, IS a vacuous assertion — "no bad items" holds
 * trivially when there are no items at all. This rule does not detect a
 * negated `.some()`. That gap is recorded here, not silently dropped.
 */
const QUANTIFIERS = new Set(["every", "reduce"]);

const meta: RuleMeta = {
  id: "vacuous-empty-quantifier",
  version: 1,
  scope: "changeset",
  severity: "fail",
  repairability: "assisted",
  registries: [],
  activatedAt: null,
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

/** True when the receiver cannot be empty. */
function isProvablyNonEmpty(receiver: ts.Expression, sourceFile: ts.SourceFile): boolean {
  // A literal array with at least one element.
  if (ts.isArrayLiteralExpression(receiver) && receiver.elements.length > 0) return true;

  // A preceding length guard that leaves the function on empty.
  const receiverText = receiver.getText(sourceFile);
  let fn: ts.Node | undefined = receiver.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn || !("body" in fn) || !fn.body) return false;

  let guarded = false;
  walk(fn.body as ts.Node, (n) => {
    if (!ts.isIfStatement(n)) return;
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

/**
 * True when a node's own value is read directly at a decision point.
 *
 * Checked shapes: the whole expression of a return, the whole test of an
 * if, the whole value of a property assignment (`{ outcome: x }` or the
 * shorthand `{ outcome }` — the same sink, two spellings TypeScript parses
 * as different node kinds), or a bare-statement ternary's condition. This
 * is deliberately shallow — one level up, with no further climbing through
 * a transforming expression. `return t;` is a direct use of `t`.
 * `return t.length;` is not a direct use of `t`, even though the number it
 * returns is derived from `t` — a derived value is not the same decision
 * as the value itself.
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
 * Bounded on purpose, per review: only a `const`/`let` with a plain
 * identifier name (no destructuring, no `var`), only inside the function
 * that declares it, and only one hop. A read that itself only feeds a
 * second variable is not followed further — that would need a second hop.
 * A variable declared but never read again decides nothing, so a
 * zero-read variable is not a sink.
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

    // Exemption, not an allowlist entry: a seeded .reduce(fn, seed) cannot
    // be vacuous. The seed IS the defined result for an empty collection —
    // review round 3. An unseeded .reduce(fn) is still checked below: it
    // throws on an empty collection, a real defect this rule should catch.
    if (name === "reduce" && node.arguments.length >= 2) return;

    const receiver = node.expression.expression;
    if (isProvablyNonEmpty(receiver, sourceFile)) return;
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
