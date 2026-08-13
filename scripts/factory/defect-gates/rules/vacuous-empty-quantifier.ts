import { readFileSync } from "node:fs";
import ts from "typescript";
import { enclosingFunctionName, lineOf, parse, walk } from "../ast";
import { violationIdentity } from "../identity";
import type { Finding, RuleContext, RuleMeta } from "../types";

const QUANTIFIERS = new Set(["every", "some", "reduce"]);

const meta: RuleMeta = {
  id: "vacuous-empty-quantifier",
  version: 1,
  scope: "changeset",
  severity: "fail",
  repairability: "assisted",
  registries: [],
  activatedAt: null,
  pinExpiresAfterMainCommits: 25,
  replayCorpus: [],
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
 * True when the call's result drives a program decision.
 *
 * A ternary used as a bare statement decides by side effect, not by value —
 * `p ? doA() : doB();` is the same decision as an if/else, so it is a sink.
 * Otherwise a ternary's condition is not itself a sink. What matters is
 * where its value goes next, so the walk passes through it and keeps
 * looking. This stops a display-only ternary (its value only builds a
 * string) from counting as a decision, while a ternary that feeds a
 * return, an outer ternary condition, or a property assignment still does.
 */
function reachesDecisionSink(call: ts.CallExpression): boolean {
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

    const receiver = node.expression.expression;
    if (isProvablyNonEmpty(receiver, sourceFile)) return;
    if (!reachesDecisionSink(node)) return;

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
