# Changes

Per-ticket changelog. Every factory PR adds an entry at the top naming its ticket ID(s):
what changed, how to run it, how to roll it back. The gate greps for the ticket ID with
anchored boundaries — `TRO-30` will not match inside `TRO-301`.

## TRO-508 — Final review fix wave: gate false-failures, fabricated pass message, guard scope, replay CLI (2026-08-12)

**Why.** A final whole-branch review of this ticket's work found two false-failure/false-pass
defects in the gate itself, plus four correctness and process gaps. All six are fixed in this
single wave. No test was weakened and no quarantine entry was widened to reach green.

**Critical 1 — a deleted file crashed the gate.** `run.ts`'s changed-file list came from `git
diff ${baseRef}...HEAD --name-only`, which includes deleted and renamed-away paths. A deleted
path reached `readFileSync` downstream and threw `ENOENT`; `engine.ts` correctly reported
`status: "error"`, which failed the gate on any branch that only deleted a `.ts` file — a false
failure this engine must never produce. Fix: `--diff-filter=ACMR` on the diff, keeping only
Added, Copied, Modified, and Renamed paths. The list-building logic is now the exported
`changedTsFiles(repoRoot, baseRef)`, with two new tests in `run.test.ts` against a real scratch
git repo: one commits a delete-and-add and confirms the deleted path is excluded and nothing
throws, the other confirms a modified path is still kept.

**Critical 2 — the gate fabricated "no introduced violations" over real findings.** `gate.sh`'s
G11 block computed `DG_N` from the run log and then discarded it, hardcoding the pass message.
A rule running `report-only` exits 0 *with findings*, so the gate recorded a clean pass while
violations existed — the exact defect this subsystem exists to eliminate, shipped inside the
tool that eliminates it. It also compounds: `vacuous-empty-quantifier`'s `activatedAt` is a
commit on this branch, so every branch already in flight at merge time runs report-only, and
would have hit this exact silent case. Fix: G11 now reads real per-rule counts from
`.factory/defect-gate.json` (`mode`, `introduced`, `pin.activatedAt`) via a small `node -e`
script — the same idiom the `tests` gate already uses for JSON parsing — and reports one of
four honest outcomes: blocking/no-findings (pass, "no introduced violations"), report-only/
findings (pass, but names the count and the activation pin), blocking/findings (fail, names the
count), or a rule that errored (fail, names it — an error must never read as zero violations,
the fourth outcome the old code also got wrong: it would have reported "0 introduced
violation(s)" for a crashed rule too).

**Important 3 — identity comparison ignored multiplicity.** `baseline.ts`'s
`introducedFindings` used a `Set` of identities. A function with one existing violation that
grows a second, structurally identical one reported zero introduced findings — the second copy
matched the same `Set` entry as the first, and the gate stayed silent on a real new defect. Fix:
`introducedFindings`/`preExistingFindings` now compare as a multiset — a per-identity count,
decremented as each head finding is matched against the baseline, so a surplus occurrence is
correctly reported as introduced. New test in `baseline.test.ts`: two identical-identity
findings in head, one in base, asserts exactly one introduced and one pre-existing.

**Important 4 (with deferred item 6) — a guard that did not guard.** `isProvablyNonEmpty` in
`vacuous-empty-quantifier.ts` walked the *entire* enclosing function for any `if` mentioning
`<receiver>.length`, with no check that the guard came before the quantifier call and no scope
check. Two real false negatives: a guard written *after* the decision, and a guard inside a
sibling nested arrow function (its exit guards that function, not the outer one). The doc
comment always said "preceding"; the code never checked position. Fix: the guard search
(`hasPrecedingLengthGuard`) now requires the `if` to start before the call and walks with a new
`walkOwnScope` helper that prunes at nested function boundaries, so a sibling function's guard
is never counted. Deferred item 6 (the `pairing.ts` `else if`-branch shape) is fixed alongside
it: `hasEnclosingLengthGuard` climbs from the call to its enclosing `if`, and recognizes a
branch condition like `else if (xs.length > 1) { ... }` as proof the receiver is non-empty
inside that branch — the mechanism the old code lacked entirely for this shape (it only
happened to pass `pairing.ts` itself because `.some` was already excluded from the checked
method set for an unrelated reason). Four new tests: guard-before (must not flag, pre-existing
test), guard-after (must flag), guard-in-nested-function (must flag), `else if` guard (must not
flag).

**Re-measured repo-wide count: 4, unchanged from the round-3 measurement.** Same four sites,
same lines: `scripts/eval/report-validation.ts:95`, `:100`, `src/app/_lib/review-queue-
client.ts:108`, `src/server/resolver/response.ts:186`. The position/scope/`else-if` fix did not
change the count — this codebase has no guard-after, nested-function, or bare `else if`-guarded
`.every`/`.reduce` site today outside the rule's own test fixtures. This is a real measurement,
not an assumption: hand-verified by re-running the same `pnpm exec tsx -e` scan used in round 3,
excluding `scripts/factory/defect-gates/` per the standing self-exclusion policy.

**Important 5 — the replay harness had no entrypoint.** Nothing outside `replay.test.ts` called
`replayRule` or `loadLedger`. `factory/replay/vacuous-empty-quantifier.v1.json` was committed as
calibration evidence, but no command could regenerate it, and spec §12.1's re-measure workflow
had no entrypoint. Fix: `scripts/factory/defect-gates/replay-cli.ts`. Run it with:

```bash
source .factory-env && pnpm exec tsx scripts/factory/defect-gates/replay-cli.ts vacuous-empty-quantifier
```

It loads `factory/review-findings.jsonl` (override with `--ledger`), selects the rule's own
`replayCorpus`, replays it, and writes `factory/replay/<rule>.v<version>.json` (override with
`--out`). Run against this repo, the regenerated file is **byte-identical** to the committed
one (`git diff` on the file is empty after running it) — the file and the command that produces
it are now confirmed to agree.

**Important 6 (with deferred item 2) — a git failure degraded to permanent, silent
report-only.** `activation.ts`'s `resolvePinFacts` swallowed any git failure into
`{ mergeBaseIsAfterActivation: false, mainCommitsElapsed: 0 }` — indistinguishable from "branch
predates activation," so an unknown or rewritten `activatedAt` disabled the rule forever with no
signal. It also conflated `git merge-base --is-ancestor`'s real "no" answer (exit 1) with a
process failure (any other nonzero exit, e.g. 128 for an invalid ref) by collapsing both into
`status !== 0`. Fix: `resolvePinFacts` now returns `{ ok: true, facts }` or `{ ok: false, error
}`, distinguishing a real "no" from a git failure at each of its three git calls. `run.ts`'s
caller treats `ok: false` the same as a crashed rule check — it forces that rule's result
`status` to `"error"`, which fails the gate loudly with the real reason, never a quiet permanent
report-only mode. Three new tests in `activation.test.ts` against a scratch git repo:
`resolvePinFacts` resolving real facts on the success path, reporting `ok: false` for an
unresolvable (fake) `activatedAt`, and reporting `ok: false` for an unresolvable `baseRef`.

**Documentation accuracy correction.** The round-3 entry below states "Precision on this
measurement: 4/4 among reported findings." Read on its own, that can be misread as spec §12.3's
"≥ 80% true-positive or exemptible" ship criterion having been *measured* and met. It was not.
What exists is 4 hand-verified sites (read by hand, not adjudicated against an independent
reviewer), two of the four (`report-validation.ts`'s `isStringArray`/`isReviewQueueListResponse`
shape check sites) carrying disclosed doubt rather than a settled genuine/false-positive call,
over a replay corpus of 2 rows — both from the same ticket, `TRO-464`. That is a real, useful
measurement. It is not the rigorous adjudicated-corpus precision figure §12.3 describes, and
this entry should not be read as claiming it is.

**Follow-up, recorded explicitly rather than left as only a code comment: restore `.some`
detection under a negating context.** Round 3 removed `.some` from `QUANTIFIERS` entirely to
close a false positive (a bare `.some()` returning `false` on empty is the safe default, not a
vacuous-truth defect). That also removed the only path to detecting `!xs.some(bad)` — a real
vacuous assertion, since "no bad items" holds trivially over zero items. That ruling was mine;
the final review found it over-broad, and I accept the correction. Future work: detect a
`.some()` call specifically when it sits under a `!` (or `=== false`) at its decision sink,
re-admitting the negated case without reopening the bare-`.some()` false positive round 3 fixed.

**Negative-tested, both directions, on the real `gate.sh`** (`--skip-review` used only to stay
inside the working timeout; every other gate ran for real in both runs):

Run 1 — probe committed (`src/lib/__dg-probe.ts`, a real unguarded `.every()`):
```
=== factory gate: TRO-508 (base main) ===

  [ok ] typecheck              clean
  [ok ] lint                   clean
  [ok ] build                  built
  [ok ] tests                  no new failures vs baseline
  [ok ] tests:not-weakened     no tests skipped or assertions removed
  [ok ] regression-test        63 test case(s) added
  [ok ] changes-entry          entry for TRO-508 present; structure valid
  [ok ] eval-not-regressed     accuracy >= committed baseline
  [ok ] scope                  25 file(s) changed
  [FAIL] defect-gate            1 introduced violation(s) — see .factory/defect-gate.json
  [skip] review                 disabled for this run

=== TRO-508: fail ===
evidence: .factory/gate-result.json
gate exit: 1
```

Run 2 — probe removed:
```
=== factory gate: TRO-508 (base main) ===

  [ok ] typecheck              clean
  [ok ] lint                   clean
  [ok ] build                  built
  [ok ] tests                  no new failures vs baseline
  [ok ] tests:not-weakened     no tests skipped or assertions removed
  [ok ] regression-test        63 test case(s) added
  [ok ] changes-entry          entry for TRO-508 present; structure valid
  [ok ] eval-not-regressed     accuracy >= committed baseline
  [ok ] scope                  24 file(s) changed
  [ok ] defect-gate            no introduced violations
  [skip] review                 disabled for this run

=== TRO-508: pass ===
evidence: .factory/gate-result.json
gate exit: 0
```

**A third case, tested directly since neither run above exercises it: report-only with
findings.** Neither negative-test run above puts the one shipped rule into `report-only` mode
(its `activatedAt` already predates `HEAD`'s merge-base on this branch), so the case Critical 2
actually fixes — a report-only rule with real findings — needed a direct check. Ran the G11
`node -e` summary script from `gate.sh` against a synthetic `.factory/defect-gate.json` with one
`report-only` rule carrying 2 introduced findings. Output:
```
no BLOCKING violations — 2 introduced violation(s) under report-only rule(s): vacuous-empty-quantifier (report-only, pinned before activation deadbeefdeadbeefdeadbeefdeadbeefdeadbeef)
```
Confirms the fix: this exact input previously recorded "no introduced violations."

**How to run it.**
```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/
pnpm typecheck && pnpm lint
pnpm exec tsx scripts/factory/defect-gates/replay-cli.ts vacuous-empty-quantifier
```

**Test execution.** 7 test files, 63 tests, all pass (up from 54 before this wave — 9 new
tests: 1 in `baseline.test.ts`, 2 in `run.test.ts`, 3 in `activation.test.ts`, 4 in
`vacuous-empty-quantifier.test.ts`). `pnpm typecheck` — clean. `pnpm lint` — 0 errors, 1
pre-existing unrelated warning in `DetailView.tsx`.

**Files changed:** `scripts/factory/defect-gates/run.ts`, `run.test.ts`, `baseline.ts`,
`baseline.test.ts`, `activation.ts`, `activation.test.ts`,
`rules/vacuous-empty-quantifier.ts`, `rules/vacuous-empty-quantifier.test.ts`, `gate.sh`
(G11 block). **File added:** `scripts/factory/defect-gates/replay-cli.ts`. **File regenerated,
byte-identical:** `factory/replay/vacuous-empty-quantifier.v1.json`.

**Rollback.** Each fix is independently revertible per-file; none changes another file's public
contract except `activation.ts`'s `resolvePinFacts`, whose only caller (`run.ts`) was updated in
the same commit.

## TRO-508 — Wire the defect gate in as G11, before review capture (2026-08-12)

**What changed.** `scripts/factory/defect-gates/run.ts` runs every registered rule, compares
findings against a baseline read from `BASE_REF` with `fileAtRef` (never a raw `git show` —
a file this branch added does not exist at `BASE_REF`, `fileAtRef` returns `null` there, and
that baseline correctly stays empty), and writes `.factory/defect-gate.json`. `scripts/factory/gate.sh`
now runs it as `G11`, placed after `G9` (scope) and before `G10` (review capture), so a
defect this factory can catch never spends external review budget. `G11` is BLOCKING: a rule
in `blocking` mode with an introduced finding fails the gate; a rule in `report-only` mode
(a newly-activated rule, on a branch cut before activation) never does.

**Negative-tested — the factory does not trust a gate it has not seen fail.** A probe file
(`src/lib/__dg-probe.ts`, a real `.every()` vacuous-quantifier violation) was committed, the
full gate was run, and `defect-gate` FAILED with the gate exiting non-zero. The probe was
then removed, the gate was run again, and `defect-gate` PASSED with the gate exiting zero.
Both runs used `scripts/factory/gate.sh --skip-review` (CodeRabbit's own step is unrelated to
this check and was skipped only to keep the run inside the working timeout; every other gate
ran for real in both cases). Observed output, both directions:

Run 1 — probe present, gate exit 1:
```
=== factory gate: TRO-508 (base main) ===

  [ok ] typecheck              clean
  [ok ] lint                   clean
  [ok ] build                  built
  [ok ] tests                  no new failures vs baseline
  [ok ] tests:not-weakened     no tests skipped or assertions removed
  [ok ] regression-test        54 test case(s) added
  [ok ] changes-entry          entry for TRO-508 present; structure valid
  [ok ] eval-not-regressed     accuracy >= committed baseline
  [ok ] scope                  24 file(s) changed
  [FAIL] defect-gate            1 introduced violation(s) — see .factory/defect-gate.json
  [skip] review                 disabled for this run

=== TRO-508: fail ===
evidence: .factory/gate-result.json
gate exit: 1
```
`.factory/defect-gate.json` recorded the one introduced finding: `src/lib/__dg-probe.ts:2`,
rule `vacuous-empty-quantifier`, `"An empty collection makes .every() vacuously true."`

Run 2 — probe removed, gate exit 0:
```
=== factory gate: TRO-508 (base main) ===

  [ok ] typecheck              clean
  [ok ] lint                   clean
  [ok ] build                  built
  [ok ] tests                  no new failures vs baseline
  [ok ] tests:not-weakened     no tests skipped or assertions removed
  [ok ] regression-test        54 test case(s) added
  [ok ] changes-entry          entry for TRO-508 present; structure valid
  [ok ] eval-not-regressed     accuracy >= committed baseline
  [ok ] scope                  23 file(s) changed
  [ok ] defect-gate            no introduced violations
  [skip] review                 disabled for this run

=== TRO-508: pass ===
evidence: .factory/gate-result.json
gate exit: 0
```

**A fix to the plan's own reference code.** The task brief's `run.ts` imports `readFileSync`
from `node:fs` and never calls it — the rule module does its own file reads internally. That
import failed `G2` (lint, `no-unused-vars`) on the very first negative-test run, alongside the
real `defect-gate` failure. Fix: drop the unused import. Confirmed with a standalone
`pnpm lint` run: 0 errors after the fix (1 pre-existing, unrelated warning in
`DetailView.tsx` remains).

**Activation pin.** `vacuous-empty-quantifier` shipped with `activatedAt: null` and
`severity: "fail"`. `decidePin` returns `blocking` for a null `activatedAt` unconditionally —
that combination would block every branch on merge, including ones cut before the rule
existed. That is retroactive blocking, exactly what the pin exists to prevent. Fixed in a
second commit: `activatedAt` is now stamped to the SHA of the commit that lands `run.ts` and
the `G11` wiring — the first commit at which the rule is actually reachable by the gate.
Verified after the stamp: `grep -rn 'severity: "fail"' -A0 scripts/factory/defect-gates/rules/*.ts`
plus a manual read of every rule module's `meta` shows no rule with `severity: "fail"` and
`activatedAt: null` remaining (one rule module exists in this repo today,
`vacuous-empty-quantifier`, and it now carries a real SHA).

## TRO-508 — First defect-gate rule: vacuous-empty-quantifier (2026-08-12)

**What it detects.** A call to `.every()`, `.some()`, or `.reduce()` over a collection that
is not provably non-empty, whose result reaches a decision sink: a return, an `if`
condition, a ternary condition, or a property assignment. An empty collection makes
`.every()` true and `.some()` false without checking anything. That is a defect only when
the boolean result decides something — a display-only use is not flagged.

**Files added.**
- `scripts/factory/defect-gates/ast.ts` — shared AST helpers: `parse`, `walk`,
  `enclosingFunctionName`, `lineOf`. Not specific to this rule; every future rule can use it.
- `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.ts` — the rule.
- `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.test.ts` — 7 tests.

**A fix to the plan's own reference code.** The task brief's example `reachesDecisionSink`
treated a ternary's condition as an immediate sink. It never checked where the ternary's
own result went next. Under that code, `items.every(done) ? "all done" : "in progress"`
counted as a decision, even when the chosen string only built a display label. The test
for exactly that case failed against the brief's own reference code — 1 finding, expected
0 (`does not flag a quantifier used only for display`). The fix: a ternary's condition is
not itself a sink. The walk now passes through the `ConditionalExpression` node and keeps
climbing. A ternary counts as a decision only when its own result later reaches a real
sink — a return, an outer `if`, or a property assignment. The walk already treats every
other non-sink node this way: a `BinaryExpression` in an `||` chain, for example, gets
climbed through, not stopped at.

**Round 1 review fix — a bare-statement ternary is also a sink.** That first fix over-
corrected: it made every `ConditionalExpression` a pure pass-through, so a ternary used
only for its side effects — `items.every(p) ? doA() : doB();` — went unflagged, even
though `if (items.every(p)) { doA(); } else { doB(); }` is the same decision and was
already flagged. A bare-statement ternary decides by side effect, not by value, so it is
now a sink too: when the `ConditionalExpression`'s own parent is an `ExpressionStatement`,
the rule flags it before climbing further. A display ternary (its value feeds a variable,
not a statement) still passes through unflagged. Added a regression test for the
bare-statement case. All 7 tests pass.

**Measured backlog, not a target.** The plan's own spec predicted about 4 sites on `main`.
The measured count, run over `src/**/*.ts` and `scripts/**/*.ts` excluding test files, is
7 — unchanged by the round-1 fix. A repo-wide grep for `.every(`/`.some(`/`.reduce(`
followed directly by `?` found no bare-statement-ternary use of a quantifier anywhere in
this codebase outside the rule's own test file, so the new sink type had nothing to catch
here. The number is not adjusted toward the plan's prediction; it is what was measured:

- `scripts/eval/report-validation.ts:95` — `.every(isReliabilityBucket)`
- `scripts/eval/report-validation.ts:100` — `.every((v) => typeof v === "string")`
- `src/app/_lib/review-queue-client.ts:108` — `.every(isReviewQueueListItemWire)`
- `src/server/resolver/response.ts:186` — `.every(...)` in `deriveOutcome`
- `src/server/router/field-resolution.ts:94` — `.some(...)` in `abvAlternatesConflict`
- `src/server/router/field-resolution.ts:112` — `.some(...)` in `netContentsAlternatesConflict`
- `src/server/router/label-blockers.ts:71` — `.some(Boolean)` in `isConflictingExtraction`

Each site was read by hand. Every one is a real return-value decision over a collection
whose non-emptiness the code never proves inline. None looked like a false positive.

**Round 2 review fix — a quantifier's result assigned to a local variable is now traced
one hop.** Replay calibration against a historical review finding (TRO-464,
`factory/replay/vacuous-empty-quantifier.v1.json`) found a real miss: `deriveOutcome`'s
`.every()` in `response.ts` assigns its ternary result to `const outcome`, then returns it
as `return { outcome, fields }`. `reachesDecisionSink` only climbed the call's own AST
ancestry. It never followed a value through a variable. `const ok = xs.every(p); return
ok;` went unflagged, even though `return xs.every(p);` already was — the same decision,
spelled two ways.

The fix, bounded to one hop: when a quantifier's result (directly, or through a
pass-through ternary) is the initializer of a `const`/`let` with a plain identifier name,
the rule now looks in the same function for a later read of that variable. A read counts
only when it is a direct decision use: the whole expression of a `return`, the whole test
of an `if`, the whole value of a property assignment — explicit `{ x: v }` or shorthand
`{ v }`, two different TypeScript node kinds, both covered — or a bare-statement ternary
condition. `text.length` is not a direct use of `text`: a derived value is not the same
decision as the value itself, so a display-only assignment still passes. A variable never
read again decides nothing, so it is never a sink. The hop does not chain: a read that
itself only feeds a second variable is not followed further. 4 new tests, 11 total, all
pass.

**Re-measured backlog: 12, up from 7.** All 5 new sites were read by hand:

- `scripts/eval/benchmark.ts:327`, `:328`, and `scripts/eval/check.ts:178` —
  `.reduce(fn, 0)` with an explicit initial value. Not genuine: a seeded `.reduce()`
  returns the seed on an empty array, the correct sum of nothing, not a vacuous wrong
  answer. The rule does not yet distinguish seeded from unseeded `.reduce()` — a
  pre-existing gap, invisible until the variable hop could reach these sites' property
  assignments.
- `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.ts:58` — the rule's own
  `.some()` inside its own length-guard detector. Not genuine: on an empty `Block`,
  `.some()` correctly returns `false` ("no exit statement found"), the right answer, not a
  vacuous one.
- `src/server/batch/pairing.ts:70` — `.some()` inside an `else if (imagesForKey.length >
  1)` branch. Not genuine: the enclosing branch condition already proves `imagesForKey`
  has more than one element. `isProvablyNonEmpty` recognizes a preceding early-exit guard,
  not an enclosing branch condition — a second pre-existing gap, also newly visible only
  through the variable hop.

None of the 5 new sites is a genuine defect, and none breaks the fix's own bound — one
hop, `const`/`let` only, same function, read afterward, no chaining. Each traces to a
separate, already-existing gap elsewhere in the rule, exposed only now that the variable
hop can see past a local assignment. Recorded as measured; not fixed this round.

**Replay recall: 1.0 (2/2), up from 0.5.** Both `TRO-464` corpus rows (`response.ts`,
`queue.ts`) now hit. The corpus is still 2 rows, so this recall is corroboration, not a
statistically meaningful result on its own — see `factory/replay/
vacuous-empty-quantifier.v1.json` and the task-6 report for the full analysis.

**Round 3 review fix — three precision exemptions, encoded in the rule.** Round 2 raised
the repo-wide count from 7 to 12 and judged all 5 new sites non-genuine. That put precision
at 7/12 (58%), below the plan's own 80% bar for a rule to ship blocking (spec §12.3). Each
non-genuine class is now an exemption encoded in the rule itself, not an allowlist entry —
an exemption helps every future site; an allowlist entry helps only the one it names (spec
§12.2).

1. **Seeded `.reduce()` is exempt.** `.reduce(fn, seed)` with 2 or more arguments cannot be
   vacuous — the seed is the defined answer for an empty collection, not a wrong one. An
   unseeded `.reduce(fn)` is still checked: it throws on an empty collection, a real defect.
   Closes 3 sites (`benchmark.ts` ×2, `check.ts` ×1).
2. **`.some` is removed from the checked method set — a narrowing of what this rule means,
   not a bug fix.** Vacuous truth is a check that claims a property HOLDS when nothing was
   examined. `[].every(p)` is `true`: it claims every element satisfied `p`, over zero
   elements actually checked — the defect class this rule is named for. `[].some(p)` is
   `false`: it claims "no matching element found," the safe, usually correct default for an
   empty collection. A bare `.some()` is not a vacuous-truth defect, so it no longer
   qualifies. **Known gap, recorded and not covered:** the negated form, `if
   (!xs.some(bad))`, IS a vacuous assertion — "no bad items" holds trivially when there are
   no items. This rule does not detect a negated `.some()`. Closes 3 of the original 7
   sites (`field-resolution.ts` ×2, `label-blockers.ts` ×1) plus 2 of round 2's 5
   (`pairing.ts`'s `else if` branch — TRO-464-request, see below — and the rule's own
   internal `.some()`).
3. **The rule's own directory is excluded from the repo-wide backlog measurement**
   (`scripts/factory/defect-gates/` — a linter does not lint itself; its own `.some()` over
   internal AST data is not a target-code defect). Already redundant with (2) for today's
   one self-referential site, but this is the standing policy for any future rule this
   directory adds.

**A second known gap, also recorded and not covered this round:** an unguarded quantifier
guarded only by an *enclosing* branch condition — `else if (xs.length > 1) { ... xs.some(p)
... }` — is provably safe (the branch already establishes non-emptiness), but
`isProvablyNonEmpty` only recognizes a *preceding* early-exit guard in the same block, not
an enclosing branch condition. `pairing.ts:70` was this shape; removing `.some` closes it
as a side effect, but the underlying gap in `isProvablyNonEmpty` is unfixed — a plain `if
(xs.length > 1) { return xs.every(p); }` (no `else`) is already handled correctly today; the
`else if` variant is not.

4 new tests (seeded reduce not flagged, unseeded reduce still flagged, `.some` not flagged,
`.every` still flagged as a regression guard). 15 tests total, all pass.

**Re-measured backlog: 4, down from 12 (was 7 before round 2).** All 4 read by hand:
`report-validation.ts:95` (`.every(isReliabilityBucket)`), `report-validation.ts:100`
(`isStringArray`'s `.every()`), `review-queue-client.ts:108` (`isReviewQueueListResponse`'s
`.every()`), `response.ts:186` (`deriveOutcome`). Judged genuine, matching this rule's own
"core case, keep" standard for a bare `.every()` reaching a real decision with no guard.

**Correction (review round 4): `response.ts:186` was overstated below as "still live at
HEAD, no doubt."** That claim went further than the evidence. Here is what the review found,
and what I confirmed independently. `deriveOutcome` has no guard of its own against an empty
`fields` array. Both of its current callers guard before calling it.
`deriveResolvedFields` (`response.ts:280`) throws first when `flaggedFields.length === 0`.
`isResolverResolution` (`queue.ts:221`) returns `false` first when `obj.fields.length === 0`
(`queue.ts:212`). The historical defect is fixed at both known call sites today — that is
observed, not assumed. What remains is different: the exported function itself has no
guard. A future caller that skips the guard would reproduce the original bug. That is a
defence-in-depth finding, not a live one, and it stays in the count on that basis.

This uses the same standard as `pairing.ts:70` above, not a different one. The question is
always the same: is safety provable from the code the rule reads? For `pairing.ts`, yes —
the guard sits in the same branch as the call, one fact, inseparable from the site. For
`deriveOutcome`, no — its safety depends on every caller staying disciplined, and its own
code cannot guarantee that. Two sites, one standard, two different answers.

Two of the four (`isStringArray`, `isReviewQueueListResponse`) validate array *shape*,
where an empty array trivially and arguably-correctly satisfies "every element has type X"
— flagged here as an honest, disclosed doubt, not resolved, and not exempted: unlike seeded
`.reduce()` or `.some()`, whether an empty `caseIds`/`items` array should be accepted is a
caller-specific business question this AST rule cannot settle, so both stay reported for
human triage rather than silently auto-exempted. Precision on this measurement: 4/4 among
reported findings — one of the four (`response.ts:186`) genuine as a defence-in-depth gap
rather than a live defect.

**Correction (final review fix wave, see the top-of-file entry with this same date): this "4/4"
figure is not spec §12.3's adjudicated ship-criterion precision.** It is 4 sites read by hand,
two carrying disclosed doubt, over a 2-row replay corpus. Read plainly, not as a claim that the
≥ 80% ship bar was measured and met.

**Replay recall unaffected: still 1.0 (2/2).** Both corpus rows are `.every` cases;
removing `.some` from the checked set does not touch them. Confirmed by re-running the
replay, not assumed.

**How to run it.**
```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/rules/vacuous-empty-quantifier.test.ts
```

**Rollback.** Delete `scripts/factory/defect-gates/ast.ts` and
`scripts/factory/defect-gates/rules/`. No other file depends on them yet. The engine does
not run this rule automatically — nothing else breaks if you remove it.

## TRO-518 — Batch image storage now survives the web/worker split (2026-08-12)

**The bug.** `src/server/storage/local-file-storage.ts` saved every uploaded label image
to a directory on the writing process's own disk. `POST /api/verify` and
`POST /api/batch/start` write there, on `labelhunter-web`. `extract-worker.ts` and
`resolve-worker.ts` read from there, on `labelhunter-worker`. `render.yaml` (TRO-481)
deploys `web` and `worker` as two separate Render services with two separate disks — a
file `web` wrote was never visible to `worker`. Local dev never showed this (`pnpm dev`
runs everything in one process), and neither did any worktree's own test suite (same
reason). Single-label verify was unaffected — one process saves the image and, later in
the same request, reads that same file back. Batch was not: every queued item would have
failed to read its image on the real deployed instance.

**The fix.** `src/server/storage/db-image-storage.ts` replaces `local-file-storage.ts`.
`saveLabelImage`/`readLabelImage` keep the exact same signatures — every real caller
needed only its import path updated. Bytes now live in a new table,
`label_image_blobs` (`storage_key` text primary key, `bytes` bytea, `original_filename`,
`created_at`), read and written through the same `DATABASE_URL` `render.yaml` already
gives both `web` and `worker` — the one resource this app's architecture already assumes
they share.

**Option A (Postgres) vs. Option B (S3-compatible bucket) — the real numbers.**
The ticket's own author suggested S3, written before this repo had confirmed Postgres was
already shared between both services. Both were evaluated for real:

- **Image size, measured, not assumed.** `preprocessImage`'s `original` output (what
  `saveLabelImage` actually writes — a full-resolution, mozjpeg-quality-92 re-encode) was
  run against every one of the 32 golden-set images: 11.4–58.8 KB, average 47.0 KB. Those
  source images are synthetic and downscaled (1000×800), so a second measurement used
  `assets/golden/references/spirits-bottle-01.jpg`, a 2483×4088 (~10 MP) reference much
  closer to a real phone photo's resolution: its `original` output is 513 KB. Call 500 KB–1
  MB a realistic per-image range for a genuine consumer photo, an order of magnitude above
  the synthetic golden-set figure.
- **Batch scale.** TH-R4 names 200–300 labels per batch. This repo's own real tests never
  exceed ~30 — the golden set itself holds exactly 32 images (`ls golden-set/images | wc
  -l`), the largest batch anything in this repo has ever actually built.
- **Projected total for a 300-image batch:** ~13–17 MB at the measured synthetic-image
  rate, ~150 MB at the realistic-photo estimate. Even accumulating dozens of such batches
  (thousands of images) stays in the single-digit gigabytes.
- **Postgres disk quota.** `render.yaml`'s `labelhunter-db` uses `plan: basic-256mb` with
  no explicit `diskSizeGB`. Render's own Blueprint-spec documentation (`docs/blueprint-spec`,
  fetched directly on 2026-08-12, corroborated by a second independent fetch of the same
  figure) states the default disk size when `diskSizeGB` is omitted is set by instance
  tier: Free 1 GB, **Basic 15 GB**, Pro 100 GB, Accelerated 250 GB. `basic-256mb` is a
  Basic-tier instance, so the default is 15 GB. **Not verified against a real Render
  dashboard** — no account exists for this deploy yet, so this is a documentation read, not
  an observed fact from Troy's own account. Reasoned conservatively from the published
  default rather than assumed higher.
- **Conclusion.** Even the realistic-photo estimate for one full 300-image batch (~150 MB)
  is under 1% of a 15 GB disk, and Postgres storage can be expanded (never reduced) in 5 GB
  increments at $0.30/GB/month if that default ever proves wrong. Option A needed zero new
  dependencies (checked `package.json` — no S3 SDK was already present, so Option B would
  have added one), zero new credentials, and zero new accounts — nothing for Troy to
  provision before this ticket's own tests could run end to end. Option B remains real code
  Troy could ask for later if image sizes or batch scale ever genuinely outgrow this
  number, but nothing in this ticket's own measurements shows that happening.

**A correction to this ticket's own hypothesis.** The brief expected `batch/start`,
`extract-worker.ts`, and `resolve-worker.ts` to be the callers needing an adapter swap.
The real caller list was wider: `verify/route.ts` (single-label save),
`label-images/[labelImageId]/route.ts` (serves image bytes to the Detail view),
`single-label-resolve/worker.ts`, and two ops scripts (`scripts/latency/measure.ts`,
`scripts/eval/cascade-runner.ts`) all import the same module. `resolve-worker.ts` and
`single-label-resolve/worker.ts` turned out to need **no** change at all, not even an
import — `readLabelImage` is caller-supplied on both, wired only in
`scripts/batch-worker/run.ts`. One caller needed a real logic change, not just an import
swap: `label-images/[labelImageId]/route.ts`'s missing-image check used to test a Node
`fs` error code (`ENOENT`); `db-image-storage.ts` throws a `LabelImageNotFoundError`
instead, so the check now tests that type (renamed `isMissingImageError`).

**A gap found and fixed in the same pass.** `label_images.storage_path` is deliberately
not a declared foreign key into `label_image_blobs` (a placeholder test value like
`"test-fixtures/x.jpg"` must remain a legal, if unmatched, value there). That means
Postgres's own cascading delete on `applications`/`batch_jobs` never reaches a real saved
blob row on its own — every test fixture that saved a real image would otherwise leak one
`label_image_blobs` row into the worktree database for the rest of that database's life.
Fixed with `deleteLabelImageBlobsWhere` (`db-image-storage.ts`), called by both
`test-support.ts` fixture files' cleanup helpers and by the four `*.test.ts` files that
manage their own cleanup inline.

**Regression tests — the cross-process claim, proven two ways.**
`src/server/storage/db-image-storage.test.ts`:
- *"the old design's failure mode was real."* `local-file-storage.ts` is deleted by this
  same change, so this cannot import it to prove its bug directly. It instead reproduces
  the exact mechanism that made it wrong: write to one directory, read from a different
  one — the same shape as two separate Render disks, not a stand-in for it. Confirmed to
  fail (`ENOENT`) exactly as the pre-fix production code would have.
- *"cross-process round trip through Postgres."* Two INDEPENDENT `pg.Pool` connections
  against the same `DATABASE_URL` — never two references to one shared pool. Save through
  one connection, read through the other (and, in a third test, through a third
  connection). This is the property that actually matters for `web`/`worker`: they share
  nothing but that connection string.
- The raw `bytea` round trip was also confirmed directly against the real pg driver before
  either test file was written: a `Buffer` containing null bytes and high-byte values
  (`\x00\x01\xff\xfe`, not just printable text) round-tripped byte-for-byte through a real
  insert/select.

**How to run it.** `source .factory-env` first (every test here needs the worktree's own
`DATABASE_URL`). `pnpm db:migrate` applies `drizzle/migrations/0004_silent_clea.sql`.
`pnpm test -- src/server/storage/db-image-storage.test.ts` for the adapter's own suite
(13 tests); `pnpm test` for everything (138 files, 1532 tests, all passing after this
change). `pnpm typecheck` and `pnpm lint` are both clean.

**Rollback.** `git revert` this ticket's commits, then `pnpm db:migrate` to leave
`label_image_blobs` dropped (Drizzle migrations are forward-only in this repo, matching
every other ticket — a revert here restores `local-file-storage.ts`, which no code will
call again unless the revert is also applied). No data migration existed to reverse: no
real Render deployment has ever run, so no production row anywhere depends on a value
this ticket wrote.

## TRO-538 — LH-033 · Score the cascade end state and the per-field confidence the report discarded (2026-08-12)

**What this builds.** The eval harness scored the Validation Router alone. It called the
result "the cascade." `scripts/eval/cascade-runner.ts:299-304` built the scored verdict from
the `/api/verify` response body. The resolver gate at `:311` ran seven lines later. By
contrast, `rollUpResolverResolution` already scored the Sonnet-only benchmark arm one stage
later than that. The two arms of the headline benchmark measured different pipeline stages.
The benchmark compared them anyway.

This ticket adds a real post-resolution stage. `cascade-runner.ts` now exports
`mergeResolutionIntoActualVerdict`. It takes the router's own five field rows and the
resolver's resolution, when one ran. It overrides each resolver-flagged row with the
resolver's own disposition, and it carries every unflagged row through unchanged. It reuses
`resolver-rollup.ts`'s existing per-field mapping, now exported as `rollUpOneField`. Every
`CascadeCaseResult` now carries two verdict scores under different names. `routerVerdict` is
the router's own verdict, before any resolver call. `cascadeVerdict` is the merged end state.
`cascadeVerdict` equals `routerVerdict` exactly when nothing escalated. `EvalReportSummary`
gained the matching `cascadeVerdictAccuracy` headline number, beside the renamed
`routerVerdictAccuracy` (was `labelVerdictAccuracy`). `benchmark.ts` now compares
`cascadeVerdict` against the Sonnet-only arm's own verdict — both post-resolution — and names
each arm's pipeline stage in a new `stage` string on the committed report. The old router-only
number survives as `cascadeRouterStageVerdictAccuracy`. It is informational only. It is never
the number this report compares.

**Open design question, decided here, needs Troy's confirmation.** `mergeResolutionIntoActualVerdict`
never reads the router's own `labelVerdict` or `headlineReason`. It reads only the field rows.
So a label-level blocker (`LOW_IMAGE_QUALITY`, `CONFLICTING_EXTRACTION`) never survives into
the cascade end state once a resolution exists. Reasoning: `buildFlaggedFieldsForEscalatedLabel`
already sends every field to Sonnet when no field individually carried its own reason — the
usual way a label-level blocker fires. So Sonnet has independently checked the blocker's
distrust by the time the merge runs. This mirrors `resolver-rollup.ts`'s own Sonnet-only-arm
choice. That arm has no router pass, so it has no blocker to take at all. Honest limit, stated
in the function's own doc comment: `buildFlaggedFieldsForEscalatedLabel` can flag a partial
field set even alongside a label-level blocker. One field's own override rejection can set the
same blocker reason on just that one field. On that path, an unflagged field still carries the
router's blocker-era verdict forward. **Troy: confirm that dropping the blocker after
resolution is the right choice.** Or name which of the two documented alternatives you want
instead: keep the blocker always, or drop it only when the resolver has resolved every field.

**A second, separate honest limit. The live run found it; nobody designed it in.** A resolved
`government_warning` field runs back through `resolver-rollup.ts`'s existing
`rollUpGovernmentWarning`. That function has no OCR channel. So it can return only `MATCH` or
`NEEDS_REVIEW` — never `MISMATCH` — the same limit the Sonnet-only arm already lives with. So a
router-level warning `MISMATCH`, once a resolver call sweeps it in for an unrelated reason,
cannot survive the merge as a `MISMATCH`. Measured on case-11, the case that motivated this
ticket: the router's own `government_warning` row read `MISMATCH`, from two agreeing real
channels. Post-merge, it reads `NEEDS_REVIEW` / `LOW_MODEL_CONFIDENCE`. The comparator did not
downgrade it. Sonnet's own resolution reported `needsHuman: true` for that field instead.
`resolver-rollup.ts`'s `rollUpCorrectionField` checks `needsHuman` before it checks which field
it is, so that flag short-circuits straight past the comparator re-run. case-11 stays a miss
(expects `FAIL`) at both stages. This is real, new evidence, and surfacing it is this ticket's
job. It is not a defect this ticket introduces or fixes. The router bug that actually caused
case-11's original miss belongs to a separate ticket: the `beverage_type` cross-check treats
"Mead" as a conflict with a declared "wine" application.

**Other evidence recorded, none of it scored.** Every case now carries the per-field
`confidence` CP-1 §4.5 step 1 asks for: `ExtractionFieldScore.confidence` and
`VerdictFieldScore.confidence`. Both read from the same captured `HaikuExtractionResult` every
caller already held. Neither needs a second API call or a database read. `EvalReportSummary`
gained `extractionReliabilityDiagram`: ten confidence-decile buckets over every scored
extraction field, each with its own `n` beside its rate (CP-1 §4.5 step 2). Every case now
carries the whole `image_quality` object (`legible`, `issues`, `confidence`) and
`beverage_type`'s `value`/`evidence`/`confidence`, as recorded evidence only.
`beverage_type` never joins the extraction-accuracy denominator, which stays at 160 for 32
cases: no golden label prints its category word, so no label ground truth exists to score it
against.

**Manifest provenance now moves with content.** `EvalReport`, `EvalBaseline`, and the
benchmark report all gained `manifestContentHash`: a SHA-256 hash of `golden-set/manifest.json`'s
raw bytes (`scripts/eval/manifest-hash.ts`). It hashes the same file `loadGoldenSetManifest()`
reads from `DEFAULT_MANIFEST_PATH`, now exported for this reason. `baseline-compare.ts` rejects
a comparison when the current hash disagrees with the baseline's hash. `manifestVersion` alone
could not catch that gap: seven straight commits edited the manifest, and every one left
`version` at `"1.0.0"`.

**Files touched.** `scripts/eval/{types,cascade-runner,resolver-rollup,verdict-scoring,
extraction-scoring,summary,check,benchmark,baseline-compare,report-validation}.ts` and their
test files; new `scripts/eval/manifest-hash.ts` (+ test) and `scripts/eval/cascade-runner.test.ts`;
`src/lib/golden-set/loader.ts` (exports `DEFAULT_MANIFEST_PATH`). No schema change, no
migration — the committed report is the evidence artifact for `image_quality`/`beverage_type`,
per the ticket's own instruction not to add a database column here.

**How to run it.**
1. `pnpm test` runs every unit test, including the new `mergeResolutionIntoActualVerdict` and
   `hashManifestContent` suites.
2. `pnpm typecheck` and `pnpm lint` both pass.
3. `pnpm eval:check -- --live --full` re-runs the whole 32-case golden set for real, then
   `--update-baseline` promotes it. Plain `pnpm eval:check` (cheap mode, what the gate runs)
   compares the committed report against that baseline with no live call.
4. `pnpm eval:benchmark -- --full` regenerates the benchmark report.

**Measured — real, live run against the full 32-case golden set, `claude-haiku-4-5` /
`claude-sonnet-5`. This ticket's own branch measured one set of numbers first. Merging this
branch with TRO-534, TRO-535, TRO-536, TRO-537, and TRO-519 changed the code under test, so
the numbers below are a full re-run against the merged result, not the original branch's own
run. They are what is actually committed as the baseline
(`scripts/eval/results/eval-report.json`, `measuredAt: 2026-08-12T22:15:52.776Z`).**

| Metric | Result |
|---|---|
| Extraction accuracy | 96.3% (154/160 fields) |
| Router-verdict accuracy (before any resolver call) | **75.0%** (24/32) |
| Cascade-verdict accuracy (end state) | **68.8%** (22/32) |
| Review-reason accuracy | 35.7% (5/14) |
| Total measured cost | $0.2706 |

**The old 65.6% (21/32) was a router number, not a cascade number.** This run's router number
is 75.0% (24/32) — TRO-534's `beverage_type` guard and TRO-535's `OCR_CONFIDENCE_FLOOR` sweep
are both now live, and both move real cases from wrong to correct at the router stage alone.
The cascade end-state number is lower, at 68.8% (22/32). Six of the 32 cases move between the
two stages:

- **Correct to wrong (4 cases):** case-16, case-18, case-23, case-24. Each held a correct
  router `REVIEW`. A resolver call resolved each one to an incorrect `PASS`. case-23 and
  case-24 are new to this list — TRO-535's floor fix is what makes their router stage correctly
  read `REVIEW` for the first time; the resolver then resolves them wrong. case-17 and case-22,
  which carried this label in the ticket's own original branch run, do **not** appear here now:
  both are wrong already at the router stage in the merged code (`PASS` where `REVIEW` is
  expected), so there is no stage to flip between — case-17 is model-call variance on an
  unrelated field (TRO-543 measures this directly), and case-22 is a separate,
  already-diagnosed defect (TRO-546, filed from this same merge).
- **Wrong to correct (2 cases):** case-28, case-29. Each held an incorrect router `REVIEW`. A
  resolver call resolved each one correctly. `eval-report.json` records the reason directly:
  case-28's `class_type` and case-29's `brand_name` both resolved `RESOLVED_MISMATCH`.

24 (router) − 4 (newly wrong) + 2 (newly correct) = 22 (cascade) — the arithmetic behind the
table above, not a separate claim. **Derived, not a claim this ticket investigates further:**
the golden set expects all four new "wrong" cases to stay in `REVIEW`. Sonnet's own judgment
resolved them past that point instead — real evidence about the resolver's own behavior on this
corpus, not a regression this ticket caused or fixes.

**The cascade-vs-Sonnet-only benchmark, corrected — both arms scored post-resolution,
`pnpm eval:benchmark -- --full`, `measuredAt: 2026-08-12T22:30:58.027Z`, also re-run against the
merged code.** 32 of 32 cases scored on both arms this time — the `case-02` Sonnet-only
response-validation failure the original branch run hit did not reproduce here. That gap
(`buildAllFieldsFlagged` forcing Sonnet to comment on an ABV field the label states nothing
about) is still real and still unfixed; it is a pre-existing, intermittent, out-of-scope issue
this ticket does not own, not something this run disproves.

| | Cascade end state (post-resolution) | Sonnet-only (post-resolution) |
|---|---|---|
| Label-verdict accuracy | **71.9%** (23/32) | **37.5%** (12/32) |
| Total measured cost | $0.2816 | $0.4710 |

Accuracy delta: **-34.4 percentage points** (Sonnet-only minus cascade end state). Cost delta:
**+$0.1894, 1.7x** (Sonnet-only costs more). **This replaces the earlier -24.1 point figure
recorded in this file** (`CHANGES.md`, the TRO-470 entry: cascade 65.5%/19/29 vs sonnet-only
41.4%/12/29). That older number compared the cascade arm's router-only verdict against the
Sonnet-only arm's post-resolution verdict — a stage mismatch, and the exact one this ticket
fixes. The corrected comparison still shows the cascade winning on accuracy and cost, by a
wider margin than the router-only reading suggested. This run also carries TRO-535's
`singleChannelPass` field for the first time: 1 of 32 cascade cases (3.1%) is a clean PASS
decided by one channel alone, the residual false-PASS exposure CP-2 §8.4 names.

**Not verified by this ticket.** Two open questions remain, one from the original analysis and
one narrowed by the merged re-run. Does Troy agree with the label-level-blocker design decision
above? Do the two newly-exposed router-to-cascade regressions still present in the merged code
(case-16, case-18; case-23 and case-24 join them, per the corrected list above) warrant a
resolver-prompt change — flagged here as evidence, not diagnosed further? `case-02`'s
Sonnet-only-arm validation failure did not reproduce in this run, narrowing but not closing that
question — it is an intermittent, pre-existing, out-of-scope gap, not confirmed fixed.

**Rollback.** `git revert` this commit. `scripts/eval/results/eval-report.json`,
`scripts/eval/baseline.json`, and `scripts/eval/results/benchmark-report.json` revert to their
pre-TRO-538 shape along with the code; no other file depends on the new fields.

## TRO-519 — OCR channel timeout (2026-08-12)

**What this builds.** `runWarningOcr` (`src/server/warning/ocr.ts`) now bounds its whole
worker lifecycle behind one shared deadline: `OCR_TIMEOUT_MS`, 2000ms. It covers creation,
parameter set, and recognition. It uses `Promise.race` against a timer — lessons.md rule
23's pattern, one timer across every await, cleared once at the end. Before this ticket, none
of those awaits carried a deadline. A hung Node `worker_threads` worker used to hang
`runWarningOcr` forever, and hang `/api/verify` with it. No error. No database row. That was
TRO-480's finding. On a timeout, `runWarningOcr` returns `null` — the exact value its
existing `catch` block already returns for a thrown error. No new branch. No new field. No
change to `reconcile.ts`. TRO-519's own scope says stop there, so this does.

**Reproduction check.** `pnpm build && pnpm start`, two real `POST /api/verify` submissions
against golden-set case-01. Both completed: HTTP 200, PASS verdict, a database row confirmed
by direct query. Times were 3.97s and 6.08s. **Did not reproduce.** That has an explanation,
not just a negative result. TRO-479 already found and fixed a related but different
production-build bug. Next's build-time output tracing could not follow tesseract.js's own
runtime path to its worker-thread entry point. `serverExternalPackages: ["tesseract.js"]`
(`next.config.ts`) fixed that before this ticket's worktree existed. That fix explains the
clean repro. It does not close TRO-519's own gap. The missing timeout was real on its own
terms — any other cause of a stuck worker thread hits the identical failure mode. A bonus
check under `pnpm dev` (TRO-480's original environment, with this ticket's fix applied) also
completed cleanly: HTTP 200, 4.01s. That is consistent with, but not proof of, the same
config fix also covering dev mode. No hang occurred in that one live attempt, so it never
exercised the timeout path. The deterministic tests below are the real proof the mechanism
works, not this live check.

**The timeout value — 2000ms, reasoned from PRD §3.8, not measured.** The OCR channel's own
p50 target is ~0.5s. 2000ms is 4x that: room for a real, slow-but-working recognition. Haiku
extraction's own p50 target is ~2.5s. The two channels run concurrently
(`compareGovernmentWarningFromImage`'s own `Promise.all`). A single OCR hang bounded at
2000ms stays under Haiku's own typical latency. The hang hides behind the Haiku call already
on the critical path, instead of becoming the new bottleneck. Named residual risk, out of
this ticket's file scope: `region-detect.ts`'s band-search fallback can call `runWarningOcr`
up to four times in one request. A systemic hang cause would hang every one of those calls
alike, so that combination's worst case is roughly 4x this constant, not 1x. That combination
is narrower than the single-hang case this ticket targets, and it was infinite before this
ticket regardless.

**Cancellation — investigated, none exists.** Checked the installed `tesseract.js@7.0.0`'s
own type declarations and `createWorker.js` source directly. Neither `createWorker` nor
`Worker.recognize` takes a `signal`, or any abort option, anywhere in the public API. This
ticket falls back to the bare-timer path as the honest fallback.

**Worker termination — fire-and-forget, and it covers a late-arriving worker too.** A first
draft awaited `worker.terminate()` inside the timeout branch's own cleanup. Local CodeRabbit
review round 1 (major) caught the real risk: a hanging `.terminate()` would extend the
deadline it should enforce. Fixed — termination is now fire-and-forget everywhere, logged if
it fails, never awaited before returning. The same round named a second gap. A worker whose
`createWorker()` call resolves after the deadline already fired was left running,
unterminated. It did real OCR work nobody would ever read. Fixed with a `timedOut` flag,
checked the moment that late worker exists. It terminates the worker immediately and skips
`setParameters`/`recognize` entirely. One case still cannot be terminated: a `createWorker()`
call that never settles at all. There is provably no handle to terminate, ever, in that case.
`runWarningOcr` still returns `null` within `OCR_TIMEOUT_MS` regardless.

**New problem noticed, not fixed here (out of this ticket's scope).** TRO-479's own
investigation found that tesseract.js's Node backend never attaches a real listener to the
underlying `worker_threads.Worker`'s `error` event. `createWorker.js` sets
`worker.onerror = fn`. That hook only does something for the library's browser backend.
Node's own `Worker` has no such property-style dispatch. TRO-479 removed the one known
trigger for this — the build-trace failure — with `serverExternalPackages`. The underlying
gap is still there for any other trigger: no listener on the raw Node worker's `error` event.
It crashes the whole process, not just one request — Node's default behavior for an
`EventEmitter` `error` event with no listener. No timeout can fix a crashed process.
tesseract.js's public API gives no hook to attach a listener to the raw worker from outside
the library. Worth its own ticket if Troy wants defense in depth here.

**Tests.** `src/server/warning/ocr.test.ts` — 6 new cases. A `createWorker` that never
resolves degrades to `null` inside the deadline. A `recognize()` that never resolves degrades
to `null` and terminates the worker. A fast real success still returns its result and still
terminates. A thrown `createWorker` error and a `createWorker` timeout converge on the
identical `null`. A worker whose own `terminate()` never resolves does not block
`runWarningOcr`'s return. A worker that resolves from `createWorker` after the deadline is
terminated the moment it exists, with `setParameters`/`recognize` never called on it.
`src/server/warning/index.test.ts` — 1 new case: the real `runWarningOcr` (not a fake),
injected only at its own `createWorker` seam. It degrades `compareGovernmentWarningFromImage`
all the way to a single-channel `MATCH` inside the deadline. That proves the production
wiring, not just the innermost function. Every new test uses vitest's fake timers; none
sleeps for real (lessons.md rule 8). Full suite: 1535 tests, all pass (`pnpm test`).

**Local CodeRabbit review, round 1 (3 findings, all fixed).**
- `src/server/warning/ocr.ts` (major): `worker.terminate()` was awaited inside the timeout's
  own cleanup, so a hanging termination could extend the timeout it was meant to enforce. A
  worker whose `createWorker()` resolved after the deadline was left running, unterminated.
  Fixed as described above: fire-and-forget termination everywhere. A `timedOut` check
  terminates a late-arriving worker the moment it exists, and skips real OCR work on it.
  Two new tests cover both fixes directly.
- `src/server/warning/index.ts` (minor): `runOcrChannel`'s own comment overclaimed a
  channel-wide bound. Only each individual `ocr` call is actually bounded by
  `OCR_TIMEOUT_MS`. `detectWarningRegion`'s band-search fallback can call it up to four
  times, and `detectRegion`/`crop` carry no deadline of their own. Fixed by naming the real
  bound precisely instead of the overclaim.
- CHANGES.md (minor): several sentences in this entry ran past ASD-STE100's 25-word
  guidance. Fixed by splitting them — this pass.

**How to run it.** No new command. `pnpm test` covers the regression.
`pnpm dev`/`pnpm build && pnpm start` both run the real path unchanged.

**Rollback.** `git revert` this ticket's commit(s) on `fix/ocr-channel-timeout`. No schema
and no config ride along. `ocr.ts`, `index.ts`, their tests, and this entry are the whole
diff.

## TRO-535 — LH-030b · Sweep OCR_CONFIDENCE_FLOOR (2026-08-12)

**What changed.** A statutory field passed on one channel. The second channel ran. It
disagreed badly. The reconciler discarded it anyway. `OCR_CONFIDENCE_FLOOR`
(`src/server/warning/reconcile.ts:106`) moves from 60, proposed and unmeasured, to 50, measured.

**The measurement.** `scripts/eval/ocr-floor-sweep.ts` replays the OCR channel against every
golden-set image. It calls the same five functions the verify route calls, in the same order:
`preprocessImage`, `detectWarningRegion`, `cropForOcr`, `runWarningOcr`, `evaluateCandidate`. It
makes no API call. It writes one file: `scripts/eval/results/ocr-floor-sweep.json`.

Every warning-bearing case landed in one of two confidence clusters, with a wide, empty gap
between them. Low cluster: 56 and 58 (case-24 and case-23, tiny warning print). Both are real
readings, badly degraded — distance 42 and 47 from the canonical text. High cluster: 91, 95, or
96 (25 of 27 warning-bearing cases with a usable OCR candidate). One high-cluster case (case-18,
glare on the warning block) read confidently while reading garbage — Tesseract confidence is
not a read-quality oracle, which is why the dual-channel agreement check, not this floor, is the
real safety net.

The old floor of 60 sat inside the empty gap, above both tiny-print readings. That is why it
discarded case-23 and case-24's OCR evidence every time, no matter how badly the print
degraded, and let a single confident VLM channel pass a label whose only other reader produced
47 and 42 edits of garbage.

**The chosen floor: 50.** The midpoint of Tesseract's 0-100 scale. Not the smallest number that
flips two cases — 55 or 56 would already do that. 50 sits 6 to 8 points under both measured
tiny-print readings.

**Honest limit.** The golden set has no case between blank-crop noise (confidence 0,
`ocr.test.ts`) and 56. Nothing in this corpus proves 50 over 40 or 45. `reconcile.ts`'s comment
and the CP-2 amendment below both name this gap. Neither hides it.

**CP-2 amendment.** `docs/checkpoints/cp2-warning-subsystem.md` §4.5 merged two states into one
table row: "OCR unavailable or below the confidence floor." Case-23 and case-24 proved they are
different states — one has no reading to discard, the other has a real one. The row is split
into two, dated 2026-08-12. CP-2 is an approved checkpoint. The split is recorded as a dated
amendment, not a silent rewrite of the original text. §11 open question 7 carries a matching
resolution note.

**Channel provenance.** `WarningComparatorResult` (`src/server/router/types.ts`) carries an
optional field, `channel`: `"dual"` or `"single"`. Every result `reconcileWarningChannels`
itself returns sets it — passed as an explicit argument through the reconciliation functions,
never read back off an already-built result. The eval report carries it too.
`VerdictCaseScore.warningChannel` (`scripts/eval/types.ts`) is populated in `cascade-runner.ts`
from the `compareGovernmentWarning` dependency's own captured result — by the time the HTTP
response body is built, `routeLabel` has already turned it into a `FieldResultRow` that carries
no channel of its own.

`WarningSegmentationSummary` gains `singleChannelPass` (`scripts/eval/warning-segmentation.ts`).
CP-2 §8.4 names this rate: the residual false-PASS exposure. It is the subset of `clean` where
one VLM channel decided PASS, with no OCR channel to disagree. It is not a fifth,
mutually-exclusive class — it overlaps `clean` by construction, exactly as CP-2 §8.4 states.
Same denominator as the other four classes: `total`. The code states that choice, because CP-2
states one for the suspect rate only.

**Measured, live: case-23 and case-24 score REVIEW, not PASS.** `pnpm eval:check -- --live
--full`, 2026-08-12T21:28:19Z, 32/32 cases, 0 failures, $0.318 measured cost. Both cases:
`actualLabelVerdict: REVIEW`, `government_warning` field verdict `NEEDS_REVIEW` (matches the
manifest), `warningChannel: "dual"` (both channels now compared), `actualReviewReason:
WARNING_MISMATCH`. That reason does not match the manifest's `LOW_IMAGE_QUALITY` — expected and
named up front in the ticket. TRO-516's correction C4 owns closing that gap; not closed here.

Label-verdict accuracy moved from 21/32 (65.6%) to 24/32 (75.0%) in this run. **Only two of
those three newly-correct cases are this ticket's fix.** The third, case-17, also flipped
PASS→REVIEW. Its headline reason is `AMBIGUOUS_BRAND`, not a warning reason. Its cause: Haiku
read `brand_name` differently on the two live calls (correct, then wrong). The original
2026-08-12 diagnosis already named this exact case as model-call variance. This ticket's code
never touches brand extraction. That same misread also cost extraction accuracy one point,
154/160 → 153/160.

The full per-case diff was checked, not assumed. Exactly three `labelVerdictCorrect` values
changed. All three moved False → True. None moved the other way.

`scripts/eval/baseline.json` is updated from this same live, full, zero-failure run — the only
honest source, since `singleChannelPass` and `warningChannel` did not exist as concepts before
this ticket and no historical value for them exists to preserve.

**A TypeScript control-flow limit, found and worked around.** A `let` variable a nested closure
reassigns (`cascade-runner.ts`'s `capturedWarningResult`) narrows to `never` at any later
property read — confirmed with a minimal reproduction, even across an intervening `await`. This
is a real TypeScript limit, not a bug in the captured value. Fixed with one small named
function, `extractWarningChannel`. A function parameter gets a fresh type binding from its own
annotation; that resets the over-narrowing.

**What stays open.** Whether Haiku read case-23 and case-24's 9px print, or completed it from
memory, stays unmeasured. No golden case pairs tiny print with a wording deviation, so nothing
in this repo can tell the two apart (CP-2 §10 Q7). Separately, this run's `singleChannelPass`
metric caught a live, real instance of the same exposure class on a different case: case-22's
`government_warning` field is a single-channel MATCH against an expected NEEDS_REVIEW (the label
verdict still lands on REVIEW overall, from a different blocker) — noticed, not fixed, here.

**How to run it.** `pnpm eval:ocr-floor-sweep` re-runs the sweep. It makes no API call. `pnpm
test` runs the regression suite, including new cases in `reconcile.test.ts` that encode the
measured case-23 (58) and case-24 (56) confidence values directly — red under the old floor,
green under the measured one. `pnpm eval:check -- --live --full` re-measures the live cascade.
This spends real money.

**Rollback.** `git revert` this commit. `OCR_CONFIDENCE_FLOOR` reverts to 60. `channel` and
`singleChannelPass` are additive; dropping them is safe for every other caller. The CP-2
amendment is a dated addition, not an edit to the original text — reverting it restores the
pre-amendment document exactly. `scripts/eval/baseline.json` and `eval-report.json` would need a
fresh `--live --full --update-baseline` run to re-establish the pre-ticket floor, since the old
files are not restored by a plain revert once superseded (both are working artifacts, committed
for evidence, not source).

## TRO-534 — LH-029 · Guard the beverage_type cross-check (2026-08-12)

**What changed.** The beverage_type cross-check in `src/server/router/index.ts` (CP-1 §5.3's
free cross-check) now needs two things before it fires `CONFLICTING_EXTRACTION`. First, the
extractor's normalized `beverage_type.value` must be a real `BEVERAGE_TYPES` member (`beer`,
`wine`, `spirits`). Second, that member must disagree with the application's declared type.
Before this fix, the check compared a free-form extractor string against the application's
closed enum by plain equality. An off-menu subtype — a real TTB category the application form
has no slot for — read as a conflict.

**Why.** The measurement comes from `scripts/eval/results/eval-report.json`, run
`2026-08-12T13:26:45.488Z`, mode `live`, model `claude-haiku-4-5`. case-11 declares beverage
type `wine`. Its label prints class type `Mead`. TTB classes mead as a wine. Neither record is wrong. The old check still
fired `CONFLICTING_EXTRACTION`. That set a label-level blocker. `rollup.ts:15` returned REVIEW
before it ever read the government warning's own `MISMATCH`. TH-R9's acceptance evidence reads
"reworded warning → fail" (`audit/requirements/inventory.md:87`). case-11 carries a genuinely
reworded warning. It now returns FAIL.

**Step 1's live read.** A scratch script, never committed, called `runOneCase` against
case-11. It pointed `DATABASE_URL` at this worktree's own database first. The raw extraction
was `beverage_type: { value: "mead", evidence: "Mead", confidence: 0.99, alternates: [] }`.
`"mead"` is not a `BEVERAGE_TYPES` member. Its confidence clears `TRUSTED_THRESHOLD_DEFAULT`
(0.85). An off-menu value at trusted confidence does not meet the ticket's stop condition
(step 3). The fix proceeds on this measured basis, not a guess.

**Net effect on label-verdict accuracy.** Accuracy stays unchanged at 21/32. This is not a
scoreboard win. Two live single-case runs followed the fix. The PR pastes both outputs in
full below:

- `pnpm eval:check -- --live --case=case-11-reworded-warning-clause-two`: `labelVerdict`
  `FAIL` (was REVIEW), `reviewReason` `null`. This result is now correct.
- `pnpm eval:check -- --live --case=case-22-low-light-warning-block`: `labelVerdict` `PASS`
  (was REVIEW), `reviewReason` `null`. This result is now incorrect.

case-22 also declares `wine`/`Mead`. Its `government_warning` field genuinely needs review.
The golden set expects `NEEDS_REVIEW`. The router now returns `MATCH`. The old blocker masked
this defect. The blocker did not produce a correct verdict for a correct reason. It produced
the right label verdict through the wrong mechanism. Removing the blocker exposes the defect
instead of hiding it. The fix corrects one case. The fix exposes one case's masked defect. The
count holds at 21/32. Read both results as honest-evidence wins under PRD §6. Neither is a net
gain or a net loss that cancels the other out.

**How to run it.** `pnpm test` runs the two new tests in `src/server/router/index.test.ts`,
beside the existing beverage_type block. `pnpm eval:check -- --live --case=<id>` reads one
case live. It never touches the committed report or baseline (`check.ts`'s own contract).

**Rollback.** Run `git revert` on every commit `git log main..fix/lh-029-beverage-type-crosscheck`
lists, oldest first. All the changes live in one file, `src/server/router/index.ts`: a new
import, the `isKnownBeverageType` guard, and the vocabulary check inside `routeLabel`. A
revert restores the old, unguarded string-equality check.

**Related, not duplicated here.** TRO-502 owns override rule 1
(`src/server/router/overrides.ts:134`) — a separate defect in the same field. This ticket
changes only the label-level cross-check in `index.ts`.

## TRO-537 — LH-032 · Prove the government warning FAIL path on a real image (2026-08-12)

**What this proves.** TH-R9 names three acceptance cases. One passes. Two fail. Until this
ticket, only the PASS case ran the real pipeline — case-01 in
`src/server/warning/index.test.ts`. Both FAIL cases ran only against hand-built strings. Both
went straight to `reconcileWarningChannels` (`reconcile.test.ts:59-63`, `:80-87`). That gap
mattered. CP-2 §4.5's rule: "we never accuse on one channel." A single readable channel
returns `NEEDS_REVIEW`, never `MISMATCH`. Comparator-level proof does not show that the live
path reaches the same answer. Troy ruled on this (INT-001,
`audit/requirements/interpretations.md:9-24`): comparator-level proof does not satisfy TH-R9.

**Two new tests, one file.** Both live in `src/server/warning/index.test.ts`, in the existing
"real image, real OCR, real region detection" `describe` block, beside the case-01 test they
mirror. Neither passes a `deps` argument to `compareGovernmentWarningFromImage` — region
detection, cropping, and OCR all run for real.

- **case-08** (the case INT-001 requires): real pipeline against
  `golden-set/images/case-08-title-case-warning-prefix-only.jpg`. Verdict `MISMATCH`, note
  "Government Warning must print in capital letters."
- **case-10** (optional under INT-001, added anyway — nearly free, and it closes TH-R9's third
  acceptance shape on a real image): real pipeline against
  `golden-set/images/case-10-reworded-warning-clause-one.jpg`. Verdict `MISMATCH`, note
  "Government Warning wording differs from the required text."

Both tests read their image path and warning text from `loadGoldenSetManifest()`, never a
pasted literal. A manifest edit that changes the ground truth breaks the test right away.

**The trap, confirmed and avoided.** `extractedWarning()`'s defaults are
`prefix_casing: "ALL_CAPS"` and the canonical warning text. A standalone `tsx` script measured
what those defaults do against case-08's real image. The script ran outside the repo and wrote
no file. The result: `NEEDS_REVIEW`, reason `WARNING_MISMATCH`, note "Government Warning could
not be read consistently" — not `MISMATCH`.

The VLM channel reads the canonical, all-caps text. The real OCR channel reads the image's
actual title-case text. The two disagree outright, so the code takes
`reconcileDualChannel`'s disagree branch (`reconcile.ts:136-138`). Only the agree branch can
return `MISMATCH`, and these two channels do not agree.

The new tests avoid this trap. Each passes the case's own transcription and its real
`prefix_casing`: `TITLE_CASE` for case-08, `ALL_CAPS` for case-10. Case-10's prefix is correct.
Only clause (1)'s wording is off.

**Evidence, measured this session.**

| measurement | value |
| -- | -- |
| case-08, real pipeline, `pnpm test` | `MISMATCH`, "Government Warning must print in capital letters." |
| case-08 wall clock | 296 ms (vitest run), 332 ms (standalone `tsx` script) |
| case-08 with the ALL_CAPS trap (verification only, not shipped) | `NEEDS_REVIEW` / `WARNING_MISMATCH`, "Government Warning could not be read consistently." |
| case-10, real pipeline, `pnpm test` | `MISMATCH`, "Government Warning wording differs from the required text." |
| case-10 wall clock | 298 ms |

**Not touched.** This ticket leaves `reconcile.ts`, `region-detect.ts`, `ocr.ts`, and
`OCR_CONFIDENCE_FLOOR` unchanged. It adds tests. It fixes no production code.
`reconcile.test.ts:59-63` and `:80-87` (the comparator-level title-case and reworded tests) stay
untouched too. They remain the right unit tests. This ticket adds the missing integration proof
beside them.

**Effect on TH-R9.** This ticket meets INT-001's bar. A FAIL case now runs the real image
pipeline. TH-R9 moves out of PARTIAL.

**Rollback.** Revert this ticket's commits. They touch two files: this changelog entry and
`src/server/warning/index.test.ts`. No schema change.

## TRO-536 — LH-031b · Drop the apostrophe at normalizer step 6 (2026-08-12)

**What changed.** Step 6 of `normalizeForFuzzyMatch` (`src/server/comparators/normalize.ts`)
dropped every punctuation mark except an apostrophe and a hyphen. It now drops the apostrophe
too and keeps only the hyphen. The function is renamed from
`dropPunctuationExceptApostropheAndHyphen` to `dropPunctuationExceptHyphen`, and its
trailing-trim regex simplifies from `/^['-]+|['-]+$/g` to `/^-+|-+$/g`.

**Why.** case-15 (`STONES THROW` on the label, `Stone's Throw` on the application) expects
PASS with `brand_name` MATCH. It returned REVIEW with `AMBIGUOUS_BRAND`. Every extraction field
scored `correct: true` in `scripts/eval/results/eval-report.json` (measured
2026-08-12T13:26:45.488Z, live, `claude-haiku-4-5`) — Haiku read the label right, so the defect
was in the comparator. Step 6 kept the application's apostrophe, so the two brand strings
normalized to `stone's throw` and `stones throw`, one character apart. `similarity()` scored
0.923077, just under `BRAND_CLASS_MATCH_THRESHOLD` (0.95), so the field escalated to
NEEDS_REVIEW and the label rolled up to REVIEW.

**Measured on the corpus, not argued.** Replayed the production normalizer and similarity
function over all 32 golden-set cases' `brand_name` and `class_type`, using Haiku's real
extracted values from the measured run, once against the old step 6 and once against the
patched one (read-only script, no repo file changed):

| Case | Field | Before | After |
|---|---|---|---|
| case-15 | `brand_name` | 0.923077 | 1.000000 |
| case-16 | `brand_name` | 0.423077 | 0.461538 |

Exactly one score crosses the 0.95 threshold: case-15. case-16 stays below it and keeps its
NEEDS_REVIEW field verdict, which its own expectation asks for (`brand.test.ts` pins this
pair). No `class_type` score moves anywhere in the 32-case corpus. `extraction-scoring.ts`
calls the same normalizer to score extraction correctness; zero extraction scores move, because
dropping a character can only merge two strings, never split them.

**A gap this closes.** `normalize.test.ts` already pinned a known gap: a curly apostrophe
(U+2019, a stylized mark a real vision-model read can emit) and a straight apostrophe
normalized to two different strings and scored ~0.923 similarity — just under MATCH. Both now
normalize to the same punctuation-free string and score 1.0. The test that pinned the gap now
pins it closed. Inverted the assertion instead of deleting the test, so the record of the
change stays in the suite.

**Honest limit.** TH-R8's own named acceptance test is `STONE'S THROW` vs `Stone's Throw`
(`audit/requirements/inventory.md:79`), and case-14 carries that exact pair and already passed
before this fix. This change does not repair a broken graded acceptance line — it extends the
same graded rule (rubric vector V5) to a second carrier, case-15, that sits just beyond every
document's own named example.

**One accepted behavior change.** A possessive and a plural now fold together — `stone's` and
`stones` normalize identically. This can produce a wrong MATCH. It cannot produce a wrong FAIL:
`compareBrandOrClass` returns only `MATCH` or `NEEDS_REVIEW` (`brand.ts:60-62`, pinned by
`brand.test.ts`). It never touches the government warning, which keeps its own exact-compare
subsystem with no shared helpers (`normalize.ts:12-15`).

**Checkpoint amendment, flagged for the record.** `docs/checkpoints/cp1-cascade-router-prompts.md`
is a checkpoint-approved document. Three lines stated step 6 as "drop punctuation except
internal apostrophes and hyphens" and printed the folded literal as `` stone's throw ``. Both
went stale the moment step 6 changed. Updated the rule text and the worked example's folded
literal, and added an inline, dated amendment note at the point of change. CP-1's outcome does
not change: `STONE'S THROW` and `Stone's Throw` still fold to one string and still score 1.0 —
only the folded spelling changed, from `stone's throw` to `stones throw`. This is a deviation
from originally-approved checkpoint text, made without a fresh live walkthrough; it is on the
record here for Troy, not a decision this ticket claims authority to make quietly.

**Evidence.**

- `pnpm test`: 1530/1530 passed, 138 test files. No test deleted, skipped, or quarantined.
  Includes a direct assertion that `normalizeForFuzzyMatch("STONES THROW")` equals
  `normalizeForFuzzyMatch("Stone's Throw")` (`normalize.test.ts`), alongside the
  comparator-level case-15 test in `brand.test.ts`.
- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors (1 pre-existing warning in `DetailView.tsx`, unrelated to this change).
- `pnpm golden:verify`: PASS, 32 cases — no manifest edit, so vector coverage is unchanged.
- TDD: `brand.test.ts`'s new case-15 test was written first and observed failing
  (`NEEDS_REVIEW`, not `MATCH`) against the pre-fix normalizer, for the documented reason
  (0.923077 similarity below the 0.95 threshold), before the source change landed.
- Live, one Haiku call: `pnpm eval:check -- --live --case=case-15-case-variant-brand-punctuation`.
  Observed `actualLabelVerdict: "PASS"` and `brand_name` `actualVerdict: "MATCH"`. The router
  now resolves the field itself, so `resolverCost` is `null` — no Sonnet call. Cost $0.00475.
  **Correction to this ticket's own prediction:** the ticket expected exit code 1 with a
  "stale coverage" message. The observed exit code was 0, with no such message.
  `scripts/eval/check.ts:154-160` explains why: `--case=<id>` is a dedicated single-case debug
  path. It prints the result and returns before the baseline-comparison logic ever runs, so it
  never emits that message and never touches the committed report. Two checks confirm this: the
  md5 of `scripts/eval/results/eval-report.json` is byte-identical before and after the run, and
  `git status` shows that path clean. No restore was needed, though a backup was taken first
  regardless.
- `pnpm eval:check` (cheap mode, what gate G8 runs): PASS, exit 0, comparing the untouched
  committed report against the committed baseline. **Stated honest limit:** this run does not
  exercise this fix at all — it is scored against the same pre-fix committed numbers, so G8
  proves nothing regressed, not that case-15 now passes. The live single-case run above is what
  proves that.

**How to run it.** `pnpm test`. Optional live check (one Haiku call, not part of the gate; copy
`scripts/eval/results/eval-report.json` aside first — though `--case` mode does not write it):
`pnpm eval:check -- --live --case=case-15-case-variant-brand-punctuation`.

**Rollback.** Revert this commit range. `normalize.ts` step 6 goes back to keeping the
apostrophe; `normalize.test.ts` and `brand.test.ts` go back to their pre-TRO-536 assertions;
CP-1's three amended lines revert to their originally-approved text.

## TRO-479 — LH-053 · E2E suite (2026-08-12)

**What this builds.** Real, executable Playwright specs for the three PRD §6 flows: verify,
batch, and review queue. Every spec runs against a real, live app and a real background worker
(`playwright.config.ts`'s `webServer`) — real preprocessing, the real deterministic router, real
persistence. The one exception is named up front, not buried: by default, the Anthropic API
itself is faked (see "Real model calls or fakes" below). This entry's earlier draft claimed
"none run against a mocked server," which was flatly wrong given the very next section —
corrected here (CodeRabbit finding, TRO-479 local review round 2).

- `e2e/verify.spec.ts` — the verify happy path (a real golden-set image, a full per-field
  checklist, click-through to detail), plus three error states: unreadable image, oversized
  file, and an API failure with a retry affordance that genuinely recovers, not just appears.
- `e2e/batch.spec.ts` — manifest upload → pairing preview → run → live progress → results
  table → click-through to detail, plus two error states: malformed CSV and unpairable
  rows/images.
- `e2e/review-queue.spec.ts` — a needs-human item with its reason visible; both Approve and
  Reject record a disposition.
- `e2e/health.spec.ts` — unchanged (LH-001's own scaffold spec).

**Scope cut, stated explicitly.** Two of the seven PRD §5 error states are not built as E2E
specs: partial batch failure and the rate-limit backoff notice. Both already have precise,
deterministic unit coverage (`src/server/batch-progress/get-batch-progress.test.ts`). That
coverage does not depend on timing. A true E2E repro of partial failure needs a
deliberately-broken item inside an otherwise-good batch. A true E2E repro of the backoff notice
needs a live 429 racing a real `available_at` timestamp against the browser's own poll window.
Both are exactly the shape of timing-dependent state that makes an E2E test flaky. Both would
add only marginal signal beyond what the unit suite already proves deterministically. Five of
seven is the real, honest count — not a silently dropped two.

**Real model calls or fakes — decided, and load-bearing.** Every existing HTTP-level test in
this repo (`src/app/api/verify/route.test.ts` and its siblings) injects a fake Anthropic client
by dependency injection. A live browser test has no such seam into a separate server process.
`scripts/e2e/fake-anthropic-server.ts` is a small, real HTTP server standing in for
`api.anthropic.com`. `getDefaultExtractorClient()` and the resolver's own default client
(`src/server/extractor/index.ts`, `src/server/resolver/index.ts`) both fall back to
`process.env.ANTHROPIC_BASE_URL` when no client is injected. Production code already has that
same seam, for the same reason. `playwright.config.ts` points the app's and the worker's
`webServer` processes at this fake server by default. An E2E run never spends real API money.
`E2E_LIVE=1 pnpm test:e2e` runs the real cascade against the real API instead. This mirrors
`scripts/eval/check.ts --live`'s own shape: cheap by default, an explicit flag pays for the real
thing. Every other part of the cascade stays 100% real in every mode: preprocessing, the
deterministic router and comparators, the warning subsystem (real tesseract.js OCR against the
real uploaded photo, included), and persistence.

The fake server's default response is `WELL_FORMED_EXTRACTION_BODY`
(`src/server/extractor/test-support.ts`), the same fixture the unit suite already trusts. It is
also the verified ground truth for `golden-set/images/case-01-clean-match-spirits.jpg`. Every
spec that needs a working extraction uploads that real, committed image (TH-R12). The fake
response and the real photo describe the same label. A spec that needs a specific failure or a
REVIEW verdict gets one a different way: it chooses a deliberately mismatched application value,
or uploads a deliberately tiny synthetic "trigger" image (`scripts/e2e/fixtures.ts`). Neither
needs a shared, racy "current scenario" control endpoint. The whole suite stays safe to run
fully in parallel (`fullyParallel: true`, unchanged from LH-001's own scaffold).

**A real production bug found and fixed, in scope for this ticket.** The first real
`next build && next start` run that uploaded a real photo crashed the whole app server process:
`Cannot find module '.../tesseract.js/src/worker-script/node/index.js'`. That was an
`uncaughtException`, and it killed every request after it, not only the one that triggered it.
Next's production build traces server-side `require()` calls to decide what ships. tesseract.js
resolves its own Node worker-thread entry point at call time — a path Next's static trace cannot
see. Nothing before this ticket ever exercised this path. The unit suite runs OCR directly in
Node, with no Next bundler involved at all. No prior ticket ran a production build with a real
image through the warning subsystem. Fixed with `serverExternalPackages: ["tesseract.js"]`
in `next.config.ts` — Next's own documented escape hatch for a package whose runtime module
resolution a static trace cannot follow. This is exactly the class of bug real E2E against a
real production server exists to catch. It would have hit the real deployed Render instance
too, not only this suite.

**Confirmed each spec exercises the real flow, not a vacuous green run.** Six separate
break/restore trials, each against a different mechanism the suite depends on: the checklist's
own MATCH text, the batch progress testid the live-polling assertion waits on, the review
queue's `AMBIGUOUS_BRAND` reason text, `ErrorPanel`'s `role="alert"`, the fake server's own
failure-trigger threshold, and the pairing module's unmatched-row reason text. Every trial
followed the same steps: break it, watch the affected spec fail for the right reason, restore
it, watch the suite go green again. One trial caught a real gap in the test itself, not in the
app. The unpairable-rows assertion originally checked the whole problems panel against one
regex, and either reported problem could satisfy it. It stayed green even with the row-specific
message broken, because the (unbroken) image-specific message alone still matched the pattern.
Fixed by asserting each reported problem against its own list item, not the panel as a whole.

**Local CodeRabbit review triage, round 1 (4 findings, 3 fixed, 1 kept as-is with reasoning).**
- `scripts/e2e/fake-anthropic-server.ts` (major): an unrecognized `model` silently fell through
  to the extraction response. Fixed — now a loud 400, since this app is the only caller and any
  other value means a caller bug or real drift from the two model constants (standing rule 13).
- CHANGES.md (major): several sentences in this entry ran well past ASD-STE100's 25-word
  guidance. Fixed by splitting them — this pass.
- CHANGES.md (minor): the fenced `bash` block below was missing a blank line on each side
  (MD031). Fixed.
- `playwright.config.ts` (major): a suggestion to set `reuseExistingServer: false` on the
  fake-model and app `webServer` entries, so a stale local process can never mask a fix. Kept
  `!process.env.CI` instead, unchanged, on both. That is the same value this file's own
  pre-existing app entry already used before this ticket (LH-001's scaffold), and it is
  Playwright's own documented convention for this flag. Forcing a full rebuild on every local
  run has a real, everyday cost: slower iteration, and it breaks the common "point Playwright at
  an already-running `pnpm dev`" workflow. In exchange, it only guards against a self-inflicted
  mistake — an orphaned local process — that CI's own `!process.env.CI` already covers where it
  actually matters. Recorded in the review ledger as reviewed, not applied.

**Local CodeRabbit review triage, round 2 — post-merge with TRO-480 (5 findings, all fixed).**
Run by the orchestrator against the merged state — this branch plus TRO-480's UX-polish changes.
The orchestrator read the actual code before sending each finding. All five held up, and all
five are fixed here; none dismissed.
- CHANGES.md (major): a real self-contradiction. "What this builds" claimed "None run against a
  mocked server," directly contradicted two paragraphs later by "Real model calls or fakes"
  explaining that the Anthropic API is faked by default. Fixed — the opening paragraph now names
  the one exception up front instead of denying it exists.
- `e2e/verify.spec.ts` (major): the happy-path test asserted exact evidence text from the fake
  server's own canned fixture (`WELL_FORMED_EXTRACTION_BODY`). Under the documented, callable
  `E2E_LIVE=1` path, a real model reads the real photo for itself. Its evidence text is not
  guaranteed to match a hardcoded fixture byte for byte. Every one of those assertions was
  foreseeably broken under a real live run, for a reason that has nothing to do with an actual
  bug. Fixed: the exact-text checks now run only when `!E2E_LIVE` (`e2e/helpers.ts`'s new
  `E2E_LIVE` export); the MATCH-badge checks, which hold under either mode for this genuinely
  clean-match label, stay unconditional. The "API failure" test's own failure-injection trigger
  has no live-API equivalent at all — the real API does not fail on demand for a small image.
  That whole test now uses `test.skip(E2E_LIVE, ...)` with the reason stated inline. This is a
  deliberate mode-scoping decision, not a weakened assertion: the retry affordance it proves
  stays fully exercised in the default mode, which is also what the gate runs. Verified the
  branching itself fires correctly — skip triggers, remaining assertions still pass — without any
  real API spend. Proved this by hardcoding the flag in the test file only.
  `playwright.config.ts`'s own real `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` overrides were never
  touched for this check.
- `e2e/helpers.ts` (major): `submitVerifyFormAndWait` used a raw, unfiltered
  `page.getByRole("alert")`. It should have used the `errorPanel(page)` helper, built
  specifically to filter out Next's own always-present route announcer
  (`__next-route-announcer__`). `.or(...)` resolves as soon as either side matches. A stale,
  non-empty announcer left over from an earlier client-side navigation could let this function
  return before the real result ever rendered. Fixed: now uses `errorPanel(page)`.
  Regression-tested directly. A new spec (`e2e/verify.spec.ts`, "helper correctness") writes
  stale text into the announcer before submitting. It then checks the checklist with a
  non-auto-retrying `isVisible()` call, deliberately not an auto-waiting `expect` — an
  auto-retrying check would have silently papered over the bug, the same way it almost always
  does. Confirmed failing against the old, unfiltered code before restoring the fix: the old code
  returned control before the real checklist had rendered, exactly as predicted.
- CHANGES.md (minor): the "true E2E repro of either state" sentence (scope-cut paragraph) still
  ran to 37 words after round 1's own pass. Split into two sentences, one per state.
- `scripts/e2e/fixtures.ts` (minor): `csvField`'s special-character check, `/[",\n]/`, quoted a
  comma, a double quote, or a newline, but not a bare carriage return — RFC 4180 requires quoting
  for `\r` too. Fixed: `/[",\r\n]/`. Added a regression case.

**Local CodeRabbit review triage, round 3 — the same automated CLI, run fresh by
`scripts/factory/gate.sh` itself against round 2's fixes (4 findings, 3 fixed, 1 acknowledged as
already handled).**
- `e2e/verify.spec.ts` (major): re-flagged the G5 gate exception this entry already documents
  below — asked to remove the skip or obtain an approved exception. Already handled: the case is
  recorded in this entry's own "flagged gate exception" section, not silently ignored. No further
  code change; noted here so the recurrence is visible, not dropped.
- CHANGES.md (major): more sentences past the 25-word guidance, this time flagged broadly rather
  than by line. Found several genuine ones round 1 and round 2 missed, including one 65-word,
  semicolon-joined sentence in the round-2 triage bullets. Fixed by splitting them across the
  affected paragraphs.
- `scripts/e2e/fake-anthropic-server.test.ts` (minor): the resolver-field test used
  `expect.arrayContaining([...six names])`, which only proves "at least these six are present."
  It would stay green even if a stray seventh field name were added to `RESOLVER_BODY` by
  accident. Fixed: compares the sorted field-name array against the exact six, no more, no
  fewer.
- `e2e/helpers.ts` (major): `errorPanel()`'s non-empty-text filter is only a proxy for "not the
  announcer" — if the real announcer is ALSO non-empty at the same moment a real `ErrorPanel` is
  showing, that filter alone cannot tell them apart. Fixed: now also excludes the announcer by
  its own stable id (`:not(#__next-route-announcer__)`), independent of its text content.
  Regression-tested — and the regression test itself needed a second attempt. Next's real
  announcer turns out to mount and remount on its own schedule (confirmed directly:
  `document.getElementById(...)` sometimes reports it absent at a point Playwright's own
  accessibility query finds it moments later), so a first version of this test that tried to
  read or mutate the live element passed even against the deliberately-reverted, buggy
  `errorPanel()` — a vacuous proof. The fixed version creates its own decoy element sharing the
  announcer's exact id, fully under the test's control, and proves the exclusion is genuinely
  by id. Confirmed failing against the old filter-only code (three consecutive runs, no flake)
  before restoring the fix.

All thirteen findings across three rounds recorded in `factory/review-findings.jsonl`.

**A flagged gate exception — read before merging.** `scripts/factory/gate.sh`'s G5
(`tests:not-weakened`) fails on this branch: one new `test.skip(E2E_LIVE, ...)` line, added by
the fix above for round-2 finding 2. G5's own comment says this is deliberate on the gate's
part. Its exact words: "`.skip`/`.todo` stays an unconditional fail: no added assertion offsets
a disabled test." This project's own non-negotiables list is just as direct: "never weaken a
test... to get a gate green," with no stated carve-out. Read literally, this skip trips that
rule. Here is the case for why it is not the thing that rule means to stop. `E2E_LIVE` is off by
default. Neither the gate nor CI ever sets it. This test runs and passes normally in the mode
the gate actually exercises — confirmed: 11/11 E2E specs pass in the default run. The skip fires
only under the opt-in, rarely-run live mode. It applies to a test whose entire mechanism — the
fake server's own byte-length failure trigger — has no live-API equivalent to run at all. This
is not a real assertion this branch is ducking. No other `.skip`/`.todo` was added anywhere
else. This was not silently routed around: no syntax was chosen to dodge G5's grep while keeping
the same behavior. The gate's real, unedited output is reported as-is, not claimed as a clean
pass it is not. The call on whether this specific exception is acceptable is left to the
orchestrator's, and ultimately Troy's, own judgment — per gate.sh's own "justify in the PR or
revert" instruction.

**How to run it.**

```bash
source .factory-env       # or your own .env.local — no ANTHROPIC_API_KEY needed by default
pnpm db:migrate            # once, if this worktree is not already current
pnpm test:e2e               # fakes the Anthropic API — no spend, ~12s once servers are warm
E2E_LIVE=1 pnpm test:e2e    # the real cascade, real API spend — needs a real ANTHROPIC_API_KEY
```

`scripts/factory/gate.sh` does not run `pnpm test:e2e` itself. G4 only runs `pnpm test`, the
vitest unit suite. That is unchanged by this ticket. Run `pnpm test:e2e` as a separate check,
exactly as this ticket's own brief asked for.

**Rollback.** `git revert` this ticket's commits. `next.config.ts`'s `serverExternalPackages`
line is safe, and worth keeping, independently of the rest of this PR. Reverting it
re-introduces a real production crash the next time a real photo reaches the warning subsystem
in a production build.

## TRO-480 — LH-054: UX polish pass — heuristic review record (2026-08-12)

**What this is.** A heuristic UX audit against TH-R3's own quote ("something my mother could
figure out... Clean, obvious, no hunting for buttons"), walking every real screen in a running
`pnpm dev` instance, not just the JSX. Five real defects found and fixed. Ran under: this
worktree's own Postgres (seeded via `pnpm db:seed`), `pnpm dev` on port 3180, Chromium via
Playwright (already a dependency — `@playwright/test`) for screenshots and live DOM
measurement, plus one real `/api/verify` submission against the golden set.

### Screen-by-screen walkthrough

**Verify (`/`).** Empty state: one clear primary flow, six fields top to bottom, "Verify"
the only filled control on the page. Filled state: values render correctly. Validation-error
state (no photo, no network call): specific message ("Add a label photo before you verify."),
plain-English title ("Check the form"). Loading state: button label and an
`aria-live="polite"` status line both say "Checking the label…". Found: intro copy said
"flags anything that needs a closer look" (vague — fixed, see below); the "Try again" button
rendered full-width inside the error panel (layout bug — fixed, see below).

**Verify detail (`/verify/:id`).** Walked all three verdict tones using seeded data
(id 1 PASS, id 2 REVIEW with a "Resolved by Sonnet" note, id 3 FAIL — the title-case warning,
Jenny's real catch). Checklist rows, evidence text, and the warning's own "Detected on the
label" / "What TTB requires" column framing all render clearly, large type, high contrast.
Found: no way back to `/` except the browser's own Back button — fixed. Not-found state
(bad id): plain message, one clear link back, real 404 status.

**Review queue (`/review-queue`, `/review-queue/:id`).** List: one seeded REVIEW item,
"Refresh" control, reason headline in bold review-amber. Detail: Sonnet's suggestion box,
per-field comparison, Approve/Reject as the two largest, most prominent controls on the page
(TH-R3 — no dead actions: confirmed the buttons are hidden entirely once an item is already
resolved, not shown disabled). Found: no way back to `/` (list) or to `/review-queue` (detail)
except browser Back — fixed on both.

**Batch (`/batch`, `/batch/:id`).** Upload: three file inputs, "Preview batch" the one filled
control. Progress/results: live-summary stat grid, results table with Label/Brand/ABV/Net/
Warning/Status columns per PRD §5, matching icon vocabulary to the single-label checklist.
Confirmed at a 400px viewport: the results table scrolls inside its own container
(`document.body.scrollWidth === window.innerWidth`, measured 400 === 400) — the page itself
never scrolls horizontally, exactly PRD §5's requirement, not just eyeballed. Found: the
"Auto-verified" stat's caveat line also read "needs a closer look" (fixed); no way back
anywhere on this page (fixed, placed at the TOP — see below for why this one screen differs
from the other four).

**Dark mode.** Walked the full set above a second time with `prefers-color-scheme: dark`
forced in the browser context. This is where the most serious finding turned up (below) —
every primary/filled button (Verify, Preview batch, Start batch, Approve) was genuinely hard
to read.

**Keyboard/focus.** First Tab from page load lands on the first real control; the focus ring
renders solid, 3px, `#2491ff` — matches `globals.css`'s own `:focus-visible` rule.

### Findings and fixes

**1. Dark-mode filled buttons: real WCAG AA contrast failure, measured, not eyeballed
(`src/app/globals.css`).** `.primary-button` (Verify, Preview batch, Start batch, Approve —
the one primary action on five different screens) sets white text on `var(--color-primary)`.
In dark mode that variable is `#7fb3ff`, a light blue chosen for *text* legibility on the dark
page (links, `.secondary-button`'s outline). White text on top of it as a solid fill measures
**2.14:1** — WCAG AA needs 4.5:1 for normal text; this misses by more than half. Confirmed
visually (screenshot) and by `getComputedStyle` in a live Chromium render, not just computed
from the CSS source.

Fix: a new pair of tokens, `--color-button-bg` / `--color-button-bg-hover`, used only by
`.primary-button`. Light mode reuses the exact existing values (pixel-identical to before).
Dark mode uses `#3468ad` / `#2a5490` — chosen by solving for two constraints at once: white
text on top stays ≥4.5:1 (measured **5.63:1** resting, **7.58:1** hover), and the fill itself
stays ≥3:1 against the dark page background (measured **3.26:1**) so the button still reads as
a distinct shape, not one that blends into the page.

**2. `.secondary-button` had no `align-self: flex-start` — stretched full-width inside any
flex-column ancestor with no `align-items` override of its own (`src/app/globals.css`).**
`.primary-button` already carries this rule, for the identical reason; `.secondary-button` was
the one place it was missing. Observed directly: the verify screen's "Try again" button
(inside `.error-panel`, a flex column) rendered 675px wide — the full width of its panel —
instead of content-sized. Same class, same bug, in `BatchProgressBrowser.tsx`'s and
`ReviewQueueBrowser.tsx`'s own "Try again" retry buttons, and in `ResultsChecklist.tsx`'s "See
the label photo and full comparison" link (`.results` is also an unguarded flex column) — not
independently re-screenshotted in those three, but the same deterministic CSS rule, confirmed
once. Fixed by adding `align-self: flex-start` to `.secondary-button`, mirroring
`.primary-button`. Re-measured after the fix: the same button now renders 124px wide (its
panel is still 675px) — content-sized, matching every other secondary button on the site.

**3. Input/box borders: real WCAG 1.4.11 (non-text contrast) failure, measured
(`src/app/globals.css`).** `--color-border` (`#a9aeb1`, USWDS gray-30) measured **2.24:1**
against the page background — below the 3:1 floor for a UI component's own boundary (visible
on every text input, `.batch-stat` box, and `.status-banner`). Dark mode's border cleared 3:1
against the main page background (3.13:1) but not against `--color-bg-alt` (2.74:1). Fixed:
light mode to `#838a90` (3.50:1 / 3.07:1 against the two backgrounds it borders), dark mode to
`#657078` (3.62:1 / 3.17:1) — the smallest shift that clears the floor in every context the
variable is used, not a redesign.

**4. "Needs a closer look" — the vague reason text standing rule 26 already banned, still
present in four real UI-facing strings.** A prior round (see this file's own TRO-461-area
history) fixed the three `AMBIGUOUS_*` reason texts to name what a reviewer must check, but
left the phrase in four places it missed:
- `src/app/page.tsx` — the verify screen's own intro copy.
- `src/app/_components/BatchProgressSummary.tsx` — the "Auto-verified" stat's caveat line.
- `src/server/router/reason-text.ts` — **`WARNING_MISMATCH`'s label-level fallback text.**
  This is the most visible instance: it is the headline banner text on the verify screen after
  a live REVIEW-verdict submission, the review-queue row's own bold headline, the review-queue
  detail page's headline, and the batch results table's Status-column link text — the phrase
  a first-time user sees most often for exactly the review reason PRD §5's own government-
  warning example centers on. Also the generic `NEEDS_REVIEW`-with-no-reason fallback one line
  below it.
- `src/server/warning/reconcile.ts` — the near-miss note's vague trailing clause (the specific
  factual part, "differs by a single character," was already fine — only the "— needs a
  closer look" tail was vague; kept the fact, replaced the tail).

Every replacement reuses this codebase's own already-established "A reviewer must check X"
vocabulary (the same fix the AMBIGUOUS_* round used) rather than inventing new wording. Where
the function genuinely has no field name to name (the generic verdict-only fallback), the
replacement stays honest rather than fabricating specificity it does not have — "A reviewer
must check this field," not a made-up field name. Two test-only fixtures (`DetailView.test.tsx`,
`get-verification-detail.test.ts`) and one shared test-support fixture
(`src/server/resolver/test-support.ts`) also carried the old phrase as sample data, unasserted
elsewhere; updated for consistency, not because a test required it. A code comment in
`BatchProgressSummary.tsx` quoted a paraphrase of this phrase attributed to CP-3 §7.1 — checked
against the actual checkpoint document (`docs/checkpoints/cp3-batch-queue.md` §7.1), which
reads "decided without Sonnet or a human," not "closer look." Corrected the comment to CP-3's
own real wording. `docs/checkpoints/cp2-warning-subsystem.md`'s own decision table (§6.1) also
quotes the old near-miss string verbatim, as CP-2's reviewed record of what LH-020 shipped at
the time — left that file untouched: it is a dated review record, not a living spec, and
CHANGES.md is the right place to record the supersession, not a silent rewrite of what CP-2
actually showed Troy.

**5. Five deep screens had no on-page way back — only the browser's own Back button.**
`/verify/:id`, `/review-queue`, `/review-queue/:id`, `/batch`, and `/batch/:id` all had zero
navigational links once you were on them (confirmed by reading every component on each route,
then confirmed again live). Only each route's own `not-found.tsx` sibling had one. TH-R3's own
quote — "no hunting for buttons" — is about finding the one you want, but a screen with no way
out at all is the same failure in the other direction for anyone who arrived by a bookmark or
a shared link, not by clicking through from `/`.

Fixed by adding one `.secondary-button`-styled link to each, reusing wording already
established elsewhere in this exact codebase rather than inventing new copy:
- `/verify/:id` → "Verify a label" → `/` (same text `not-found.tsx` already uses for this
  route).
- `/review-queue` → "Verify a label" → `/`.
- `/review-queue/:id` → "Back to the review queue" → `/review-queue` (same text that route's
  own `not-found.tsx` already uses).
- `/batch` → "Verify a label" → `/`.
- `/batch/:id` → "Start a batch" → `/batch` (same text that route's own `not-found.tsx`
  already uses).

Placement: bottom of the page, matching `src/app/page.tsx`'s own `.page__nav-links`
convention, for four of the five. `/batch/:id` is the one exception — placed at the TOP,
directly under the heading — because PRD §5 itself says this one results table can run to "a
few hundred rows"; a link only below the table would make a reviewer scroll through all of
them first just to leave. This is a deliberate, screen-specific call, not an inconsistency.

None of these five changes rename, remove, or restructure any existing element — every new
link is a new, additional node. TRO-479 (the concurrent E2E-suite ticket) was told to expect
additive changes like these.

### A new problem found, not fixed here (out of scope)

`tesseract.js`'s Node worker-script path resolution fails under `pnpm dev`'s Turbopack
bundler: `Error: Cannot find module '.../tesseract.js/src/worker-script/node/index.js'`,
logged as an `uncaughtException` during a live `/api/verify` request. This looks like it hangs
the warning comparator's OCR half well past its own intended budget — PRD §3.8 budgets OCR at
~0.5s; the client's own `DEFAULT_TIMEOUT_MS` (`src/app/_lib/verify-client.ts`) is 45s,
"generous above the Haiku extractor's own 30s client timeout," by that file's own comment,
meaning this should not fire under normal conditions. One real submission (golden-set
case-01, correct application fields) did not return within 120 seconds; the dev server log
showed the same module-resolution error three times during that request. No new
`verifications`/`applications` row was written (checked directly against the database), so
this was not merely slow — it did not complete. This blocked a live capture of the
`ResultsChecklist` "happy path" render specifically. Stood in for it: the loading state
(screenshotted), the timeout/service-error message text (captured via `textContent` — "Something
went wrong" / "LabelHunter took too long to respond. Check your connection and try again.", not
separately screenshotted; its `.error-panel` styling is the same class the validation-error
screenshots above already show directly), and the seeded DetailView pages (same CSS/verdict
system as `ResultsChecklist`).

**Not fixed here.** This is a warning-subsystem/OCR pipeline issue (TH-R9, CP-2's own
checkpoint), not a CSS/copy defect — out of this ticket's scope per its own instructions.
**Not verified:** whether this also reproduces under `pnpm build && pnpm start` (the
production mode Render actually runs) — `pnpm build` itself completed cleanly, but a
production build does not exercise this runtime request path, so that is not evidence either
way. Worth its own ticket if it also reproduces in production — it would blow TH-R2's 5-second
budget outright if so.

### Claim provenance

**Observed** (live Chromium render, this worktree's `pnpm dev`, port 3180): every screenshot
cited above; the two contrast fixes' `getComputedStyle` re-checks; the `.secondary-button`
width re-check (124px vs. the panel's 675px); the timeout/service-error message's exact text
(via `textContent`, not a screenshot of that specific state).
**Derived** (computed from the actual `globals.css` custom-property hex values via the WCAG
2.x relative-luminance formula, cross-checked against one live `getComputedStyle` reading per
fixed pair): every contrast ratio number quoted above.
**Not verified:** the tesseract/Turbopack issue under production mode (`next start`); a
directly-observed live render of `ResultsChecklist`'s success state (blocked by the tesseract
issue above; substituted with the seeded DetailView pages, which share its verdict/checklist
CSS).

### How to run it / verify

```bash
source .factory-env
pnpm db:migrate && pnpm db:seed   # only if the worktree DB is empty
PORT=$APP_PORT pnpm dev           # next dev honors PORT directly
```
Visit `/`, `/verify/1`, `/verify/2`, `/verify/3`, `/review-queue`, `/review-queue/1`, `/batch`,
`/batch/1` — light and with the OS/browser set to dark mode. `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm build` all green (`pnpm test`: 135 files, 1503 tests).

### Regression tests

- `src/app/_components/BatchProgressSummary.test.tsx` — asserts the new caveat text and a
  `not.toMatch(/closer look/i)` guard.
- `src/server/router/reason-text.test.ts` — new test sweeps every `ReviewReason` plus the
  null-reason fallback, asserting none produce "closer look" text.
- Confirmed both new/changed assertions fail for the right reason: reverted each source fix
  locally, re-ran the two test files, saw the expected diffs, restored the fix, re-ran green.
- The remaining changed test files (`reconcile.test.ts`, `router/index.test.ts`,
  `warning-golden-cases.test.ts`) update exact-string assertions to match the new copy — the
  full suite catching a stale string was itself the check (it did: `warning-golden-cases.test.ts`
  failed on the first full-suite run after the `reconcile.ts` copy fix, before that file was
  updated).
- The CSS fixes (contrast, layout) have no unit-level regression coverage — this codebase has
  no visual-regression/screenshot test harness yet, and inventing one for two CSS rules would
  be new test infrastructure, not a regression test for existing behavior. The `getComputedStyle`
  re-checks in this entry are the evidence; not a substitute for a real automated check, named
  here rather than left implicit.

### Rollback

`git revert` this ticket's commits on `feat/lh-054-ux-polish-pass`. The three fix groups (CSS —
findings 1-3, copy — finding 4, nav links — finding 5) sit in three separate commits, each
touching a disjoint file set, and revert independently. No schema change, no migration,
nothing to undo outside the app source tree.

## TRO-511 — Single-label REVIEW verdicts now get an automatic resolution trigger (2026-08-12)

**The gap.** `src/app/api/verify/route.ts` inserts a `review_queue` row on every REVIEW
verdict. It never called `resolveEscalatedLabel`. Nothing else in the codebase called that
function outside its own test files. A REVIEW-verdict single-label verification sat with
`resolver_output: NULL` forever. A human could still act on it, but never saw a Sonnet
suggestion — quieter than PRD §5's "Resolved by Sonnet annotations" promise. TRO-474's own
checkpoint doc named this gap and carried it forward as open question 5
(`docs/checkpoints/cp3-batch-queue.md` §9, §12).

**What changed.** `app/api/verify/route.ts` still inserts the `review_queue` row immediately
on a REVIEW verdict — a human sees "needs review" the moment the request returns, unchanged.
The route now ALSO snapshots `{ schemaVersion, extraction, router, flaggedFields }` into a new
`resolverInput` column on that same row, built by `deriveFlaggedFields`/
`buildResolverInputSnapshot` (`src/server/batch-queue/resolver-snapshot.ts`) — the same pure
functions the batch `EXTRACT` worker already uses for `batch_queue_items.resolver_input`. A new
module, `src/server/single-label-resolve/`, claims that row later and calls
`resolveEscalatedLabel` for it, off the request path, in the same background-worker process
`scripts/batch-worker/run.ts` already runs (PRD §3.6 names one worker process, singular).

**The claim query is new; it does not touch `batch_queue_items`.** CP-3 §12 Q5's own
recommendation reads `review_queue WHERE resolver_output IS NULL AND batch job is absent`.
`batch_queue_items.batch_job_id` is `NOT NULL`. Its claim query's own `JOIN batch_jobs ...
WHERE bj.status = 'RUNNING'` is load-bearing for the batch design (CP-3 §3.1). Loosening that
column and rewriting the join would touch shared, already-tested batch-worker infrastructure —
`claim.ts`, `resolve-worker.ts`'s counters, and the escalation cap. The cap is defined in terms
of `batch_jobs.totalCount`, a number a single-label row does not have.

`src/server/single-label-resolve/claim.ts` is a new, small, dedicated claim query against
`review_queue` instead — the same atomic-claim shape as `batch-queue/claim.ts`
(`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, a fresh
`claim_token` on every claim, lease-expiry recovery), applied to a table that already carries
every column this needs once `resolverInput` and six claim/lease columns are added. "Batch job
is absent" turns out to be exactly `resolver_input IS NOT NULL`. Only the verify route ever sets
that column, so a batch-originated row can never satisfy the claim query.

**No escalation cap for single-label rows — not a gap, a non-applicability.** The batch cap
(`batch-queue/escalation-cap.ts`) bounds Sonnet call attempts as a fraction of a batch's
`totalCount`. A single-label verification has no `batch_jobs` row to count against. This ticket
does not reuse that cap with different semantics. It does not invent a second one either. A
single-label REVIEW row gets exactly one Sonnet call attempt, retried on transient failure with
the same backoff the batch path uses — the same one call it always needed.

**`resolveEscalatedLabel` needed a fix for an INSERT-vs-UPDATE collision.**
`resolveEscalatedLabel` always inserted a fresh `review_queue` row. It refused, via
`findExistingReviewQueueEntry`, to touch a row that it did not recognize as a valid prior
resolution. The verify route now pre-files a bare row: reason and `resolverInput` set,
`resolverOutput` still null. Calling `resolveEscalatedLabel` for that row would have hit the
same refusal every time. `findExistingReviewQueueEntry` now returns a
three-state result (`"none"` / `"pending"` / `"resolved"`, `src/server/resolver/queue.ts`) instead
of a nullable single shape. A new `updateReviewQueueEntryResolution` fills in a pending row
instead of inserting a second one. The batch path never produces a `"pending"` row (nothing
writes a bare `review_queue` row for a batch-originated escalation), so this branch is
unreachable from batch code — its own insert-and-throw-on-conflict behavior, and
`resolve-worker.ts`'s existing recovery from that throw, are unchanged.

**How to run it.** `pnpm worker` starts all three worker loops in one process — the existing
batch extract/resolve pools, plus this ticket's single-label resolve worker (concurrency 1 by
default, `SINGLE_LABEL_RESOLVE_WORKER_CONCURRENCY` to change it). No new command; the existing
`pnpm worker` entry point now does more.

**Known limitation, named rather than silently absent.** The batch RESOLVE pool has a
whole-pool rate-limit cooldown (CP-3 §5.3). It stops several concurrent workers from each
re-discovering the same exhausted Sonnet budget on their own. This worker's own per-item backoff
still degrades gracefully on a 429. But at its default concurrency of 1, it has no cooldown to
coordinate, and it does not share the batch RESOLVE pool's cooldown state either. Picture a batch
running at the same time as a single-label REVIEW item, both drawing down the same Sonnet rate
limit. Each backs off on its own, not in coordination with the other. That is a minor
inefficiency, not a spend-safety or correctness gap — the same `maxAttempts` cap still bounds
every retry. Worth revisiting only if this worker's concurrency ever rises well above 1.

**Migration.** `drizzle/migrations/0003_single_label_resolve_trigger.sql` adds `resolverInput`,
`claimedBy`, `claimToken`, `claimedAt`, `leaseExpiresAt`, `availableAt`, `attempts`, `lastError`
to `review_queue`, plus a partial index matching the claim query's own `WHERE` clause. Every new
column is nullable or defaulted — no data migration, no effect on an existing row.

**Regression test.** `src/server/single-label-resolve/worker.test.ts`'s "end to end" case drives
the real `handleVerifyRequest` route to a REVIEW verdict, confirms the resulting `review_queue`
row has `resolverOutput: null` and a populated `resolverInput`, then runs this ticket's worker
against that exact row with a fake Anthropic client and confirms `resolverOutput` gets filled in
on the SAME row. Confirmed to fail for the right reason before this ticket's `route.ts` change
(`resolverInput` stays null, so the claim query finds nothing) — not just a missing-module error.

**Rollback.** Revert this ticket's commits; run `pnpm db:migrate` after reverting to leave the
added `review_queue` columns as harmless, unused nullable columns, or write a down-migration
dropping them. `scripts/batch-worker/run.ts` reverts to two pools. No other shipped behavior
changes — the verify route's response shape and its immediate `review_queue` visibility are
unchanged either way.

## TRO-469 — LH-021: Warning cases in golden set + eval (2026-08-12)

**Investigated first, per the ticket's own instruction.** The golden set already had six
warning-variant cases: title-case (×2), reworded (×2), missing (×2). Each had a real image. The
eval harness already scored `governmentWarning`/`government_warning` accuracy field by field
(TRO-470 / LH-030). Two real gaps remained. First, PRD §3.7's warning-check segmentation
(true-mismatch vs. resolution-suspect) had no code behind it anywhere. Second, two named
golden-set defects from the CP-2 checkpoint walkthrough
(`docs/checkpoints/cp2-warning-subsystem.md` §9.2) were still unfixed. This ticket closes both
gaps.

**PRD §3.7 / CP-2 §8.4's warning-check segmentation, built from scratch.** New file:
`scripts/eval/warning-segmentation.ts`. It exports one pure function, `segmentWarningCheckOutcomes`.
The function sorts every scored case's `government_warning` outcome into CP-2 §8.4's four
classes: clean, true-mismatch, resolution-suspect, not-found. The four classes are mutually
exclusive and exhaustive. The function reports `resolutionSuspect`'s rate — the number that
drives the Haiku→Sonnet upgrade ladder. Three files now wire this in:

- `summary.ts` — `VerdictSummary` and `EvalReportSummary` both gain a `warningSegmentation`
  field.
- `report-validation.ts` — checks the new field's shape, the same way it checks every other
  summary field.
- `check.ts` — prints the segmentation in its console output.

`baseline-compare.ts` deliberately does NOT gate on the new field. PRD §3.7 calls this metric
"a number in CI output, not a judgment call mid-week." It feeds a five-way human decision. It is
not a pass/fail check.

Getting the field's own `reviewReason` to the segmentation function needed real plumbing.
`ActualVerdict.fields` (`verdict-scoring.ts`) used to carry only `{ field, verdict }`. It
dropped the router's own per-field `reviewReason` on the floor. It is now a discriminated union
(`ActualFieldOutcome`, standing rule 19): `reviewReason` is forbidden on `MATCH`/`MISMATCH` and
present on `NEEDS_REVIEW`. Two files thread the real reason through: `cascade-runner.ts` (from
the real response body) and `resolver-rollup.ts` (from the Sonnet-only rollup).

**One deliberate extension beyond CP-2 §8.4's own table, documented in code and here.** §8.4's
table names only `LOW_IMAGE_QUALITY` and `WARNING_MISMATCH` as resolution-suspect reasons. It
builds this list from §6.1's table, and §6.1 only covers what `WarningComparatorResult` (the
comparator's own return type) can produce. But `resolveGovernmentWarningField`
(`src/server/router/field-resolution.ts`) has two more real paths outside the comparator:
`overrideRejected` maps to `CONFLICTING_EXTRACTION`, and a defensive no-comparator-result
fallback maps to `LOW_MODEL_CONFIDENCE`. CP-2 §6.2 already names both as values the comparator's
own union cannot return. Their absence from §8.4's table is that same fact, not a fresh
decision. Both mean exactly what resolution-suspect means: the check ran, and it could not
confidently resolve one way or the other. `warning-segmentation.ts`'s `RESOLUTION_SUSPECT_REASONS`
set includes all four reasons for this. This decision is flagged here for review, not buried in
a comment nobody reads.

**A second, unplanned finding, from running this ticket's own real `--live --full` sweep — not
a hypothetical.** The first live run crashed. A real response carried
`{ field: "brand_name", verdict: "NEEDS_REVIEW", reviewReason: null }`. This ticket's first
draft assumed that shape was impossible, and threw an error on it. The shape is real and
deliberate. `resolveGovernmentWarningField` and `resolveComparatorField` both suppress a
redundant `MISSING_REQUIRED_FIELD` on one condition: the field is absent and required, and the
label already carries a `LOW_IMAGE_QUALITY` blocker. CP-1 §5.3 states the reason for this
carve-out directly: "LOW_IMAGE_QUALITY already explains the whole label." The router does not
accuse a photo of causing a violation twice. The fix: loosen `ActualFieldOutcome`'s
`NEEDS_REVIEW` branch to `reviewReason: ReviewReason | null`. This type now matches
`FieldResultRow`'s own real, looser invariant. The fix also classifies a null reason as
resolution-suspect, because that state is definitionally tied to `LOW_IMAGE_QUALITY` by the
router's own condition — it belongs in the same class. A real run finds this kind of thing; a
synthetic fixture cannot. See `verdict-scoring.ts`'s and `warning-segmentation.ts`'s own doc
comments for the full trace, and this ticket's own report for a plain-language version.

**Golden-set corrections — CP-2 §9.2 findings 1 and 2, recommended at the checkpoint,
implemented here.** Neither fix touches the comparator. Both are ground-truth data fixes, this
ticket's own territory.

- **Finding 1.** Cases 23/24 (tiny warning text) expected a label-level `reviewReason` of
  `LOW_MODEL_CONFIDENCE`. `WarningComparatorResult` can only return `WARNING_MISMATCH`,
  `LOW_IMAGE_QUALITY`, or `MISSING_REQUIRED_FIELD`. The manifest asked for a value the system
  could never produce. Fixed: corrected to `LOW_IMAGE_QUALITY`, CP-2's own recommendation. Tiny
  print is an image-resolution problem — that is the honest name for it.
- **Finding 2.** Case-09's field-level reason text said "the wording must match the statute
  exactly." That implies a wording failure. With case folded, this case's body is a genuine
  exact match (distance 0). The real failure is capitalization, not wording. This is confirmed
  by `src/server/warning/golden-case.test.ts`'s own existing assertion on this case's `note`
  string. Fixed: reworded to name the capitalization rule.

**Two new golden-set cases — CP-2 §9.2 findings 4 and 5, and §11 open question 9.** Both are
TTB-documented real mistakes (§2.6), not invented ones. Both render through the existing
pipeline (`pnpm golden:build`); neither is hand-crafted.

- `case-31-title-case-warning-surgeon-general-lowercase` (finding 5): the warning body prints
  `surgeon general` in lower case; the `GOVERNMENT WARNING` prefix stays all-caps. No case
  exercised the `Surgeon`/`General` capitalization positions before this. CP-2 §5.4 added those
  positions on TTB's own checklist authority. This case MISMATCHes on capitalization against
  the real comparator.
- `case-32-reworded-warning-near-miss-missing-comma` (finding 4): the warning omits the comma
  after `General` — a genuine one-character deviation. No case exercised CP-2 §5.5's proposed
  near-miss band (edit distance 1–2) before this; the existing reworded-warning cases sit at
  distance 24 and 38. This case routes REVIEW/`WARNING_MISMATCH` against the real comparator.
  The real edit distance (1) and wording classification (`NEAR_MISS`) are computed, not
  asserted by hand.

`scripts/eval/warning-golden-cases.test.ts` verifies both cases' exact defect computationally,
against the real, already-shipped comparator (`reconcileWarningChannels`, `evaluateCandidate` —
imported, never reimplemented). `src/server/warning/golden-case.test.ts` already gives
case-08/09/10/11 this same property. The manifest grew from 29 to 32 cases: TRO-515's
`case-30-clean-match-net-contents-alt-format` (below) landed on `main` first, closing rubric
vector V7; this ticket's two cases are numbered `case-31`/`case-32` to come after it, not
`case-30`/`case-31` as this ticket's own first draft had them.
`loader.test.ts`'s ballpark upper-bound assertion moved from 30 to 32, with a comment citing
why. `golden-set/README.md`'s case-count prose was updated to match.

**The Jenny title-case catch is a named case, at the eval-harness boundary specifically — not
only at the router unit-test layer LH-013 already covers.**
`scripts/eval/warning-golden-cases.test.ts` asserts three things about case-08: it is present
and named "Jenny's catch" in its own manifest notes; it is always included in `args.ts`'s
`DEFAULT_SAMPLE_CASE_IDS`, so a bare `--live` run (no `--full` needed) never skips it; and it
MISMATCHes against the real comparator. Fixing case-23 (Finding 1, above) had one side effect:
`args.ts`'s default sample lost its `LOW_MODEL_CONFIDENCE` exemplar, because case-23 now
duplicates case-17's `LOW_IMAGE_QUALITY` family instead. The fix: swap case-23 for case-25 in
the default sample. Case-25 (odd-typography) is a genuine `LOW_MODEL_CONFIDENCE` case, via
`brand_name`, unrelated to the warning field. The sample again covers every reviewReason family
it always intended to.

**Tests (all in `pnpm test`, red-first where a fix followed).**
- `scripts/eval/warning-segmentation.test.ts` — new, TDD (written before the implementation
  file existed). Covers every class, the deliberate `CONFLICTING_EXTRACTION`/`LOW_MODEL_CONFIDENCE`
  extension, the null-reviewReason real case, the sum-equals-total invariant, the empty-run
  zero case, and two harness-bug throws (a bogus reviewReason, a missing field score).
- `scripts/eval/warning-golden-cases.test.ts` — new. Covers the case-08 named-case assertions,
  the case-09/23/24 ground-truth corrections, and case-31/32's real, computed verdicts.
- `scripts/eval/verdict-scoring.test.ts` — extended. Covers `actualReviewReason` threading,
  including the real null-on-NEEDS_REVIEW case.
- `scripts/eval/summary.test.ts`, `scripts/eval/report-validation.test.ts`,
  `scripts/eval/baseline-compare.test.ts` — extended for the new `warningSegmentation` field.
- `src/lib/golden-set/loader.test.ts` — the manifest case-count ballpark moved from 30 to 32,
  with a citation.

**How to run it.**
1. `pnpm test` runs every test above.
2. `pnpm typecheck` and `pnpm lint` both pass.
3. `pnpm golden:build` renders every case, including the two new ones (already committed).
4. `pnpm golden:verify` checks all 32 cases: zero known gaps, zero problems found.
5. `pnpm eval:check -- --live --full --update-baseline` re-runs the whole golden set for real
   and refreshes the committed baseline.
6. Plain `pnpm eval:check` (cheap mode — what the gate runs) reads that baseline back with no
   live call.

**Measured — real, live run against the full 32-case golden set, today, after the TRO-515
merge below.** Extraction accuracy: 96.3% (154/160). Label-verdict accuracy: 65.6% (21/32).
Review-reason accuracy: 35.7% (5/14). Warning-check segmentation, of 32 cases: clean 65.6%
(21), true-mismatch 15.6% (5), **resolution-suspect 12.5% (4)**, not-found 6.3% (2). The four
counts sum to 32, as CP-2 §8.4 requires. Total cost: $0.2920. Per PRD §3.7's ladder, a 12.5%
resolution-suspect rate falls in the **10–25%: fix the crop pipeline first** band. It is not
healthy, and it is not yet a model-upgrade signal. This is the first real number behind that
decision. It is reported here as evidence, not acted on — the crop pipeline is not this
ticket's territory. (An earlier run, against this ticket's own pre-merge 31-case branch state,
measured 95.5%/67.7%/35.7% and a 12.9% resolution-suspect rate — materially the same picture;
superseded by the number above, the real one behind the committed baseline.)

**Not done here (explicitly out of scope, named so they don't read as gaps).**
- **The single-channel PASS rate** (CP-2 §8.4/§11 Q10 — "the residual false-PASS exposure").
  This needs the comparator to expose which channel or channels decided a verdict. That means a
  new field on `WarningComparatorResult`/`FieldResultRow` — comparator-shape territory this
  ticket was told not to touch. It is a real, separate, follow-on gap against LH-020/LH-012.
- **The real label-verdict/reviewReason accuracy numbers measured above are not this ticket's
  to fix.** Eleven cases scored "verdict WRONG" this run: case-11, 15, 17, 19, 21, 23–26, 28,
  29. This reflects real comparator/router accuracy, out of this ticket's scope (data and eval
  wiring only). It is reported honestly here, not hidden or softened. One case (case-17) flips
  between runs — the pre-merge run scored it correct, this run does not, with no code change to
  explain it. This is real call-to-call model variance, not a harness bug (`check.ts`'s cascade
  makes one real, non-deterministic Haiku call per case every time it runs).
- `scripts/eval/results/benchmark-report.json` is not refreshed. `resolver-rollup.ts`'s change
  was smoke-tested live, via `pnpm eval:benchmark -- --case=case-08-...`; both arms produced a
  correct `ActualFieldOutcome` shape. The full paid `--full` sweep was not re-run — it is not
  this ticket's deliverable.
- `docs/approach.md` (LH-064, blocked by LH-030 **and** LH-031, neither this ticket) is where
  CP-2 §9.2 finding 3 belongs in the write-up: no image can exercise channel disagreement, and
  LH-020's own unit tests already cover it there. Not created here.

**Rollback.** `git revert` this ticket's commits on `feat/lh-021-warning-golden-eval`. The
revert restores the pre-TRO-469 golden set: TRO-515's 30 cases (case-31/32 and the
LOW_MODEL_CONFIDENCE/wording-reason defect fixes go away; TRO-515's own case-30 is untouched,
it lands from a separate ticket). It removes `scripts/eval/warning-segmentation.ts` and its
wiring, and reverts `ActualVerdict`'s field shape. `scripts/eval/results/eval-report.json` and
`scripts/eval/baseline.json` revert to their pre-ticket committed values along with the code. If
a fresh baseline under the old code is needed instead of the reverted commit's own, re-run
`pnpm eval:check -- --live --full --update-baseline` after reverting.

## TRO-513 — Fix the flaky "Old Tom Distillery" fixture in route.test.ts (2026-08-12)

**What changed.** This fix has two parts. The ticket's own description bundled two
different problems into one.

**Problem 1: shared fixture text.** Nine test files write real `applications` rows with
the literal brand name `"Old Tom Distillery"`. That text is TH-R11's canonical example.
`src/app/api/verify/route.test.ts` needs the exact words to get a real comparator
`MATCH` against `WELL_FORMED_EXTRACTION_BODY`. Five of the nine files did not need the
real text at all. Each one inserts a filler row and checks disposition, list membership,
or display shaping — never a comparator match, and every lookup in those five files
already used the row's own generated id, never the brand-name text. Those five files now
default to a new, ticket-scoped name instead. This matches the pattern already used in
`src/server/batch-queue/test-support.ts` and `src/server/review-queue/list.test.ts`:

- `src/app/api/review-queue/test-support.ts` (`makeQueueItemFixture`, shared by both
  `review-queue/route.test.ts` files) → `"TRO-476 Test Fixture"`
- `src/app/api/label-images/[labelImageId]/route.test.ts` → `"TRO-466 Test Fixture"`
- `src/server/review-queue/get-item.test.ts` → `"TRO-476 Test Fixture"`
- `src/server/review-queue/record-disposition.test.ts` → `"TRO-476 Test Fixture"`
- `src/server/verification-detail/get-verification-detail.test.ts` → `"TRO-466 Test Fixture"`

Each new name matches the file's own origin ticket — the same convention already used
safely in its sibling files. `route.test.ts`'s own default stays `"Old Tom Distillery"`,
the one fixture in the whole suite that still needs the real text, because it is the one
place a real comparator runs against it. TH-R11's coverage is not incidental test data.
The ticket's own brief is explicit here: do not remove it, and do not rename it out of
the suite.

**Problem 2: the actual reproducible cause.** Checking all nine files found only two
places that looked a row up by brand-name VALUE, instead of by its own generated id. Both
are in `route.test.ts`. TRO-514 and TRO-478 already fixed both, before this ticket
started. No live value-collision remained to fix. But the flake kept recurring after
those fixes landed. A value-collision explanation does not fit that fact on its own.
`factory/config.yaml`'s own `knownLimits` note, written at scaffold time, already named
the real suspect. It flagged concurrent, cross-worktree gate runs as untested. The
sibling "ship" factory's own experience says that is exactly where load-sensitive flakes
cluster.

Measured directly: one worktree's full `pnpm test` run opens 17 separate `pg.Pool`
instances, not one. `src/lib/db/index.ts`'s `globalThis` guard is real. It only dedupes
calls to `getPool()` WITHIN one process. Vitest's default pool setting, "forks", isolates
every test file into its own forked process. A "singleton" pool in the source code still
becomes 17 independent pools at runtime — one pool per fork. Every worktree shares one
Postgres server. Its 17 pools compete for the same server-wide `max_connections` limit
(100 on a default local install) as every other worktree's own test run. Under real
connection pressure, Postgres can refuse one pool's connection attempt. Its own error
says so directly: `sorry, too many clients already`. This failure lands on whatever test
is running a query at that moment. It clears on a standalone re-run, because a standalone
run only ever opens one pool. This matches the bug's own signature exactly.

Two changes close this gap:
- `vitest.config.ts` sets `maxWorkers: 4`. This bounds how many forked processes — and so
  how many pools — one `pnpm test` run can open at once. An unbounded run scales with the
  host's CPU count instead.
- `src/lib/db/index.ts` drops the pool's `max` from pg's default of 10 to 5, but only
  under a real Vitest run (`process.env.VITEST`, Vitest's own signal). The live Next.js
  server and `scripts/batch-worker/run.ts` each run as one long-lived process with one
  pool. Neither one hits the per-process multiplication a test run does, so production
  keeps pg's own default capacity untouched (local review round 1).

Combined worst case: 4 pools × 5 connections = 20 per worktree, down from an unbounded
17 × 10 = 170. Nothing in this fix caps how many worktrees actually run at once — the
factory's own concurrency limit, if any, lives elsewhere. As one illustration only: four
worktrees running full suites at the same moment would now draw at most 80 of the shared
100 connections, comfortable headroom, against the old numbers' 680, which left none.

**Evidence.**

| Check | Result | Ran under |
|---|---|---|
| Reproduce, before the fix | 0 failures | 4 concurrent full suites, same worktree DB, no artificial pressure |
| Reproduce, before the fix | 57 failed tests, 9 files, all `sorry, too many clients already` | Full suite while a throwaway script held 96 of 100 server-wide connection slots |
| After the fix, same pressure | 5–21 failed tests across two separate runs, 3–4 files, same error class both times | Full suite while the same script held 96 of 100 slots, run twice |
| After the fix, realistic load | 0 failures, across two separate batches of 3 concurrent runs each (6 runs total) | Concurrent full suites (`--maxWorkers=4`), same worktree DB, simulating concurrent worktree gates |
| Full suite, repeated | 0 failures, every run | `pnpm test`, run standalone 4 separate times after the fix |
| `pnpm typecheck` | clean | — |

**Observed:** the exact Postgres error (`53300`, `sorry, too many clients already`)
reproduced repeatedly under engineered connection pressure, on this ticket's own worktree
database — once before the fix, twice after, on two separate runs at the same artificial
pressure. The "before" run used the unmodified pool config. The only change was one
instrumentation line that added a log write and nothing else. The fix cut the failure
count by 63–91% under that same artificial pressure (96% of server capacity held by
something else), varying by run. That pressure level is a deliberately extreme stress
test. The range is not a claim of one fixed, exactly-reproducible number — this class of
bug is inherently timing-dependent. Under no artificial pressure at all, simulating the
realistic condition this ticket actually cares about (several worktrees' gates running
at once), the fix produced zero failures across six separate concurrent-suite runs.

**Derived:** the connection-pool mechanism is the actively firing cause on this branch
today, not the shared literal by itself. The two historical value-collision sites were
already closed before this ticket started. The flake still recurred after that. The
fixture-text change closes a real risk, but a latent one today: a future test that
queries by that shared value would reopen it. It is not, by itself, an independently
reproducible cause of the current flake.

**Not verified:** the precise number of concurrently-running worktrees needed to trigger
this organically, without an artificial connection hog, in the real factory environment.
This machine had comfortable headroom: 4 concurrent full suites alone, with no other
pressure, did not reproduce a failure, either before or after the fix. The mechanism is
proven. The exact real-world trigger threshold is not measured.

**Regression test.** `src/lib/db/index.test.ts` (new file) asserts the pool's own `max`
stays at or below 5, under this file's own real Vitest run. It failed for the right
reason before the fix (`expected 10 to be less than or equal to 5`, pg's default with
`max` unset). It passed after the fix. Both runs were standalone.

**How to run it.** Source `.factory-env` first. Every file this ticket touches writes to
a real Postgres database. `pnpm test` runs the whole suite. `pnpm test --
src/lib/db/index.test.ts` runs just the new regression test.

**Rollback.** `git revert` this ticket's commits. `vitest.config.ts`'s `maxWorkers`
returns to unbounded. `src/lib/db/index.ts`'s pool `max` returns to pg's default of 10.
The five fixture files return to writing `"Old Tom Distillery"`. Rolling back also
restores the pre-TRO-513 flake risk.

## TRO-481 — LH-060: Render deploy config (2026-08-12)

**What changed.** This ticket builds the deploy config that PRD §3.6 and §8
describe. `render.yaml`, at the repo root, wires three resources: a `web`
service (the Next.js app), a `worker` service (the batch worker —
LH-041/TRO-474's `scripts/batch-worker/run.ts`), and a Postgres database.
All three deploy from `main`. This advances TH-R16 — a deployed URL an
evaluator can open and test.

This ticket does not create a live deployment. Troy must still give Render
his real Anthropic key by hand. Deploying that key to a third-party platform
is a hard stop — the factory does not do this on its own
(`.claude/skills/labelhunter-factory/references/escalation.md`, item 4).
Instead, this ticket builds the config for Troy's own first deploy — no
further code change needed — plus the runbook for that manual step
(`docs/deploy.md`).

**Design decisions.**
- Every secret (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`) is `sync: false`.
  This is Render's own convention: the operator fills the value in by hand,
  once, in the dashboard. Neither key, nor a placeholder shaped like one,
  appears anywhere in `render.yaml`.
- `DATABASE_URL` is wired through `fromDatabase`, never a literal connection
  string.
- Migrations run as a `preDeployCommand` on the web service only
  (`pnpm db:migrate`) — Render's release-phase hook: it runs after build,
  before the new code starts serving traffic. Not duplicated on the worker:
  running the same migration from two services on one deploy risks a race
  between them.
- The worker's `buildCommand` skips `pnpm build`. It runs
  `scripts/batch-worker/run.ts` directly through `tsx`, never the Next.js
  build output, so building it would spend build minutes on nothing.
- The worker's pool-size env vars (`BATCH_WORKER_CONCURRENCY`,
  `BATCH_RESOLVE_WORKER_CONCURRENCY`, `BATCH_WORKER_SHUTDOWN_TIMEOUT_MS`)
  are plain, non-secret env vars, set to `run.ts`'s own in-code defaults.
  That file's own header comment names this as the intended lever for
  tuning the pools with no redeploy, once the real deployed key's
  rate-limit tier is known.
- Every resource defaults to a paid plan tier (`starter` / `starter` /
  `basic-256mb`), not free. Render has no free-tier option for `type:
  worker` services at all. A free Postgres database also auto-deletes 30
  days after creation — a real risk for a submission evaluators may revisit
  past that window. `render.yaml`'s own comment and `docs/deploy.md` both
  flag this as a default, not a Troy-confirmed budget decision.
- `autoDeployTrigger: checksPass`: Render will not deploy a commit until its
  GitHub Actions checks (`.github/workflows/ci.yml`) pass. This is the same
  green-CI bar this repo's merge policy already requires, applied a second
  time at the deploy step.

**Flagged, not fixed: batch image storage does not survive the web/worker
split.** `src/server/storage/local-file-storage.ts`'s own header comment
already names local disk as "a prototype-appropriate stand-in, not a
durable object store." `POST /api/batch/start` (LH-042/TRO-475, merged to
`main` after this branch started) saves a batch's images this way, on the
`web` service. The `worker` service (`extract-worker.ts`, `resolve-worker.ts`)
reads them back the same way. Once both are real, separate Render services —
exactly what this ticket wires up — they are two different disks. A real
batch run will fail to read every image it queues. Single-label verify is
unaffected: one process saves the image and, later, reads that same file
back. This needs a shared or durable store before batch is real on Render.
Documented in `docs/deploy.md`'s "Known limitations." Not fixed here — out
of this ticket's scope, and it touches application code this ticket does
not own.

**Flagged, not fixed: no deploy-ordering guarantee between the migration
and the worker.** Render deploys `labelhunter-web` and `labelhunter-worker`
independently, so nothing guarantees the web service's `preDeployCommand`
finishes migrating before the worker starts polling. Render's Blueprint
spec has no documented field for cross-service deploy ordering — this
ticket did not omit a setting; Render does not currently offer one. Only a
deploy that adds a migration is exposed, and `run.ts`'s own error handling
does not crash the worker on one failed claim. Documented in
`docs/deploy.md`'s "Known limitations." Closing it needs either a
Render-wide migration step or a worker-side readiness check; neither is
built here.

**Regression test.** `scripts/deploy/render-yaml.test.ts` (23 cases) parses
`render.yaml` with `js-yaml` and checks its real structure: exactly one
`web` service, one `worker` service, and one database named
`labelhunter-db`; both services redeploy only after CI checks pass
(`autoDeployTrigger: checksPass`); every build, start, and migrate command
matches a real `package.json` script (a drift between the two files fails
this test); `DATABASE_URL` references that same database resource, by name
and by connection property; every secret-shaped env var is `sync: false`
with no literal `value`; and the file's raw text contains no string shaped
like a real Anthropic key. Confirmed failing for the right reason:
temporarily hardcoding a fake `sk-ant-...` value in place of `sync: false`
failed 3 cases — the two structural secret checks and the raw-text scan,
all naming the injected value — before the fix was reverted.

**How to run it.** `pnpm test -- scripts/deploy/render-yaml.test.ts` runs
the regression suite. It needs no `DATABASE_URL` — it only reads
`render.yaml` and `package.json` from disk. `pnpm typecheck` and `pnpm lint`
both run clean across the whole repo.

**Observed.** `pnpm install --frozen-lockfile && pnpm build` — the web
service's exact `buildCommand` — exits 0. `PORT=3791 pnpm start` — the web
service's exact `startCommand`; `APP_PORT` from `.factory-env` stands in for
Render's own injected `PORT` — serves `GET /api/health` at HTTP 200 with
`{"status":"ok", ...}`, and `GET /` at HTTP 200. `pnpm worker` — the
worker's exact `startCommand` — starts both pools with zero errors across
several 2-second poll cycles against this worktree's real database, then
shuts down cleanly on `SIGTERM` ("stopped cleanly", matching `run.ts`'s own
shutdown log).

**Derived.** `render.yaml`'s field names and service types match Render's
currently-documented Blueprint spec (`services[].type`: `web` / `worker` /
`pserv` / `cron` / `keyvalue`; `runtime: node`; `envVars[].sync` /
`fromDatabase`; `databases[].plan`), and its free-tier and Postgres-expiry
behavior, both checked against Render's own docs during this ticket, not
recalled from memory.

**Not verified.** A real Render deployment. No Render account was available
to this ticket — that is Troy's own step, documented in `docs/deploy.md`.

**Rollback.** `git revert` this ticket's commits. This deletes `render.yaml`,
`docs/deploy.md`, and `scripts/deploy/render-yaml.test.ts`, and drops the
`js-yaml` / `@types/js-yaml` devDependencies (run `pnpm install` after
reverting, to sync `node_modules`). No other file in the repo references
any of these three, so nothing else breaks.

## TRO-515 — Golden set: rubric vector V7 (net-contents format match) has zero coverage (2026-08-12)

**What changed.** `golden-set/manifest.json` gains one new case:
`case-30-clean-match-net-contents-alt-format`. Its label prints net contents as `750ml` — no
space, lowercase unit. Its application states the same quantity as `750 mL`, the structured,
canonical form the eval harness always synthesizes from `netContentsValue` + `netContentsUnit`.
Every other field matches `case-01-clean-match-spirits` exactly, so the format difference is
the case's one isolated variable — the same pattern `case-04-clean-match-spirits-alt-format`
already uses for V6's ABV format difference. Expected verdict: MATCH, per `audit/rubric.md`
Appendix A's V7 definition. Checked against the real comparator, not just asserted:
`src/server/comparators/net-contents.ts`'s `parseNetContents` reads `750ml` and `750 mL` as the
identical `{ value: 750, unit: "ml" }` — the normalizer lowercases and trims whitespace before
matching a unit, so spacing and case never affect the result.

`scripts/golden/verify.ts`'s `KNOWN_VECTOR_GAPS` no longer lists V7 — it is now an empty set.
The check is symmetric (LH-006/TRO-499): a manifest that covers a tracked vector without the
tracking entry being removed fails `vector-coverage-drift`. Adding the case without removing
the entry would fail the same way, checked directly (see Evidence below) before the entry was
removed. Both changes land in this one PR.

**Closing the gap broke five tests, not just two.** Two tests check the real committed manifest
directly: `verify.test.ts`'s "the real committed golden set" block, and `loader.test.ts`'s
vector-coverage test. Both now expect zero remaining gaps instead of `["V7"]`.

Three more tests broke for a less obvious reason. They build a synthetic fixture and use V7 as
a worked example of "a tracked gap." `KNOWN_VECTOR_GAPS` is a private, hardcoded constant, so
these tests had no way to supply their own example vector. Once the real constant went empty,
V7 stopped being a gap, and the tests had nothing left to demonstrate.

Rather than delete tests that prove the drift check works, `VerifyOptions` gained a new
optional field, `knownVectorGaps`. `main()` (the CLI entry point) never sets it, so a real
`pnpm golden:verify` run still checks the manifest against the real `KNOWN_VECTOR_GAPS`. The
three mechanism tests now pass `knownVectorGaps: new Set(["V7"])` directly. They no longer
depend on which vector, if any, is a genuine gap in the committed manifest.

Two more tests needed the same fix for an unrelated reason. Both build their fixture from
`validManifestCases()`, which always leaves V7 uncovered by construction, and both assert
`report.problems` comes back completely empty: an ai-generated "passes" case, and a
rendered+ai-backdrop "passes" case. Both get the same `knownVectorGaps` override.

`golden-set/README.md`'s known-gap note is rewritten: V7 is closed; V10 remains the one
property that stays manifest-wide, not per-case. Image count and total size move from 29 /
about 1.08 MB to 30 / about 1.14 MB (measured: `du -sh golden-set/images/` after a fresh `pnpm
golden:build`), and the clean-match category count moves from 4 to 5.

**New regression coverage.** `src/lib/golden-set/loader.test.ts` gains one new test —
"includes the net-contents format-variant case required by rubric vector V7 (TRO-515)" — that
finds the new case by ID, checks its label and application values differ only in format, and
checks its expected `netContents` verdict is MATCH. Confirmed red for the right reason first:
loaded the pre-ticket manifest directly (`git show HEAD:golden-set/manifest.json`) through the
real loader and re-ran the same assertion — 29 cases, no `case-30-...` entry, V7 not in the
covered-vectors set. `scripts/golden/verify.test.ts` gains one new test covering the DEFAULT
(no-override) path with a fixture that has no genuine gap, proving the empty-`KNOWN_VECTOR_GAPS`
case reports cleanly.

**Files.**
- `golden-set/manifest.json` — new case-30, appended after case-29.
- `golden-set/images/case-30-clean-match-net-contents-alt-format.jpg` — rendered through
  `pnpm golden:build` (Playwright/Chromium, the existing render pipeline), not hand-crafted.
  Every one of the other 29 committed images came out byte-identical from the same build run
  (`git diff --stat golden-set/images/` showed zero changes to any tracked file) — the
  pipeline's determinism claim, checked here, not assumed.
- `scripts/golden/verify.ts` — `KNOWN_VECTOR_GAPS` now empty; `VerifyOptions` gained
  `knownVectorGaps` as a test-only override.
- `scripts/golden/verify.test.ts` — 3 existing tests updated to pass `knownVectorGaps`
  explicitly; 2 more `validManifestCases()`-based "passes" tests get the same override for the
  unrelated fixture reason above; the real-committed-golden-set test now expects zero known
  gaps; 1 new test for the default (no-override) path.
- `src/lib/golden-set/loader.test.ts` — the "8 of 10 vectors" test becomes "9 of 10" (V10
  only); 1 new test for the case-30 shape.
- `golden-set/README.md` — known-gap section rewritten; image count/size and clean-match
  category count updated to the measured current values.

**Evidence.**
- `pnpm golden:verify`, case-30 added and rendered but `KNOWN_VECTOR_GAPS` not yet touched:
  `FAIL: 1 problem(s) found. [vector-coverage-drift] V7 is now covered by at least one case,
  but scripts/golden/verify.ts still lists it in KNOWN_VECTOR_GAPS — remove it there (and
  update golden-set/README.md's gap note) in this change.` The symmetric check, firing exactly
  as LH-006/TRO-499 designed it to.
- `pnpm golden:verify` after removing V7 from `KNOWN_VECTOR_GAPS`: `PASS: golden set is
  consistent.` Zero problems, zero known gaps reported.
- `pnpm test -- scripts/golden/ src/lib/golden-set/ scripts/eval/`: 278 tests, all green.
- `pnpm typecheck`: clean.

**How to run it.** `source .factory-env` first. `pnpm golden:verify` for the gate check itself;
`pnpm test -- scripts/golden/ src/lib/golden-set/` for the full test suite covering this
change; `pnpm golden:build` regenerates `golden-set/images/` from the manifest (deterministic,
no network call) if an image is ever lost or needs rebuilding.

**Rollback.** `git revert` this change's commit(s). `golden-set/manifest.json` drops case-30 —
also delete `golden-set/images/case-30-clean-match-net-contents-alt-format.jpg` by hand if the
revert leaves it behind (it is a new file, not a modified one, so reverting the commit that
added it removes it in the normal case). Restore the `["V7"]` entry in `scripts/golden/
verify.ts`'s `KNOWN_VECTOR_GAPS` in the same revert: a manifest without the case, combined with
an empty `KNOWN_VECTOR_GAPS`, fails `vector-coverage` instead of passing clean.

## TRO-475 — LH-042: batch progress + results UI (2026-08-12)

**What changed.** This ticket builds the two screens PRD §5 names: "manifest upload → pairing
preview → run → live progress summary → results table." `/batch` uploads a CSV manifest and
label images, previews the pairing, and starts the batch. `/batch/:id` polls the batch live
and shows the results table.

**The missing connection.** LH-040's preview endpoint never started a job. LH-041's queue and
worker pool had no caller yet. Both said so in their own file comments. `POST /api/batch/start`
(`src/app/api/batch/start/route.ts`) is that caller. It re-parses the same manifest-and-images
upload `POST /api/batch/preview` accepts. It resolves real image bytes for every matched
pairing, including — for the first time — real bytes pulled out of a zip
(`src/server/batch-start/extract-zip-bytes.ts`). The preview step never decompresses a zip
entry, by design; this ticket is the first that needs the real bytes, not just a filename and a
declared size. `startBatchFromPairings` (`src/server/batch-start/start-batch.ts`) then creates
`applications` and `label_images` rows, and calls LH-041's own `enqueueExtractItems` and
`startBatchJob`, untouched. One unreadable image skips only that label. It never fails the whole
batch. If every image in a batch is unreadable, the batch is marked `FAILED` outright — never
left `RUNNING` with nothing in it, forever.

**The polling endpoint.** `GET /api/batch/:batchJobId` (`src/app/api/batch/[batchJobId]/route.ts`)
reads a live summary straight off `batch_jobs`, `batch_queue_items`, and `verifications` — no
separate cached counters of its own. The counts match PRD §3.5's own words: processed,
auto-verified, resolved-by-Sonnet, needs-human, plus average and p95 latency computed from each
label's own claim-to-done gap (`src/lib/utils/latency-stats.ts`). CP-3 §7.1 flags that
"auto-verified" bundles PASS and FAIL together. The summary shows the real split too, computed
straight from `verifications.verdict`, so a batch with real compliance problems never reads as
though everything passed.

**The results table.** Label / Brand / ABV / Net / Warning / Status, one row per label — the
same ✓ / ✗ / ⚠ vocabulary the single-label checklist already uses, for the same four fields
Sarah's own interview quote names one at a time ("Brand name matches? Check. ABV is correct?
Check. Government warning is there? Check."). A row with a finished verdict links to the
existing single-label detail view (`/verify/:verificationId`). A still-queued, processing, or
failed row links nowhere — there is nothing to open yet.

**The four batch-scoped designed states (TH-R20), all real and tested, not just described:**
- Malformed CSV / malformed zip — the upload screen shows the exact plain-English error the
  preview endpoint already produces.
- Unpairable rows — unmatched rows, unmatched images, and invalid rows are each listed by name
  and reason on the same screen. Nothing is silently dropped.
- Partial batch failure — the progress screen shows a count, and each failed row's own status
  detail is read straight from `batch_queue_items.last_error` — CP-3 §7.3's own instruction for
  where that text lives.
- Rate-limit backoff notice — LH-041's own backoff state is read, not recomputed. An item
  pushed back to `PENDING`, with `available_at` still in the future and at least one prior
  attempt, means a retry is genuinely scheduled. The notice never names a specific cause. A
  rate limit and any other transient error look identical from the queue rows alone — standing
  rule 12 says uncertain beats wrong.

**How to run it.** Source `.factory-env` first.
`pnpm test -- src/server/batch-start src/server/batch-progress src/app/api/batch src/lib/utils/latency-stats.test.ts src/app/_lib/batch-client.test.ts`
runs this ticket's own suite. `pnpm test` runs the full suite. `pnpm dev`, then open `/batch` to
upload a manifest and images, or open `/` and follow "Start a batch."

**Rollback.** `git revert` this ticket's commits. No schema change — every table this ticket
writes to already existed before it.

**Observed.** Every new server, API, and component file has a red-before-green test. Each test
runs against a real Postgres database or a real DOM render. The full suite passes:
1409 tests across 128 files. `pnpm typecheck`, `pnpm lint`, and `pnpm build`
are all clean.

This ticket's own flow also ran once against a live `pnpm dev` server, over real HTTP with
`curl`. The run posted a real CSV manifest and two real JPEGs to `POST /api/batch/preview`. It
then called `POST /api/batch/start`, which created a real batch job and returned its id.
`GET /api/batch/:id` showed both labels as queued. `/batch` and `/batch/:id` both rendered with
status 200. `/batch/abc` returned 404 for a malformed id. A well-formed but nonexistent id
returned 200 and showed the client-side NOT_FOUND state, not a hard page 404. The test batch job
and its uploaded files were deleted afterward. They never reached this branch's history.

A local CodeRabbit review pass on this ticket's own diff found 9 real issues, all fixed here, not
described and left for later: two real bugs (a stale/overlapping-poll race in
`BatchProgressBrowser.tsx`, and every network failure in `batch-client.ts` showing the timeout
message instead of its own — traced back to a hardcoded `true` two commits up), one accessibility
fix (a `<p>` inside a `<dl>`'s `<div>`, outside the `<dt>`/`<dd>` content model that spec allows),
one real UX gap (changing a file input after previewing left a stale "Start batch" button that
would have submitted a different, unpreviewed upload), and five test-quality findings (an
assertion inside a mock that would have been swallowed as a network error, an anchored regex that
could never match its own target string, three added assertions and one added case tightening
coverage this ticket's own tests already claimed but did not fully prove). See
`factory/review-findings.jsonl` for the full record.

**Not measured.** Real multi-hundred-image batch-start latency — `startBatchFromPairings`
processes matched images sequentially, a deliberate simplicity-over-throughput trade-off stated
in that file's own comment, not benchmarked against this project's 200-300-label scale
reference. A live-browser click-through of the results table into the detail view — this repo's
established convention is HTTP-handler-level and component-level testing, not a live browser.

## TRO-517 — Wire the warning comparator into the batch extract-worker (2026-08-12)

**What changed.** `src/server/batch-queue/extract-worker.ts` now calls LH-020's real warning
comparator on every claimed `EXTRACT` item. The comparator is `compareGovernmentWarningFromImage`
(`src/server/warning`). TH-R9's word-for-word government-warning check is now live for the
batch path. TRO-514 built the same wiring for the single-label route. A compliant warning
contributes to a PASS label verdict. A non-compliant one contributes to a FAIL. The
field-level verdict is now a real answer, not a permanent `NEEDS_REVIEW` placeholder.

**Concurrency (PRD §3.8, CP-2 §4.4 rule 1).** The comparator starts before the Haiku call
resolves, not after. `extract-worker.ts` passes the extraction as a still-pending `Promise`:
`extractionPromise.then((r) => r.government_warning)`. This is the same contract
`compareGovernmentWarningFromImage`'s own file comment documents. Region detection and OCR
now run alongside the Haiku call. They no longer add their own time after it.

**Failure handling (CP-2 §4.4 rule 3).** A REVIEW outcome is the comparator's normal return
value, not a thrown error. A thrown error means a real infrastructure failure.
`resolveWarningOrDegrade` (`extract-worker.ts`) catches the error — a rejected promise or a
synchronous throw, either one. It mirrors TRO-514's own helper of the same name in `route.ts`.
It passes `null` for that one field: the same "uncertain beats wrong" behavior the
single-label route uses. `resolveGovernmentWarningField` already routes a `null` result to
`NEEDS_REVIEW`. It never fabricates a match. The item still completes. The worker marks it
`DONE`. It escalates the item to a `RESOLVE` queue item — the same path any other REVIEW
verdict takes. A warning-check failure degrades one field. It never fails the item. It never
crashes the worker loop.

**Image source (CP-2 §8.3).** The comparator reads `original`, the full-resolution buffer
`readLabelImage` returns. It never reads the resized `haikuVariant`. The resized variant falls
below Tesseract's usable x-height floor at the statute's legal minimum print size (1 mm).

**`ExtractWorkerDeps` changed shape.** `compareGovernmentWarning` replaces the old
`warningResult` field. `warningResult` was a provisional, constructor-injected value. This
worker's own header comment named it temporary: it existed "purely so this ticket's own tests
can exercise the PASS/FAIL/`autoVerifiedCount` code paths without waiting on LH-020." TRO-517
deletes the stand-in. It adds the real function dependency instead. The new field matches
`VerifyRouteDeps.compareGovernmentWarning`'s own DI shape. `defaultDeps()` sets the default to
the real `compareGovernmentWarningFromImage`. `scripts/batch-worker/run.ts` is the production
entry point. It never set `warningResult`. It does not need to set `compareGovernmentWarning`
either. It inherits the real comparator automatically.

**Regression tests.** `src/server/batch-queue/extract-worker.test.ts` gets a new "government
warning wiring" describe block, with 6 cases. Each case failed for the right reason before
this ticket's code existed. Three reasons explain why: a value mismatch against the old
`NEEDS_REVIEW`-only behavior, a `wasCalled`/`capturedOriginalImage` flag proving the
dependency was never called, or a 5-second timeout for the concurrency case. The old code
never called the dependency at all.

- The comparator starts before the Haiku call's own promise resolves. The test proves this: a
  fake Anthropic client holds its response open on a gate that the test controls. The test
  waits for an observable "the comparator was called" signal — never a fixed sleep.
- A compliant warning (`MATCH`) rolls the label verdict up to a clean `PASS`.
- A non-compliant warning (`MISMATCH`) rolls the label verdict up to `FAIL`.
- A comparator that rejects its promise degrades that field to `NEEDS_REVIEW`. The item still
  completes: `outcome.kind` is `"done"`, never `retry` or `failed`.
- A comparator that throws synchronously — before it returns any promise — degrades the field
  the same way.
- The comparator receives the original image, never the resized one. The test proves this
  against an independently recomputed `haikuVariant` buffer built from the same bytes. The two
  buffers are provably different.

Three pre-existing tests changed too. Each one used the deleted `warningResult` literal. Each
now uses the new `compareGovernmentWarning` function instead. The behavior stays the same.
Only the mechanism changes. The PASS test and the FAIL test each now pass
`compareGovernmentWarning: async () => ({ verdict: "MATCH" })`. They used to pass
`warningResult: { verdict: "MATCH" }`. The lost-lease test does the same at both of its two
completion points.

A fourth pre-existing test's comment also changed — not its assertion. The old comment
explained the `government_warning` field's REVIEW result as "LH-020 not yet wired in." That
reason is now false. The field still resolves to REVIEW, but for a different reason:
`makeDeps()`'s default `compareGovernmentWarning` is a deliberately neutral stub. The wiring
itself is not missing.

**How to run it.** Source `.factory-env` first — this suite writes to a real Postgres
database, per this repo's own `DATABASE_URL` discipline. Then run
`pnpm test -- src/server/batch-queue/extract-worker.test.ts`. `pnpm typecheck` and `pnpm lint`
both run clean across the whole repo.

**Not measured.** This entry reports no new latency number. TRO-514's own entry gives the same
reason: a number from before this ticket and a number from after it are not comparable.
Running the batch worker end to end needs a live Anthropic key. That run was out of this
ticket's scope.

**Rollback.** `git revert` this ticket's commits on `feat/wire-warning-into-batch`. The revert
restores `extract-worker.ts`'s old `warningResult: null` behavior. It removes
`compareGovernmentWarning` from `ExtractWorkerDeps`. It restores the old `warningResult` field.

## TRO-474 — PR #26 review: GitHub CodeRabbit, 24 findings, 21 fixed, 3 dismissed (2026-08-12)

**What changed.** GitHub's CodeRabbit reviewed PR #26's full diff — this ticket's whole batch
queue and worker pool — and posted 24 comments, `CHANGES_REQUESTED`. This is a third,
independent pass, after two local CodeRabbit rounds already folded into the branch. Every
finding was checked against the current code and the CP-3 design doc, not taken on faith.
Three were real correctness bugs. Two more looked like bugs but are this design's own stated
intent. The remaining 19 were hardening, test-quality, and documentation findings.

- **A batch's own `enqueueExtractItems` never checked its status.** A caller could enqueue
  `EXTRACT` items into a batch that had already started, finished, or failed. `total_count`
  would climb, but the claim query only ever pulls from a `RUNNING` batch (`claim.ts`). Those
  items would then sit forever, invisible and unprocessed. Added a `FOR UPDATE` lock and a
  `PENDING`-only guard, matching the sequence this module's own comment already stated:
  enqueue while `PENDING`, then `startBatchJob` flips it to `RUNNING`.
- **A worker pool's own error backoff never actually escalated.** `consecutiveErrors` reset
  to 0 right after a successful claim, before `processClaim` had a chance to fail. A
  `processClaim` that throws on every single attempt — a systemic config bug, a dead
  dependency — never saw its backoff grow past the 1-second floor. It hammered the failing
  dependency once a second, forever, instead of backing off toward the 30-second ceiling.
  Moved the reset to after a full claim-and-process cycle completes without throwing.
- **`last_error` stored an upstream SDK error message verbatim, with no length bound.** A
  human reads this column on a dashboard. Nothing capped how much of a raw exception's text
  could land in the database — potentially a large stack dump, or something an upstream
  library should not have included. Added a 2000-character cap in `markFailed`, the single
  place both workers' failures actually get written.

Two findings looked like bugs but are this design's own stated intent, quoted and dismissed
rather than changed. The escalation cap reserves budget on *every* Sonnet attempt, retries
included — CP-3 §6.2 is explicit that this is what keeps the cost bound real, not an
oversight. The backoff delay is deliberately not re-capped after adding jitter — CP-3 §5.2's
own formula, and its own words: the scheduled delay is "not an upper bound on wall-clock
time." Both got a test proving the actual, intentional behavior, not a code change.

The rest closes three more input-validation gaps this ticket had left implicit: `leaseSeconds`,
`WorkerPoolConfig`, and an empty `flaggedFields` snapshot all now reject bad input at the
boundary instead of failing later, confusingly. A redundant image-resize calculation is gone —
the router now reads the dimensions `sharp` actually produced, closing a latent drift risk. A
worker-pool shutdown that could hang forever is now bounded by a configurable timeout. One
comment claimed a type guarantee that was never actually enforced where it claimed; the
comment is now accurate. Nine more findings strengthened tests: real assertions in place of
type casts, silent comments, and loose `.rejects.toThrow()` calls with no argument. One
nitpick — shared JPEG-quality constants — stayed out of scope a third time: the shared value
lives in a module this ticket's own code explicitly does not import from.

Every finding and its fix is recorded in `factory/review-findings.jsonl`.

**How to run it.** Source `.factory-env` first. `pnpm test -- src/server/batch-queue
src/server/resolver/queue.test.ts` runs this ticket's suite — 122 tests across 11 files, all
green (up from 91 before this round). `pnpm test` runs the full suite — 1184 tests, 107 files.

**Rollback.** `git revert` this commit. No schema change this round — the migration and its
own rollback procedure are unchanged from the original TRO-474 entry below.

## TRO-474 — LH-041: job queue + worker pool (2026-08-11)

**What changed.** This ticket builds the batch queue that CP-3 designed: a Postgres-backed
job queue, two worker pools, backoff, and a hard cap on Sonnet spend. It advances TH-R4
(batch upload of 200-300 labels, each processed and reported on its own).

A new table, `batch_queue_items`, holds two logical queues in one place. `EXTRACT` rows
run the Haiku-extract-then-route cascade for one label. `RESOLVE` rows run the Sonnet
resolver for one escalated label. A worker claims a row with one atomic SQL statement
(`FOR UPDATE SKIP LOCKED`). Every claim creates a new `claim_token`, even a reclaim of the
same row. A completion write updates the row only when its `claim_token` still matches.
The write rejects a worker whose lease already expired, even if that worker is still
running. The transaction discards that stale result — it never double-applies one.
`claim.test.ts` and `complete.test.ts` fire ten workers at one row and prove exactly one
wins. They also force a lease to expire mid-claim, and prove the late worker's write
touches nothing.

Two separate worker pools run the two queues. Each pool's size is a configurable default:
5 extract-workers, 2 resolve-workers, both proposed by CP-3 §4.4. An environment variable
overrides either one at startup (`BATCH_WORKER_CONCURRENCY`,
`BATCH_RESOLVE_WORKER_CONCURRENCY`) — never a hard-coded number. A retryable failure (a
429, a 5xx, a network drop) releases its item for a later retry with exponential backoff
and jitter; a non-retryable one (a bad request, a corrupt image) fails the item on the
first try. The worker never sleeps holding a claim — it releases and moves on. A 429 also
opens a short, whole-pool cooldown, so four other workers do not immediately re-discover
the same throttled endpoint.

The Sonnet escalation cap (CP-1's own deferred question, settled by CP-3 §6) reserves one
unit of a batch's call budget before every Sonnet attempt, first try or retry alike — not
after a settled outcome, which an earlier design round found could never trip the cap on a
batch where every attempt happened to fail. Once a batch's budget (25% of its label count,
rounded up) runs out, further escalations skip Sonnet and go straight to the human queue,
recorded as such — never silently dropped, never charged for a call that never happened.

`resolver/queue.ts` gains `insertSkippedReviewQueueEntry` for that skip case, and
`review_queue` gains a `resolver_skip_reason` column so a `NULL` resolver output means
exactly one thing (Sonnet has not run yet) rather than two different things at once.
`batch_jobs` gains `sonnet_call_count`. Both are their own numbered migration
(`drizzle/migrations/0002_batch_queue.sql`).

One bad image fails only that item. `batch_queue_items.last_error` holds the reason. The
batch itself finishes once every item reaches `DONE` or `FAILED`, no matter the mix. A
batch's own `RUNNING` status gates every claim, so no worker can start on a batch that has
not started yet, or one that has already finished.

**TRO-506: the required stopgap, not the full fix.** `resolveEscalatedLabel` can, under
lease expiry, still have two workers reach its own Sonnet call for the same label. The
atomic claim makes this narrow — reachable only when a lease expires while a call is
genuinely still in flight — but not zero. This ticket's resolve-worker catches the
resulting unique-constraint conflict on `review_queue` and completes using the winning
worker's own outcome. The loser reports a real result, not a false failure. The same
catch-and-recover path also handles a second, related race this design adds beyond
TRO-506's own text: two cap-skip attempts, or a cap-skip and a real resolution, landing on
the same row. The `ON CONFLICT DO NOTHING` reservation that would close the TRO-506 window
entirely is a recommended follow-up, not built here. CP-3 §3.3 scopes it out because it
also needs a small, coordinated change to `review-queue/list.ts`, a file this ticket does
not own.

A small worker entry point, `scripts/batch-worker/run.ts` (`pnpm worker`), starts both
pools and runs until `SIGINT`/`SIGTERM`. Wiring it into `render.yaml` is LH-060's job, not
this one's.

**How to run it.** Source `.factory-env` (a factory worktree) or set `DATABASE_URL` yourself
first — every test below writes to a real Postgres database, per this repo's own DATABASE_URL
discipline. Then `pnpm db:migrate` applies the new table and columns.
`pnpm test -- src/server/batch-queue src/server/resolver/queue.test.ts` runs this ticket's
suite (91 new test cases across 11 files — counted from the diff, not estimated). `pnpm worker`
starts a worker process against `DATABASE_URL`; a manual run against a real batch (documented
in this PR) processed one label through both the extractor and the resolver, real Anthropic
calls, in about 16 seconds (04:03:31.003 to 04:03:46.995, observed from `batch_jobs.startedAt`/
`completedAt`).

**Rollback.** Revert this commit, then run `pnpm db:migrate` again on the reverted branch.
Drizzle does not generate a down migration. Once `0002_batch_queue` is applied and
journaled, undoing it is a manual step, in this order (drop the table before its own enum
types — Postgres refuses to drop a type still in use):

```sql
DROP TABLE "batch_queue_items";
DROP TYPE "batch_queue_item_kind";
DROP TYPE "batch_queue_item_status";
ALTER TABLE "batch_jobs" DROP COLUMN "sonnet_call_count";
ALTER TABLE "review_queue" DROP COLUMN "resolver_skip_reason";
```

Dropping `batch_queue_items` also drops its own foreign keys, indexes, and CHECK
constraints — nothing extra to do for those by hand. Dropping the two columns above also
drops their own CHECK constraints (`batch_jobs_sonnet_call_count_bounded`,
`review_queue_resolver_output_skip_reason_exclusive`): Postgres cannot keep a constraint
that names a column no longer there.
## TRO-470 — LH-030: Eval harness (2026-08-12)

**What changed.** An eval harness for extraction accuracy and verdict accuracy against the
golden set (TH-R17, TH-R19, PRD §6), plus the cascade-vs-Sonnet-only benchmark PRD §4 asks
for. Gate G8 (`scripts/factory/gate.sh`, "eval-not-regressed") goes live: it no longer skips.

- `scripts/eval/check.ts` — `pnpm eval:check`. Two modes:
  - No flags: **cheap mode.** Reads the committed `scripts/eval/results/eval-report.json`
    and `scripts/eval/baseline.json`, compares them, exits non-zero on a regression. Makes
    no live API call. This is what `gate.sh` and CI both run, on every gate run and every
    push.
  - `--live`: runs the real cascade (real Haiku extraction; real Sonnet resolution only for
    cases the router actually escalates) over a case sample, scores it, writes a fresh
    report, then runs the same comparison against the fresh numbers. `--full` covers the
    whole 29-case golden set instead of a fixed 8-case default sample
    (`scripts/eval/args.ts`); `--update-baseline` promotes a clean run's numbers into the
    committed baseline — always a separate, explicit flag, never an automatic side effect
    of `--live` (the same reasoning a snapshot test's "update snapshot" step follows: a
    baseline update is a decision a human or agent makes on purpose, not something a script
    does to itself); `--case=<id>` runs one named case for debugging and never touches the
    committed report or baseline.
- `scripts/eval/cascade-runner.ts` — runs one golden-set case through the real cascade via
  `handleVerifyRequest` (the same in-process pattern `scripts/latency/measure.ts` already
  uses, not a real HTTP round-trip). Captures the real Haiku extraction, the real
  preprocessed image, and the real warning-comparator result through `VerifyRouteDeps` —
  the same dependency-injection seam `measure.ts` already validated — rather than
  re-deriving them with a second, possibly-different API call. Calls the real, pure
  `routeLabel` a second time with those captured values to get the case's full
  `LabelRouterResult` (needed for the resolver's own input contract, and impossible to get
  from the API response body alone) and asserts it agrees with the response body's own
  verdict — a harness bug, not a case result, if it does not. Shared by `check.ts` and
  `benchmark.ts` so the two scripts cannot silently disagree about what "run the real
  cascade" means.
- `scripts/eval/extraction-scoring.ts` — did Haiku read each of the five fields correctly,
  against the golden set's ground-truth `label` block? Reuses the router's own parsing and
  normalizing functions (`parseAbv`, `parseNetContents`, `normalizeForFuzzyMatch`, the
  warning subsystem's `normalizeTransport`/`foldCase`) rather than a second, hand-rolled
  comparison that could drift from what "correct" means in production.
- `scripts/eval/verdict-scoring.ts` — did the final label-level and field-level verdicts
  match the golden set's `expected` block? Scored at the router level: a golden-set case
  whose `expected.labelVerdict` is `"REVIEW"` counts as correct when the system also lands
  on REVIEW with the matching reason, matching both production (`route.ts` never resolves a
  REVIEW inline, TH-R19) and the manifest's own design (several cases' `notes` treat
  "correctly escalated" as the right answer for a case a human still needs to look at).
- `scripts/eval/summary.ts`, `baseline-compare.ts` — pure aggregation and regression-decision
  logic. `baseline-compare.ts` is this ticket's adaptation of
  `scripts/latency/exit-status.ts`'s `computeExitCode` — read, not copied: that file asks
  "did every run finish cleanly," this one asks "did accuracy hold at or above a baseline,"
  a different condition needing different logic. Gates on the three headline rates
  (extraction, label-verdict, review-reason), not the per-field breakdowns — a single
  field's small-sample noise should not fail the whole gate while the headline numbers hold.
  Also checks a coverage-staleness condition: a report that does not cover every case the
  baseline was built from cannot honestly claim "no regression."
- `scripts/eval/usage.ts` — real, measured API cost. `createUsageCapturingClient` wraps a
  real `Anthropic` client (neither `extractLabel` nor `resolveEscalatedLabel` surfaces
  `usage` to its own caller) so every call's real token usage is captured with no second
  call. `computeCostUsd` multiplies that real usage by Anthropic's published per-token
  price — the price is a known public rate, the token count is always a real measurement,
  neither half is invented.
- `scripts/eval/flagged-fields.ts` — builds the resolver's `FlaggedField[]` input.
  `buildFlaggedFieldsForEscalatedLabel` handles a real shape found running this ticket's own
  `--live --full` sweep against the golden set, not a hypothetical: a label can escalate to
  REVIEW purely on a label-level blocker (`LOW_IMAGE_QUALITY`, `CONFLICTING_EXTRACTION`)
  with every individual field still scoring a clean MATCH, which left `flaggedFields` empty
  and `resolveEscalatedLabel` correctly refused to run ("nothing to resolve"). Falls back to
  flagging every field, using the label's headline reason as the trigger, when no field
  individually failed — a label-level blocker means the whole reading is suspect, not that
  one field failed alone.
- `scripts/eval/resolver-rollup.ts` — the Sonnet-only benchmark arm's "what would the system
  have decided" step. Reuses the router's own pure `rollupLabelVerdict`/`pickHeadlineReason`
  rather than a second hand-written roll-up rule. Documents a real, measured property: with
  no OCR channel, the government-warning field can only ever reach MATCH or NEEDS_REVIEW in
  this arm, never MISMATCH (`reconcile.ts`'s own single-channel rule: "a single-channel FAIL
  is never allowed, only REVIEW") — a real, structural reason the Sonnet-only arm scores
  worse on warning-related categories below, not a benchmark artifact.
- `scripts/eval/response-validation.ts` — validates the `/api/verify` response body shape at
  the boundary (standing rule 13), extending `scripts/latency/response.ts`'s
  `parseVerifySuccessBody` to also cover `fields`, which this harness needs and the latency
  harness does not.
- `scripts/eval/benchmark.ts` — `pnpm eval:benchmark` (`--full`/`--case=<id>` supported, same
  as `check.ts`). Always live; there is no cheap mode, since a benchmark's only useful
  output is a real number. Not wired into the gate or CI — PRD §4 already settles the
  architecture ("keep the cascade regardless"); this script produces the evidence for an
  already-decided question once, not a check that reopens it on every push. Runs every case
  through both arms over the SAME real Haiku extraction (reused via
  `CaseRunOutcome.rawExtraction`/`rawPreprocessed`, never a second Haiku call for one image)
  so the only variable between arms is the one PRD §4 actually asks about. "Sonnet-only"
  means every field routed to the real resolver regardless of what the router decided — the
  only real Sonnet code path in this repo (`resolveEscalatedLabel`) is built to re-read
  fields the router already flagged, using Haiku's own reading as context; there is no
  from-scratch Sonnet extractor in this codebase, and TH-R19 means this ticket does not add
  one. `resolver-rollup.ts`'s module comment states this definition plainly rather than
  letting a reader assume a hypothetical "Sonnet reads a blank slate" arm was measured.
- `scripts/eval/results/eval-report.json`, `scripts/eval/baseline.json`,
  `scripts/eval/results/benchmark-report.json` — the committed evidence (numbers below).
- `scripts/eval/args.ts` — CLI parsing, split from `check.ts`/`benchmark.ts` so a test can
  import it without a live call, the same reason `scripts/latency/args.ts` is split from
  `measure.ts`. `MAX_CASES` (40) is the same typo backstop `scripts/latency/args.ts`'s
  `MAX_RUNS` is, sized above the golden set's own 29 cases.
- `package.json` — added `eval:check` and `eval:benchmark`.
- `.github/workflows/ci.yml` — a documentation-only comment on the existing "Eval harness not
  regressed" step explaining that it now runs for real, in cheap mode, with no live call
  (the CI-wiring decision, below). The step's own behavior needed no code change: it already
  called `pnpm eval:check` bare, and cheap mode is that command's default.
- 118 unit tests across 10 files, all new (`scripts/eval/*.test.ts`), TDD where the logic is
  deterministic — the comparison/scoring/regression-decision logic, not the live API calls,
  per this ticket's own brief.

**The CI-wiring decision.** The ticket asks this harness to run in CI. But CI has no
`ANTHROPIC_API_KEY` budget for a real-API sweep on every push — that would spend real,
unbounded money on every commit. `scripts/golden/verify.ts` and `renderSmoke.ts` (TRO-499)
already set this repo's precedent: a CI-wired check makes no live or network call. This
harness follows that same rule. `pnpm eval:check` with no flags is cheap by construction. It
compares the already-committed `eval-report.json` against the already-committed
`baseline.json` — arithmetic only, no I/O beyond two JSON reads. The real, paid sweep lives
behind an explicit `--live` flag that a human or agent invokes on purpose, the same
discipline `latency:check` already uses. CI and `gate.sh` check that committed output going
forward. Neither one re-derives it.

The rejected alternative: wire CI to call `pnpm eval:check -- --live` directly. That would
spend real API money and several real minutes on every push, even one that touches nothing
about extraction or routing — unbounded cost for no proportional benefit.

The accepted trade-off: CI can go stale. A router change that regresses accuracy will not
fail CI until someone re-runs `--live --update-baseline` and commits the refreshed numbers.
`compareToBaseline`'s coverage-staleness check catches one sharp edge of this gap — a report
that silently stopped covering the full golden set. It does not catch "the code changed and
nobody re-ran the harness yet." That gap is a stated human decision, not a hidden one.

**The real measured numbers (observed, all 29 golden-set cases, `claude-haiku-4-5` /
`claude-sonnet-5`, 2026-08-12).** `pnpm eval:check -- --live --full --update-baseline`, the
run now committed as the baseline:

| Metric | Result |
|---|---|
| Extraction accuracy | **95.9%** (139/145 fields) |
| Label-verdict accuracy | **62.1%** (18/29 cases) |
| Review-reason accuracy | **30.8%** (4/13 REVIEW cases) |
| Total measured cost | **$0.2691** |
| Cases escalated to Sonnet | 12/29 (41.4%) |

Per-field verdict accuracy: `alcohol_content` 100%, `net_contents` 100%, `class_type` 89.7%,
`government_warning` 86.2%, `brand_name` 82.8%.

Two independent live runs on this final code — this `eval:check` sweep and the benchmark's
cascade arm below — produced label-verdict accuracy of 62.1% (18/29) and 65.5% (19/29) on
the identical 29 cases. This is real call-to-call model variance, not a harness bug. Both
runs agree the number sits in the low-to-mid 60s.

**These numbers are real findings this ticket reports, not problems this ticket fixes** —
an eval harness's job is to produce the evidence, not to re-tune the router or the
extractor prompt it is measuring. Two specific, precise findings for whoever picks up
router/prompt tuning next:

1. Six of eleven verdict misses are golden-set cases expecting `REVIEW` (glare, low-light,
   tiny-warning-text, odd-typography categories). In each, Haiku read the image confidently
   enough that the router returned a clean `PASS` instead. Two explanations are worth
   checking: the golden set's degradation parameters may be milder than intended, or Haiku's
   real image-quality confidence on these renders may be higher than the router's escalation
   thresholds assume.
2. `case-28-conflicting-class-type` and `case-29-conflicting-brand-name` both expect
   `labelVerdict: "FAIL"`. But `brand_name`/`class_type` never assert `MISMATCH` by design
   (`route.ts`'s own header comment, CP-1 §5.3: "distance beyond threshold routes to REVIEW,
   a judgment call, never a silent FAIL"). A case whose only distinguishing feature is a
   brand-or-class conflict cannot validly expect `FAIL` under that design. The real system
   always routes it to `REVIEW`/`AMBIGUOUS_BRAND` instead. This reads as a golden-set
   ground-truth question, not a router bug: should these two cases expect `REVIEW`, matching
   `case-16`'s already-correct pattern? Flagged here, not corrected — editing
   `golden-set/manifest.json` is outside this ticket's scope.

**The cascade-vs-Sonnet-only benchmark (PRD §4, TH-R19) — observed, all 29 cases, both arms
scored against the identical real Haiku extraction per case, 0 failures.** `pnpm
eval:benchmark --full`:

| | Cascade (real production path) | Sonnet-only (every field, every case) |
|---|---|---|
| Label-verdict accuracy | **65.5%** (19/29) | **41.4%** (12/29) |
| `government_warning` field accuracy | 86.2% (25/29) | 58.6% (17/29) |
| Total measured cost | **$0.2766** | **$0.4409** |

Accuracy delta: **-24.1 percentage points** (Sonnet-only is worse). Cost delta: **+$0.1643,
1.6x** (Sonnet-only is more expensive). On this golden set, routing every field to Sonnet is
both less accurate and more expensive than the selective cascade — a real, measured, doubly
one-sided result, not a close call.

**Why Sonnet-only loses on accuracy, precisely, not just "it does."** The
`government_warning` field is the clearest driver. The real warning subsystem cross-checks a
VLM reading against an independent OCR reading (`src/server/warning/reconcile.ts`). The
Sonnet-only arm has no second channel. That module's own single-channel rule says a
single-channel FAIL is never allowed, only REVIEW — so the Sonnet-only arm can never assert
a hard `MISMATCH` on this field. A title-case or reworded warning always escalates instead
of correctly failing, dragging the whole label's verdict from a correct `FAIL` to an
incorrect `REVIEW`. This is a structural property of having one reading instead of two, not
a prompt-quality problem. More Sonnet calls do not fix a missing corroborating channel.

**Per this ticket's own instruction, the recommendation is not up for renegotiation by this
finding.** PRD §4: "Keep the cascade regardless per Troy; the benchmark is the evidence."
This benchmark produces that evidence — in this case, evidence that agrees with the
already-settled decision, not merely evidence that was collected regardless of outcome.
`benchmark.ts`'s own committed report carries a fixed `recommendation` string rather than one
derived from the numbers, so a future re-run cannot accidentally flip a recommendation this
project already made.

**Golden-set escalation rate vs. PRD §4's production estimate.** 12 of 29 cases (41.4%)
escalated to Sonnet on this run — noticeably higher than PRD §4's "~10-15% of labels"
estimate. This is not a contradiction: PRD §4's figure describes expected real-world
production traffic; the golden set is deliberately weighted toward hard and degraded cases
(glare, rotation, low light, tiny text, conflicting data) that a real label population would
rarely produce at this density. Reported as measured on this specific, intentionally-hard
test set — not a claim about production traffic.

**Gate.** `scripts/factory/gate.sh` G8 ("eval-not-regressed") now runs `pnpm eval:check` for
real. Confirmed: `[ok ] eval-not-regressed  accuracy >= committed baseline` — no longer
`skip`.

**How to run it.** `pnpm eval:check` (free, no live call) for the regression gate.
`pnpm eval:check -- --live --full --update-baseline` to refresh the committed baseline after
a real router or prompt change (costs real API money, several minutes). `pnpm eval:benchmark
-- --full` to refresh the cascade-vs-Sonnet-only evidence (real money, several minutes,
never automatic). `source .factory-env` first in a factory worktree, same `DATABASE_URL`
discipline as every other script here.

**Rollback.** `git revert` this ticket's commits. That removes every `scripts/eval/*` file,
the two `package.json` scripts, and the CI comment, and restores gate.sh's G8 to its prior
`skip` behavior (`gate.sh` itself already handles "no eval:check script" as a real branch,
unchanged by this ticket).

## TRO-473 — local CodeRabbit review round 3: 4 findings, 4 fixed (2026-08-11)

**What changed.** A full gate run against round 2's own fix commits captured 4 findings —
one critical. All 4 were real. All are fixed.

- `route.ts` (**critical**): `readLimitedBody` (round 2) accumulated every chunk, then
  allocated a SECOND full-body-sized `Uint8Array` to merge them into — a request near the
  cap briefly held roughly twice its own size in memory, on the exact route meant to bound
  memory use. That second allocation also ran outside the function's `try`/`catch`, so a
  real allocation failure would have propagated uncaught instead of reaching the designed
  error response. Switched to `new Blob(chunks)` — verified empirically first that
  `Response(blob, ...).formData()` re-parses identically, with no second full-size copy —
  wrapped in its own `try`/`catch`. Also lowered `MAX_TOTAL_REQUEST_BYTES` from 2 GB to 1 GB:
  this cap is now also a peak-memory bound, on a hosting instance this design cannot assume
  is generously provisioned. A new test simulates a `Blob`-construction throw and confirms
  the designed `VALIDATION` response, not an uncaught exception.
- `constants.ts` (minor): `MAX_TOTAL_REQUEST_BYTES`'s own doc comment still claimed
  `request.formData()` ran uncapped when `Content-Length` is absent — stale the moment round
  2 added `readLimitedBody` to close exactly that gap. Rewritten to describe
  `checkRequestSize` as the fast path and `readLimitedBody` as the authoritative check.
- `pairing.ts` (major): zero-byte images were filtered out before duplicate detection ran, so
  a row matching a filename with BOTH an empty and a non-empty upload silently matched the
  non-empty one — the exact "guess instead of report" shape this module's own philosophy
  refuses everywhere else. `imagesByFilename` is now built from every image, empty or not;
  emptiness is checked per-image only after the duplicate question is settled, so an empty
  duplicate correctly makes the pairing ambiguous — unmatched, both images reported — instead
  of silently losing to its non-empty twin.
- `pairing.test.ts` (trivial): added the suggested regression test directly — one row, two
  uploads sharing its filename (one zero-byte, one real). Confirms no row matches and both
  uploads are reported.

Recorded in `factory/review-findings.jsonl` — categories `correctness` (2), `doc-accuracy`
(1), `test-coverage` (1).

**Tests.** `pnpm test -- src/server/batch/ src/app/api/batch/` — same 7 files, now 91 test
cases (was 89), all green. `pnpm typecheck` and `pnpm lint` both clean.

**How to run it.** `source .factory-env` first. `pnpm test -- src/server/batch/
src/app/api/batch/`, or `pnpm test` for the full suite.

**Rollback.** `git revert` this round's commits. No schema change, no migration.

## TRO-473 — local CodeRabbit review round 2: 2 findings, 2 fixed (2026-08-11)

**What changed.** A second independent CodeRabbit pass, against round 1's own fix commits,
captured 2 findings. Both were real. Both are fixed.

- `csv.ts` (moderate): a bare carriage return (`\r` not followed by `\n`) was silently
  dropped in an unquoted field and silently kept as literal content in a quoted field —
  neither an error. The unquoted case is the serious one: dropping the `\r` merges what
  looks like two lines into one cell with no separator, invisible data corruption. Both
  branches now return a syntax error for a bare `\r`; a genuine CRLF pair is unaffected in
  either branch. Four new regression tests, confirmed red first.
- `route.ts` (major, and correctly flagged as bypassing round 1's own fix rather than a new
  problem): `checkRequestSize` only rejects a request whose `Content-Length` header is
  present and already reveals it is too large. A request with no such header — this route's
  own normal shape in production, confirmed empirically — sailed past that check into an
  uncapped `request.formData()`, the exact risk round 1 meant to close. Added
  `readLimitedBody()`: reads the request's real bytes via its own stream reader, aborting
  the instant the cap is exceeded, measured rather than declared. `checkRequestSize` stays
  as a cheap fast path; `readLimitedBody` is now the authoritative check. Verified
  empirically first that reconstructing a `Response` from the buffered bytes plus the
  original `Content-Type` header re-parses as `FormData` identically to the original
  request, and that an early `reader.cancel()` exits cleanly. The existing "no
  Content-Length header" test's framing was updated (a small such request still succeeds,
  unchanged); two new tests prove a large one is now rejected and a small one still isn't.

Recorded in `factory/review-findings.jsonl` — categories `correctness` (1),
`boundary-validation` (1).

**Tests.** `pnpm test -- src/server/batch/ src/app/api/batch/` — same 7 files, now 89 test
cases (was 83), all green. `pnpm typecheck` and `pnpm lint` both clean.

**How to run it.** `source .factory-env` first. `pnpm test -- src/server/batch/
src/app/api/batch/`, or `pnpm test` for the full suite.

**Rollback.** `git revert` this round's commits. No schema change, no migration.

## TRO-473 — LH-040: Batch input — CSV manifest + images + pairing preview (2026-08-11)

**What changed.** TH-R4 asks for batch upload. This ticket builds the first stage: a CSV
manifest, paired against uploaded images, validated before any processing starts. It does
not start a batch job. LH-041 (job queue + worker pool) and LH-042 (batch progress + results
UI) build on this ticket's output. Neither is touched here.

New module, `src/server/batch/` — pure logic, no database call, TDD throughout:

- `csv.ts` — an RFC 4180 CSV tokenizer. Handles quoted fields, a comma or a newline inside
  one, CRLF and LF line endings, a leading UTF-8 BOM, and blank lines. Reports a syntax
  error at the line it actually started on.
- `manifest.ts` — turns CSV rows into validated `ManifestRow` values. Reuses
  `src/app/api/verify/parse-request.ts`'s own field rules: the same beverage types, ABV
  range, and net-contents units. A structural problem (bad headers, a duplicated column, a
  wrong cell count) fails the whole file — a ragged row means columns may have shifted, so
  guessing past that point is not safe. A value problem in one row (a bad beverage type, a
  non-numeric ABV) fails only that row, reported in `rowErrors`, never dropped.
- `pairing.ts` — deterministic filename pairing. Every row and every uploaded image ends up
  in exactly one of `matched`, `unmatchedRows`, `unmatchedImages`. Filename comparison is
  Unicode NFC-normalized (standing rule 20) and case-sensitive, matching the case-sensitive
  uniqueness Postgres will enforce once a batch's `label_images` rows exist.
- `zip.ts` — filenames and sizes from an uploaded zip, via `fflate` (new dependency). No
  entry is ever decompressed: its `fflate` filter reads name and declared size from
  central-directory metadata alone. Every entry path reduces to a basename before anything
  else sees it, so nothing ever uses a zip entry's raw path for a filesystem operation —
  closing off zip-slip as a concern.
- `index.ts` — `buildBatchPreview`, the facade. Its output, `PairedItem[]` (`{ row, image
  }`), is the exact handoff shape for whatever starts a batch job next, plus every
  unmatched or invalid item TH-R20 requires reported alongside it.

New route: `POST /api/batch/preview`. Accepts a CSV manifest plus images — multi-file drop,
a zip, or both — and returns a 200 pairing preview. An unmatched row or image is data inside
that response, not a request failure: TH-R20 asks for these to be reported, never silently
dropped, which is not the same as rejected. Only a request the server cannot preview at all
(no manifest, an unreadable CSV, a corrupt zip, too many images) returns a designed error
(`kind: VALIDATION | MALFORMED_CSV | MALFORMED_ZIP | SERVICE`), matching
`src/app/api/verify/types.ts`'s `VerifyErrorKind` pattern.

**Scope boundary.** This ticket writes nothing to the database — no `batch_jobs`,
`applications`, `label_images`, or `batch_queue_items` row. Two reasons.
`docs/checkpoints/cp3-batch-queue.md` §10: "this document assumes a `batch_jobs` row only
exists once pairing has already succeeded" — pairing precedes job creation, it is not part
of it. And `batch_queue_items` does not exist on this branch; LH-041 adds it in its own
migration, in a sibling worktree. `docs/error-states.md` (LH-052, already merged) reached
the same boundary independently from the UI side, naming LH-042 — not LH-040 — as the
ticket to carry the malformed-CSV and unpairable-row states into an actual UI panel. This
ticket builds the pipeline LH-042 needs; it builds no UI page.

**Tests.** `pnpm test -- src/server/batch/ src/app/api/batch/` — 7 files, 70 new test
cases, all green (verified 2026-08-11). Every new module's test file was written first and
confirmed to fail on "module not found" before the module existed. One real bug caught this
way: `csv.ts`'s first draft reported an unterminated quote at the line the parser ran out of
input on, not the line the quote actually opened on, when the unterminated field itself
spanned a newline. Fixed by tracking the quote's own start line separately from the running
line counter.

**How to run it.** `source .factory-env` first, matching this repo's convention — though
this ticket's own tests touch no database. Then `pnpm test -- src/server/batch/
src/app/api/batch/`, or `pnpm test` for the full suite.

**Rollback.** `git revert` this ticket's commits. No schema change, no migration. Outside
this changelog, the only existing files touched are `package.json` and `pnpm-lock.yaml`
(the new `fflate` dependency) — every other file this ticket adds is new.

## TRO-473 — local CodeRabbit review round 1: 11 findings, 11 fixed (2026-08-11)

**What changed.** The gate's first local CodeRabbit pass hit the organization's rate limit
(see the PR body — confirmed via `coderabbit auth status`, not an auth problem). An
independent re-run minutes later captured 11 findings. All 11 were real. All are fixed.

- `parse-request.ts` (major): the uploaded zip archive had no size ceiling before
  `.arrayBuffer()` read it, and no whole-request check ran before `request.formData()`.
  Added `MAX_ZIP_ARCHIVE_BYTES` (`parse-request.ts`, injectable so a test can prove the
  rejection cheaply) and `checkRequestSize()` (`route.ts`, checked against the
  `Content-Length` header before `formData()` runs).
- `csv.ts` (minor, two findings): a quoted empty field (`""`) was indistinguishable from a
  blank line and silently dropped. Fixed by tracking whether a record used real CSV syntax,
  not just its final shape. Separately, quote placement was too permissive — `a"b"` and
  `"a"b` both silently parsed as `ab` instead of erroring. Fixed with explicit field-start
  and after-closed-quote state, matching RFC 4180's own placement rule.
- `pairing.ts` (major + minor): a row referencing a zero-byte image got the generic "no
  image found" message instead of the empty-file reason, because zero-byte images were
  already filtered out before the row-side lookup ran. Fixed by tracking empty-image
  filenames separately. Separately, the image-side loop reported only the FIRST image for a
  shared filename, silently dropping every image past it — contradicted this module's own
  documented "every image ends up in exactly one list" contract. Fixed to report every one.
- `pairing.test.ts` (minor): the zero-byte-image fixture was named `empty.jpg`, so its
  `/empty/i` assertion could pass on the filename rather than the actual reported reason —
  and did, coincidentally, on the row side, while the bug above was still live. Renamed the
  fixture; the `pairing.ts` fix above was needed before the test passed again for the right
  reason.
- `zip.test.ts` (trivial): added a regression test proving the zip-slip protection
  directly — a crafted `../../../etc/evil.jpg` entry extracts to just `evil.jpg`.
- `types.ts` (major): `ManifestRow.netContentsUnit` was a bare `string`, even though
  `manifest.ts` already validated it against a closed set at runtime. Added
  `NET_CONTENTS_UNITS`/`NetContentsUnit` as the canonical export; `manifest.ts` now imports
  and casts instead of re-declaring the set locally.
- `zip.ts` (major, two findings). First: `extractZipEntries` returned `true` from its
  `fflate` filter for every accepted entry, so `fflate` decompressed each one even though
  this module only ever needed its filename and declared size. Restructured to always
  return `false` — name and declared size are captured inside the filter itself, before
  that decision — so no entry is ever inflated. Also moved the directory check before the
  entry-count increment, so folders no longer consume that budget.
  Second, and the one worth real scrutiny: does trusting a zip's declared size for the
  cap hold up against a hostile file? **Verified, not assumed.** Two hand-crafted zips (a
  real DEFLATE stream; local- and central-directory size fields forged in both directions —
  declared 10 bytes/real 20 MB, and declared 200 MB/real 2 bytes), tested directly against
  `fflate.unzipSync`, 2026-08-11. Finding: `fflate` bounds real inflate output to the
  declared size either way — the pre-fix code was not actually exploitable the way the
  finding worried. The restructuring above was adopted anyway, so the guarantee is now
  architectural (nothing is ever decompressed, full stop), not dependent on an unstated,
  version-specific `fflate` behavior. `zip.ts`'s own file comment states this precisely.

Recorded in `factory/review-findings.jsonl` — categories `boundary-validation` (2),
`correctness` (5), `prose-style` (1), `test-coverage` (2), `type-safety` (1).

**Tests.** `pnpm test -- src/server/batch/ src/app/api/batch/` — same 7 files, now 83 test
cases (was 70), all green. Every fix's regression test was confirmed red first for the
right reason against the unfixed code — most prospectively (test written, confirmed
red, then the fix); the `Content-Length` check was confirmed red retroactively (fix
temporarily disabled, test re-run, fix restored), recorded here rather than left unstated.

**How to run it.** `source .factory-env` first. `pnpm test -- src/server/batch/
src/app/api/batch/`, or `pnpm test` for the full suite. `pnpm typecheck` is clean.

**Rollback.** `git revert` this round's commits. No schema change, no migration.

## TRO-499 — LH-006: Golden set verify gate + CI smoke (2026-08-11)

**What changed.** `scripts/golden/verify.ts` is the golden set's health check. It checks one
thing: whether `golden-set/manifest.json`, the ticket's own "consumer interface for
eval/latency harnesses," is trustworthy right now. Run it with `pnpm golden:verify`. It calls
no model and makes no network call (TH-R7). Every check reads only the manifest and local
files.

It checks five things:
1. The manifest loads and passes schema validation. This check calls
   `src/lib/golden-set/loader.ts` directly, instead of checking the shape a second, separate
   way. The verified-before-eval rule for `ai-generated` and `rendered+ai-backdrop` cases
   already lives there.
2. Every case's `imagePath` resolves to a real, non-empty file.
3. Every file under `golden-set/images/` resolves back to some case's `imagePath`. This
   catches an orphan in either direction, not just a manifest entry with a missing file.
4. Every `rendered+ai-backdrop` case's backdrop file must exist, at
   `golden-set/backdrops/<caseId>.png`. Its `referenceBottle` must resolve to a real, valid
   bottle reference JSON (`src/lib/golden-set/bottleReference.ts` checks that schema too).
   That JSON's own `referencePhoto` must exist as well. The realistic-corpus design doc asks
   for this exact check
   (`docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md` §6).
5. Every `audit/rubric.md` Appendix A vector V1–V10 has at least one covering case.

**The vector-coverage design decision.** Two vectors have zero coverage today. This is
documented, existing repo state. This ticket did not introduce it.
`golden-set/README.md` and `src/lib/golden-set/loader.test.ts` (TRO-497/LH-004) already name
both gaps:
- V7 is a net-contents format match, for example `"750 mL"` vs `"750ml"`. No case isolates
  that difference yet.
- V10 is a batch of 20 or more cases. That is a property of the whole manifest, not a tag on
  one case.

`verify.ts` mirrors that same tracked-not-silent pattern instead of inventing a second one.
V10 counts as covered once the manifest holds 20 or more cases — it holds 29 today. V7 is a
named exception: `KNOWN_VECTOR_GAPS` in `verify.ts`. The CLI reports it as a known gap, never
as a failure. Any other vector still fails the gate if it loses its only covering case. If V7
gains a case but `verify.ts` still lists the exception, the gate fails the other way. This
catches drift in both directions — the same guarantee `loader.test.ts` already makes for
itself.

Closing V7 for real means adding a golden-set case whose distinguishing feature is a
net-contents format difference. That is new manifest content. It falls outside this ticket's
scope: a verify gate and a CI smoke test, not new test cases. This entry flags it as a real
follow-up. It does not paper over the gap.

**Files.**
- `scripts/golden/verify.ts` — `verifyGoldenSet()`, the five checks above, plus a CLI `main`
  guarded by the `import.meta.url` check (`scripts/golden/imagen.ts`'s existing pattern).
  Importing this file for its exports never runs the CLI as a side effect.
- `scripts/golden/verify.test.ts` — 20 tests. 19 of them each build a small, isolated
  manifest and image tree, one failure mode per test. The last test calls `verifyGoldenSet()`
  with no overrides. It checks the real, committed golden set and confirms that set still
  passes today.
- `scripts/golden/renderSmoke.ts`, `renderSmoke.test.ts` — the "one headless render smoke"
  CI needs (design doc §7: "render one label headlessly, then run verify.ts"). It renders the
  first renderable case through the real `render.ts` pipeline, then checks the result decodes
  at the fixed canvas size. This check is narrower and faster than `render.test.ts`'s full
  determinism-and-font suite, which still runs inside `pnpm test`.
- `package.json` — added `golden:verify` and `golden:render-smoke` scripts, matching the
  existing `golden:build` and `golden:imagen` naming.
- `.github/workflows/ci.yml` — two new steps, "Golden set verify" and "Golden set render
  smoke," placed after Lint and before Build. Neither needs Postgres or a full `pnpm build`,
  so both fail fast, before the slower steps run.
- `golden-set/README.md` — updated the two sentences that said `verify.ts` "will eventually"
  check the realistic-corpus track and vector coverage. It does now. This documents how.

**How to run it.** `pnpm golden:verify` (fast, no browser). `pnpm golden:render-smoke`
(launches Chromium once, ~1-2s). Both now run in CI, before `pnpm build`.

**Rollback.** `git revert` this ticket's commits. That removes `scripts/golden/verify.ts` and
`renderSmoke.ts`, their tests, the two `package.json` scripts, and the two CI steps.
`golden-set/manifest.json` itself is untouched. Nothing else depends on this ticket yet.

## TRO-509 — Compositor silently truncated the label on trapezoid quads (2026-08-11)

**What changed.** `compositeLabelOntoBackdrop` (`scripts/golden/compositeBackdrop.ts`) built
its destination bounding box from all 4 detected quad corners, including `bottomRight`. The
warp itself, `solveLinearMap`, is a 3-point affine map. It uses only `topLeft`, `topRight`, and
`bottomLeft`. `bottomRight` never feeds the warp. That gap is a known, accepted approximation —
the file's own docstring names it, and so does the design doc (§11).

A real bottle-label photo detects as a genuine trapezoid, not a parallelogram. On a trapezoid,
the detected `bottomRight` and the affine map's own implied 4th corner
(`topRight + bottomLeft − topLeft`) are different points. The detected point can still fall
inside the parallelogram the map draws. It is simply not that parallelogram's own far vertex.
The old bounding box was built from the four detected corners. It could then stop short of the
implied corner. That made it smaller than the parallelogram the warp actually draws. The pixel
loop only visits pixels inside the bounding box. Pixels between the detected box's edge and the
implied corner never got visited. They stayed raw backdrop. They never received label content.

The renderer's `LABEL_REGIONS.warning` region sits in the label's bottom band. A trapezoid quad
with this shape can truncate the statutory government-warning text. The pipeline would still
report `governmentWarning: MATCH` — the comparator never sees the pixels that went missing.

**The fix.** `compositeLabelOntoBackdrop` (`scripts/golden/compositeBackdrop.ts:85-90`) now
builds `xs`/`ys` from `topLeft`, `topRight`, `bottomLeft`, and the computed implied 4th corner —
not the detected `bottomRight`. This bounding box always covers the whole parallelogram the
warp draws. Clamping to the backdrop image's bounds is unchanged. Only the corner set feeding
it was wrong.

**Tests.** `scripts/golden/compositeBackdrop.test.ts` gained a new block:
`compositeLabelOntoBackdrop — genuine trapezoid quad (TRO-509)`. It reuses the exact corner
values from this ticket's own measured reproduction: `topLeft(100,100)`, `topRight(400,120)`,
`bottomLeft(130,500)`, `bottomRight(370,470)`.

- The first test checks one destination pixel, `(420, 510)`. That pixel sits inside the
  affine-drawn parallelogram and inside the corrected bounding box. It sits outside the old,
  bug-produced one. Confirmed red first: before the fix, the pixel read as raw backdrop color
  (green channel 10, the backdrop's own value). After the fix, it reads as the solid test
  label's own color (green channel 180).
- The second test scans every interior point of the affine-drawn parallelogram: 110,041 points.
  The scan stays a small margin back from the exact geometric edge, so the check does not
  depend on nearest-neighbor rounding at a sub-pixel boundary — that rounding is expected
  behavior, not this defect. Confirmed red first: before the fix, 4,167 of those 110,041 points
  (3.79%) read as raw backdrop. After the fix, zero do.
- Both counts are measured, from this branch's own commits. The margin-inset interior scan
  above found 4,167 of 110,041 missing (3.79%). A wider check — the full parallelogram,
  including its edge, at the ticket's own reproduction label size — found 7,744 of 119,400
  missing (6.49% missing, 93.51% drawn). That figure matches the ticket brief's own cited
  numbers exactly.

**How to run it.** Source `.factory-env` first. `pnpm test -- scripts/golden/compositeBackdrop.test.ts`
runs this file alone: 5 tests, all pass. `pnpm test -- scripts/golden` runs the full golden
pipeline suite: 83 tests, all pass. `pnpm typecheck` is clean.

**Not fixed here.** No `rendered+ai-backdrop` manifest case exists yet. No real bottle
reference photo has been supplied. This fix has no golden-set image to re-render. It closes the
defect before the first real pilot batch can reach it, per the ticket brief.

**Rollback.** `git revert` this ticket's commit(s). Reverting restores the detected-corner
bounding box and removes both new tests. No image, migration, or other file depends on this
change.

## TRO-514 — Wire the warning comparator into the live verify route (2026-08-11)

**What changed.** `src/app/api/verify/route.ts` now calls LH-020's real warning comparator
(`compareGovernmentWarningFromImage`, `src/server/warning`) on every request. TH-R9's
word-for-word government-warning check is live: a compliant warning contributes to a PASS
label verdict, a non-compliant one contributes to a FAIL, and the field-level verdict is a
real answer, not a permanent `NEEDS_REVIEW` placeholder. This closes the gap TRO-468's own
"Known limits" section named.

**Concurrency (PRD §3.8, CP-2 §4.4 rule 1).** The comparator starts before the Haiku call
resolves, not after. `route.ts` passes the extraction as a still-pending `Promise`
(`extractionPromise.then((r) => r.government_warning)`) — the same contract
`compareGovernmentWarningFromImage`'s own file comment documents. Region detection and OCR
now run alongside the Haiku call, instead of adding their own time after it.

**Failure handling (CP-2 §4.4 rule 3).** A REVIEW outcome is the comparator's normal return
value, not a thrown error — `reconcileWarningChannels` is pure and synchronous, and its OCR
half already turns its own failures into `{ available: false }`. A thrown error means a real
infrastructure failure. `resolveWarningOrDegrade` (`route.ts`) catches it — a rejected
promise or a synchronous throw, either one — and passes `null` for that one field, exactly
today's "uncertain beats wrong" behavior. `resolveGovernmentWarningField` already routes a
`null` result to `NEEDS_REVIEW`; it never fabricates a match. The request still returns 200.

**Image source (CP-2 §8.3).** The comparator reads `preprocessed.original`, the
full-resolution image — never the resized `haikuVariant`. The resized variant falls below
Tesseract's usable x-height floor at the statute's legal minimum print size (1 mm).

**`VerifyRouteDeps` extended.** `compareGovernmentWarning` joins the existing
dependency-injection fields (`db`, `preprocessImage`, `extractLabel`, `saveLabelImage`,
`comparators`). Production gets the real `compareGovernmentWarningFromImage`. Every test in
`route.test.ts` supplies its own fake, the same pattern the other fields already use. The
latency harness (`scripts/latency/measure.ts`, TRO-471) wires in the real function too — its
own header comment now says the warning subsystem is part of what it measures, not excluded.

**Regression tests.** `src/app/api/verify/route.test.ts`, a new "government warning wiring"
describe block, 6 cases — every one confirmed to fail for the right reason before this
ticket's implementation code existed (a value mismatch against the old hardcoded `null`
behavior, a `wasCalled`/`capturedInput` flag proving the dependency was never invoked, or a
5-second timeout for the concurrency case, since the old code never called it at all):
- A compliant warning (`MATCH`) rolls the label verdict up to a clean `PASS`.
- A non-compliant warning (`MISMATCH`) rolls the label verdict up to `FAIL`.
- A comparator that rejects its promise degrades that field to `NEEDS_REVIEW` — the request
  still returns 200, not a 500.
- A comparator that throws synchronously, before returning any promise at all, degrades the
  same way — `resolveWarningOrDegrade`'s `try`/`await`/`catch` catches both failure shapes.
- The comparator receives `preprocessed.original`, proven against a distinguishable marker
  buffer, never the resized `haikuVariant`.
- The comparator is invoked, and is provably still running, before the Haiku call's own
  promise resolves — a fake Anthropic client holds its response open on a gate the test
  controls, and the test awaits an observable "the comparator was called" signal, never a
  fixed sleep.

Two pre-existing tests' comments — not their assertions — were also corrected: the
happy-path test and the `alcohol_content` MISMATCH test each explained their own
`government_warning` field staying `NEEDS_REVIEW` as "no comparator yet." That reason is now
false. It stays `NEEDS_REVIEW` in those two tests because `makeDeps()`'s default
`compareGovernmentWarning` is a deliberately neutral stub, not because the wiring is missing.

**How to run it.** `pnpm test -- src/app/api/verify/route.test.ts`. `pnpm typecheck` and
`pnpm lint` both run clean.

**Not measured.** No new latency number is reported here. This ticket wires the comparator
in; TRO-471's harness (`pnpm latency:check`) is the tool that would measure the effect, and
running it costs a real, live Anthropic API call per run. A number captured before this
ticket and a number captured after it are not comparable — the earlier one excluded the
warning subsystem's own work entirely. Noted in `measure.ts`'s own header comment.

**Rollback.** `git revert` this ticket's commits on `feat/wire-warning-into-route`. Reverts
`route.ts` to passing `warningResult: null`, `VerifyRouteDeps` to its five original fields,
and `measure.ts` to its pre-TRO-514 `deps` object and header comment.

## TRO-477 — LH-051: Imperfect-image handling (2026-08-11)

**What changed.** TH-R10 sets one bar for a glare, rotation, or low-light label. The router
must return a correct extraction. Or it must return an explicit `LOW_IMAGE_QUALITY` review.
It must never return a confident wrong verdict. Investigation found the Validation Router
(LH-012) already meets this bar. No router code changes here. This ticket adds proof.

Two pieces already do the work. First, the Haiku extractor's prompt (LH-011,
`src/server/extractor/prompt.ts` rule 6) tells the model to report low confidence when glare,
blur, an angle, low light, a crop, or an obstruction blocks it. Second, the router
(`src/server/router/label-blockers.ts`'s `isLowImageQuality`) already escalates a label to
`LOW_IMAGE_QUALITY` review whenever the whole-image read is `"no"`, or `"partial"` with any
required field below the Unusable confidence floor (0.60). Together, an honest extraction of
a degraded photo already routes to review under the router's existing logic. This ticket did
not need a new heuristic. It needed evidence the existing one covers the six glare/rotation/
low-light golden-set cases.

**Files.**
- `src/server/router/golden-image-quality.test.ts` — new. One test per golden-set case,
  case-17 through case-22 (`golden-set/manifest.json`'s `glare`, `rotation`, and `low-light`
  categories — the complete set this ticket covers, not only the three
  `docs/checkpoints/cp2-warning-subsystem.md` §9.1 names as warning-relevant). Each test
  builds a `HaikuExtractionResult` shaped like an honest read of that case's documented photo
  defect: glare over the brand name only, glare over the warning block only, a mild
  15-degree tilt, an unreadable upside-down and blurred shot, dim light on the front label
  only, and dim light on the warning block only. Each test then checks `routeLabel`'s output
  against the golden-set manifest's own `expected` block — label verdict, headline reason,
  and every field's verdict — pulled from the manifest directly, not retyped. Ground-truth
  text (brand, class, ABV, net contents, warning) also comes from the manifest, the same
  pattern `src/server/extractor/golden-case.test.ts` (LH-011) already uses for case-01.

  The two warning-block cases (case-18, case-22) pass `warningResult: null`. That is
  `route.ts`'s real value as of this writing: `route.ts` does not call LH-020 yet, even
  though LH-020's own subsystem module has since merged (TRO-468, PR #19, mid-way through this
  ticket's own work) — `route.ts`'s own file comment still says so, and `scripts/latency/
  measure.ts`'s doc comment records the same gap from before LH-020 merged. Passing `null`
  here proves this ticket's own mechanism carries the `LOW_IMAGE_QUALITY` headline on its
  own — not a hypothetical future warning subsystem standing in for it, and not contingent on
  exactly when `route.ts` starts calling one. An earlier draft of these two tests passed a
  synthetic warning result instead. A mutation check (below) showed that draft passed even
  with the router's own detection disabled — it was proving the test fixture, not the router.
  Switched to `null` and reconfirmed.

**Verification beyond a green test run.**
- Mutation check, not shipped. Temporarily forced `isLowImageQuality` to always return
  `false`, reran the suite, then always return `true`, reran again, then reverted both
  changes (`git diff` confirmed zero lines each time). Forcing `false` failed the five
  REVIEW-expecting cases (17, 18, 20, 21, 22) and left the PASS-expecting case (19) green.
  Forcing `true` failed only case-19. Both directions show the new tests exercise real
  router behavior, not a vacuous pass.
- Confirmed all six images (`golden-set/images/case-17-*.jpg` through `case-22-*.jpg`) decode
  through the real `preprocessImage` pipeline (LH-010) without rejection, at 800-1173px on
  the long edge — above the 640px floor `isLowImageQuality` checks. This is a narrow, purely
  technical claim about the decode step, not a claim about the golden-set manifest's own
  `verified` field (still `false` on every case — no human has confirmed the images show what
  their spec claims). It confirms the tests' default `PreprocessingSignal` fixture
  (`rejected: false, longEdgePx: 1568`, `test-support.ts`'s existing convention) does not
  paper over a real preprocessing-level rejection.

**How to run it.** `source .factory-env` first — every test command needs `DATABASE_URL`
pointed at this ticket's own worktree database, even though this specific suite touches no
table. `pnpm test -- src/server/router/golden-image-quality.test.ts`. No live model call and
no real money — every fixture is a hand-built, clearly-labeled stand-in for a Haiku response,
not a live extraction.

**Rollback.** Delete `src/server/router/golden-image-quality.test.ts`. No production code
changed.

**Not verified.** Whether the real `claude-haiku-4-5` model reports confidence and
`image_quality.legible` the way this ticket's fixtures assume, for these six specific
photographs. That needs a live API call against the committed images. It is outside this
ticket's TDD scope on deterministic router logic (PRD §6), and outside LH-011's own already-
Done, already-out-of-scope-here extractor work.

## TRO-478 — local CodeRabbit review round 1: 3 findings, 3 fixed (2026-08-11)

**What changed.** The gate's local CodeRabbit pass reviewed this branch once, before the PR
opened. It found 3 issues. All were real. All are fixed.

- `docs/error-states.md` (minor): a missing relative pronoun. "A UI a first-time user" read
  wrong. It now reads "a UI that a first-time user."
- `docs/error-states.md` (major): the outbound-dependency section claimed "exactly one
  outbound dependency… nothing else calls another host," then carved out Postgres in the very
  next paragraph. That is an internal inconsistency, not just loose wording. Postgres now has
  its own row in the dependency table, with its real degradation behavior (503 SERVICE,
  "could not save this verification") and an explicit note on why it is a different kind of
  concern than a public vendor endpoint behind a firewall.
- `src/app/api/verify/route.test.ts` (minor): the "no SDK detail leaks into the response"
  assertion checked the error class name and errno-style strings, but not the literal SDK
  message "Connection error." Added to the same check.

Recorded in `factory/review-findings.jsonl` — categories `prose-style`, `doc-consistency`,
`test-coverage`.

**How to run it.** `pnpm test -- src/app/api/verify/route.test.ts`.

**Rollback.** `git revert` this commit. Every change here is prose or a test assertion; no
production code moved.

## TRO-478 — LH-052: Designed error states (2026-08-11)

**What changed.** This ticket covers four single-label designed error states (TH-R20):
an unreadable image, an oversized file, an API failure or timeout with a retry
affordance, and unreachable-endpoint degradation (TH-R7). Each gets a ticket-named
regression test. `docs/error-states.md` is new — the error-path walkthrough TH-R20 asks
for, and the outbound-dependency list TH-R7 asks for.

Three of the four states already worked. LH-010's preprocessing pipeline and LH-015's
verify screen built them first. No route-level test proved it for the unreadable-image
and oversized-file cases, and no test used the Anthropic SDK's real connection-error
class for the unreachable-endpoint case. This ticket adds that proof:

- `src/app/api/verify/route.test.ts` — a corrupt/truncated image (a valid JPEG header,
  damaged pixel data) returns 422 IMAGE, distinct from an unsupported format. Confirmed
  the extractor is never reached.
- `src/app/api/verify/route.test.ts` — a file over the 20 MB upload ceiling returns 422
  IMAGE. Confirmed the extractor is never reached.
- `src/app/api/verify/route.test.ts` — a real `Anthropic.APIConnectionError` (not a
  generic stand-in `Error`) returns 503 SERVICE. Confirmed no SDK-internal detail leaks
  into the response, and no application row is left behind.
- The pre-existing route test titled "an unreadable image" was renamed. It tests garbage
  bytes with no recognizable image format at all — a different state from a damaged file
  with a real header. The new corrupt-image test above is the genuine unreadable-image
  case.

**The one real bug, fixed.** `verify-client.ts`'s request timeout did not stay live
through the whole request. The old code cleared the timer in a `finally` block right
after `fetch()` resolved — before the response body finished parsing. A response whose
headers arrived quickly, but whose body then stalled past the 45-second budget, had no
timeout protection at all once headers were in. `review-queue-client.ts` had this exact
bug shape, found and fixed for TRO-476 (see that entry, below). This ticket applies the
same fix here: the timer now clears only after the body read completes, in `finally`
around `response.json()`, not around `fetch()` alone (standing rule 23).

`src/app/_lib/verify-client.test.ts`'s new case proved the bug first: a manufactured slow
body read resolved successfully instead of aborting, because the timer had already been
cleared. It is green after the fix. `src/app/_components/VerifyForm.test.tsx` adds a
second case: a SERVICE-classified failure shows the designed panel, and "Try again"
resubmits and succeeds — the retry affordance TH-R20 asks for, proven at the component
level too.

**Deferred — four batch-scoped states, not attempted here.** LH-052's ticket text also
names a malformed CSV, unpairable rows, a partial batch failure, and a rate-limit backoff
notice. None of these exists to test yet. The batch pipeline they belong to — LH-040
(CSV manifest + pairing) and LH-041 (job queue + worker pool) — is still in progress in
sibling worktrees, not yet merged to `main`. Building throwaway error-state UI against a
pipeline shape that has not landed would not reliably match what LH-040/LH-041 actually
ship, and batch infrastructure is outside this ticket's file scope. `docs/error-states.md`
names this deferral explicitly. These four states become buildable once LH-040 and LH-041
merge; LH-042 (batch progress + results UI) is the natural ticket to carry them.

**Tests.** `pnpm test -- src/app/api/verify/route.test.ts src/app/_lib/verify-client.test.ts
src/app/_components/VerifyForm.test.tsx src/app/_components/ErrorPanel.test.tsx` — 4 files,
all green.

**How to run it.** Run `source .factory-env` first — `route.test.ts` uses this worktree's
real database. Then run the command above, or `pnpm test` for the full suite.

**Rollback.** `git revert` this ticket's commits. `verify-client.ts`'s timer fix is the
only behavior change; reverting it restores the pre-existing (buggy) timeout-clearing
order. No schema change, no migration.

## TRO-472 — PR #18 review: GitHub CodeRabbit, 14 findings, 14 fixed (2026-08-11)

**What changed.** GitHub's CodeRabbit reviewed PR #18's full branch diff — the design document
plus the local review round below it — and posted 14 actionable comments, `CHANGES_REQUESTED`.
This is a second, independent pass; several findings pushed past what the local round caught.
All 14 were real. The three that most changed the design:

- **The escalation cap could be raced past its own threshold, and its cost bound was wrong as a
  result.** The check counted settled outcomes (`resolvedBySonnetCount + needsHumanCount`), which
  a `RESOLVE` item that exhausts every retry never touches — a batch where every Sonnet attempt
  failed could spend without limit while the cap read zero. Rebuilt around a new
  `batch_jobs.sonnet_call_count` counter, reserved atomically (`UPDATE ... WHERE sonnet_call_count
  < $cap RETURNING ...`) before *every* Sonnet call attempt, first try or retry. `$5.55` is now an
  actual worst-case bound, not a no-race estimate; retries explicitly spend budget, which the
  first draft never decided one way or the other.
- **`claimed_by` alone could not fence a stale completion.** CodeRabbit's own simulation showed
  it precisely: a worker-instance identifier is stable across a worker's whole lifetime, so it
  cannot tell a claim episode a worker still holds from one it held earlier on the same row and
  lost to a lease expiry. Added `claim_token`, generated fresh on every claim including a
  reclaim by the same worker, required by every completion, retry-release, and failure write
  alongside `claimed_by` (kept as the human-facing "which worker" identifier).
- **`EXTRACT` enqueue had no idempotency guard.** Only the `RESOLVE` side did. A retried
  batch-creation step could duplicate an `EXTRACT` row, and nothing in the schema — not
  `batch_queue_items`, not `verifications` — would stop each copy from producing its own
  `verifications` row for the same label. Added a matching partial unique index,
  `(batch_job_id, application_id, label_image_id) WHERE kind = 'EXTRACT'`, and required
  conflict-safe enqueue against it.

Four more real gaps: the claim query never checked `batch_jobs.status = 'RUNNING'`, so a worker
could claim before the batch's own warm-up step ran; the `RESOLVE` completion flow calls
`resolveEscalatedLabel` — which writes `review_queue` internally — before this design's own
completion guard ever runs, an asymmetry with the `EXTRACT` path that was true but unstated;
a losing caller in the TOCTOU race (TRO-506, §3.3) had no defined recovery and would have thrown
uncaught; and the whole-pool 429 cooldown (§5.3) assumed one worker-pool process without saying
so. All four fixed: the claim query now joins `batch_jobs` and requires `RUNNING`; the asymmetry
is now stated plainly, with a required (not optional) recovery — catch the unique-constraint
conflict, load the winning row, complete idempotently, never mark a resolved label `FAILED`; and
the single-process assumption is now explicit, with the multi-instance alternative named for a
future deployment that needs it.

The rest were accuracy fixes matching the local round's own pattern: the opening banner ran four
distinct facts into one dense paragraph (split, ASD-STE100); the worked example's `resolver_input`
snapshot omitted the `schemaVersion` its own requirement demands (added, `"1"`); and the worked
example's final summary said "199 processed successfully" where `processedCount` — by this
document's own definition two sections earlier — is 200, since a failed item still completed its
`EXTRACT` phase (corrected; the outcome split is now a clearly separate, derived line).

Every finding and its fix is recorded in `factory/review-findings.jsonl`.

**How to run it.** No product build is required — still docs-only. Run
`scripts/factory/gate.sh --fast` then the full `scripts/factory/gate.sh`; the `regression-test`
failure both report is expected. Read `docs/checkpoints/cp3-batch-queue.md` §3 and §6 for the
two sections this round changed most.

**Rollback.** `git revert` this commit. The prior two commits' document is internally consistent
on its own, just missing these corrections — reverting does not break anything downstream, since
nothing outside this document depends on it yet.

## TRO-472 — gate's local CodeRabbit pass: 13 findings, 13 fixed (2026-08-11)

**What changed.** The full gate's CodeRabbit capture reviewed `cp3-batch-queue.md` and this
file, found 13 issues, and all 13 were real. Three were genuine correctness gaps in the design
itself, not writing nits:

- **A double-counted `processedCount`.** The decision table incremented `processedCount` again
  when a resolver call exhausted its retries, on a label that had already incremented it once
  at `EXTRACT` `DONE`. Left in, this could push `processedCount` past `totalCount` and fail
  `batch_jobs_processed_count_bounded` outright. Fixed, and the table now says in one sentence
  what `processedCount` counts and does not count.
- **No completion guard.** The design specified an atomic *claim* (§3.1) but not an atomic
  *completion* — a worker whose lease expired mid-call could still write a stale result after
  another worker reclaimed and finished the same item, with nothing stopping a duplicate
  `verifications` row. Added a completion guard to §3.2, same shape as the claim: the write that
  finishes an item is conditioned on still holding it.
- **A missing schema constraint.** `batch_queue_items`'s columns had no rule tying which ones
  apply to which `kind`, and no unique index stopping two `RESOLVE` rows for one verification.
  Added both, mirroring constraints this schema already uses elsewhere for the same shape of
  problem (`label_images_belongs_to_something`, `review_queue_verification_id_unique`).

Two more findings, smaller but still real:

- **The lease-release write was ambiguous.** A worker releasing an item after a retryable
  failure could read as leaving the row `CLAIMED`. Fixed: the release is now one unconditional
  write that clears `claimed_by`, `claimed_at`, and `lease_expires_at`, and sets `status`
  back to `PENDING`.
- **The escalation-cap check was a check-then-act race.** Two resolve-workers could both read
  "under budget" and both proceed. Named, with the fix tied to the same reservation pattern
  already recommended for TRO-506 (superseded by a full fix in the next round — see the entry
  above this one).

Six more findings were accuracy and prose fixes, each mapped to one finding in
`factory/review-findings.jsonl`:

1. A PASS/FAIL decision-table row read as if a router FAIL were "auto-verified," with no
   caveat. Split the row and added the caveat.
2. A rate-limit-utilization claim said "under a fifth." The document's own worst-case number is
   24%. Corrected to "under a fifth for extraction, under a quarter for resolution."
3. The backoff worked example said five waits totaling 31 seconds. Five attempts produce four
   waits, totaling 15 seconds. Corrected.
4. The `resolver_input` snapshot had no version tag. A code change between when a `RESOLVE` row
   is written and read could misinterpret it. Added `schemaVersion`.
5. The 25% escalation-cap threshold did not name its small-batch rounding edge. Named it.
6. Two prose passages ran multiple facts into single sentences: a five-event sequence, and a
   three-fact banner. Rewrote both as separated statements per this repo's ASD-STE100 rule.

Every finding and its fix is recorded in `factory/review-findings.jsonl`.

**How to run it.** No product build is required — this branch is still docs-only. Run
`scripts/factory/gate.sh --fast` then the full `scripts/factory/gate.sh`; both must still run,
and the `regression-test` failure they report is expected (see the walkthrough-material entry
below). Read `docs/checkpoints/cp3-batch-queue.md` directly for the fixes themselves; every one
above is in the section named.

**Rollback.** `git revert` this commit; the prior commit's document is still internally
consistent on its own, just missing these corrections.

## TRO-472 — LH-CP3: ⛔ CHECKPOINT 3 walkthrough material (2026-08-11)

**This entry does not clear a checkpoint.** It adds the material Troy reads at the checkpoint.
One thing differs from CP-1 and CP-2's own entries. Troy's 2026-08-11 policy change (commit
`c09250e`) removed the block on dispatch: LH-040, LH-041, and LH-042 can start once this
material exists and Troy has been notified, without waiting for his reply. That change affects
dispatch only. Troy's acknowledgment is still what makes this design one he accepts, not one an
agent merely produced.

**What changed.** One new document: `docs/checkpoints/cp3-batch-queue.md`. No product code, no
`src/` change, no schema migration. It covers everything the ticket asks for — queue design,
worker concurrency, backoff strategy, the Sonnet sub-queue, partial-failure semantics, a full
worked example — plus a "defend it" Q&A and open questions (TH-R4, TH-R20, TH-R2, TH-R19,
TH-R21, TH-R23).

- **What's actually queuing, and why the existing schema can't answer that alone.**
  `verifications` only records a *finished* cascade result — its own doc comment says so:
  "there is no 'pending' state, because the row exists only once the cascade has produced a
  result." The document designs a new table, `batch_queue_items`, LH-041's own migration, with
  atomic-claim columns (`status`, `claimed_by`, `lease_expires_at`, `available_at`, `attempts`)
  that a finished-only table cannot supply. The Sonnet sub-queue reuses `review_queue` instead
  of a second table — it already has the right unique-per-verification constraint.
- **TRO-506, read and answered concretely, not deferred again.** The Linear finding says two
  concurrent workers can both pay for the same Sonnet call before either insert lands. The
  document's atomic claim (`FOR UPDATE SKIP LOCKED`) makes that structurally impossible under
  normal operation; a narrower residual window (lease expiry during a slow-but-alive worker) is
  named precisely rather than claimed closed, with TRO-506's own recommended fix scoped as a
  follow-up (it also touches the already-shipped review-queue UI's list query).
- **The PRD's own "tuned to Anthropic rate limits" claim, tested against real numbers and found
  not to hold — as a steady-state calculation, not a safety proof.** Anthropic's published
  Start/Build/Scale rate limits for Haiku 4.5 and Sonnet 5 (retrieved live 2026-08-11) show a
  5-worker pool using under a fifth of the Start-tier budget on every axis for extraction, and
  under a quarter for resolution even under CP-1's own 40%-escalation stress case (24% OTPM, the
  single highest figure computed). That arithmetic divides a minute's traffic by a minute's
  budget; it says nothing about the token-bucket, shorter-interval, and acceleration limits
  Anthropic's own page also documents, which can 429 a burst or a usage spike regardless of the
  per-minute average. The real reasons for ~5 are named instead of a false safety margin: an
  unquantified "Evaluation" tier the real account may sit in, unmeasured local-compute limits,
  and blast-radius/cost discipline. The recommendation is to make the number an environment
  variable, with jittered backoff, `retry-after` handling, and a pool-wide cooldown on 429s
  (§5) as the actual defense against bursts and acceleration limits — not the headroom
  arithmetic alone.
- **CP-1's own open question 6, decided, and its cost bound corrected to a real one.** CP-1
  deferred the per-batch Sonnet escalation cap to this document. It adopts CP-1 Q7's proposed
  25% threshold, on a fixed `totalCount` denominator — but the first draft checked settled
  outcomes (`resolvedBySonnetCount + needsHumanCount`), which a batch where every Sonnet attempt
  failed could exceed without ever tripping the cap. Corrected in the review round above to an
  atomic per-batch counter reserved before every Sonnet call attempt, including retries: `$5.55`
  worst-case on a 300-label batch now holds as an actual bound, not a no-race estimate.
- **A full decision table for partial-failure semantics**, plus a precise definition: a batch is
  `COMPLETED` once every queue item reaches a terminal state, whatever that state is — not a
  claim that everything passed. A worker crash mid-batch is explicitly not a job failure; it is
  the case the persistent, leased queue exists to survive.
- **One gap found outside this ticket's scope, named rather than silently fixed.** Single-label
  REVIEW verdicts appear to have no automatic resolution trigger at all today — nothing outside
  test files calls `resolveEscalatedLabel`. Flagged as an open question for a follow-up ticket,
  not folded into this design.
- **Six open questions**, each with a recommendation and the cost of choosing wrong — including
  whether "~5" is one pool or two, and whether the TRO-506 hardening should land now or as its
  own ticket.

**How to run it.** Nothing to build, nothing to test — this branch adds no code. Read
`docs/checkpoints/cp3-batch-queue.md` — about 40 minutes — and work the Appendix A checklist
during the walkthrough. Appendix B names the live URL and the file:line citations behind every
**verified** and **derived** claim.

**Rollback.** `git revert` this commit. The document adds no code and nothing imports it.

**Known limits.** Every worker-pool size, lease duration, and backoff parameter is **proposed**,
not measured — LH-031's latency harness is what replaces them, the same pattern CP-1 and CP-2
used for their own thresholds. The local-compute ceiling (§4.4) and the actual deployed
account's rate-limit tier (§4.2) are both **not measured**.

## TRO-468 — LH-020: Warning subsystem (2026-08-11)

**What changed.** This ticket builds the government-warning comparator (TH-R9) under
`src/server/warning/`. CP-2 (`docs/checkpoints/cp2-warning-subsystem.md`) is the
Troy-approved design. This ticket implements it as written.

The comparator checks one thing. Does the label's government warning match 27 CFR part 16,
word for word? It checks a second thing too. Does `GOVERNMENT WARNING` print in capital
letters? Two independent readers feed the check. A vision model transcribes the label. A
local OCR engine, tesseract.js, reads the same block again. Code compares both readings
against the statutory text. No model ever judges whether the warning "looks right." That
split is CP-2's whole argument.

This ticket calls no model. It consumes the vision model's transcription, which the
extractor (LH-011) already produced. It runs its own OCR pass and its own region detection.

**Files.**
- `canonical.ts` — the statutory text, retrieved live from the eCFR API on 2026-08-11 and
  cross-checked against a committed XML fixture (`fixtures/ecfr-16-21.xml`). A future edit to
  the constant that drifts from the source fails a test. It does not ship silently.
- `normalize.ts` — `normalizeTransport`, the six CP-2 §5.2 rules in their fixed order. Unicode
  NFC, not NFKC. Four named space characters map to a plain space. Zero-width characters
  strip out. A hyphen at a line break joins, before line breaks collapse to spaces. Case never
  changes here. `foldCase` is a separate, later step.
- `caps.ts` — `checkCapitalPositions`. Four positions, hard-enforced. `GOVERNMENT` and
  `WARNING` need every letter capitalized (27 CFR 16.22(a)(2)). `Surgeon` and `General` need
  only their first letter capitalized (TTB's own label checklist).
- `distance.ts` — a Levenshtein implementation local to this module. It does not import
  `../comparators/similarity.ts`. The judgment regime (TH-R8) and the exact regime (TH-R9)
  share no helpers. Not even a generic algorithm.
- `wording-compare.ts` — `evaluateCandidate`, CP-2 §3.3's per-candidate algorithm, plus the
  §5.5 near-miss band. A distance of 1 or 2 after normalization returns REVIEW, not FAIL.
- `reconcile.ts` — `reconcileWarningChannels`. CP-2 §4.5's dual- and single-channel decision
  tables. CP-2 §7.1's cross-check against the model's own `prefix_casing` report. Produces
  `../router/types.ts`'s `WarningComparatorResult`.
- `ocr.ts` — `runWarningOcr`, the tesseract.js wrapper. Crop-only. `PSM.SINGLE_BLOCK`,
  confirmed against the installed library, not guessed.
- `tessdata/eng.traineddata.gz` — the English language file, committed to the repo so
  recognition never reaches the network (TH-R7). 2.8 MB. The LSTM-only variant, matching
  tesseract.js's own default engine mode.
- `ocr-network-guard.cjs`, `ocr-startup.test.ts` — the "network disabled" startup test CP-2
  §4.3 requires by name. A fresh Node process runs with `fetch`/`http`/`https` blocked.
  Recognition still succeeds, using only the committed file.
- `region-detect.ts` — `detectWarningRegionClassical` (primary) and
  `detectWarningRegionByBandSearch` (fallback). Classical detection finds the warning by its
  shape: a dense, several-line block of small print. It runs in milliseconds and needs no
  OCR, so OCR can still start at the same time as the Haiku call. `cropForOcr` outputs PNG,
  never JPEG — tesseract needs no re-encode, and JPEG compression would hurt exactly the
  small print this channel exists to read.
- `index.ts` — the module's public entry point. `compareGovernmentWarningFromImage` ties
  region detection, cropping, OCR, and `reconcileWarningChannels` together against a real
  image.

**Load-bearing decisions.** CP-2 §11 lists ten open questions with a recommendation each.
"Cp2 is good" means implement the recommendation. This ticket did, and names each one here.

- Four checked capitalization positions, all adopted (open question 1): `GOVERNMENT`,
  `WARNING`, `Surgeon`, `General`. Case folds everywhere else in the body.
- The near-miss band, adopted at N = 2 (open question 2). A distance of 1 or 2 returns
  REVIEW. The band never touches capitalization, and never turns a FAIL into a PASS.
- Classical detection first, band search second (open question 3). A model-reported box was
  rejected. It cannot exist before the Haiku call returns, which breaks the concurrency
  requirement.
- `WarningComparatorResult`'s union stays as CP-1 defined it (open question 4). Channel
  disagreement routes as `WARNING_MISMATCH`. `CONFLICTING_EXTRACTION` and
  `LOW_MODEL_CONFIDENCE` never come out of this comparator.
- One bold flag, kept for the prototype (open question 5). The second bold rule in 27 CFR
  16.22(a)(2) — the body must NOT print bold — stays named as unchecked, in the limitation
  comment `wording-compare.ts` and `reconcile.ts` carry, not silently dropped.
- The OCR crop skips the JPEG re-encode (open question 6). `cropForOcr` is this module's own
  function. It does not call `../preprocessing/pipeline.ts`'s `cropRegion`, which always
  encodes JPEG.
- The OCR confidence floor stays at 60 (open question 7), Tesseract's own 0-100 scale. Below
  it, the OCR reading is discarded and the comparator runs single-channel.
- A single channel may PASS at VLM confidence 0.90 or above (open question 10). A single
  channel may never FAIL. "We never accuse on one channel" is CP-2's own line for this.
- The two-element canonical constant (open question 8): `CANONICAL_WARNING_PARAGRAPHS` is a
  tuple, not one 283-character literal. It matches the two `<P>` elements eCFR itself renders.
- One decision beyond the ten open questions: CP-2 §7.1 says the model's `prefix_casing`
  report is "a cross-check, not the source of truth," and that a disagreement between it and
  the derived caps result routes to REVIEW. CP-2 does not spell out the exact rule. This
  ticket's reading: derived-ALL-CAPS and reported-ALL_CAPS must agree, treating `TITLE_CASE`
  and `OTHER` as real, competing claims — the model asserting a specific non-ALL_CAPS reading.
  `NOT_VISIBLE` is not a claim. It means the model could not judge the casing at all, so it is
  excluded from the check rather than treated as an active "not ALL_CAPS" vote — a review-round
  fix, below. A disagreement can only downgrade an already-decided PASS or FAIL to REVIEW. It
  never upgrades a REVIEW to anything else.

**Review round.** A local CodeRabbit pass ran against the first commit. It found 13 findings,
folded into this same entry rather than a separate one, since no PR had opened yet.
- **Major.** `applyPrefixCasingCrossCheck` treated `NOT_VISIBLE` — the model could not judge
  the prefix's casing at all — the same as an active "not ALL_CAPS" claim. A correct, confident
  derived ALL_CAPS read got flagged as inconsistent whenever the model merely abstained. Fixed:
  `NOT_VISIBLE` now leaves the result unchanged, in both directions. `OTHER` and `TITLE_CASE`
  still count, since those are real, competing claims.
- **Major.** `runOcrChannel` did not catch a rejected `deps.detectRegion`/`crop`/`ocr` promise.
  A rejection would reject the whole `Promise.all`, discarding an already-good VLM read along
  with it. Fixed: wrapped in `try`/`catch`, returning `{ available: false }`.
- **Major.** `runWarningOcr` called `worker.terminate()` inside a bare `finally` block. A
  termination failure would replace an already-successful `recognize()` result with a thrown
  error. Fixed: the result is captured first; `terminate()`'s own failure is isolated so it
  cannot destroy a good read.
- **Major.** The OCR startup test's child process set `NODE_OPTIONS` to the guard's `--require`
  flag alone, overwriting any value the parent process already carried, and inserted the guard
  path unquoted into a value Node splits on whitespace — a repo path with a space in it would
  have corrupted the flag. Fixed: appends to any existing `NODE_OPTIONS`, quotes the path.
- **Major.** `wording-compare.test.ts` defined its own `capsPassesFor` helper, duplicating
  `caps.ts`'s own exported `capsCheckPasses`. Fixed: removed, call site uses the shared function.
- **Minor.** `dehyphenateAtLineBreaks` matched a hyphen before `\n` or `\r\n` but not a bare
  `\r` — inconsistent with `lineBreaksToSpace`, which handles all three line-break forms. Fixed.
- **Minor.** `__dirname`, used in two test files, is not defined in genuine ESM; it only
  resolved because vitest's own transform shims it. Fixed: `import.meta.dirname`.
- **Minor.** A real-image OCR test pinned its confidence assertion to a specific measured
  number, fragile against a CI environment that substitutes a different font for the synthetic
  render. Fixed: asserts against `OCR_CONFIDENCE_FLOOR`, the number that actually matters.
- **Trivial.** Three tests strengthened to check the exact UI note text or the
  confidence-below-floor property, not only the verdict. CHANGES.md's own wording tightened.
- **Dismissed, both false-positive.** A suggestion to add latency-metric instrumentation to
  `region-detect.ts`, citing a metrics convention that does not exist anywhere in this
  codebase — LH-031 is the latency-harness ticket, not this one. A suggestion to resolve
  `TESSDATA_DIR` from something other than `process.cwd()`: that matches
  `src/server/storage/local-file-storage.ts`'s own established convention exactly, and
  `pnpm build` (measured, passes clean) already includes `tessdata/` with no extra
  configuration — there is no `output: "standalone"` in `next.config.ts` to need one.

All 13 findings are recorded in `factory/review-findings.jsonl`.

**Regression tests.** `src/server/warning/*.test.ts` — 11 files, 119 cases (115 from the
initial build, 4 more from the review round below), all written
before their implementation. Every file's first run failed on a missing module, confirmed
before any implementation code existed.

Named cases: `case-08` and `case-09` (title-case prefix, TH-R9's acceptance evidence) MISMATCH
on capitalization; `case-10` and `case-11` (reworded clauses, measured distance 38 and 24)
MISMATCH on wording; the canonical text itself PASSes; `surgeon general` in lower case and a
missing comma after `General` (both named common mistakes in TTB's own brewer training deck)
are covered directly, since no golden-set image can isolate them yet — that is LH-021's job.
Channel disagreement has its own synthetic test suite, `reconcile.test.ts`, since CP-2 §9.2
finding 3 is right: no photograph can exercise two readers disagreeing.

`golden-case.test.ts` loads `golden-set/manifest.json` directly and checks this comparator's
verdict against each case's own expected verdict, not a hand-copied string.

`region-detect.test.ts` and `index.test.ts` both run the real pipeline — real image, real
OCR, real region detection — against `case-01-clean-match-spirits.jpg`, not only synthetic
fixtures. Measured while building this ticket, not assumed: six real golden-set label images
with a warning present are all correctly located and read back at 90-95% confidence (54% on
the one case with deliberately tiny print, which is below the OCR confidence floor and
therefore correctly discarded); two images with no warning correctly return no region at all.

**How to run it.** `pnpm test -- src/server/warning` runs 11 files. `pnpm typecheck` and
`pnpm lint` both run clean.

**Known limits.**
- `src/app/api/verify/route.ts` still passes `warningResult: null` to `routeLabel`, exactly
  as it did before this ticket. This ticket was scoped to the comparator itself — CP-2's own
  "own component" framing, and the ticket's list of existing code to build on names
  `region.ts`, `pipeline.ts`, `constants.ts`, and `router/types.ts`, not `route.ts`. Wiring
  `compareGovernmentWarningFromImage` into the live request path is a separate, later change
  to `route.ts` and its own test suite. `route.ts` must start region detection and OCR before
  it awaits the Haiku call, not after, to keep PRD §3.8's concurrency requirement. That is a
  real control-flow change, not a one-line import swap, so this ticket leaves it named here
  as follow-up work rather than folding it in.
  **Closed by TRO-514** (entry below): `route.ts` now calls `compareGovernmentWarningFromImage`
  concurrently with the Haiku call, exactly as this bullet specified.
- The full golden set's OCR/detection accuracy is not measured. LH-030's eval-harness sweep
  is the ticket that measures it, per CP-2 §12.
- The live drift check CP-2 §2.7 describes (a scheduled or manual re-fetch of the eCFR text,
  reporting a difference for a human to read) is not built. The deterministic, offline half —
  the constant checked against a committed fixture — is built and gated. The doc is explicit
  that the two are separate mechanisms; only the first is a CI concern.
- Bold detection stays exactly the documented limitation CP-2 §7.3 drafted: an advisory
  three-valued signal from the vision model, never checked, never changing a verdict.

**Rollback.** `git revert` this ticket's commits on `feat/lh-020-warning-subsystem`.
`src/server/warning/*.ts` and `*.test.ts`, `tessdata/`, and the `tesseract.js` dependency are
removed. No other module imports from `src/server/warning/` yet, so nothing else breaks.

## TRO-498 — PR #17 CI fix + 12 CodeRabbit findings (realistic-corpus Gemini pipeline) (2026-08-11)

**Fixed — CI regression.** CI's verify job failed on `build.test.ts`'s new compositing test.
The real cause: `.github/workflows/ci.yml` never ran `playwright install`. No test that
launches a real Chromium could pass on a fresh runner. This is not the same defect as the
rescale bug below — confirmed by reading the actual failed CI run's uploaded
`unit-tests.json` artifact, not by assumption. Added a
`pnpm exec playwright install --with-deps chromium` step before the unit-test step.

`render.test.ts`'s pre-existing renderer-determinism tests carried the identical defect.
This defect stayed silently uncaught. A `beforeAll` hook failure reports as skipped tests,
plus a failed test file with no per-assertion failure. `testdiff.mjs` only inspects
assertion-level results, so it never saw this failure either. Not fixed here — flagged as a
separate gap below.

**Fixed — 12 CodeRabbit findings**, across the original PR review and a fresh local
CodeRabbit pass run after this round's own fixes, each checked against the real code before
any change:

1. `scripts/golden/blankRegionDetector.ts` — `toOriginal` reused the horizontal rescale
   factor for the vertical axis too. `detectionHeight` is a rounded value; the real
   vertical factor is `originalHeight / detectionHeight`, not
   `originalWidth / DETECTION_WIDTH`. Fixed with independent per-axis factors. Added a
   fixture confirmed red-first against the pre-fix logic (a 5px miss the existing corner
   tests' 15px tolerance would have absorbed without ever noticing).
2. `scripts/golden/imagen.ts` — `enumerateTargets` now rejects a duplicate `targetCaseId`
   before any Gemini call. Two reference files sharing a `bottleId`, or one file repeating
   a scene, would have silently overwritten an earlier generation result and paid for a
   wasted API call.
3. `scripts/golden/imagen.ts` — a real security finding, not a style nit. `bottleId` and
   `sceneId` feed a filename with no safe-slug check. A value like
   `x/../../../../tmp/pwned` reached `path.join` unvalidated and wrote outside
   `golden-set/backdrops/` — reproduced empirically before fixing. Added slug validation
   at target-construction time and an independent path-containment check in `generateOne`.
4. `scripts/golden/imagen.ts` — `generateWithGemini` hardcoded the reference photo's MIME
   type as `image/jpeg` regardless of its real content. `generateOne` wrote every
   generated response as `<caseId>.png` regardless of what Gemini actually returned.
   Both now derive from real content: the reference type from the file's own signature,
   the response transcoded to real PNG bytes whenever it is not already `image/png`.
5. `src/lib/golden-set/loader.ts` — `checkGenerationMetadata` only checked
   `generatedAt` for a non-empty string, so a malformed value like `"unknown"` passed.
   Added a real ISO-8601 check that round-trips the value through
   `Date.prototype.toISOString()`.
6. `golden-set/README.md` — the manual manifest-entry instructions never told the
   operator what to do when `generateOne` writes `labelPlacement: null` (detection
   failed). Now explicit: measure a real quadrilateral by hand, and keep
   `verified: false` until both the placement is real and a human confirms the composite.
7. `golden-set/README.md` — rewrote the surrounding prose per CLAUDE.md's ASD-STE100
   rule: short, single-actor sentences instead of dense multi-clause ones. No workflow or
   technical detail changed.
8. `scripts/golden/imagen.ts` — `bottle.referencePhoto` had the same missing-validation gap
   as finding 3, on the read side: it reached `readFileSync` in `generateWithGemini` with no
   containment check. A traversal value could read an arbitrary file (including `.env.local`,
   which holds this repo's real API keys) and send its bytes to Gemini. Now resolved and
   checked against `assets/golden/references/` before use.
9. `scripts/golden/imagen.ts` — `generateOne` computed its output-path safety checks after
   calling Gemini, not before. An unsafe target would already have cost a real API call
   before `generateOne` refused to write it. Moved the checks first; added a test proving
   `generate` is never invoked for an unsafe target.
10. `scripts/golden/imagen.ts` — `ensurePngBytes` trusted Gemini's self-reported `mimeType`
    label instead of checking the response's real bytes. This is the same unverified-claim
    pattern finding 4 already removed on the request side. Now detects the format from
    content only; the `mimeType` parameter is gone.
11. `src/lib/golden-set/loader.test.ts` — the suite tested a malformed `labelPlacement`
    corner, and a `generationMetadata` object missing one nested field. It never tested
    either key missing entirely. Added both cases.
12. `scripts/golden/build.test.ts` — the compositing test asserted only output dimensions.
    A regression that silently returned the backdrop untouched would still have passed.
    Added a center-pixel check against the backdrop's known solid color.

**Known gap, not fixed this round.** `testdiff.mjs`'s vitest adapter only inspects
`assertionResults`, so a `beforeAll`/`afterAll` hook failure in a file that also has
passing or skipped tests never becomes a reported failure identity — `render.test.ts`'s
renderer-determinism suite hit exactly this. Out of scope here (`testdiff.mjs` is shared
factory infrastructure, not a file this ticket touches); flagged for a follow-up ticket.

**How to run it.** `source .factory-env` first — every test command below needs
`DATABASE_URL` pointed at this ticket's own worktree database.
- `pnpm test -- scripts/golden/blankRegionDetector.test.ts scripts/golden/imagen.test.ts src/lib/golden-set/loader.test.ts scripts/golden/build.test.ts` —
  the suites this round's fixes touch. All pass locally (Chromium already cached on this
  machine); CI will confirm the Playwright-install fix on a fresh runner.
- `pnpm typecheck && pnpm lint` — clean on this branch.
- `scripts/factory/gate.sh` — full gate, run from the ticket worktree.

**Rollback.** `git revert` the commits tagged TRO-498 on this branch. Each fix is its own
commit. Reverting the CI-install commit alone restores the original CI failure; reverting
any one code-fix commit restores that specific defect without touching the others.

## TRO-476 — PR #16 review round 2: 34 CodeRabbit findings, 30 fixed, 1 filed, 3 dismissed (2026-08-11)

**What changed.** CodeRabbit reviewed PR #16 six times. The GitHub PR review reported 11
findings. The gate's local CLI capture then ran five more times, once against each new
commit. Those five rounds reported 9, then 4, then 4, then 3, then 3 more findings. The
orchestrator checked every finding against the current code, not on trust. All 34 findings
named a real issue or a legitimate duplicate. Thirty are fixed here. One is real but out of
this PR's scope; it is filed as TRO-507. Three are dismissed, with reasons stated below.
`factory/review-findings.jsonl` is the final, authoritative count from here — CodeRabbit's
own review of a commit that restates this count necessarily reviews a commit one count behind
itself, so this paragraph stops chasing the exact number past this point.

**Buttons stayed live after a conflict.** A 409 conflict left the Approve and Reject buttons
enabled. A retry could only ever 409 again. TH-R3 asks for no hidden actions. A dead action
is one kind of hidden action. A conflict now disables both buttons for good. The fix first
missed one case: a 409 body with no specific `conflictDisposition` field still fell through
to the retryable branch. The local CLI pass caught it. Every `CONFLICT` is terminal now,
named decision or not.

**A callback failure could look like a record failure.** `onResolved` ran inside the same
`try` block as the network call. A failure in the caller's own callback, for example a
failed `router.push`, was reported as "could not record this decision." The server had
already recorded it. `onResolved` now runs only after the success state is committed, and
its own errors are caught and logged, not left to reject an unobserved promise.

**A manual refresh unmounted the list.** The reviewer lost their scroll position on every
refresh. This file's own comment names a queue a reviewer can churn through smoothly as the
whole point of the control. A refresh now keeps the rows mounted. The button reads
"Refreshing…" while the request is in flight.

**Neither review-queue request had a timeout.** A hung connection left the queue loading and
the action buttons disabled with no way out. Both requests now abort after 15 seconds. This
matches `verify-client.ts`'s own pattern, sized down: neither call here reaches a model. The
first version of this fix cleared the timer right after the fetch resolved, so a response
whose body never finished parsing had no timeout protection at all. The timer now stays live
through the body read too.

**A malformed timestamp could render as "Invalid Date UTC."** `createdAt` and `disposedAt`
were checked as strings, not as timestamps that parse. Both now require `new Date(value)` to
succeed.

**Wire IDs were checked as numbers, not as the server's own contract.** The server route
rejects a zero, negative, or fractional id. The client accepted any number as a valid wire
id. The client now requires the same positive-integer shape the server enforces.

**The list query took no floor or ceiling on its own `limit` argument.** Nothing today calls
it with anything but the default, so this is a boundary hardened before it is exercised, not
a fix to an active bug. `listUnresolvedReviewQueue` now rejects a limit outside 1 through 100
before it reaches `.limit()`.

**Both review-queue routes discarded the caught error before their 503.** An operator seeing
repeated 503 responses had no signal to diagnose. Both routes now log the cause first.
`console.error` is `db/index.ts`'s own existing pattern. CodeRabbit named `verify/route.ts`
instead; that file binds its caught error for type-checking, not for logging. It sets no
precedent to follow.

**Every row's link shared one accessible name.** A screen-reader user listing the page's
links could not tell rows apart. The name now includes the brand. The timestamp now sits
inside a `<time dateTime=…>` element.

**The success banner had no live-region role.** A screen reader never announced it. Added
`role="status"`, matching the error panel's existing `role="alert"`.

**Three test gaps closed.** A 409 response missing `disposition` had no coverage. A test
titled "without touching the database" asserted only the response, not the claim in its own
name — it now injects a `db` that throws on any access. `ReviewQueueList.test.tsx` matched
any link name loosely; it now requires the exact name and checks the `<time>` element's
`dateTime` attribute.

**`route.test.ts` and `[reviewQueueId]/route.test.ts` duplicated the same fixture and
cleanup helpers.** Both now import them from a new `test-support.ts`.

**A failed manual refresh replaced a working list with a bare error panel.** The reviewer
lost the rows they already had on screen. A refresh failure now keeps the rows mounted and
shows the error alongside them, the same principle as the earlier in-flight-refresh fix. That
fix itself missed one case: retrying after a failed refresh checked only whether the previous
attempt had *succeeded* before deciding to keep the rows mounted. Retrying after a *failed*
refresh fell through to the bare loading state and unmounted the list again. Both cases now
keep the rows mounted.

**The PATCH response's `id` field used a weaker check than the list response's items.** Both
now require the same positive-integer shape the server route itself enforces. A shape check
alone does not confirm a response is even about the item just requested — `submitDisposition`
now also requires the response's own `id` to match the `reviewQueueId` that was sent.

**The review-queue action route and detail page both validated ids with `Number.isInteger`,
not `Number.isSafeInteger`.** Same class this session's own `verify/[verificationId]/page.tsx`
fix already addressed elsewhere: precision loss above `Number.MAX_SAFE_INTEGER` can round a
long digit string to a different, smaller integer and silently address the wrong row. Both
now use `isSafeInteger`.

**Dismissed: `format-timestamp.ts`'s minute-level precision.** A reviewer suggested
second-level precision for the "waiting since" timestamp. This is a triage cue for a human
scanning a queue, not a legal-record field. The file's own doc comment already states the
accuracy rationale for an absolute UTC timestamp. Minute-level is the correct grain for that
purpose. Not changed.

**Filed as TRO-507, not fixed here.** CodeRabbit tagged it a "Heavy lift." The list endpoint
defaults to 100 rows. It has no pagination past that limit. CHANGES.md's own claim below
("returns every unresolved item") is corrected in place to state the current, accurate
limit. Two later local rounds re-flagged the same gap against later commits. Both dismissed
as duplicates of TRO-507, not fixed a second or third time.

**Tests.** `pnpm test -- src/app/_components/ReviewActions.test.tsx
src/app/_components/ReviewQueueBrowser.test.tsx src/app/_lib/review-queue-client.test.ts
src/app/api/review-queue src/server/review-queue` — every fix above has a new or extended
case that failed before the fix and passes after.

**How to run it.** Point `DATABASE_URL` at this worktree's own database first — schema
provisioning resets it. `source .factory-env`, then `pnpm test`, `pnpm typecheck`, `pnpm
lint`, `pnpm build`.

**Rollback.** `git revert` this commit. The two TRO-476 entries below stand on their own;
this round only tightens them.

## TRO-476 — local CodeRabbit review round 1: 6 findings, 6 fixed (2026-08-11)

**What changed.** `scripts/factory/gate.sh`'s local CodeRabbit CLI reviewed this branch
against `main`. It reported 6 findings. This entry checked each one against the current
code, not on trust. All 6 named a real, narrow defect. This round fixes all 6.

- **`review-queue-client.ts` — the list response's `items` array was checked for shape, not
  its contents.** `isReviewQueueListResponse` confirmed `items` was an array. It never
  checked what was inside. A malformed entry would have reached `ReviewQueueList.tsx` as if
  it were real. `isReviewQueueListItemWire` now checks every field of every entry, enum
  fields included, against the real closed set — not just "is a string."
- **`get-item.test.ts` — a defensive branch ran on every test but no test checked it.** This
  file's fixture inserts only two of five `field_results` rows. The other three always hit
  `get-item.ts`'s "no result was recorded" fallback. No assertion ever looked at that
  fallback's shape. One test now checks it directly.
- **`types.ts` — `ResolverSuggestedField` used two fields that only made sense some of the
  time.** `disposition` was only ever set on a `"judged"` field. `needsHuman` was only ever
  set on a `"correction"` field. CLAUDE.md's own standing rule 19 asks for a discriminated
  union in exactly this case, not two independently-optional fields. `ResolverSuggestedField`
  is now a proper union, keyed on `kind`.
- **`types.ts` — one doc comment explained the wrong field.** The comment above
  `ReviewQueueItemDetail.disposition` was really about `resolverOutput` and
  `resolveEscalatedLabel`. That explanation now sits with `resolverNote`, the field it
  actually describes. `disposition`'s own comment is about `disposition` only.
- **`record-disposition.test.ts` — a test helper's own fallback error could get swallowed by
  its own `catch` block.** `expectCheckConstraintViolation` threw its "nothing threw" error
  inside the same `try` block that awaited the real promise. Its own `catch` then caught
  that error and asserted on an undefined `.cause` — a confusing failure, not the intended
  one. The fallback error now throws after the `try`/`catch`, not inside it. A new test
  proves the helper reports the right message.
- **`list.ts` — no limit, and no tiebreaker for two rows sharing one `createdAt`.**
  `listUnresolvedReviewQueue` read every unresolved row with no bound. A large, real queue
  would read all of it on every page load. Two rows created in the same instant had no
  guaranteed order between them. `listUnresolvedReviewQueue` now takes an optional `limit`
  (default 100) and orders by `createdAt` then `id`, so ties resolve the same way every time.

**Tests.** `pnpm test -- src/server/review-queue src/app/_lib/review-queue-client.test.ts
src/app/_components/ReviewItemDetail.test.tsx` runs 5 files and 34 cases (up from 30 before
this round). Every new case in this round was checked against the pre-fix code by reasoning
through the code path, not run against a deliberately-broken copy — each is explained above
in terms of exactly what the old code did wrong.

**How to run it.** `source .factory-env` first. `pnpm test -- src/server/review-queue
src/app/_lib/review-queue-client.test.ts src/app/_components/ReviewItemDetail.test.tsx`.
`pnpm test` for the full suite. `pnpm typecheck` and `pnpm lint` are both clean.

**Rollback.** `git revert` this commit. The TRO-476 entry below stands on its own; this
round only tightens it.

## TRO-476 — LH-050: Review queue UI (2026-08-11)

**What changed.** This ticket builds the review queue (PRD §5). A person uses this screen
to approve or reject a label. The router or the resolver could not decide that label alone.

**This is TH-R22's differentiator.** LabelHunter routes every label through a
confidence-based cascade:

1. Haiku extracts the label's fields.
2. Code routes each field deterministically.
3. Sonnet resolves an escalation.
4. A human makes the final call on what is still uncertain.

The review queue is the visible end of that chain. It turns "uncertain beats wrong" from an
internal rule into a real screen. A TTB reviewer can act on it directly. The
escalation-to-human-review loop is the differentiated idea. It is not a UI detail added on
top.

- **List endpoint.** `GET /api/review-queue` (`src/app/api/review-queue/route.ts`) returns
  unresolved items, oldest first, up to `listUnresolvedReviewQueue`'s default 100-row limit
  (round 1's own fix, above). It does not paginate past that limit yet — see round 2, below.
  Its `WHERE` clause matches `review_queue_unresolved_idx` (`schema.ts`), the partial index
  built for this query.
  `EXPLAIN` against this worktree's database confirms the index serves the filter. The
  table was empty during that check. This is not a claim about a larger, real-world table.
  See `src/server/review-queue/list.ts`'s own comment for the exact, honest result.
- **Action endpoint.** `PATCH /api/review-queue/:reviewQueueId`
  (`src/app/api/review-queue/[reviewQueueId]/route.ts`) records `APPROVED` or `REJECTED`.
  `recordDisposition` (`src/server/review-queue/record-disposition.ts`) sets `disposition`
  and `disposedAt` together, in one guarded `UPDATE … WHERE disposition IS NULL`. Two
  reviewers acting on the same item cannot both win this way. A second call returns 409. It
  carries whichever decision already won, so the client can show "Someone already rejected
  this item" instead of a bare conflict message.
- **Queue list page** (`/review-queue`, `ReviewQueueBrowser.tsx` + `ReviewQueueList.tsx`).
  Each row shows the reason, brief context (brand, class/type), and a link to the item. A
  manual refresh button re-fetches the list. An empty queue shows one designed message: "No
  items need review right now."
- **Review/detail page** (`/review-queue/:id`, `ReviewItemWorkspace.tsx` +
  `ReviewItemDetail.tsx` + `ReviewActions.tsx`). It shows the reason, the full per-field
  extracted-vs-application comparison, and the resolver's suggestion when one exists. Two
  large Approve/Reject buttons record the decision.
- **`resolverOutput` null is the normal case, not an error state.** Nothing in this running
  system calls the Sonnet resolver off a `review_queue` row yet. `route.ts` writes the row.
  The consumer that would call `resolveEscalatedLabel` against it is LH-041's job, behind
  CP-3. It does not exist yet. Every item reachable through the app's real request path
  today shows its reason. A human decides with no resolver suggestion present. This is the
  case this ticket designed for, not a fallback case. `get-item.ts` also reads a populated
  `resolverOutput` correctly, for whenever LH-041 lands or a test fixture supplies one.
- **No verdict mutation.** PRD §5 says "approve/reject records disposition." It does not say
  a disposition changes `verifications.verdict`. This ticket records the disposition only.
  Whether a later ticket should also update the verdict is an open question. This entry
  flags it; it does not answer it.
- **No reviewer identity anywhere.** TH-R6 and `schema.ts`'s own comment on `review_queue`
  are explicit about this rule. This ticket adds no reviewer-identity column and no such
  field.

**On LH-016 (TRO-466, the Detail view) — a premise correction.** This ticket's brief assumed
two files were already merged into this branch's base:
`src/server/verification-detail/get-verification-detail.ts` and `DetailView.tsx`. They are
not. PR #15 (`feat/lh-016-detail-view`) is still open. `factory/tickets.md`'s own LH-050
entry lists it as "Blocked by LH-014" only, not LH-016. This ticket does not depend on that
PR merging first.

`src/server/review-queue/get-item.ts` reads the same database tables independently. It
reuses two things that are actually merged: `ResultsChecklist.tsx`'s CSS classes, and
`src/server/router/index.ts`'s own wording (lines 227 and 252) for an unfiled optional field
and for the government warning's application-side text. It does not show the label image.
That route is also LH-016's, also unmerged. PRD §5's review-queue line does not ask for a
photo. `src/app/_components/ReviewItemDetail.tsx` uses a `review-field*` CSS prefix, not
`detail-field*`, to avoid a name collision with `DetailView.tsx`'s own rules once that PR
lands.

**Tests.** Written first. Each one failed for the right reason before implementation. All
are green now.

- `src/lib/db/enums.test.ts` — `toReviewDisposition`.
- `src/server/review-queue/list.test.ts`, `get-item.test.ts`, `record-disposition.test.ts` —
  against this worktree's real database. Two tests try to violate
  `review_queue_disposition_disposed_at_consistency` directly, with an `UPDATE` and an
  `INSERT`, in both column directions. Both confirm the database itself rejects the write,
  not only this module's own code.
- `src/app/api/review-queue/route.test.ts` and
  `src/app/api/review-queue/[reviewQueueId]/route.test.ts` — the two HTTP endpoints,
  including the 400/404/409 error paths.
- `src/app/_lib/format-timestamp.test.ts` and `review-queue-client.test.ts`.
- `src/app/_components/ReviewQueueList.test.tsx`, `ReviewItemDetail.test.tsx`,
  `ReviewActions.test.tsx`, and `ReviewQueueBrowser.test.tsx`.

This command runs 12 files and 67 cases, all new or touched by this ticket:

`pnpm test -- src/server/review-queue src/app/api/review-queue src/app/_lib/review-queue-client.test.ts src/app/_lib/format-timestamp.test.ts src/app/_components/Review src/lib/db/enums.test.ts`

**How to run it.** Run `source .factory-env` first. Several of these tests need
`DATABASE_URL` pointed at a migrated worktree database. Then run the command above, or run
`pnpm test` for the full suite (646 cases pass). `pnpm typecheck`, `pnpm lint`, and
`pnpm build` are all clean. `pnpm build` shows `/review-queue` prerendered as a static
shell. Its data comes from the client-side `GET /api/review-queue` call, marked dynamic, not
from anything baked in at build time. `pnpm build` shows `/review-queue/:id` server-rendered
on demand. Both match this ticket's design.

**Rollback.** Run `git revert` on this ticket's commits, in reverse order. This ticket makes
no schema change and no migration, so there is nothing to roll back at the database level.
`src/lib/db/enums.ts`'s `toReviewDisposition` is additive. No other ticket uses it yet, so
reverting it is safe.

## TRO-466 — PR #15 review round 2: 3 findings, 1 fixed, 2 dismissed (2026-08-11)

**Fixed.** `src/app/api/label-images/[labelImageId]/route.ts` treated any `readLabelImage`
failure as a missing file (404). A permissions error or a disk I/O error is a different fact —
the row and the file both exist, something else went wrong, and that is a server error, not a
404. Fixed: checks `error.code === "ENOENT"` specifically; anything else now answers 500. One
new regression test injects an `EACCES` error and confirms 500, not 404 — confirmed red first.

**Dismissed.**
- The "add auth" finding is an exact duplicate of round 1's already-dismissed finding on this
  same route — no auth mechanism exists anywhere in this app yet; deferred to LH-061 (TRO-482).
- A finding asked `vitest.setup.ts` (loads for every test file) to reject an unset
  `DATABASE_URL` globally, before any test runs. Checked, not assumed: only 2 of 48
  `*.test.ts(x)` files under `src/` reference `DATABASE_URL` at all — the rest are pure-function
  and component tests with no database dependency. A global guard would break roughly 46
  legitimate tests that have never needed one. The underlying concern (this repo's own
  `DATABASE_URL` discipline) is real, but the right fix is a per-file or per-DB-helper guard,
  not a blanket one — out of scope for a one-line change on this ticket.

**How to run it.** `pnpm test -- "src/app/api/label-images"`, `pnpm typecheck`. Both ran clean.

**Rollback.** `git revert` this commit. The `isMissingFileError`/`readFailed` helpers and the
new test are additive; reverting restores the prior (over-broad 404) behavior.

## TRO-466 — PR review round 1: local CodeRabbit pass, 7 fixed, 1 dismissed (2026-08-11)

**What changed.** A local CodeRabbit pass against this branch posted 8 findings. Seven are
real. This entry fixes all seven. One finding is dismissed below. This entry states the
reason.

Fixed:
- `src/app/verify/[verificationId]/page.tsx` (a real correctness gap): the not-found
  branches rendered a plain component. That answered HTTP 200, with "not found" wording in
  the body. The words were honest; the status code was wrong. Fixed: call
  `next/navigation`'s `notFound()` instead, backed by a new `not-found.tsx` in the same
  route segment. Observed with a real `pnpm dev` run: `/verify/999999999` and
  `/verify/not-a-number` both now answer 404, with the same plain-language message as
  before.
- `src/app/_components/DetailView.tsx` (minor, accessibility): the image's alt text said
  "The uploaded label photo." A screen reader already announces the element as an image.
  The word "photo" repeated that fact. Fixed: "The label submitted with this application."
  It names the content, not the medium. Updated the matching test query.
- `src/app/globals.css` (minor): `.secondary-button` had no explicit `display` rule. Fixed:
  added `display: inline-block`. The class now works the same way inside or outside a flex
  container.
- `src/app/_components/DetailView.test.tsx` (trivial, test isolation): one test rendered the
  component twice without unmounting the first tree. A later `getByText` call then searched
  two mounted trees at once. Fixed: unmount between the two renders.
- `src/app/_components/DetailView.test.tsx` (trivial, test honesty): a second test's own name
  promised "never a bare confidence number." No line in that test asserted it. The claim held
  only because that test's fixture had no number to leak. Fixed: added the same regex check
  this codebase already uses for the identical claim elsewhere.
- `src/app/api/label-images/[labelImageId]/route.test.ts` (trivial): added an explicit
  `Cache-Control` assertion to the existing success-path test.
- `src/server/verification-detail/get-verification-detail.test.ts` (trivial): expanded the
  header comment. It now says `DATABASE_URL` must point at the worktree's own database
  before this file runs.

Dismissed:
- `src/app/api/label-images/[labelImageId]/route.ts` (tagged major): "authenticate the
  requester and verify ownership… using the existing application auth and ownership
  mechanisms." No such mechanism exists anywhere in this app yet. Every route, including the
  one that saves these same photos (`POST /api/verify`), is equally open today. Access
  control is PRD §8 and LH-061 ("Key protection"), an Urgent ticket. LH-061 is already
  scoped for a shared access code, per-IP and global rate limits, and its own
  security-semantics escalation gate before merge. Bolting one-off auth onto a single GET
  route now would leave every sibling route open. It would also preempt LH-061's real
  design. It also falls under this factory's own stop condition for security-semantics
  changes. Not fixed here. Flagged for LH-061 to own.

**How to run it.** Point `DATABASE_URL` at this worktree's own database first — schema
provisioning resets it. Then run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. All
four ran clean after every fix above, in the same worktree.

**Rollback.** `git revert` this commit. The Detail view (the entry below this one) still
works without it — this round only tightens an error state's status code, a11y wording, one
CSS rule, and three tests.

## TRO-466 — LH-016: Detail view (2026-08-11)

**What changed.** LabelHunter now has a Detail view (PRD §5). It shows the label photo next
to every field's extracted value, the applicant's own value, a match badge, and the reason.
The results checklist gained one new link to open it: "See the label photo and full
comparison."

The view lives at `/verify/:verificationId`. It reads straight from the database. It works
right after a verify, and it works for a link revisited later. It never calls a model. It
only shapes rows the verify route already saved — TH-R19: the cascade is the architecture.

Three server pieces support it:
- `src/server/verification-detail/` shapes one verification's full detail. Each field gets a
  label value, an application value, evidence, a verdict, and a reason. The detail also
  includes the label image's URL and pixel dimensions.
- `src/app/api/label-images/[labelImageId]/route.ts` serves the saved label photo's bytes.
- `src/server/storage/local-file-storage.ts` gained `readLabelImage`, the read-side twin of
  the existing `saveLabelImage`.

**The scope question, resolved with evidence.** The ticket asked what PRD §5's Detail view
needs that the app does not carry yet.

- The application's own value per field is already in the database, on the `applications`
  table (`brand_name`, `class_type`, `alcohol_content_raw`, `net_contents_raw`). This view
  reads those columns directly. It needs no migration.
- The label image for side-by-side display was already in the database
  (`label_images.storage_path`). No route served it before this ticket. The new image route
  closes that gap.
- A "Resolved by Sonnet" flag is already in the database, but only at the label level
  (`verifications.resolution_path`). `field_results` has no per-field resolver column. This
  view shows one label-level badge instead of a per-field annotation. A per-field annotation
  would invent a fact the schema does not carry. This entry names that limit instead of
  hiding it.
- The warning's "expected vs. detected" diff has a limit: the government warning has no
  per-application value to diff against. One fixed statutory standard applies to every label,
  not an application-specific one (see `schema.ts`'s own comment on `applications`). Sourcing
  and verifying that statutory text against ttb.gov is LH-020's own decision. CP-2 gates that
  decision, and CP-2 has not run yet. This view shows the label's detected text and a plain
  description of the legal standard, side by side. The verdict and reason shown come from a
  check already computed upstream. It never computes its own text comparison. Standing rule
  11 requires the real exact-compare result here, never a fuzzy re-derivation invented by
  this view.

**Tests added this ticket.** Every new module was written test-first (red for the right
reason, then green):
- `get-verification-detail.test.ts` — 13 cases: the not-found path, a clean PASS, the
  "not filed on the application" fallback, resolved-by-Sonnet true and false, the resolver's
  note read defensively against an untyped `jsonb` column, and the headline message for a
  REVIEW verdict.
- The label-image route's `route.test.ts` — 4 cases: a real byte round-trip, a 404 for an
  unknown id, a 404 for a non-numeric id with no database query at all, and a 404 (never a
  crash) for a database row whose file was lost from disk.
- `DetailView.test.tsx` — 9 cases: the image tag's real dimensions, the shared verdict-banner
  text, per-field match badges, the warning row's own column labels, the "Resolved by Sonnet"
  badge, and the resolver's note, with an explicit check that its confidence number never
  reaches the page.
- `local-file-storage.test.ts` — 4 new cases for `readLabelImage`, including a
  path-traversal check.
- `ResultsChecklist.test.tsx` — 1 new case for the "See the label photo and full comparison"
  link.

**Observed, not only unit-tested.** A real `pnpm build` and a real `pnpm dev` run gave direct
evidence, not only unit tests. A real POST to `/api/verify` made one live Haiku call. A real
fetch of the returned `/verify/:id` link then showed the persisted headline message, an image
tag with the right URL, and all five field rows. `/api/label-images/:id` returned a genuine
JPEG matching the uploaded photo's exact pixel dimensions. A nonexistent id on both routes
returned a designed 404, never a crash. Setting `resolution_path` to `EXTRACTOR_RESOLVER` by
hand, and adding a resolver note, confirmed two things: the "Resolved by Sonnet" badge and the
note text render on the page, and the note's confidence number does not render.

**How to run it.** Point `DATABASE_URL` at this worktree's own database first — schema
provisioning resets it. Then run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

**Rollback.** `git revert` this commit. The verify flow and the results checklist keep
working without it: this ticket only adds a new view, linked from the checklist, and two new
server modules. It changes no database table. It changes no existing route's request or
response shape. The only visible change to an existing screen is the checklist's one new
link.

---

## TRO-505 — PR #14 review round 7: ledger dedup + 3 dismissed (2026-08-11)

**Fixed.** Merging `main` (which had already independently merged the same upstream commit's
TRO-464 ledger entries via an earlier round on this ticket) duplicated 3 lines in
`factory/review-findings.jsonl`. Deduped; verified line count and JSON validity before and
after.

**Dismissed.**
- A finding asked the system-font check in `render.test.ts` to scope to just the `<style>`
  block instead of the whole rendered HTML, guarding against a label whose own text happens to
  contain a font name. Checked, not assumed: grepped every golden-set spec directly — none
  contains any of the 6 checked strings as content. The two checks are equivalent against real
  data today; not worth the added regex-extraction complexity for a case this repo's own data
  rules out.
- Two findings (one in the ledger, one in `CHANGES.md`) are the 5th recurrence of the
  `DATABASE_URL`-unset claim, already addressed identically in rounds 3, 4, and 6. The claim is
  true, verified twice by actually running the affected tests with `DATABASE_URL` unset.
  Declined again for the same reason: retracting a verified fact to placate a reviewer that
  keeps re-raising it is not correcting an error.

**How to run it.** `node scripts/factory/review-ledger.mjs report` — confirms no ticket now
shows a duplicate-line count mismatch.

**Rollback.** `git revert` this commit. The 3 deduped lines re-duplicate; no other file changes.

## TRO-505 — golden renderer fonts: embedded, not system (2026-08-11)

**What changed.** `scripts/golden/render.ts` used three system-font stacks: Helvetica/Arial,
plus generic `cursive`/`fantasy` fallbacks for the two odd-typography cases. Those generic
fallbacks named no real font file, only a category. A different OS could substitute a
different real font for each category. `render.ts`'s own KNOWN LIMITATION comment named this
OS-font-substitution risk directly. Design doc §2 says fonts must be committed to the repo.
`render.ts` now embeds every font instead, removing the substitution risk entirely. TH-R17
grades correctness. An unrepeatable render pipeline is a correctness problem, not a cosmetic
one.

Every font is now a pinned npm package. `render.ts` reads each font's real WOFF2 file and
embeds it as a base64 `data:` URI inside a `@font-face` block. Chromium never asks the host OS
for a font substitution. `pnpm-lock.yaml` pins the exact bytes, the same way it pins every
other dependency.

The maintainers checked each font's license two ways: against the package's own
`package.json` `license` field, and against the actual `LICENSE` file text each package ships.
Both checks confirmed SIL Open Font License 1.1 for every font. Neither check relied on the
metadata field alone.

- **Inter** provides the base sans-serif for brand, class/type, content, and warning text. It
  carries an OFL-1.1 license. `render.ts` gets it from `@fontsource/inter` version 5.3.0.
  `render.ts` embeds three weights: 400, 500, and 700.
- **Dancing Script** renders the script-style "odd typography" brand case, case-25. It carries
  an OFL-1.1 license. `render.ts` gets it from `@fontsource/dancing-script` version 5.3.0.
  `render.ts` embeds its weight-700 cut.
- **UnifrakturMaguntia** renders the blackletter "odd typography" class/type case, case-26. It
  carries an OFL-1.1 license. `render.ts` gets it from `@fontsource/unifrakturmaguntia` version
  5.3.0. `render.ts` embeds its weight-400 cut, the font's only static weight. `render.ts`
  already named this exact font as a system-font fallback before this ticket. It turns out to
  ship as its own installable, OFL-licensed package. The maintainers checked that fact before
  they looked for an alternative font.

Case-26's class/type now renders at font-weight 400, not the usual 500. UnifrakturMaguntia
ships only one weight. Requesting weight 500 against a single-weight font would make Chromium
synthesize a bold cut on its own. A synthesized cut changes glyph metrics. Nothing in
`render.ts` requests that change. Rendering at the font's real weight keeps the glyph metrics
exactly what the vendored file ships. All three font packages are `devDependencies`. They are
build-time tooling for `scripts/golden/` only — the same category as `@playwright/test` and
`tsx`. The running app never imports them.

`SCRIPT_FONT_STACK` and `BLACKLETTER_FONT_STACK` fall back to `"Inter"`, not to the generic
`cursive`/`fantasy` categories. `Inter` is embedded too, so even the fallback path stays
file-embedded. A future regression that broke the Dancing Script or UnifrakturMaguntia
`@font-face` rule would degrade to Inter, not silently back to an OS-dependent font.

**Re-rendered the golden set.** `pnpm golden:build` re-rendered all 29 committed images. Total
size is 1,126,682 bytes, or 1100.3 KB. Before this ticket, the total was 1,104,318 bytes, or
1078.4 KB. Real font metrics differ slightly from the OS's previously-substituted ones. That
difference explains the size change. JPEG quality stayed at 82 with mozjpeg, unchanged from
before. Every image stays well under the ~500 KB-per-image target. `git diff --stat` against
the previous commit confirms both totals directly, file by file.

The maintainers spot-checked several images by eye: case-01 (clean baseline), case-14 (the
`STONE'S THROW` apostrophe), case-17 (glare), case-20 (severe rotation plus blur), case-23 and
case-24 (tiny warning text), and case-25 and case-26 (the two odd-typography cases). Text stays
inside its `LABEL_REGIONS` box in every one. Nothing overflows or truncates. The blackletter and
script faces render real glyphs, not placeholder boxes.

**Determinism, verified on this machine.** The maintainers ran `pnpm golden:build` twice. Each
run launches a fresh Chromium process (`createLabelRenderer` in `build.ts`'s `main`). All 29
output images were byte-identical across both runs. `cmp` confirmed this on every file, not
just a file count. The maintainers did not verify cross-machine determinism. This sandbox is
one machine. The honest claim is this: the renderer no longer depends on OS font substitution,
by construction. Every font is file-embedded now, not system-referenced. "Verified
cross-machine" would overstate what the maintainers actually checked.

**Tests.** `scripts/golden/render.test.ts` gained a new block: `buildLabelHtml font embedding
(TRO-505)`. It holds three tests:
- The first test confirms the rendered HTML embeds each of the five real `@fontsource` files'
  exact bytes as a base64 `data:` URI. It reads those files itself, independent of
  `render.ts`'s own `fontFileDataUri` helper. A wrong path or a stale encoding in `render.ts`
  would still fail it.
- The second test confirms the rendered HTML never references any of the five pre-TRO-505
  system-font names: Helvetica Neue, Brush Script MT, Apple Chancery, Snell Roundhand, and
  Blackletter.
- The third test confirms the rendered HTML never falls back to the generic `cursive` or
  `fantasy` families, checked across all 29 rendered cases, not just the two odd-typography
  ones.

The maintainers confirmed all three tests red-first. They checked out the pre-fix `render.ts`
from `HEAD` each time. They ran the relevant test against that old file. They restored the new
file afterward. The embedding test failed on a missing Inter data URI. The no-system-font test
failed because `"Helvetica Neue"` was present. The no-generic-fallback test failed because
`"cursive"` was present for case-25. Every one failed for the reason TRO-505 exists to fix, not
an import error or a typo.

The existing Chromium determinism suite (`describe("renderLabelImage determinism", ...)`)
gained a third case. Before this ticket, its two independent-browser-instance tests only
exercised case-01. That case only uses plain Inter, the base font path. The new test renders
case-25 and case-26. Those are the two cases that load the Dancing Script and
UnifrakturMaguntia `@font-face` rules. Each case renders across two independent browser
instances. Both produced byte-identical decoded pixels, the same result as case-01.

**How to run it.** Source `.factory-env` first, per this repo's standing convention. `pnpm
golden:build` regenerates every image from the current manifest. `pnpm test -- scripts/golden`
runs every test file under `scripts/golden/`. `render.test.ts` now holds 12 tests, up from 8
before this ticket. `degrade.test.ts` holds 21 tests, unchanged by this ticket. All pass.

**Rollback.** `git revert` this ticket's commit(s). Reverting restores the three system-font
stacks and removes the three `@fontsource/*` devDependencies from `package.json`. Run `pnpm
install` and then `pnpm golden:build` again after a revert. The 29 committed images are pixel
data, not source. They need a fresh render to match the reverted code.

**Review triage.** Six local CodeRabbit rounds against this ticket's own commits, seven real
findings fixed, five dismissed:
- Round 1 (major, `CHANGES.md`): the entry's font and license bullets were sentence
  fragments — no explicit subject or verb. A full ASD-STE100 rewrite fixed this. Every fact
  stayed; every sentence gained a subject and a verb.
- Round 2 (major, `scripts/golden/render.ts`): `SCRIPT_FONT_STACK` and `BLACKLETTER_FONT_STACK`
  still fell back to the OS-dependent generic `cursive`/`fantasy` categories. Both stacks now
  fall back to `"Inter"` instead, described in the font section above.
- Round 2 (trivial, `CHANGES.md`): "this gap"/"that gap" read as abstract backreferences. The
  rewrite named the concrete risk directly instead.
- Round 3 (major, `CHANGES.md`): repeated "this ticket" as the subject of many sentences read
  as an abstract, repetitive actor. The rewrite named the concrete actor instead — `render.ts`,
  `pnpm golden:build`, the maintainers, or TRO-505 by ticket ID.
- Round 4 (major, `CHANGES.md`): a repeated finding asked the "How to run it" section to show
  `DATABASE_URL` discipline for `pnpm test -- scripts/golden`, this time asking explicitly for
  no documented exception. Round 3 already checked this command directly. With `DATABASE_URL`
  and every other secret unset from the environment entirely, all 45 tests across
  `render.test.ts`, `degrade.test.ts`, and `images.test.ts` passed. None of those three files,
  and no part of the global `vitest.setup.ts`, touch a database. That check still stands; this
  entry does not retract it. "How to run it" now leads with sourcing `.factory-env` anyway,
  this repo's own standing convention (CLAUDE.md, lessons.md rule 3), regardless of whether
  this specific command strictly needs it.
- Round 4 (minor, `scripts/golden/render.test.ts`): the "never references a pre-TRO-505 system
  font" test only checked `renderableCases[0]` (case-01). Case-01 never triggers the
  script/blackletter overrides. It could never have caught `"Brush Script MT"` —
  `SCRIPT_FONT_STACK`'s original fallback — inside case-25's own rendered HTML specifically.
  The test now checks every rendered case instead. The maintainers confirmed this red-first
  against the true pre-TRO-505 `render.ts`, checked out from before this ticket's first commit
  and restored after.
- Round 4 (major, `CHANGES.md`), dismissed: a finding asked the "What changed" opening
  paragraph to split into more granular sub-topics than its current eight short sentences
  already do — font-stack history, substitution risk, design requirement, implementation
  change, and TH-R17 impact as separate parts. That paragraph already gives each sentence one
  claim, an explicit subject, and an active verb. It already satisfies every concrete rule in
  CLAUDE.md's ASD-STE100 table. Further fragmentation past that point is a stylistic
  preference beyond what this repo's own written standard requires. A fourth rewrite of the
  same paragraph risks introducing a new defect for undefined benefit — round 1's fix
  introduced round 2's finding, and round 2's fix left round 3's finding. This entry stops
  chasing paraphrase-level suggestions at this point.
- Round 5, after merging `main` (minor, `scripts/golden/render.test.ts`): the same
  pre-TRO-505-system-font test named `"Helvetica Neue"` but not `"Arial"`, the other real font
  in the old `BASE_FONT_STACK`. Fixed: `"Arial"` joined the checked list. Confirmed no case's
  label text contains that word first, so the new check cannot false-positive on real content.
- Round 5, dismissed (major, `CHANGES.md`): a finding claimed the 29 regenerated golden images
  were not committed. Checked, not assumed: `git diff --stat main...HEAD -- golden-set/images/`
  lists all 29 files, matching the totals this entry already documents. The images are
  committed and are part of this branch's diff against `main`.
- Round 5, dismissed (major, `package.json`): a finding asked `pnpm-lock.yaml` to be
  regenerated to match the new `@fontsource/*` entries. Checked, not assumed: `pnpm install
  --frozen-lockfile` — the exact check a real frozen-lockfile install or CI run performs —
  passed cleanly. The lockfile already matches the manifest.
- Round 5, dismissed (major, `scripts/golden/render.ts`): a finding asked `BASE_FONT_STACK` to
  drop its `sans-serif` fallback and asked for a runtime check that fails before the
  screenshot when a font is unavailable. `Inter` is the base font itself — there is no
  more-embedded family left to fall back to, so removing the word `sans-serif` changes
  nothing: an unstyled browser default behaves the same way an explicit generic keyword does.
  This is already stated directly in `render.ts`'s own comment on `BASE_FONT_STACK`. A real
  runtime font-load check (`document.fonts` in the page context) is a new capability, not a
  one-line fix, and no committed case has ever shown a font-load failure to guard against —
  a base64 `data:` URI has no network round-trip to race. Worth a ticket if a real failure is
  ever observed; not invented speculatively here. The finding's narrower, valid half — no
  stack should fall back to generic `cursive`/`fantasy` — was already covered by round 2's
  test.
- Round 6, dismissed (minor, `CHANGES.md`): a third recurrence of the `DATABASE_URL` topic
  (rounds 3 and 4 above), this time asking this entry to remove the claim that
  `render.test.ts`/`degrade.test.ts`/`images.test.ts` were run with `DATABASE_URL` unset and
  passed. That claim is true. It was checked directly, twice, not assumed once. Removing a
  verified claim because a reviewer stayed uneasy about it would manufacture doubt about a
  fact, not correct an error — the opposite of what CLAUDE.md's provenance rule asks for. The
  actionable half of this recurring concern was already accepted in round 4: "How to run it"
  leads with sourcing `.factory-env` regardless of what any one command strictly needs. This
  entry stops here on this topic.

**Not done here (explicitly out of scope).** LH-006 plans a CI smoke test: render one label
headlessly, then run `verify.ts`. TRO-505 does not build that test. TRO-505 only removes the
font-determinism blocker LH-006 was waiting on. `verify.ts` itself is still LH-006's job.

---

## TRO-471 — LH-031: Latency harness (2026-08-11)

**What changed.** A latency harness for the single-label verify flow (TH-R2, PRD §3.8, §6).

- `scripts/latency/percentile.ts` — pure percentile math. `percentile(valuesMs, p)` uses the
  nearest-rank method: sort ascending, then `rank = ceil(p/100 * n)`. `summarizeLatencies
  (valuesMs)` returns count/min/max/mean/p50/p95 from one function call. Internally that call
  does a reduce for the sum, separate min/max scans, and two calls to `percentile` — each of
  those sorts its own copy of the input. That is fine at this harness's sample sizes (15-50).
  It is not a single-pass algorithm. Both functions reject a `NaN` or `Infinity` entry with a
  `RangeError` instead of sorting it in or silently writing `null` into the committed report.
  Neither function touches a clock, a network, or disk. Written before `measure.ts`,
  TDD-style (PRD §6).
- `scripts/latency/percentile.test.ts` — 12 unit tests against synthetic millisecond arrays.
  Covers known nearest-rank values on 10- and 20-sample arrays. Covers the empty-array and
  out-of-range-`p` guards: both throw `RangeError`, never return a silent `NaN`. Covers
  shuffled-input order independence and confirms the input array is never mutated. Runs
  inside `pnpm test` — the `scripts/**/*.test.ts` glob in `vitest.config.ts` already covers
  it. No live call, no real money.
- `scripts/latency/args.ts` — pure CLI argument parsing, split out from `measure.ts` so a test
  can import it without triggering a real API call. `parseArgs` reads `--runs=<n>` and
  `--case=<caseId>`, defaulting to 20 runs against `case-01-clean-match-spirits`. It also
  enforces a hard `MAX_RUNS` ceiling of 50. Every run spends real money on one live Haiku
  call. A typo like `--runs=2000` must fail loudly instead of spending real API money by
  accident. Raising the cap takes a deliberate code edit, not a CLI flag.
- `scripts/latency/args.test.ts` — 11 unit tests: defaults, each flag alone and both together,
  the literal `--` token pnpm forwards (`scripts/run-tests.cjs` works around the same quirk
  for `pnpm test`), an unrecognized argument, a non-integer or zero `--runs`, and the
  `MAX_RUNS` ceiling (accepted at the limit, rejected one above it, with the offending value
  named in the error). No live call, no real money.
- `scripts/latency/measure.ts` — the harness itself. Run: `pnpm latency:check` (optionally
  `pnpm latency:check --runs=20 --case=<caseId>`). **Costs real money.** Each run makes one
  real, live `claude-haiku-4-5` call. It never mocks the call: TH-R2 exists to produce an
  honest number, and a mocked client would answer a different question. It calls
  `handleVerifyRequest`, the exact function `route.ts`'s `POST` calls. It passes a real
  `Request` through the real preprocessing pipeline, the real extractor, and the real
  Validation Router. It times wall-clock from that request to the rendered response body. It
  deletes every application row it creates afterward — this cascades to that row's label
  image, verification, field results, and review-queue row. Uploaded images land in a scratch
  temp directory, never the real `var/uploads/`. A run that throws, or that gets a non-200
  status, stays in the log with its own duration. It does not count toward p50/p95: a failure
  is neither a verdict nor a flag, so it is not a latency sample for TH-R2's clock.
- `scripts/latency/results/single-label-verify.json` — the committed measurement (below). The
  next `pnpm latency:check` run overwrites it. The filename stays stable on purpose: a later
  ticket (a stats page) can read it without knowing today's date. The file's own `measuredAt`
  field carries the date instead.
- `package.json` — added the `latency:check` script, matching `factory/config.yaml`'s
  planned `commands.latencyCheck` name.

**Local CodeRabbit triage, three passes (10 findings, 9 fixed, 1 dismissed).**
`scripts/factory/gate.sh`'s review step ran before any PR existed. All three passes' findings
are folded into this same entry rather than split into separate round entries, since no PR
existed yet for any pass to review.

- This CHANGES.md entry read as too dense in several spots — fixed with shorter, single-
  clause sentences throughout (no fact, command, or number changed).
- `measure.ts`'s `--runs` had no upper bound, so a typo could spend real API money at scale —
  fixed with the `MAX_RUNS` cap in `args.ts`, with its own regression test.
- This entry's own claim that `summarizeLatencies` runs "in one pass" was not accurate. It
  reduces once for the sum. It scans twice more for min/max. It calls `percentile` twice, and
  each of those sorts its own copy of the input. Fixed the wording here and in
  `percentile.test.ts`'s describe title. The sort-based approach is still correct and fast
  enough at 15-50 samples — just not single-pass.
- This entry's claim that the ~1.2s gap against PRD §3.8's internal sub-target "most likely"
  came from this machine or network running slower than Render was unsupported speculation —
  this harness never measured Render at all. Fixed: the cause is reported as not established.
- The "How to run it" section did not repeat this repo's `DATABASE_URL` discipline for
  `pnpm test` — fixed by adding the same reminder other entries use.
- **Dismissed:** a suggestion to compute `durationMs` after `response.json()` instead of
  before it. This finding described code this file does not have. `measure.ts` already
  computes `durationMs` before the `response.json()` call, not after. That order is
  intentional, not an oversight. `route.ts`'s `NextResponse.json(...)` already serializes the
  response body by the time `handleVerifyRequest` resolves. Parsing that body again, in this
  harness, is this harness's own bookkeeping — not server time. The suggested reorder would
  have inflated the measured number with that bookkeeping cost. Added a comment at that line
  instead, so a future review pass sees the reasoning and does not re-raise the same finding.
- A `finally` block called `rm(scratchDir, ...)` then `pool.end()` — if `rm` itself threw,
  `pool.end()` would never run, leaking an open connection pool that keeps the process alive.
  Fixed with a nested `try`/`finally` so `pool.end()` always runs.
- `measure.ts`'s module comment claimed a measurement run "leaves the worktree database
  exactly as it found it." Too strong: cleanup is best-effort row deletion, logged on
  failure, not a guarantee (sequence counters still advance regardless). Reworded.
- A failed per-row cleanup delete only reached `console.warn` — invisible to anything reading
  the committed JSON artifact, and never affected the exit code. Fixed: `measure.ts` now
  collects `cleanupFailures` into the report, prints a summary warning naming the stranded
  `applicationId`(s) if any, and exits non-zero on a cleanup failure (still writes a fully
  valid report either way — a cleanup failure means housekeeping needs a follow-up look, not
  that the p50/p95 numbers are wrong).
- The "Dismissed" bullet above (originally written in the second-pass commit) read as one
  dense paragraph. Rewritten into short, separate sentences, same facts.

**The measured numbers (observed, not derived, not fabricated).** 20 runs, case
`case-01-clean-match-spirits` (the golden set's own "TH-R11 reference example": a clean
spirits label, every field matching, no glare/rotation/degradation — the realistic image PRD
§3.8 budgets the fast path against). All 20 succeeded (0 failed).

| Stat | Value |
|---|---|
| p50 | **4232 ms** |
| p95 | **4763 ms** |
| mean | 4252 ms |
| min | 3459 ms |
| max | 5277 ms |

Machine: Apple M4 Pro, macOS (darwin/arm64), Node v23.2.0, local development machine — not
Render's deployed infrastructure, and not the same network path a real evaluator's browser
would use. Model: `claude-haiku-4-5`. Ran sequentially, one call at a time, same local network,
2026-08-11 afternoon.

**Reading the number against the two PRD targets.** TH-R2's own acceptance bar is "about 5
seconds," PRD §3.8's ~5s p50. This measurement meets it: 4232 ms p50 is under 5000 ms. PRD
§3.8's stage table also names a more optimistic internal sub-target: "~3s p50 · ≤5s p95" for
the fast path. The measured p50 runs about 1.2s over that internal figure. The measured p95
(4763 ms) still clears the ≤5s p95 ceiling. One run of 20 — the max, 5277 ms — landed just
past the literal 5-second mark. That is expected at a 95th-percentile reading on 20 samples:
by definition, up to 1 in 20 sits above p95. It is not evidence of a systemic miss.

**The cause of the ~1.2s gap against the internal sub-target is not established.** This
harness ran on one local machine, once, against the live Anthropic API. It cannot tell apart
three explanations: normal call-to-call variance in the live Haiku call itself, this
machine's or network's own conditions, or PRD §3.8's ~3s figure being a pre-measurement
estimate that ran a little optimistic. Nothing here points to a broken pipeline. This entry
reports the gap as an observed, unexplained fact, not tuned away, per CLAUDE.md's "never
fabricate a number" — that rule covers a confident wrong explanation as much as a wrong
number.

**Every run returned `REVIEW` / `LOW_MODEL_CONFIDENCE` — expected, not a bug.** This is not a
Haiku confidence problem on the label's other four fields. The cause is
`resolveGovernmentWarningField`'s defensive branch (`src/server/router/field-resolution.ts`,
the `!input.warningResult` case). The warning subsystem (LH-020) has not merged. `route.ts`
passes `warningResult: null` on every call — its own file comment says so — and this label
carries a government warning. The router has no dedicated "warning subsystem not built yet"
reason of its own, so the defensive branch reuses `LOW_MODEL_CONFIDENCE` instead of fabricating
a match it cannot check. This verdict costs no extra wall-clock time. It is a same-request,
synchronous answer. Sonnet never runs from this route, escalated or not (TH-R19 — the
cascade is the architecture). **Updated after merging main (2026-08-11, later the same day):**
LH-014's resolver (`src/server/resolver/`) has since merged to `main`. That does not change
this measurement. `route.ts` is byte-identical before and after that merge — confirmed with
`git diff`, not assumed — so this route still never calls the resolver inline. The resolver
runs off the `review_queue` table, on its own schedule, not inside this request.

**Batch throughput: not measured, blocked on LH-041/LH-CP3.** The job queue and worker pool
that would actually run a batch (LH-041) do not exist yet. `src/worker/` is still an empty
`.gitkeep`, and CP-3 is not acknowledged. PRD §3.8 is explicit that batch is throughput-bound,
not latency-bound. A number extrapolated from the single-label figure above would not be a
measurement. It would be a guess dressed as one. Deferred to LH-041.

**Approximate real API spend.** This ticket's own work made 26 real Haiku calls in total. 20
of those are the committed measurement. The other 6 are one-run plumbing smoke tests, run
after each round of fixes that touched runtime behavior, to confirm the wiring still works
end to end. PRD §4 estimates ~$0.005 per label call. The running total is about $0.13,
against the $25 build+eval spend cap.

**A note on running tests.** `pnpm test` reads `DATABASE_URL`. Every worktree gets its own
database (`scripts/factory/worktree.sh`). Running tests with `DATABASE_URL` unset, or
pointing at any database other than the current worktree's own, breaks this repo's own
non-negotiable rule (`CLAUDE.md`) — test provisioning resets the target schema. Run `source
.factory-env` before `pnpm test`, the same as before `pnpm latency:check`.

**How to run it.** Run `source .factory-env`, or set `ANTHROPIC_API_KEY` and a
worktree-scoped `DATABASE_URL` yourself. Then run `pnpm latency:check`. It defaults to 20 runs
against `case-01-clean-match-spirits`. Override the count or the case with `--runs=<n>` and
`--case=<caseId>`. `pnpm test` runs the full suite. That includes this ticket's math,
argument-parsing, and cleanup-flow unit tests (`percentile.test.ts`, `args.test.ts`,
`cleanup.test.ts`). Those three files make no live call and touch no database. The rest of
`pnpm test` does.

**What this ticket could not verify.**

1. The deployed Render environment's own latency — this ran on a local development machine.
2. Batch throughput (see above).
3. The escalation path's own latency contribution. No run in this measurement hit Sonnet.
   `route.ts` has no live path to the resolver either way — true when this measurement ran,
   and still true after merging main (LH-014 has since merged, but `route.ts` did not
   change). PRD §3.8 already scopes that time as async and off the 5-second clock, but this
   harness has nothing live to time there.

**Rollback.** `git revert` this commit, or delete `scripts/latency/` and the `latency:check`
line in `package.json`. No product code path depends on this harness. Nothing else imports
from `scripts/latency/`.

## TRO-471 — PR #13 review round 1: 3 CodeRabbit findings, 3 fixed, 0 dismissed (2026-08-11)

**What changed.** GitHub's CodeRabbit posted a first review round on PR #13, against commit
`8481b63`. This triage checked each finding against the current code, not against the
suggested diff alone. All three named a real defect.

- **CHANGES.md — several passages combined implementation details, rationale, limits, and
  measurements in one sentence.** The `percentile.ts` bullet was the named example. Split into
  single-fact sentences (see that bullet above, and the two triage bullets below it). No fact,
  count, or number changed.
- **`scripts/latency/percentile.ts` — `percentile` and `summarizeLatencies` accepted a `NaN`,
  `Infinity`, or negative entry.** Three separate facts, three separate risks. `NaN` sorts
  unpredictably. `Array.prototype.sort`'s own comparator returns `NaN` for a `NaN` operand.
  The spec treats that as "equal." The entry never settles to either end of the sort.
  `Infinity` sorts fine on its own. `JSON.stringify` writes it as `null` in the committed
  report, though — a bad duration would silently disappear rather than fail loudly. A negative
  number is not a real duration at all: `performance.now()` is monotonic within one process,
  so a legitimate elapsed-time measurement can never go below zero. Fixed: both functions
  share one new `assertValidDurations` check. It runs before any sort, min/max, or sum. It
  rejects any entry that is not finite, and separately rejects any entry below zero, each with
  its own `RangeError` message. `percentile.test.ts` adds direct cases for `percentile` and
  `summarizeLatencies`, covering `NaN`, `Infinity`, and a negative value. It also adds one
  case confirming zero itself is accepted — a near-instant call is a real, valid duration, not
  an edge case to reject. Confirmed red first, twice: once for the `NaN`/`Infinity` guard,
  once more for the negative-value guard added in a follow-up local pass. Each time, the new
  assertions failed with "expected function to throw an error, but it didn't" before its guard
  existed.
- **`scripts/latency/measure.ts` — a scratch-directory cleanup failure could lose the whole
  measurement.** The cleanup `finally` block ran `rm(scratchDir, ...)` then `pool.end()`. A
  prior fix (this ticket's second local round) nested those two calls so `pool.end()` always
  runs even if `rm` throws. That fix did not go far enough: `rm`'s error still propagated out
  of the whole `finally` block, which propagated out of `main()` itself, skipping every line
  after it — including the code that builds and writes the JSON report. A rare filesystem
  error during cleanup would have silently discarded every already-completed, already-paid-for
  run's results. Fixed: extracted `scripts/latency/cleanup.ts`'s `cleanupScratchDirAndPool`,
  which catches an `rm` failure and returns it as `scratchDirCleanupError` instead of
  re-throwing it. `main()` always reaches its report-writing code now, whether or not cleanup
  succeeded. The report gains a `scratchDirCleanupError` field (`null` on a clean run), and the
  exit code is non-zero when it is set — same "still writes a valid report, but flags
  follow-up" treatment `cleanupFailures` already gets. `cleanup.test.ts` adds 5 tests, using
  fake `removeScratchDir`/`closePool` closures — no real filesystem or database call. Confirmed
  red first: temporarily removed the `catch` block, watched the "never throws" and
  "still closes the pool" tests fail with the raw rejection instead of a normal assertion
  failure, then restored the fix and confirmed all 5 pass.

**A follow-up local `gate.sh` pass found 3 more issues while preparing this round's fix.**
These came from the local CodeRabbit CLI capture (`.factory/coderabbit.json`), not the GitHub
PR review — a fourth local round, on top of the three the original entry already names, not
part of round 1 above. All three were real.

- **CHANGES.md — the "Approximate real API spend," "A note on running tests," and "How to
  run it" sections were still dense.** Rewritten into short sentences with one fact each. No
  command, count, or number changed.
- **`scripts/latency/cleanup.ts` — `closePool`'s own rejection could still escape the "never
  throws" contract.** The prior fix caught a `removeScratchDir` failure but left `closePool`
  unguarded — the exact same defect class, one function later. Fixed: `closePool` is now
  wrapped in its own `try`/`catch`, returned as a new `closePoolError` field, never re-thrown.
  `measure.ts` threads `closePoolError` into the report and the exit code the same way
  `scratchDirCleanupError` already works. Two new `cleanup.test.ts` cases confirmed red
  first (a rejected `closePool` failed the test line itself, not an assertion) before the fix,
  then green after it.
- **`scripts/latency/measure.ts` — its own `Pool` had no error listener and no connection
  timeout.** `src/lib/db/index.ts`'s shared pool already carries both safeguards, fixed there
  as a PR review finding on TRO-456. Without them, an idle client losing its connection during
  a multi-minute, 20-plus-run session would crash the whole process (Node treats an
  unlistened-for `"error"` event on an `EventEmitter` as fatal), and an unreachable database
  would hang forever instead of failing fast. Fixed: matched `src/lib/db/index.ts`'s exact
  pattern — `connectionTimeoutMillis: 10_000` plus an `error` listener that logs and continues.
  This is the same defect family recurring in a second file; the ledger records it under the
  existing `unhandled-error`/`resource-timeout` slugs rather than a new one.

**A second follow-up local pass found 4 more — 3 fixed, 1 dismissed.** Also from
`.factory/coderabbit.json`, not GitHub — a fifth local round.

- **CHANGES.md — the `percentile.ts`/`summarizeLatencies` bullet above was still dense.**
  Rewritten again, into short sentences (see that bullet). No fact or number changed.
- **`scripts/latency/percentile.ts` — `percentile` and `summarizeLatencies` still accepted a
  negative entry.** The `NaN`/`Infinity` guard above did not check for a negative number.
  `performance.now()` is monotonic within one process, so a real elapsed-time measurement can
  never be negative. Fixed: extracted the shared `assertValidDurations` check described above,
  now rejecting a negative entry too. Two new `percentile.test.ts` cases (one per function)
  confirmed red first, plus one case confirming zero itself still passes.
- **Dismissed:** a claim that the default case, `case-01-clean-match-spirits`, has no
  committed image for `measure.ts`'s `readFileSync` to read. Checked against the actual repo,
  not assumed: `golden-set/images/case-01-clean-match-spirits.jpg` exists (43 KB, committed).
  The finding likely confused the manifest's `verified: false` field with a missing file.
  `loader.ts`'s own validation only requires `verified: true` for a `provenance:
  "ai-generated"` case; this case's `provenance` is `"rendered"`, so that rule does not apply
  to it at all. Six real runs against this exact default case, across this ticket's own
  sessions, already read this file successfully — the strongest evidence available that it
  exists and works.

**A third follow-up local pass found 1 more, in `measure.ts` itself.** Its module comment,
and the `pipelineScope` string it writes into every future report, both still said "no
Sonnet resolver (LH-014 not merged)" — stale, since the merge earlier in this entry. This
ticket's own prose had already caught and fixed the same staleness in `CHANGES.md`; the code
comment and the runtime string were the two spots that still needed the same update. Fixed:
both now say LH-014 has merged to `main`, `route.ts` still never calls it inline, and Sonnet
resolution (when it happens) runs asynchronously off the review queue, outside this request.
The already-committed 20-run report is left as it was — its `pipelineScope` text was accurate
for the conditions under which that measurement actually ran (LH-014 had not merged yet); only
the code that describes *future* runs needed the correction.

**Ledger, whole-ticket total.** An earlier version of this note undercounted: it reported
only this entry's own findings (11), not the whole ticket's. `factory/review-findings.jsonl`
is the source of truth for the exact count. Run `grep -c '"ticket":"TRO-471"'
factory/review-findings.jsonl` to see it live — `review-ledger.mjs report --since` will not
match every row here, because the original entry's ten rows carry `ts: null`, not a date. As
of the fix two paragraphs above this one: 21 rows for TRO-471, 3 `source: "pr"` (`pr: "13"`,
this entry's round 1) and 18 `source: "local-cli"` (10 from the original entry's three
rounds, 8 from this entry's three follow-up rounds).

**A fourth follow-up local pass found 4 more — 1 fixed, 3 dismissed as a self-referential
loop.** Also `.factory/coderabbit.json`, not GitHub.

- **`scripts/latency/measure.ts` — a malformed 200 response body would have been reported as
  a successful run.** `runOnce` cast the parsed body straight into the expected shape with a
  bare `as`, never checking it. `route.ts`'s own type system rules this out today — every real
  200 response it sends already matches the shape. That is not the same as this file checking
  it. This repo's other boundaries (`parseVerifyFormData`, `parseExtractionResponse`) all
  validate an untrusted value instead of assuming its shape; this one did not. Fixed:
  extracted `scripts/latency/response.ts`'s `parseVerifySuccessBody`, a pure shape check with
  no live call. A body missing `applicationId`, with a non-string `labelVerdict`, or with a
  `headlineReason` that is neither `null` nor a string, now returns a failed run with a clear
  error instead of `ok: true` and `undefined` fields baked into the committed evidence.
  `response.test.ts` adds 11 cases. Confirmed red first: temporarily reinstated the bare cast,
  watched 8 of the 11 assertions fail with the raw malformed object instead of `null`, then
  restored the fix and confirmed all 11 pass.
- **Dismissed, all three, as a self-referential loop:** three findings asking for the exact
  ledger count above to be corrected again (to 22, then a fourth time to re-sync
  `factory/review-findings.jsonl`'s own summary of itself). Recording any one of them adds
  another row, which invalidates the number the finding just asked to fix — a loop with no
  fixed point. The note above already explains this and points at a live `grep` command
  instead of a number frozen at write time. Continuing to chase this specific class stops
  here, by engineering judgment, not oversight: `factory/review-findings.jsonl` remains the
  real, correct, live source of truth throughout, whatever number this prose last mentioned.

**Ledger.** The response-validation fix recorded under `boundary-validation` (a category this
ledger already uses several times over — see `report`'s recurrence view). The three
self-referential loop findings recorded as `dismissed` under a new `meta-ledger-loop`
category, named once, deliberately, rather than forced into an existing slug that does not
fit — a category that should never need a second entry on any other ticket.

**How to run it.** `pnpm test` covers every fix in this entry (`percentile.test.ts`,
`cleanup.test.ts`, `response.test.ts`) — no live call, no real money. `pnpm latency:check
--runs=1` smoke-tests the wiring end to end with one real API call. This entry ran that smoke
test three times in total, once per round that touched runtime behavior: after wiring
`cleanup.ts` in, after the `closePoolError`/`Pool` follow-up, and after this
`parseVerifySuccessBody` follow-up. The committed 20-run `results/single-label-verify.json` is
unaffected by any of them — restored from git each time.

**Rollback.** `git revert` this commit. `scripts/latency/cleanup.ts` and `cleanup.test.ts` are
new files with no other caller; deleting them and reverting `measure.ts`'s import and cleanup
block restores the prior (buggier) behavior.

**Orchestrator triage, one more round (2026-08-11).** `gate.sh`'s local capture surfaced 2 more
findings after the rounds above. `scripts/latency/response.ts`'s `parseVerifySuccessBody`
checked `applicationId` was a `number` but not that it was a positive safe integer — negative,
zero, fractional, and unsafe-integer values all passed through. Fixed: added
`Number.isSafeInteger(...) && > 0`, 4 new regression cases (red confirmed before the fix — all
four previously passed through unrejected). The second finding — recovering a run's cleanup
handle even from a malformed 200 body — is dismissed with a comment at the call site
(`measure.ts`, above `parseVerifySuccessBody`'s call): unreachable today per `route.ts`'s own
type guarantee, and a real fix needs a second identity channel disproportionate to a
measurement harness; the failure is already loud (non-zero exit), not silent.

**PR #13 review round 2 (2026-08-11), 1 finding, fixed.** The process exit code stayed `0`
whenever at least one run succeeded. It stayed `0` even when other runs in the same batch
failed. The condition — `successful.length === 0 || cleanupFailures.length > 0 || ...` — never
checked `failed.length`. A caller that only checks the exit code (a CI step, a cron wrapper)
would read a 15/20 partial-failure run as clean. Fixed: the decision moved into a new pure
function, `computeExitCode` in `scripts/latency/exit-status.ts`. This matches the split this
file already uses for `percentile.ts`, `args.ts`, `cleanup.ts`, and `response.ts` — pure logic
in its own file, testable without a live call. `computeExitCode` adds an explicit
`failedCount > 0` branch. `exit-status.test.ts` adds 6 unit tests. Red-then-green confirmed by
temporarily disabling the new branch, watching the "some runs failed" case fail for the right
reason, then restoring it.

## TRO-464 — PR #10 review round 3: 3 CodeRabbit comments, 2 fixed, 1 dismissed (2026-08-11)

**What changed.** GitHub's CodeRabbit posted a third review round on PR #10.
This triage checked each finding against the current code. One finding
named a real prose defect. One named a real code defect. One restated a
race this ticket already deferred to TRO-506 in round 1.

- **CHANGES.md — round 2's own prose used passive, subject-less sentences.**
  ASD-STE100 (CLAUDE.md's own standing rule) asks for an explicit subject
  and an active verb in every sentence. "Each was checked," "All four are
  fixed here," and two "Added ..." clauses named no actor. Rewritten with
  explicit subjects: "This triage," "This round," "This entry," "The
  validator."
- **`queue.ts` — a stored resolution with an empty `fields` array passed as
  `"resolved"`.** `deriveOutcome` takes whatever `fields` array it receives
  and stays a plain function over it. `[].every(...)` is vacuously true, so
  `deriveOutcome([])` returns `"resolved"` — a resolution that resolved
  nothing. `response.ts`'s own `deriveResolvedFields` already guards this
  exact case at its own call site, before it ever calls `deriveOutcome`.
  `isResolverResolution` now guards its own call site the same way:
  `fields` must be non-empty before the outcome check runs.

**Dismissed (1), with a reason.**

- **`queue.ts` lines 1-64 — the resolver's check-then-insert flow is
  TOCTOU, not atomic.** This restates round 1's own finding. `index.ts`'s
  flow is unchanged: `findExistingReviewQueueEntry` runs, then Sonnet is
  called, then `insertReviewQueueEntry` runs, with no reservation between
  the check and the model call. Verified against the current file — lines
  104-125 are exactly what round 1 found. This is TRO-506, already filed
  and scoped to LH-CP3/LH-041, where real concurrency first exists. No
  code change. This is a duplicate, not a new defect.

**Tests.** `pnpm test -- src/server/resolver` runs 11 files and 131 cases
(up from 130). The new `fields: []` case was confirmed red-first: the
corrupted row came back as a valid `"resolved"` resolution before the fix.

**How to run it.** `source .factory-env` first — this command needs
`DATABASE_URL` pointed at a migrated worktree database. Then
`pnpm test -- src/server/resolver`. `pnpm test` — 588 cases pass repo-wide.
`pnpm typecheck` / `pnpm lint` / `pnpm build` are all clean.

**Rollback.** `git revert` this commit. The earlier TRO-464 entries below
stand on their own; this round only tightens them.

## TRO-464 — PR #10 review round 2: 4 CodeRabbit comments, 4 fixed (2026-08-11)

**What changed.** GitHub's CodeRabbit posted a second review round on PR #10.
It found 4 new problems in the code this branch had already pushed. This
triage checked each finding against the current code instead of applying it
on trust. Each finding named a real, narrow defect. Two concern CHANGES.md's
own prose. Two concern the resolver's boundary checks. This round fixes all
four.

- **CHANGES.md — the deferred-race paragraph overclaimed.** The entry
  below for round 1 said the `index.ts` TOCTOU race "is not reachable
  today," reasoning from "no caller exists in this repo yet." That reasoning
  proves less than the sentence claimed. `resolveEscalatedLabel` is
  exported. A caller outside this repo, or a future caller inside it, can
  still call the function twice for one verification and hit the same race.
  The sentence is narrowed to what the evidence actually supports: the race
  cannot happen through this repo's own code today. It does not say the
  race cannot happen at all.
- **CHANGES.md — the test instructions skipped a setup step.** The same
  entry's "How to run it" line named `pnpm test -- src/server/resolver`
  but not the `DATABASE_URL` step this file's own later note (the "A note
  on running tests" section, below) and the original LH-014 entry both
  already state. This entry now states it too, in the same words: the
  command needs `DATABASE_URL` pointed at a migrated worktree database,
  `source .factory-env` first.
- **`input-validation.ts` — one extraction field reached the prompt with no
  length bound.** `assertUntrustedInputWithinBounds` checked six of the
  seven top-level fields on `HaikuExtractionResult`. It skipped
  `image_quality`. `buildExtractionBlock` (`user-message.ts`) serializes the
  whole `extraction` object, `image_quality` included, so its `legible` and
  `issues` strings were exactly as reachable as the six checked fields,
  with no check of their own. The validator now applies the same
  object-then-length checks the other fields already get. `checkAlternates`
  is now `checkStringArray` — one function, shared by `alternates` and the
  new `issues` check, with a `label` parameter so a rejected `issues` array
  is not misreported as `alternates` in the error text.
- **`queue.ts` — a stored resolution got a looser check than a fresh one.**
  `isResolvedFieldResult` accepted any finite `confidence`, including `42`.
  `response.ts`'s own validation rejects anything outside `[0, 1]`. A row
  already sitting in the database was trusted more than a response that had
  just arrived. Separately, `isResolverResolution` never checked that a
  row's stored `outcome` actually matched what its `fields` said: a row
  claiming `"resolved"` next to a judged field's `NEEDS_HUMAN` disposition,
  or a correction field's `needsHuman: true`, passed silently. A caller
  would have read that label as resolved when the resolver's own answer, if
  read correctly, said a human still needed to look. `response.ts` now
  exports `deriveOutcome(fields)` — the one formula both `deriveResolvedFields`
  and `queue.ts` call, so a fresh response and a stored row cannot silently
  disagree about what "resolved" means.

**Dismissed: none.** Every finding named a real gap. None misread the code.
None contradicted a settled design.

**Tests.** `pnpm test -- src/server/resolver` runs 11 files and 130 cases (up
from 121). Every new test was confirmed red-first against the pre-fix code.
The four `image_quality` cases found no rejection at all. The four `queue.ts`
cases found the corrupted row returned instead of rejected.

**How to run it.** `source .factory-env` first — this command needs
`DATABASE_URL` pointed at a migrated worktree database. Then
`pnpm test -- src/server/resolver`. `pnpm test` — 587 cases pass repo-wide.
`pnpm typecheck` / `pnpm lint` / `pnpm build` are all clean.

**Rollback.** `git revert` this commit. The three earlier TRO-464 entries
below stand on their own; this round only tightens them.

## TRO-464 — PR #10 review round: 13 CodeRabbit comments, 10 fixed, 2 dismissed, 1 deferred (2026-08-11)

**What changed.** GitHub's CodeRabbit review of PR #10 posted 13 comments. Each
comment was checked against the current code, not applied on trust. Ten named a
real defect. Two were checked and found incorrect. One named a real gap outside
this ticket's scope. Every comment is recorded in
`factory/review-findings.jsonl`, `--source pr`.

**The important fix.** `user-message.ts` interpolated `FieldResultRow.reason`
and `FlaggedField.trigger` straight into the prompt, outside any
`<UNTRUSTED_DATA>` block and with no escaping. This was a real gap in the
untrusted-data boundary CP-1 §6.3 exists to hold. A field comparator's `note`
(`src/server/comparators/net-contents.ts`, `abv.ts`, `brand.ts`, already merged
to main) interpolates the extractor's raw label reading straight into `reason`
— confirmed by reading those files, not assumed. A label whose printed text
contains `</UNTRUSTED_DATA>` could have reached the prompt through that path,
unescaped, even though the two JSON blocks were already safe. Fixed:
`serialize.ts` gained `escapeUntrustedText`, and both values now go through it
before they reach the prompt. `input-validation.ts` now bounds their length too.

**Other fixes.**

- **`input-validation.ts`.** `extraction[field]` and `extraction.government_warning`
  were dereferenced without checking they were objects first. A `null` or
  `undefined` container crashed with an uncontrolled `TypeError` instead of the
  aggregated `ResolverInputError` — the exact failure mode the array check
  next to it already prevented. Added the same container check for objects.
- **`response.ts`.** `confidence` accepted any value typed `number` — `NaN`,
  `Infinity`, `-1`, and `42` all passed, then flowed into a persisted
  `field_results` row. `ValidationContext` gained `unitInterval`, which
  rejects (never clamps) anything outside a finite `[0, 1]`.
- **`response.ts`.** `deriveResolvedFields` returned `{ outcome: "resolved",
  fields: [] }` for an empty `flaggedFields` list — an empty array's
  `.every(...)` is vacuously true, and an empty loop leaves `problems`
  empty too. `resolveEscalatedLabel` already guarded its own callers, but
  `deriveResolvedFields` is exported and callable directly. It now guards
  itself.
- **`queue.ts`.** `isResolverResolution` checked that `fields` was an array,
  never what was inside it — `{ outcome: "resolved", fields: [null] }` passed.
  It now validates every element against both `ResolvedFieldResult` branches.
- **`serialize.ts`.** `JSON.stringify` returns `undefined`, not a string, for
  `undefined`, a function, or a symbol. `.replace` then threw an uncontrolled
  `TypeError`. `serializeUntrusted` now checks the result's type and throws a
  named error.
- **`types.test.ts`.** One assertion compared a literal array to an
  identical hand-written copy — it would still pass if `ResolverJudgedField`
  gained or lost a member. Replaced with a `Record<ResolverJudgedField, true>`
  map, which fails `pnpm typecheck` on that drift instead.
- **`injection.test.ts`.** The forged-tag test counted opening
  `<UNTRUSTED_DATA source=...>` tags only. A bare injected `</UNTRUSTED_DATA>`
  with no opening tag truncates a block early and this count alone would not
  catch it. Added a matching closing-tag count.
- **`user-message.test.ts`.** The escaping test proved only the
  `application_form` block was safe. `buildExtractionBlock` uses the same
  `serializeUntrusted` call but had no test of its own. Extracted a shared
  `blockContent` helper and applied the same assertion to both blocks, plus
  new cases for the `row.reason`/`flagged.trigger` fix above.

**Dismissed (2), with reasons.**

- **`schema.ts` — add `minItems: 1` and `confidence: {minimum, maximum}` to
  the resolver's structured-output schema.** The schema is CP-1 §6.4-approved,
  copied verbatim — this ticket's own mandate is to implement it as written,
  not to silently amend Troy-approved bytes. CP-1 §3.4 note 2 already
  documents, for the sibling extractor schema, that structured outputs do not
  support `minimum`/`maximum`; the same constraint plausibly applies here, and
  this repo forbids the live API call that would confirm or refute it. The
  equivalent protection now exists at the code layer instead — `response.ts`'s
  new `unitInterval` check (confidence) and the new empty-`flaggedFields`
  guard (the array-length concern) — without touching the approved schema.
  Amending CP-1 §6.4 itself needs a new checkpoint, not a reviewer suggestion
  applied silently.
- **`types.test.ts` — a `@ts-expect-error` directive is followed by another
  comment line, which the finding claims makes it "Unused" and fails
  `pnpm typecheck`.** Checked, not assumed: `pnpm typecheck` passed clean
  before this claim was investigated, and passed clean again after an
  isolated reproduction of the exact structure (a `// @ts-expect-error` line
  immediately followed by a second `//` comment line, immediately followed by
  the erroring code) compiled against this repo's own `typescript@5.9.3`
  with zero errors. TypeScript treats consecutive `//` lines as one
  contiguous comment block; the directive applies to the code line after the
  whole block, not literally the next physical line. The finding's cited web
  sources describe a different scenario, or an outcome that does not hold for
  this exact adjacent-comment structure on this compiler version.

**Deferred to a new ticket (1).**

- **`index.ts` — the duplicate-verification check is TOCTOU, not atomic.**
  Correct as stated: two concurrent callers can both find no `review_queue`
  row and both call Sonnet before either inserts. A real fix needs a
  reservation acquired BEFORE the model call — insert a placeholder row first,
  let the unique constraint pick one winner, have the loser wait for or reuse
  the winner's result — which is a genuinely different, heavier shape than a
  pre-flight check, and CP-1 §10 already assigns "queue design, concurrency,
  rate-limit strategy, partial-failure semantics" to CP-3, not this ticket.
  No caller of `resolveEscalatedLabel` exists in this repo's production code
  yet, outside its own tests. That proves the race cannot happen through this
  repo's own code today. It does not prove the race is gone —
  `resolveEscalatedLabel` is exported. An external caller could still call it
  twice for the same verification. So could a future caller inside this repo.
  Either would hit the same race. The CHANGES.md overclaim this finding also
  caught ("the model is never called twice") is corrected in the PR review
  round 1 entry below. Filed as a CP-3-scoped follow-up, not silently dropped.

**Tests.** `pnpm test -- src/server/resolver` runs 11 files and 121 cases (up
from 91). Every fix's regression test was confirmed red-first against the
pre-fix code before being restored, the same discipline as the round-1 entry
below.

**How to run it.** `pnpm test -- src/server/resolver` (needs `DATABASE_URL`
pointed at a migrated worktree database — source `.factory-env` first).
`pnpm typecheck` / `pnpm lint` / `pnpm build` clean.

**Rollback.** `git revert` this commit.

## TRO-464 — PR review round 1: orchestrator triage, 6 fixed, 2 test-only (2026-08-11)

**What changed.** The orchestrator's independent gate run kept 8 CodeRabbit findings
from this worktree's earlier capture. Each finding was checked against the current
code, not applied on trust. Six findings named a real defect. All six are fixed
here, each with a new regression test, each confirmed red-first.

- **`index.ts`/`queue.ts` (trivial, real).** A duplicate call for one verification
  paid for a second Sonnet call before the review-queue unique constraint ever
  caught the duplicate. `findExistingReviewQueueEntry` now runs before the model
  call. A row that already exists is returned as-is. This closes the gap for a
  SEQUENTIAL duplicate — a caller retrying after a crash or a timeout. It does
  NOT close the gap for a genuinely CONCURRENT one: two callers racing for the
  same `verificationId` can still both find no row and both call the model,
  because the check and the model call are not atomic. A real fix needs a
  reservation held before the model call, not after — a heavier change than
  this ticket's scope, and CP-1 §10 already assigns concurrency and queue
  design to CP-3. Filed as a follow-up rather than built here; see the PR #10
  review-round entry below for the full reasoning. A row whose `resolverOutput`
  does not match this module's shape (`db:seed.ts`'s own older fixture, for
  example) raises a clear error instead of a silent guess.
- **`input-validation.ts` (major, real, two findings).** The length check covered
  only `brandName` and `classType`. It now covers every `ApplicationRecord` field
  that reaches the prompt: `beverageType`, `netContentsUnit`, and the two numeric
  fields (`alcoholContentPercent`, `netContentsValue`), which are now checked for
  finiteness — `JSON.stringify` silently turns `NaN`/`Infinity` into `null`, with
  no error. Separately, `checkLength` and `checkAlternates` trusted the declared
  TypeScript type at a boundary where CLAUDE.md's own rule says not to. A
  non-string value crashed with an uncontrolled `TypeError` instead of a clean,
  named `ResolverInputError`. Both functions now check the real runtime type first.
- **`response.ts` (minor, real).** A judged field (`brand_name`/`class_type`) could
  carry `disposition: "RESOLVED_MATCH"` with `corrected_value: null` — a decided
  verdict with no reading behind it. `deriveResolvedFields` now rejects a decided
  disposition (`RESOLVED_MATCH`/`RESOLVED_MISMATCH`, or a correction field once
  `NEEDS_HUMAN` is ruled out) that carries no `corrected_value`.
- **`field-result.test.ts` (major, real).** One test's assertion sat inside an `if`
  guard. The `NEEDS_HUMAN` branch, where the guard was false, asserted nothing at
  all. The guard is gone. Every disposition now asserts an exact expected
  `resolvedBy` value.
- **`injection.test.ts` (trivial, real, test-only).** `extractionReadingBlock`
  sliced the built prompt text without checking that its marker `indexOf` calls
  found anything. A missing marker would have sliced from the wrong position
  instead of failing loudly. It now throws a clear error when either marker is
  missing.

**Dismissed: none.** Every finding named a real gap in the current code — none
misread it, and none contradicted a settled design.

**CHANGES.md prose (2 findings).** The original entry's "What changed" and "Tests"
paragraphs ran long, compound sentences. Both are rewritten in short, one-meaning
sentences, active voice — ASD-STE100, CLAUDE.md's standing rule, not optional style
for this repo.

**Red-first, confirmed.** Every one of the six code fixes was checked against the
pre-fix version (restored from git for `index.ts`/`input-validation.ts`; reverted
inline for `response.ts`) before being restored. Each fix's new tests failed for
the right reason against the un-fixed code: the dedupe tests found the model called
with no pre-flight lookup at all; the input-validation tests found nine failures,
including an uncontrolled `values.forEach is not a function` `TypeError` on a
non-array `alternates`; the response.ts tests found three failures where a
self-contradictory decided-but-empty answer passed silently.

**How to run it.** `pnpm test -- src/server/resolver` — 11 files, 91 cases (up from
71). `pnpm typecheck` / `pnpm lint` clean.

**Rollback.** `git revert` this commit. The original TRO-464 commit stands on its
own; this round only tightens it.

## TRO-464 — LH-014: Sonnet resolver + review-queue insertion (2026-08-11)

**What changed.** This ticket adds the Sonnet resolver under `src/server/resolver/`.
It serves PRD §3.1, PRD §3.3, TH-R1, and TH-R22. The resolver answers one question
for each field the Validation Router (LH-012/LH-013) could not decide: what should
the verdict be? The resolver never runs on a label the router passed. `resolveEscalatedLabel`
refuses at runtime when `labelVerdict !== "REVIEW"` (TH-R19). The design comes from
CP-1 §6. Troy approved that design. This ticket implements it as written.

- **`prompt.ts`** — `SYSTEM_PROMPT`, the CP-1-approved bytes (§6.2) copied verbatim.
- **`schema.ts`** — `RESOLVER_JSON_SCHEMA`, the CP-1-approved output schema (§6.4),
  also copied verbatim.
- **`serialize.ts`** — `serializeUntrusted(value)`. Plain `JSON.stringify` does not
  escape `<`, `>`, or `/` — a value containing the literal string
  `</UNTRUSTED_DATA>` survives a bare `JSON.stringify` call intact and can close the
  prompt's untrusted-data block early. Verified with a real `node -e` run before
  writing this down (see `serialize.ts`'s doc comment for the exact input/output
  pair). This function Unicode-escapes those three characters after
  `JSON.stringify`, so no literal `<`, `>`, or `/` reaches the prompt.
- **`input-validation.ts`** — `assertUntrustedInputWithinBounds`, the length check
  CP-1 §6.3 requires before any application or extraction value reaches the prompt
  template (an implausibly long value is itself a signal). Rejects, never truncates.
- **`user-message.ts`** — builds the resolver's per-call user message: two
  `<UNTRUSTED_DATA>` blocks (application form, extractor reading, both through
  `serializeUntrusted`), a "WHAT THE CODE DECIDED" table from the router's own field
  rows, and a "FLAGGED FIELDS" section naming only the fields the caller flagged.
- **`request.ts`** — `buildResolverRequestParams(input)`: `model: "claude-sonnet-5"`,
  `output_config.format` carrying the schema, `output_config.effort: "high"`
  (CP-1 §6.6's starting point), no `temperature` (the model rejects it — confirmed
  live during TRO-460, reused here rather than re-asserted), no `thinking` config
  (adaptive thinking is on by default).
- **`response.ts`** — `parseResolverResponse`/`deriveResolvedFields`: shape validation
  (collects every problem, same convention as the extractor), then the
  judges-only-brand/class rule (CP-1 §6.5). `brand_name`/`class_type` keep the
  resolver's disposition as authoritative. `alcohol_content`/`net_contents`/
  `government_warning` never carry a MATCH/MISMATCH opinion forward — the type
  (`CorrectionFieldResolution`) has no property that could hold one; only
  `needsHuman` survives, because "I cannot read this" is real signal the prompt
  explicitly allows (rule 7), distinct from the equivalence judgment the prompt
  forbids for these fields (rule 5). `overall` is always recomputed from the derived
  fields, never trusted from the raw response.
- **`field-result.ts`** — `toJudgedFieldResultRow`, the one place this ticket
  constructs a router `FieldResultRow`. Its parameter type is `JudgedFieldResolution`,
  not the full `ResolvedFieldResult` union — passing a correction-field resolution is
  a compile error. `resolvedBy: "sonnet"` only appears with a non-null
  `reviewReason`, satisfying `FieldResultRow`'s discriminated union by construction.
  The three correction fields still need a real comparator re-run on the corrected
  reading before they have a final verdict (CP-1 §6.5: "code re-decides") — that is
  the pipeline's job (LH-015/LH-016), not this ticket's.
- **`queue.ts`** — `insertReviewQueueEntry`. One `review_queue` row per escalated
  verification, for both a `resolved` and a `needs-human` outcome — `disposition`
  stays null in both; it is a human's later action, never set by this module
  (matches `db:seed`'s own fixture). `resolverOutput` carries the full,
  business-rule-enforced resolution as the auditable trail TH-R22 asks for.
- **`index.ts`** — `resolveEscalatedLabel(input, options?)`, the public entry point.
  Guards `labelVerdict === "REVIEW"` and a non-empty `flaggedFields` list before
  calling anything. Injectable `client` and `db` for tests; the shared default client
  reads `ANTHROPIC_API_KEY`, timeout 60s, `maxRetries: 0` (same reasoning as the
  extractor: an SDK-level retry would stack silently under a future batch worker's
  own backoff).

**Load-bearing decisions.**
- `serializeUntrusted` is applied to every untrusted value, always after
  `JSON.stringify`, never as a substitute for it — confirmed the composition order
  matters with the same `node -e` check.
- The judges-only-brand/class rule is enforced by the TYPE, not a comment: there is
  no code path anywhere in this module that can read a MATCH/MISMATCH opinion off a
  correction field, because the type has no such property.
- `resolveEscalatedLabel` throws `ResolverNotEscalatedError` on a non-REVIEW router
  result — a second, runtime layer of TH-R19 enforcement, independent of whichever
  pipeline ticket ends up calling this function.

**Tests.** `pnpm test -- src/server/resolver` runs 11 files and 91 cases.

- The attack-string serialization is byte-exact. A real `node -e` run checked it.
- Input-length rejection covers every serialized `ApplicationRecord` field, not just
  `brandName` and `classType`.
- Runtime type checks reject a non-string or non-array untrusted value. They do not
  just check length.
- The resolver request shape is checked: the model, no `temperature`, the `effort`
  setting, and image-before-text ordering.
- The judges-only-brand/class rule is checked, including a decided disposition with
  no `corrected_value`.
- Review-queue insertion runs against this worktree's real database (`queue.test.ts`,
  via `.factory-env`'s `DATABASE_URL`). A second insert for one verification hits the
  unique constraint. This is not just the happy path.
- A duplicate call for one verification does not call the model twice.
  `findExistingReviewQueueEntry` is checked against the real database and with a
  mocked client.
- `FieldResultRow`'s discriminated-union legality is checked in `field-result.test.ts`.
  `types.test.ts` adds a compile-time proof through `@ts-expect-error`.
- Never-on-the-happy-path is checked twice: a runtime guard, and a mocked-client
  assertion that Sonnet is never called for a non-REVIEW result.
- A dedicated prompt-injection oracle (`injection.test.ts`) matches CP-1 §6.3's own
  oracle. A sibling field's injection payload does not change the targeted field's
  disposition. This is checked at the request-building layer and the
  response-parsing layer.

**Red-first, confirmed.** Two regressions were deliberately reintroduced and
confirmed to fail the right tests before being reverted: (1) reverting
`serializeUntrusted` to a bare `JSON.stringify` failed 4 tests, including the
injection test that caught a forged third `<UNTRUSTED_DATA>` tag; (2) making
`deriveResolvedFields` always report `needsHuman: false` for a correction field
failed 3 tests, including the `needs-human` outcome test in `index.test.ts`. Both
fixes were then restored and the suite re-confirmed green.

**How to run it.** `pnpm test -- src/server/resolver` (needs `DATABASE_URL` pointed
at a migrated worktree database — source `.factory-env` first; one test file,
`queue.test.ts`, writes to and cleans up after itself against the real schema).
`pnpm typecheck` / `pnpm lint` / `pnpm build` all clean.

**Rollback.** `git revert` this commit; restore `src/server/resolver/.gitkeep`.
Nothing outside `src/server/resolver/` changed.

**Known limits — not verified.** No live call to `claude-sonnet-5` was made, or
could be, under this repo's no-live-API-calls-in-tests rule — every claim about the
model's actual behavior (whether it truly ignores an injected instruction, its real
latency, its real token cost) is "not measured," same honesty standard as CP-1 §7.
What IS verified: the request this module builds matches CP-1 §6.6's settings
exactly, the untrusted-data escaping is byte-verified, and the parsing/business-rule
layer defends correctly against every raw response shape this repo can construct in
a test, including one simulating a model that got the injection wrong. This ticket
does not wire the resolver into a pipeline — no code in this repo calls
`resolveEscalatedLabel` yet outside its own tests; that wiring, and the comparator
re-run for `alcohol_content`/`net_contents`/`government_warning`'s corrected
readings, is LH-015/LH-016.

## TRO-497 — PR review round 4: local CodeRabbit pass, 4 fixed, 1 dismissed (2026-08-11)

**What changed.** A fresh local CodeRabbit pass posted 5 findings against the round-3 fix
commit. Four are real; this entry fixes all four. One restates round 2's already-deferred
`Degradation.params` discriminated-union item. Dismissed again; no code change.

Fixed:
- `scripts/golden/build.ts:11` (minor): the header's determinism claim was unqualified. Fixed:
  scoped to "one machine with one toolchain," and pointed at `render.ts`'s system-font
  substitution known limitation.
- `golden-set/README.md:31` (major): the LH-005 paragraph read as dense prose. Fixed: ASD-STE100
  rewrite into short, one-fact sentences. Every fact stays — LH-005 ownership, the Gemini API
  call, the image's current absence, the required `verified: true` sign-off, the loader's
  schema-only check, and `images.test.ts`'s existence check.
- `CHANGES.md:9` (major): the round-three summary combined several facts per sentence. Fixed:
  ASD-STE100 rewrite into short, single-fact sentences. Every count and detail stays.
- `src/lib/golden-set/loader.ts:244` (major): `checkDegradations` accepted a `glare` or
  `low-light` entry after a `rotate` or `perspective` entry. `degrade.ts`'s
  `assertMatchesOriginalCanvas` already refuses that same order at build time — a geometric
  transform changes the canvas, so `LABEL_REGIONS`'s coordinates go stale. Fixed: the same
  order check now runs at spec-validation time. New red-first tests cover a 180-degree rotate
  followed by `glare` and by `low-light`, and a `perspective` entry followed by `glare`. The
  committed manifest has no case that breaks the new rule — confirmed by
  `loadGoldenSetManifest`'s own test, which loads and validates the real file.

Dismissed:
- `src/lib/golden-set/types.ts:130` (minor): replace `Degradation.params` with a discriminated
  union keyed by `DegradationType`. Round 2 already deferred this same item as a bigger refactor
  across `types.ts`, `loader.ts`, and `degrade.ts`'s dispatcher. Still true; no code change here.

**Tests added this round.** `loader.test.ts`: three new rejection cases for the degradation
order rule (rotate-then-glare, rotate-then-low-light, perspective-then-glare), and one new
acceptance case (glare-then-rotate). Two pre-existing tests changed their fixture's
degradation order to stay valid under the new rule; their assertions did not change.

**How to run it.** `pnpm test`, `pnpm typecheck`, `pnpm lint`.

**Rollback.** `git revert` this commit.

## TRO-497 — PR review round 3: GitHub PR #9, 11 fixed, 2 dismissed (2026-08-11)

**What changed.** CodeRabbit reviewed PR #9's live GitHub diff, not the local round-1/round-2
passes. That review posted 13 comments. Eleven were real; this entry fixes all eleven. Two
are dismissed. One restates a finding this entry already fixes, under a different comment.
CodeRabbit's own severity tag calls the other one "Low value" — it is a test refactor, not a
bug.

Fixed — documentation and ground truth:
- `CHANGES.md:10` (minor): round 2's own header claimed "5 fixed, 3 deferred." Its breakdown
  listed something different: six real fixes bundled into five bullets, one stale finding, two
  deferred findings, and one dismissed prose complaint mislabeled "deferred." Round 1's own
  CodeRabbit-triage section had the same kind of mismatch — it fell three lines short of its
  claimed "3 deferred." Fixed: both headers and their "Deferred" lists now match what each
  entry enumerates.
- `CHANGES.md:220` (minor): the "How to run it" line said "same spec in, same pixels out." That
  is an unqualified determinism claim. `render.ts`'s font stacks name system fonts, not files
  committed to the repo — this same changelog entry already states that fact 30 lines earlier.
  Fixed: the claim now says "on one machine" and points at the font-substitution caveat.
- `golden-set/manifest.json:1165` (minor): case-20's `description` and `notes` named only the
  upside-down rotation. Its `degradations` list also applies an 18-sigma blur, and its `V9`
  vector maps to "blurry/unreadable" specifically because of that blur. Fixed: both fields now
  name the blur.
- `golden-set/README.md:38` (major): the LH-005 section said the loader "rejects a
  `verified: true` `ai-generated` case" — backwards. `loader.ts` line 494 rejects
  `verified !== true`; it requires `true`, not rejects it. Fixed: swapped `true` for `false`.
- `golden-set/README.md:70` (minor): the `degradations` field's parenthetical named three of
  the five `DegradationType` values (glare, rotation, low light), reading as if `blur` and
  `perspective` were unsupported. Fixed: named all five.
- `golden-set/README.md:87` (minor): the naming convention permitted `.png` for any case, but
  `build.ts` always JPEG-encodes a `rendered`/`rendered+degraded` case — a `.png` path there
  would hold JPEG bytes under a PNG name, undetected. Fixed: scoped `.png` to a future
  `ai-generated` case (LH-005), whose image comes straight from Imagen, not `build.ts`'s encode
  step.
- `scripts/golden/images.test.ts:8` (minor): the file header claimed its tests confirm a
  degraded case's `degradations` entry "matches what `degrade.ts` actually applied when
  `build.ts` produced the committed image." The tests compare the manifest against hardcoded
  literals; none reads the committed image bytes or calls `degrade.ts`. Fixed: the header now
  states what the tests check, and names the real gap — a manifest edit without a
  `pnpm golden:build` rerun goes uncaught here.

Fixed — code:
- `scripts/golden/build.ts:76` (trivial): the JPEG encode had no explicit `.flatten()` call.
  sharp's JPEG encoder composites alpha over black by default; the pipeline avoids that today
  only because `render.ts` paints an opaque white body and `applyRotate`/`applyPerspective` fill
  new corners white — an invariant spanning three files, enforced nowhere. Fixed: added
  `.flatten({ background: "#ffffff" })` before the JPEG encode, the same call `pipeline.ts` uses
  for the same reason. A no-op on today's fully opaque images — confirmed by rebuild: all 29
  committed images stayed byte-identical.
- `scripts/golden/render.ts:203` (minor): `.classType` and both `.divider` elements hardcoded
  pixel positions (`210`, `90`, `310`, `500`) that must stay in sync with `LABEL_REGIONS` by
  hand. `degrade.ts` crops by `LABEL_REGIONS`; a future edit to one side without the other would
  move painted pixels without moving the crop — the same silent-wrong-pixels risk round 2's
  `assertMatchesOriginalCanvas` fix closed for `applyGlare`/`applyLowLight`. Fixed: the four
  literals now derive from `LABEL_REGIONS` plus three named gap constants
  (`CLASS_TYPE_GAP_PX`, `CONTENT_DIVIDER_GAP_PX`, `WARNING_DIVIDER_GAP_PX`), reproducing today's
  exact values. Confirmed by rebuild: byte-identical to before.
- `scripts/golden/degrade.test.ts:235` (trivial): no test asserted `applyDegradation`'s
  documented determinism claim — that the same input and params always produce the same output
  bytes. `applyGlare` rasterizes an SVG through librsvg, the transform most likely to vary.
  Fixed: a new test calls each of the five types twice on the same input and asserts byte
  equality.
- `scripts/golden/render.test.ts:142` (trivial): the one determinism test reused a single
  `renderer.page` for both renders, proving determinism only within one Chromium process.
  `pnpm golden:build` launches a fresh browser every run (`createLabelRenderer` in `build.ts`'s
  `main`). Fixed: a second test renders the same case from an independent
  `createLabelRenderer()` call and compares decoded pixels.

Dismissed:
- `scripts/golden/render.test.ts:1` — a rollup comment restating the same two gaps
  `degrade.test.ts:235` and `render.test.ts:142` already name individually (both fixed above).
  Duplicate, not a separate finding.
- `src/lib/golden-set/loader.test.ts:267` — extract six tests' repeated throw/catch block into a
  shared helper. CodeRabbit's own severity tag on this finding is "Low value." No correctness or
  coverage gap; skipped to avoid churn against six passing tests — CLAUDE.md's simplicity rule
  governs prose Claude writes, not restructuring code "for its own sake."

**Tests added this round.** `degrade.test.ts`: one new case, byte-equality for all five
degradation types called twice. `render.test.ts`: one new case, decoded-pixel equality across
two independent `createLabelRenderer()` calls.

**How to run it.** `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Rebuilt with
`pnpm golden:build` after the `build.ts`/`render.ts` changes — all 29 committed images matched
their prior byte counts exactly (1,104,318 bytes total), confirming no rendered pixel changed.

**Rollback.** `git revert` this commit. The pipeline works without it; these are documentation
corrections and hardening, not new features.

## TRO-497 — PR review round 2: 6 fixed, 2 deferred (2026-08-11)

**What changed.** A second gate run triggered a fresh CodeRabbit pass against round 1's fix
commit. It found 10 findings. Six were real defects. The five bullets below fix all six — one
bullet fixes two findings in the same file. One finding restated work round 1 already did:
stale, no action needed. Two findings are real but deferred, not fixed here. One finding is
addressed by explanation below, not by a code change — it is neither a fix nor a deferral.

- `degrade.ts` (major): `applyGlare` and `applyLowLight` trusted `LABEL_REGIONS`'s fixed
  coordinates. Those coordinates are only correct against the original, unrotated canvas. A
  degradations list that ran a geometric transform (`rotate`, `perspective`) before a
  region-targeted one (`glare`, `low-light`) would silently glare or dim the wrong pixels. No
  committed case does this today, but a future one could. Fixed: `assertMatchesOriginalCanvas`
  checks the input image's real decoded size before either function runs, and throws a clear
  `RangeError` on a mismatch instead of silently misplacing the effect. New tests: apply each
  function to an already-rotated image, confirm it throws.
- `loader.ts` (major): `DEGRADATION_PARAM_SHAPE` checked only each type's required params. It
  never checked glare's optional `angleDegrees`/`opacity` when present, and never rejected a
  param a transform does not use at all — for example, a `rotate` entry that also carried a
  stray `sigma`. Fixed: the shape table now has a `required` and an `optional` part per type,
  every optional key is type-checked when present, and any key outside both sets fails
  validation. New tests for all three cases.
- `build.ts` (major): `imagePath` came straight from the manifest into `join(REPO_ROOT, ...)`.
  The loader already checks `imagePath` starts with the literal string
  `"golden-set/images/"`, but that is a string-prefix check — it would not catch a value like
  `"golden-set/images/../../etc/passwd"`, which starts with that same prefix as plain text.
  Fixed: `resolveImagePath` resolves the real path and confirms it stays inside
  `golden-set/images/` before any write. The manifest is a committed, reviewed file, not
  runtime input, so this is defense in depth, not a response to an active threat.
- `images.test.ts` (minor): the existence check confirmed a file was present and non-empty,
  never that it decoded as an actual JPEG. Fixed: a new test decodes every committed image
  with sharp and asserts `metadata.format === "jpeg"`.
- `golden-set/README.md` (minor + major): "May be empty." lost its subject — changed to "The
  list may be empty." The LH-005 section did not say an `ai-generated` case's image and its
  `verified: true` flag must land in the same manifest change — added that sentence, and named
  which test starts failing if they don't (`images.test.ts`).

One finding restated "commit the missing image assets" — already done in round 1's commit;
stale against the current tree, no action needed.

Two findings are deferred, not fixed here:
- Replacing `Degradation.params: Record<string, number | string>` with a discriminated union
  keyed by `DegradationType`. The shape validation added in round 1, tightened further above,
  already closes the practical gap. The type-level version is a bigger refactor across
  `types.ts`, `loader.ts`, and `degrade.ts`'s dispatcher — better as its own change.
- `render.ts`'s font stacks name system fonts, not fonts committed to the repo, which design
  doc §2 calls for. Documented as a known limitation directly in `render.ts`'s module comment,
  with the exact practical consequence (same-machine determinism holds; cross-machine font
  substitution could differ). Not fixed here — sourcing and license-checking real font files
  is a real task, and rushing a font choice risks a license problem worse than the gap it
  closes.

**Dismissed, not deferred.** A tenth finding argued this changelog entry (round 1's) was still
too dense. Round 1 already applied one real ASD-STE100 pass (see that entry's own note). This
round adds five more short, single-fact paragraphs rather than a second full rewrite of round
1's text — further compressing already-compressed technical detail risks losing precision for
its own sake, which CLAUDE.md's writing-style section warns against directly.

**Tests added this round.** `degrade.test.ts`: two new "rejects an already-transformed image"
cases (glare, low-light). `loader.test.ts`: four new cases for the closed degradation-params
schema (accepts glare's optional params when well-typed, rejects a wrong-typed optional param,
rejects an unrecognized param). `images.test.ts`: one new case for the decoded-JPEG check.

**How to run it.** Same as round 1: `pnpm golden:build`, `pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm build`. Re-ran `pnpm golden:build` after these fixes — every image's byte
count matched round 1's exactly, confirming the fixes changed no rendered pixel.

**Rollback.** `git revert` this commit. Round 1's pipeline still works without it; these are
hardening fixes, not new features.

## TRO-497 — LH-004: golden-set degradation pass, plus the renderer LH-003 deferred (2026-08-11)

**Scope note.** This ticket's stated job was the degradation pass. LH-003 (TRO-458, Done)
shipped the spec schema, the manifest, and the loader. LH-003 did not ship `render.ts`. Its
own CHANGES.md entry says so directly: "the renderer itself... `golden-set/images/` is still
empty." A degradation pass needs a clean base image to degrade. No clean base existed. The
orchestrator approved building the renderer here, as a prerequisite of this ticket, on this
branch — not as a separate ticket. Both pieces follow below.

**What changed.** `golden-set/images/` now holds a real, committed JPEG for every `rendered`
or `rendered+degraded` case. That is 29 of 29 — every case that currently exists in the
manifest. Total size: 1,104,318 bytes (1078 KB). Largest file: 46,719 bytes (case-19).
Smallest file: 9,365 bytes (case-20). Every image stays well under the ticket's ~500 KB
target. No `ai-generated` case exists in the manifest yet — that provenance is LH-005's job.
This ticket leaves that path imageless; a scoped test checks for exactly that, per plan.

- **`scripts/golden/render.ts`** — the renderer. `buildLabelHtml` is a pure function. Given a
  case's `label` ground truth, it builds an HTML/CSS document. The document draws the brand,
  class/type, ABV line, net contents, and government warning verbatim. Whatever string the
  spec carries is the string in the HTML, byte for byte — design doc §1's core rule: no image
  model is ever trusted with the warning text. `renderLabelImage` screenshots that HTML with
  Playwright's bundled Chromium. Chromium is already a repo dependency, for `pnpm test:e2e` —
  no new dependency. The HTML is fully inline, so this makes no network call. `LABEL_REGIONS`
  names four pixel rectangles (`brand`, `front`, `content`, `warning`); `degrade.ts` targets
  each region by name. Two categories bake their "imperfection" into the render itself, not a
  post-process transform: tiny warning text (case-23/24) and an unusual brand/class-type font
  (case-25/26). Both are print choices, not photo conditions. `CASE_STYLE_OVERRIDES`
  (`render.ts:105`) is keyed by exact `caseId`, never a substring match.
- **`scripts/golden/degrade.ts`** — five transforms per design doc §4: `applyRotate`,
  `applyBlur`, `applyPerspective`, `applyGlare`, `applyLowLight`. `applyDegradation` is the
  one dispatcher `build.ts` calls. It reads a manifest case's `degradations` list, so that
  list stays the single source of truth for what happened to a case's pixels. Every numeric or
  region parameter is validated before it reaches sharp — finite, in-range, a real region name
  (CLAUDE.md rule 13). `degrade.test.ts`'s "rejects ..." tests are red-first against that
  validation: each one checks a specific bad input throws, not just that something throws.
  `applyPerspective` approximates a keystone camera angle with a 2D affine shear. sharp has no
  true 4-corner projective warp; a real one needs a per-pixel remap, and this repo has no
  dependency for that — not worth adding one for a synthetic test fixture. No committed case
  uses `applyPerspective` yet. It is implemented and unit-tested as a design-doc-§4 capability,
  ready for the next case that needs it.
- **`scripts/golden/build.ts`** — orchestrates render → degrade → JPEG-encode (mozjpeg,
  quality 82) → write, for every non-`ai-generated` case. Run with `pnpm golden:build`.
- **`golden-set/manifest.json`** — six cases gained a `degradations` entry recording the exact
  parameters `build.ts` used:
  - case-17: glare on the `brand` region.
  - case-18: glare on the `warning` region.
  - case-19: a mild, correctable 15° rotation.
  - case-20: a 180° rotation plus an 18-sigma blur — direct evidence for rubric V9's
    "blurry/unreadable," not rotation alone. The case's own note says no field should read
    confidently; the added blur backs that up.
  - case-21: low light on the `front` region.
  - case-22: low light on the `warning` region.

  Cases 23–26 (tiny text, odd typography) and every clean `rendered` case carry no
  `degradations`. Their imperfection, if any, is render-time — never a `degrade.ts` transform.
- **`src/lib/golden-set/types.ts`, `loader.ts`** — added `DegradationType` and `Degradation`.
  Design doc §3 named this `degradations` field; LH-003 never implemented it. Added the
  loader's matching validation: the field is optional, each entry's `type` must be a known
  transform, and each transform's required `params` keys must be present with the right type
  (see the review-triage note below for the two checks added after CodeRabbit's first pass).
  New `loader.test.ts` cases cover both the accept and reject paths. The manifest's shape
  changed. The loader still accepts it — "loader stays green," per this ticket's brief.
- **`vitest.config.ts`** — widened `include` to also match `scripts/**/*.test.ts`. This
  ticket's tests now run inside `pnpm test`, the one unit vitest run — not a separate suite.
- **`package.json`** — added the `golden:build` script.
- **`golden-set/README.md`** — replaced the "no images yet" section. It now states what
  exists (the three-script pipeline, image sizes) and what still doesn't (LH-005's
  `ai-generated` wild labels, LH-006's `verify.ts`). Left `verified: false` on every case
  alone. `verified` records a **human** sign-off (design doc §3); CP-2 review is where that
  happens, not this ticket.

**A real tool quirk found while writing tests, not a `degrade.ts` bug.** Chaining
`sharp(image).extract(region).stats()` in one pipeline silently returns whole-image
statistics. It ignores the extract (sharp 0.35.3 / vips 8.18.3, this machine). A minimal
repro confirmed it: a 100×100 white canvas with one 10×10 black corner. `.extract().stats()`
reported the *same* mean for the black corner, a white corner, and the full image.
Materializing the extract into its own buffer first fixes it — `.extract(region).toBuffer()`,
then `sharp(thatBuffer).stats()` — and gives the correct, expected numbers. `degrade.ts`
itself never calls `.stats()`. It chains `.extract()` straight into
`.modulate()`/`.composite()` and `.toBuffer()`, which materializes correctly regardless. So
this was a test-helper bug, not a production one. `degrade.test.ts`'s `meanBrightness` helper
documents the finding and the fix.

**CodeRabbit review triage.** Round 1's local CodeRabbit pass raised 10 findings against the
initial commit. Five were real defects, fixed below. One was already correct by design. One is
deferred. Two more are STE100 prose critiques resolved by an in-place rewrite, not by a
deferral — see the note after the deferred item.

Fixed:
- `loader.ts` (major): `checkDegradations` checked that `params` was an object but never that
  it held the right keys. Fixed: a `DEGRADATION_PARAM_SHAPE` table checks each transform's
  required params are present with the right primitive type (`angleDegrees`/`sigma`/`shear`/
  `brightnessFactor` numeric, `region` a string). Range checks stay in `degrade.ts`, the
  schema of record for those.
- `loader.ts` / `checkCase` (major): a `rendered` case could carry a non-empty `degradations`
  list — self-contradictory, since "rendered" means clean. Fixed: the loader now rejects a
  non-empty `degradations` list unless `provenance` is `rendered+degraded`.
- `degrade.ts` (major): `applyPerspective` checked `shear` was finite but never bounded it.
  Fixed: rejects `|shear| > 3` (`MAX_SHEAR_MAGNITUDE`), with tests at and past the bound.
- `render.test.ts` (minor): the "omits the ABV line" test only checked that net-contents text
  appeared somewhere in the HTML — it would not have caught a stray empty ABV line. Fixed per
  CodeRabbit's own suggested diff: count `.line` divs directly, assert exactly one, holding
  net contents.
- `images.test.ts` (major): the ai-generated existence test only checked one direction
  (unverified + no image). Fixed: now checks both directions — a verified case must have a
  real image, and an imageless case must not be verified.

Already correct by design, not a real gap:
- A finding argued the loader's `imagePath` contract should let an `ai-generated` case be
  imageless. It already is: the loader never checks file existence for any case (LH-003's own
  design — see `loader.ts`'s comments); only `images.test.ts` checks existence, and it already
  scopes that check to non-`ai-generated` cases.

Deferred (filed as follow-up work, not fixed here — real but larger than this triage pass):
- Replacing the loose `Degradation.params: Record<string, number | string>` with a
  discriminated union keyed by `DegradationType`, one interface per transform. The shape
  validation added above closes the practical gap (a manifest with a missing or wrong-typed
  param now fails to load); the type-level version is a bigger refactor across `types.ts`,
  `loader.ts`, and `degrade.ts`'s dispatcher, better done as its own change.

Resolved by explanation, not deferred: two STE100 prose findings against this entry's own
first draft and against `golden-set/README.md`'s new section were addressed directly, in
place, rather than filed as follow-up work.

**Tests (all in `pnpm test`, red-first where a fix followed).**
- `scripts/golden/render.test.ts` — `buildLabelHtml`'s exact-warning-text guarantee, checked
  by a literal substring match (`.includes()`) against every rendered case's spec text; the
  same for brand/class-type text. The warning `<div>` is empty when
  `governmentWarningPresent` is false. HTML-escaping is scoped to `&`/`<`/`>` only — a first
  draft escaped `'`/`"` too, which broke the literal-substring check against case-14's
  `STONE'S THROW`; fixed by narrowing the escape to the three characters that are actually
  structural in a text-content context, never a quoted attribute here. The "omits the ABV
  line" test counts `.line` divs directly (see the review-triage note above). A
  Playwright-backed determinism test renders the same case twice and compares **decoded raw
  pixels**, not just PNG bytes, for exact equality.
- `scripts/golden/degrade.test.ts` — each transform's effect: rotation expands the canvas and
  changes pixels; blur measurably lowers stdev; glare brightens its target region only; low
  light darkens its target region only; perspective changes shape. Plus the
  boundary-rejection tests described above, including the new shear bound. The dispatcher
  routes every known type and rejects an unknown one.
- `scripts/golden/images.test.ts` — every non-`ai-generated` case's `imagePath` resolves to a
  real, non-empty, well-under-500KB file. The six degraded cases' `degradations` entries match
  exactly what's described above. Every tiny-text/odd-typography/clean case carries none. The
  ai-generated consistency check covers both directions (see the review-triage note above).
- `src/lib/golden-set/loader.test.ts` — new cases for the `degradations` schema: accepts a
  well-formed list and every transform type with its required params; rejects an unknown
  transform type, a missing `params` object, a missing required param
  (`rotate` without `angleDegrees`), a wrong-typed param (`glare` with a numeric `region`),
  and a non-empty list on a case that isn't `rendered+degraded`.

**How to run it.** `pnpm golden:build` regenerates every image from the current manifest and
code. This is deterministic on one machine: same spec in, same pixels out on that machine —
proven by the render-determinism test. Cross-machine determinism is not verified. `render.ts`'s
font stacks name system fonts (see the "Deferred" note above), so a different OS could
substitute a different font and produce different pixels. `pnpm test` runs everything above.
`pnpm typecheck` / `pnpm lint` / `pnpm build` all pass.

**Rollback.** `git revert` this ticket's commit(s). Reverting removes `scripts/golden/`, the
29 committed images, the `degradations` manifest entries and schema addition, and the
`vitest.config.ts`/`package.json` wiring. No other ticket's code depends on any of it yet.
LH-005 (Imagen) and LH-006 (verify gate) are both still open, and unblocked either way.

**Not done here (explicitly out of scope).** `scripts/golden/verify.ts` (LH-006) and
`scripts/golden/imagen.ts` (LH-005) — neither written nor called. No code in this ticket
performs a network call.
## TRO-467 — PR review round 2: 8 findings, 7 fixed, 1 dismissed (2026-08-11)

**Still does not clear CP-2.** The gate's second review pass found 8 more findings against the
corrected document. Seven were real.

Four were internal inconsistencies the round-1 edits introduced or left behind. Two passages
said capitalization is checked at "three named positions" and then listed four words. §5.4's
distance table said "the other 25 cases with a warning" when 29 total minus 2 missing-warning
cases minus 4 listed cases is **23**. Q8 still described the ladder with three outcome classes
and overlapping rate bands, while §8.4 had been corrected to four classes and disjoint bands.
And the original CP-2 entry below still credited NFKC as passing the normalization test.

Two were real gaps. §7.1 promised that a disagreement between the derived capitalization and the
model's `prefix_casing` produces REVIEW, but §6.1's mapping table had no row for it — a promise
with no branch behind it. And Appendix B's verification commands could not fail: they printed
`match: True`/`False` and exited 0 either way, and the TTB-page check carried a **second
hard-coded copy of the statutory string**, which is precisely the drift risk this document exists
to remove. Both scripts now derive the expected text from the S1 fetch, check all six of TTB's
checklist items rather than one, and exit non-zero on any mismatch. Both were extracted from the
document and executed as written before this commit.

One was prose style: §5's opening used a figurative "gets attacked in the interview". Rewritten
literally, per the repo's ASD-STE100 rule.

**One dismissed, for the second time.** *"De-hyphenation must require line-geometry evidence"*
(raised as major in round 1, escalated to critical in round 2, with no new argument). Dismissed
on two grounds, and §5.2 now states the first as a proof rather than an assertion: for the rule
to produce a false PASS, some candidate would have to de-hyphenate to the canonical string
without being a hyphenated wrap — but the rule only deletes a hyphen that a newline follows, and
the canonical string contains no hyphen, so every such candidate is canonical with a wrap hyphen
inserted. No such candidate exists. The worst case is a severity downgrade from FAIL to REVIEW,
which still puts the label in front of a person. Second: the proposed mechanism needs character
bounding boxes, which the OCR channel can supply and the vision channel cannot, so adopting it
would make the two channels disagree by construction on every hyphenated label.

**How to run it.** Nothing to build or test. Appendix B's S3–S5 and S6–S7 scripts are now
runnable checks — `bash` them; they exit non-zero if a source has changed.

**Rollback.** `git revert` this commit.

## TRO-467 — PR review triage: 15 CodeRabbit findings, 14 fixed, 1 dismissed (2026-08-11)

**This entry still does not clear CP-2.** It corrects the checkpoint document. CP-2 stays
blocking until Troy runs the walkthrough and gives explicit acknowledgment.

**What changed.** The orchestrator's gate run captured 15 findings against the CP-2 document.
Each was verified against the document before anything was edited. Fourteen were real. One was
dismissed with a reason. Three of the fixes are substantive enough to name.

**1. TTB checks the capitals in `Surgeon General`, and our draft would have passed them in
lower case.** CodeRabbit claimed TTB guidance requires it; we did not take that on faith. We
retrieved TTB's own *Checklist of Mandatory Label Information* for wine and for distilled
spirits, and both carry the checkbox verbatim: `☐ Are the “S” in Surgeon and “G” in General
capitalized?` TTB's *2022 Boot Camp for Brewers* lists lower-case `surgeon general` under "Keg
Label Common Mistakes". The document's §5.4 had recommended a fully case-insensitive body
comparison, which would have accepted a deviation the agency's own specialist is instructed to
catch. **Capitalization is now checked at four word positions** — `GOVERNMENT`, `WARNING`,
`Surgeon`, `General` — each with its own citation, and case is folded everywhere else. The
find also produced a new §2.6 mapping all six of TTB's warning checkboxes onto what LabelHunter
does and does not do, and named the two it cannot check ("one statement", "separate and apart").
This is the best material in the document, and it exists because a reviewer pushed on a claim.

**2. NFKC was wrong by the document's own standard.** §5.1 states that a normalization rule is
legitimate only when it cannot change what a human reader sees. NFKC folds compatibility forms —
fullwidth `Ａ` to `A`, the ligature `ﬁ` to `fi` — which a reader **can** see, and it fails in
the dangerous direction by making a visibly deviant label compare equal. Changed to **NFC**, with
an explicit rule for the space characters (U+00A0 and friends) that NFKC had been handling by
accident. The effect on this project is nil and the document says so: the statutory string is
pure ASCII, so every edit distance in §5.4 is unchanged. The rule was corrected because it was
wrong in principle, not because it produced a wrong number.

**3. Two claims were stated in the present tense that describe work nobody has done.** The
tesseract.js `langPath` test and "a change to the regulation breaks a test" both read as
existing protections. Neither exists. The first is now an explicit LH-020 requirement, including
the library's real filename contract (`` `${langPath}/${lang}.traineddata${gzip ? '.gz' : ''}` ``,
verified from source) and a network-disabled startup test — a test that only checks `langPath`
is set would pass while the filename is wrong. The second is now split into two mechanisms: a
deterministic CI test against the committed eCFR fixture, which catches the constant drifting;
and a separate live re-fetch, run on a schedule or by hand, which is the only thing that can
notice the regulation itself changing. Neither is built.

**The other eleven fixes.** Agreement between the VLM and OCR channels now requires matching
capitalization verdicts, not only matching words — folding case in the agreement test would have
called `GOVERNMENT WARNING` and `Government Warning` "agreeing" while they produce opposite
verdicts. The ladder's outcome classes gained a fourth ("not found") and are now stated as a
partition with a summing assertion, so a missing warning cannot inflate the resolution-suspect
rate that drives model upgrades. The ladder's rate bands no longer overlap at exactly 10%. The
capitalization check now runs on transport-normalized text rather than raw, so an invisible
zero-width character cannot cause a false capitalization failure. De-hyphenation gained its
safety argument — the statutory string contains no hyphen, so the rule cannot manufacture a PASS,
only downgrade a FAIL to a REVIEW. The golden-set count was wrong: the document said 12 while its
own table listed 13, and the correct figure under a stated selection rule is **15**; the rule and
a runnable query are now both in the document. §9.2 gained a fifth finding — the two new
capitalization positions have no covering golden case. Appendix B gained runnable commands for
every claim it had been describing in prose, so "every command is in Appendix B" is now true.

**One dismissed.** *"Single-channel PASS must be forbidden."* Dismissed: this is **open question
10**, which the document already raises with a recommendation, both costs, and a named place in
the Q&A (Q7 calls it the residual false-PASS path). Changing the rule here would pre-empt the
decision the checkpoint exists to put in front of Troy. The document surfaces the exposure rather
than hiding it, and §8.4 now also requires the single-channel rate to be reported separately so
it cannot disappear into a healthy-looking aggregate.

**How to run it.** Nothing to build or test. Re-read §2.6, §5.2, §5.4, and §7.1 — those carry the
substantive changes. Appendix B's S6–S8 commands reproduce the TTB checklist finding; they need
`pdftotext`.

**Rollback.** `git revert` this commit. It edits two documents and no code.

## TRO-467 — LH-CP2: ⛔ CHECKPOINT 2 walkthrough material (2026-08-11)

**This entry does not clear a checkpoint.** It adds the material Troy reads *at* the
checkpoint. CP-2 stays blocking until Troy runs the walkthrough and gives explicit
acknowledgment. Until then, LH-020 and LH-021 do not start.

**What changed.** One new document: `docs/checkpoints/cp2-warning-subsystem.md`. No product
code, no `src/` change, no golden-set change. It covers everything PRD §10 requires CP-2 to
cover — canonical text sourcing, the OCR choice, normalization, the exact compare, caps and
bold handling, and the limitation wording — plus the golden-set review PRD §12 assigns to this
checkpoint, and a "defend it" Q&A (TH-R9, TH-R10, TH-R7, TH-R12, TH-R15, TH-R21, TH-R23).

- **The canonical text is now verified, not assumed.** PRD §3.4 carried the statutory string
  with a note beside it: "verify verbatim against ttb.gov during implementation — a ticket,
  not an assumption." This is that task, and it is done. The statement was retrieved live on
  2026-08-11 from the eCFR API for 27 CFR 16.21 (title 27, issue date 2026-07-06) and
  cross-checked against three ttb.gov pages — malt beverage, wine, and distilled spirits. All
  four sources carry a byte-identical string. **The PRD's copy is exactly right:** 283
  characters, pure ASCII, SHA-256 `35e1f5d39ee341ac7c114f8159956cb0cc1981b94e4ffeee194ff5060bf99fbc`,
  no discrepancy in wording, punctuation, casing, or whitespace. Every command is in the
  document's Appendix B.
- **Two findings the verification turned up.** The CFR renders the statement as two
  paragraphs, not one string, so the joined form is a documented design decision rather than
  something inherited. And the caps rule lives in 27 CFR 16.22(a)(2), not 16.21 — a sentence
  that carries **two** bold rules, not one: the first two words must print in bold, and the
  remainder may not. The extractor schema has a single `formatting.bold` flag and checks
  neither. The document names both and drafts the limitation wording.
- **Normalization is the load-bearing section**, and it turns on one sentence: a normalization
  rule is legitimate only when it cannot change what a human reader sees on the label.
  Whitespace runs, line breaks, line-end hyphenation, invisible characters, Unicode NFC
  canonical forms, and an explicit list of space characters all pass that test and are
  normalized. (This bullet said NFKC when the document first shipped; NFKC folds *visibly*
  different compatibility forms and therefore fails the test — corrected in the review round
  above.) Quote folding, diacritic
  stripping, and punctuation dropping all fail it and are deliberately absent — even though
  all three appear in the brand-name normalizer, where equivalence rather than exactness is
  the requirement. The statutory string contains no apostrophe, no quotation mark, and no
  non-ASCII character, so those rules could only ever make a deviant label look compliant.
- **Capitalization is checked at four word positions and folded everywhere else.** Words 1 and
  2 must be `GOVERNMENT WARNING` in full capitals (16.22(a)(2)); `Surgeon` and `General` must
  each carry an initial capital (TTB's own label checklist — see the review-round entry above,
  which corrected this section from a fully case-insensitive body). Computed over the golden
  set's own ground-truth strings, the title-case cases (case-08, case-09) sit at edit distance
  **0** once case is folded — the separate capitalization check is the only thing that catches
  them, and rubric gate G4 depends on it. Genuine rewordings sit at distance 24 and 38, which
  is what sizes the proposed near-miss band at 1–2.
- **Every verdict maps onto a real `WarningComparatorResult` branch**, and the document names
  the two `ReviewReason` values the union cannot return: `CONFLICTING_EXTRACTION` (PRD §3.7
  uses it for channel disagreement) and `LOW_MODEL_CONFIDENCE` (golden cases 23 and 24 expect
  it). Recommendation: leave the type alone and fix the two golden entries.
- **The tesseract.js choice is verified, and it carries a hazard.** Version 7.0.0, Apache-2.0,
  pure JS plus a WASM core with no native dependencies — that is the Render argument. But
  unless `langPath` is set, it downloads language data from a public CDN **at runtime**, which
  would break TH-R7's constrained-network requirement and PRD §3.8's latency budget together.
  Found by reading the package source, not by hitting it. LH-020 must commit
  `eng.traineddata`, set `langPath`, and test that it stays set.
- **A real conflict between PRD §3.8 and one crop-detection option.** A model-reported bounding
  box cannot arrive before the model call finishes, so it cannot satisfy §3.8's "OCR runs
  concurrently with the Haiku call". The document recommends classical detection instead, with
  a band-search fallback and a single-channel final fallback.
- **The golden-set review CP-2 owns.** 29 cases, 15 warning-relevant (the count and its
  selection rule were corrected in the review round above), **zero images** —
  `golden-set/images/` holds only `.gitkeep`. CP-2 can sign off on the specifications and
  cannot sign off on the pixels. Five findings are raised for the walkthrough to settle.
- **Eleven open questions**, each with a recommendation and the cost of choosing wrong. Every
  threshold is marked **proposed** and every unmeasured figure says "not measured", CP-1 style.
  A fifth claim label, **verified**, was added for retrieved statutory text — it is a stronger
  claim than "derived" and weaker than "measured on our own system".

**How to run it.** Nothing to build, nothing to test — this branch adds no code, so `pnpm build`
and `pnpm test` have nothing new to exercise. Read `docs/checkpoints/cp2-warning-subsystem.md`
— about 45 minutes — and work the Appendix A checklist during the walkthrough. Appendix B holds
a runnable command for every **verified** claim in the document, including the canonical-text
byte comparison against PRD §3.4 and the golden-set case count.

**Rollback.** `git revert` this commit. The document adds no code and nothing imports it.
## TRO-465 — LH-013 comparator swap (2026-08-11)

**What changed.** LH-013 (TRO-463) merged real field comparators to `main`
(`src/server/comparators/`). This ticket's one swap point,
`src/app/api/verify/route.ts`, now imports `productionComparators` from there instead of
the provisional stand-in. `provisional-comparators.ts` and its test are deleted — nothing
else in the repo imported them.

**Behavioral change, honest.** `alcohol_content` and `net_contents` can now report a
`MISMATCH` on a genuine numeric disagreement — the provisional stand-in never asserted
`MISMATCH` for any field. `brand_name`/`class_type` still never do (CP-1 §5.3: a judgment
call routes to REVIEW, never a silent FAIL — LH-013's own design, unchanged by this ticket).
The label-level verdict a real disagreement now produces is still `REVIEW`, not `FAIL`: the
government warning has no comparator yet (LH-020) and always needs review today, and REVIEW
outranks FAIL in the rollup. `route.test.ts` updated: the STONE'S THROW case now asserts a
real `MATCH` with a normalization note (TH-R8, previously untestable under the provisional
stand-in's plain casefold); a new test asserts the ABV field-level `MISMATCH` this ticket
could not previously produce. No test was weakened — every changed assertion states the real
comparator's real behavior, verified by reading `src/server/comparators/*.ts` directly, not
by trusting either side's prose.

**How to run it.** `pnpm typecheck`, `pnpm lint`, `pnpm test` (400 tests), `pnpm build` — all
green.

**Rollback.** `git revert` this commit. The provisional comparator files it deletes are
restored by the revert; no other ticket depends on them.

## TRO-465 — PR review round 1: orchestrator triage, 9 fixed, 0 dismissed (2026-08-11)

**What changed.** The worktree's captured CodeRabbit review (`.factory/coderabbit.json`, 9
findings) was triaged against current code, not against the review text's own instructions.
Every finding checked out as real and current — none was stale or a misread. All 9 fixed.

Fixed, real:

- `verify-client.ts` (critical): the default `fetchImpl` was a bare `fetch` reference. Some
  engines throw "Illegal invocation" when `fetch` runs detached from its receiver. Fixed:
  `globalThis.fetch.bind(globalThis)`. Added a test that stubs `globalThis.fetch` and confirms
  the default path works with no injected `fetchImpl`.
- `verify-client.ts` (major): `isVerifyErrorResponse` accepted any object with an `error` key,
  with no check that `kind` was a real `VerifyErrorKind` or that `message` was a string. A
  successful response was cast to `VerifySuccessResponse` with zero shape check. Fixed: `kind`
  now checks against a new `VERIFY_ERROR_KINDS` array (`types.ts`), and a new
  `isVerifySuccessResponse` guard checks `applicationId`, `verificationId`, `labelVerdict`
  (against `LABEL_VERDICTS`), and `fields` before trusting the body. Either check failing now
  throws the same designed `VerifyClientError("SERVICE", …)` instead of letting a malformed
  body reach `ResultsChecklist` and crash it. Four new tests cover the paths this closes.
- `ResultsChecklist.tsx` (major): its own `aria-live="polite"` wrapper mounts fresh, with its
  content already inside, only once a result exists — a live region that appears with content
  already in it is not guaranteed to be announced (WAI-ARIA). Fixed: `ResultsChecklist` no
  longer sets `aria-live` itself; `VerifyForm.tsx` now renders it inside the one persistent
  `aria-live="polite"` region that already existed for the loading message, present from the
  form's first render.
- `parse-request.test.ts` (trivial, ×2): added a test for the inclusive alcohol-content
  boundaries (0 and 100 both parse) and a test for a missing `netContentsUnit` (same rejection
  message as an unrecognized one).
- `ResultsChecklist.test.tsx` (trivial): added a test for a `MISMATCH` row — the suite
  previously only exercised `MATCH` and `NEEDS_REVIEW`.
- `VerifyForm.tsx` (trivial): added a comment on the `FormData` build explaining why it must
  run before `setPhase({ status: "loading" })` — every control disables on loading, and a
  disabled control is excluded from `FormData` by the HTML forms spec itself.
- `CHANGES.md` (minor, ×2): reworded the provisional-comparators bullet for precision
  (`provisional-comparators.ts` defines the default bundle; `route.ts` is the call site that
  passes it into `routeLabel`) and rewrote the styling/jsdom/how-to-run prose to ASD-STE100 —
  shorter sentences, one instruction each, no hedging, no embedded test/file counts that go
  stale on the next edit.

Not raised by this review, confirmed unchanged: no finding asked for the real field
comparators or the warning subsystem. The provisional stand-in and the `warningResult: null`
wiring stay exactly as this ticket's original entry describes — settled design, not something
this round touched. `main` still does not have LH-013 merged (re-checked before this round).

**How to run it.** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — all green.

**Rollback.** `git revert` this commit. Independent of the original TRO-465 commit below;
reverting this one alone restores the pre-triage behavior without touching the rest of the
ticket.

## TRO-465 — LH-015: Verify screen + results checklist (2026-08-11)

**What changed.** The single-label verify flow now runs end to end. It serves PRD §3.8, §5,
and TH-R1, TH-R3, TH-R20.

- `src/app/api/verify/route.ts` — a new `POST /api/verify` route. One request does the whole
  fast path: preprocess the photo, run the Haiku extractor, route the result, persist
  `applications`, `label_images`, `verifications`, `field_results`, and — on a REVIEW verdict —
  `review_queue`. It returns per-field verdicts and the label verdict in the same response. It
  never calls Sonnet. A REVIEW verdict returns immediately with an explicit "needs review —
  {reason}" flag, matching PRD §3.8's latency contract; LH-014's resolver (a sibling ticket,
  not yet merged) consumes the `review_queue` row later, on its own schedule.
- `src/app/api/verify/parse-request.ts` — boundary validation for the multipart form: image
  present, beverage type in the closed set, brand name and class/type non-blank, alcohol
  content a number in 0–100 or blank, net contents a positive number with a recognized unit.
  Every rejection carries a specific, plain-language message.
- `src/app/api/verify/types.ts` — shapes shared between the route and the UI.
- `src/server/router/provisional-comparators.ts` — **LH-013 (TRO-463) has not merged.** This
  file defines the default `FieldComparators` bundle: exact text match after a trim and a
  casefold, and the router's own provisional numeric parser for ABV and net contents. It never
  returns `MISMATCH` on its own (PRD §3.3: a real disagreement routes to REVIEW, never a
  silent FAIL). `route.ts` is the only production call site that passes a `FieldComparators`
  value into `routeLabel` — it does so through `VerifyRouteDeps.comparators`, defaulted to
  this bundle. Swap the one import in `route.ts` for LH-013's real bundle when it lands;
  nothing else changes.
- **The government warning has no comparator yet either** (LH-020, gated by CP-2, not yet
  merged). `route.ts` passes `warningResult: null` to `routeLabel` — honestly, not a
  fabricated match. `resolveGovernmentWarningField` (LH-012) already handles a `null` result
  by routing to `NEEDS_REVIEW`. Until LH-020 lands, every label with a warning on it needs
  review for that one field. Expected, not a bug in this ticket.
- `src/server/storage/local-file-storage.ts` — writes the uploaded photo to `var/uploads/`
  (gitignored) and returns the path `label_images.storage_path` stores. Prototype-appropriate,
  not a durable store: Render's filesystem is ephemeral, so a redeploy can lose these files
  while the database row survives. Documented in the file as a one-file swap point for a real
  object store later.
- `src/app/page.tsx` — replaces the scaffold placeholder with the Verify screen: upload
  control, the five application fields plus the beverage-type selector, one Verify button.
- `src/app/_components/VerifyForm.tsx`, `ResultsChecklist.tsx`, `ErrorPanel.tsx` —
  the form, the results checklist (✓ / ✗ / ⚠ rows with evidence and the one-line reason from
  `reason-text.ts`, never a bare confidence number), and the designed error panel (`role="alert"`,
  not a toast) for every failure mode TH-R20 names.
- `src/app/_lib/verify-client.ts` — the fetch wrapper. Classifies every failure into
  `VerifyClientError` with a `kind`: a structured error body from the server, a non-2xx
  response with none, a response this client cannot parse, a network failure, or a 45-second
  client-side timeout (`AbortController`) for the case the server never answers.
- `src/app/globals.css` — USWDS-influenced styling: navy and white, 18px base type, and
  high-contrast focus rings. No purple-gradient AI slop. No emoji-driven design. Dark mode
  follows `prefers-color-scheme`.

**A jsdom finding, not a product bug.** `VerifyForm` reads the selected photo from the file
input's own `.files` ref, not `new FormData(form).get("image")`. In this repo's jsdom test
environment, a `FormData` built from a form element reconstructs its file entries with the
right filename but `size: 0`. The reconstruction loses the underlying bytes. Reading the input
directly avoids the problem.

**How to run it.** Run `pnpm dev` and open `/`. Run
`pnpm test -- src/app src/server/router/provisional-comparators.test.ts src/server/storage`
for this ticket's own suites. Run `pnpm test` for the full suite; every test passes. Run
`pnpm build`; it succeeds. A manual smoke test against `pnpm start` confirmed the page
renders. The same test confirmed that `/api/verify` returns the correct JSON for a missing
image and for an unreadable image, over a real HTTP request. The smoke test made no live
Anthropic call.

**What this ticket could not verify.** No live Haiku call, and no real photograph of a real
label — every test mocks the Anthropic client (`makeMockMessage`, matching
`src/server/extractor/index.test.ts`'s own pattern) or uses a synthetic sharp-generated JPEG.
A true end-to-end run needs a real `ANTHROPIC_API_KEY` and a real label photo; say so rather
than claim it.

**Comparator set shipped.** Provisional (`provisional-comparators.ts`), not LH-013's real
bundle — LH-013 had not merged into `main` as of this ticket's work. `main` was re-checked
immediately before finishing; still not merged.

**Rollback.** `git revert` this commit. `var/uploads/` is gitignored and holds no data worth
preserving.

## TRO-463 / TRO-504 — LH-013: real field comparators (2026-08-11)

**What changed.** This ticket builds the real field comparators under `src/server/comparators/`.
They replace the router's placeholder judgment logic. They serve TH-R8 and TH-R11.

- `normalize.ts` — the fuzzy-match normalizer. Six steps: Unicode NFKC, casefold, apostrophe
  folding, diacritic stripping, whitespace collapse, punctuation drop. Apostrophe folding runs
  before NFKC, not after. NFKC decomposes the acute accent (´) into a space and a combining
  mark. Folding first keeps that character from disappearing before the fold rule can see it.
  A code comment explains the exception.
- `similarity.ts` — normalized Levenshtein distance. It backs the brand/class fuzzy match.
- `brand.ts` — the real `brand_name` / `class_type` comparator. TH-R8's named case: label
  "STONE'S THROW" against application "Stone's Throw" now MATCHes, with a note. Similarity at
  or above 0.95 MATCHes. Below 0.95, the field goes to NEEDS_REVIEW. It never returns MISMATCH.
  A brand comparator is a judgment tool, not an exact one.
- `abv.ts` — the real ABV grammar. It reads a percent, a proof statement, or both, in either
  order. It checks proof against percent: 27 CFR 5.1 defines proof as twice the percent by
  volume. It compares the label's percent against the application's declared percent.
- `net-contents.ts` — the real net-contents grammar. It reads a value and a unit (mL, L, fl
  oz), converts units, and compares the label's quantity against the application's.
- `index.ts` — `productionComparators`, the one import site LH-015 (TRO-465) wires into
  `routeLabel` in place of the router's placeholder set.

**TRO-504's three deferred edge cases close here, not as patches to the code they name.**

1. Combining marks did not stop `text-boundary.ts`'s evidence check from reading a combining
   mark's position as a word boundary. An unaccented value could pass as evidence for a
   different, accented word. `\p{M}` now joins `\p{L}\p{N}` in that check's lookaround.
2. `text-boundary.ts`'s casefold used bare `toLowerCase()`. German ß did not fold to "ss", so
   an all-caps label spelling and a mixed-case ß spelling of the same word did not match. Both
   `text-boundary.ts` and the new fuzzy normalizer now fold ß (and ẞ) to "ss".
3. The net-contents parser stopped at the first number in the text and gave up if that
   number's unit did not match. `"90 Proof 750 mL"` returned no match instead of finding
   `750 mL`. The real parser scans every number in the text and returns the first one a known
   unit follows.

**A regulatory VERIFY cell closes.** `required-fields.ts` marked beer's `alcohol_content` cell
VERIFY. 27 CFR 7.65(a) states an alcohol content statement is optional on a malt beverage
label, unless a state law prohibits or requires it. This system models the federal rule, not
state law. The cell is now `not_required`, cited. Wine's cell stays VERIFY: 27 CFR 4.36(a)'s
real rule is conditional on the wine's own ABV and its class/type wording. The required-field
table has no way to express that condition without a larger schema change. The comment states
what was verified and what still needs a larger fix.

**Two numbers move from "fails safe, unverified" to "verified, and zero is correct."** TTB's
ABV tolerance regulations govern the bottled product against its own label (27 CFR 5.65(b) for
spirits, 27 CFR 4.36(b) for wine). This comparator checks a different thing: does the label's
printed number match the application form's declared number. Zero tolerance is the right
answer for that second question. It is not a stand-in for the first.

**Wiring.** `field-resolution.ts` and `overrides.ts` import their numeric parsing from
`../comparators/abv.ts` and `../comparators/net-contents.ts` now, not from
`provisional-numeric.ts`. That file's docstring says LH-013 replaces its callers, not
necessarily the file itself. Its only remaining caller is `test-support.ts`'s own placeholder
fixtures, which belong to the already-merged LH-012 router-core ticket. The docstring is
narrowed to say so.

**A known gap, left open rather than silently fixed.** CP-1 §5.3 names three literal
apostrophe variants to fold: the straight apostrophe, the backtick, and the acute accent. A
label extracted by a real vision model may use a Unicode right single quotation mark (’,
U+2019) as a stylized apostrophe instead. That character is not one of the three named
variants, so it is not folded. Measured effect: "Stone’s Throw" against "Stone’s Throw" scores
about 0.923 similarity. That is just under the 0.95 match threshold. The pair routes to
NEEDS_REVIEW, not a clean MATCH. `docs/checkpoints/cp1-cascade-router-prompts.md` should decide
whether to widen the rule. This ticket implements the rule as written, not a guess at its
intent.

**Six more fixes from this ticket's own CodeRabbit review round, applied before this commit.**
Each one is a real gap, each has a named regression test, and each keeps the comparators pure
functions with no new dependency.

- `brand.ts`: two values that both normalize to an empty string (e.g. "..." against "---",
  once punctuation is stripped) no longer score a false MATCH. Empty normalized text has
  nothing left to judge, so it now routes to NEEDS_REVIEW like any other undecidable pair.
- `abv.ts`: `compareAbv` now catches a self-contradictory label (CP-1's own named example, "45%
  Alc./Vol. (100 Proof)") on its own, as a pure function — not only through the router's
  separate structural check. It reports NEEDS_REVIEW even when the stated percent happens to
  equal the application's.
- `net-contents.ts`: `parseNetContents` now reads a comma-grouped thousands number
  ("1,000 mL") as one value, and does not misread a comma-decimal (European-style "1,5") as a
  US decimal.
- `net-contents.ts`: `compareNetContents` now MATCHes two equal zero quantities. The tolerance
  check divides by the application's quantity, defined as an infinite fraction when that
  quantity is zero — correct when the label states something else, wrong when the label also
  states zero and the two numbers actually agree.
- `field-resolution.ts`: `checkAbvStructural`'s tolerance-vs-application check now reads a
  proof-only label's canonical percent (27 CFR 5.1), not only a label that states a percent
  directly. A proof-only reading used to skip this check entirely.
- `overrides.ts`: the ABV evidence-support check now compares the value and the evidence on
  the canonical percent scale, not axis-by-axis (percent-vs-percent, proof-vs-proof only). A
  value stated as "45%" whose evidence states only "90 Proof" is the same reading and is now
  recognized as such — this is the same bug class TRO-462's own `abvAlternatesConflict` fix
  already closed for the alternates check, now closed here too.

**Two required-fields.ts findings from that same review round, not adopted.** CodeRabbit
suggested reverting beer's `alcohol_content` cell from `not_required` back to `verify`. This
ticket verified the regulation directly (27 CFR 7.65(a), fetched and quoted in the code
comment): a malt beverage label's alcohol content statement is optional under federal law.
`not_required` is the cited, correct value, not a guess CodeRabbit's heuristic should override.

**Three more fixes from PR #8's GitHub review, applied before this commit.** Each one has a
named regression test.

- `net-contents.ts`: `parseNetContents("1,5 L")` used to return `{ value: 5, unit: "l" }`
  instead of failing. The comma-grouping fix above stopped it from misreading "1,5" as "1.5",
  but it left the orphaned "5" behind as a fresh candidate. `NUMBER_PATTERN` now refuses to
  read a bare number that sits directly after a comma, so a malformed comma-decimal rejects the
  whole read instead of handing back a different, wrong quantity.
- `field-resolution.ts`: `checkNetContentsStructural`'s alternates check now MATCHes two equal
  zero quantities, the same zero-division bug already fixed in `compareNetContents`, present
  here too.
- `text-boundary.ts`: `normalizeForBoundaryMatch` now calls `.normalize("NFC")` first. A
  precomposed accented letter and its canonically equivalent decomposed form (a base letter
  plus a combining mark) used to normalize to different strings. They are the same text under
  Unicode's own definition, and now they normalize the same way.

**A note on running tests.** `pnpm test` and `pnpm test -- <path>` both read `DATABASE_URL`.
Every worktree gets its own database (`scripts/factory/worktree.sh`); running tests with
`DATABASE_URL` unset, or pointing at any database other than the current worktree's own, is
this repo's own non-negotiable rule (`CLAUDE.md`) — test provisioning resets the target
schema. `source .factory-env` before running either command below.

**How to run it.** `pnpm test -- src/server/comparators src/server/router` runs the new and
changed suites. `pnpm test` runs everything; 344 tests pass repo-wide. `pnpm typecheck` and
`pnpm lint` are both clean.

**Rollback.** `git revert` this commit. That one command is the whole procedure. The same
commit changed `field-resolution.ts` and `overrides.ts`'s imports. It also added the module
they import from. A revert restores the old imports and the old behavior together. Nothing is
left to fix by hand.

## TRO-462 — PR review round 2: orchestrator triage, 2 fixed, 3 deferred (2026-08-10)

**What changed.** The orchestrator's independent gate run found 5 more CodeRabbit findings
against the round-1 fix commit. Two were real and fixed here.

- `field-resolution.ts` (major): `abvAlternatesConflict` compared a percent reading to a
  percent alternate, and a proof reading to a proof alternate, as two separate checks. It
  never converted across the two scales. `"45%"` against an alternate of `"100 Proof"`
  passed as agreeing, because neither separate check ever ran — 100 Proof has no percent
  reading to compare, and 45% has no proof reading to compare. Fixed: both readings convert
  to a canonical percent scale first (proof is twice the percent, 27 CFR's own definition),
  then compare. `"45%"` against `"90 Proof"` now correctly agrees. `"45%"` against
  `"100 Proof"` (50%) now correctly conflicts.
- `types.ts` (major): `FieldResultRow` allowed `resolvedBy: "sonnet"` with
  `reviewReason: null` — a state that should not exist, since a field is only resolved
  because something escalated it. Fixed: a discriminated union. The resolved branch
  requires the reason; the unresolved branch keeps it nullable. No behavior change — every
  construction site in this ticket already passes `resolvedBy: null`, since LH-014's
  resolver does not exist yet.

Three findings were real but deferred, filed as **TRO-504** rather than fixed here:
combining-mark and German-ß handling in the word-boundary text match (deep Unicode edge
cases with no golden-set coverage yet), and a provisional net-contents parser that stops
at the first unsupported unit instead of scanning past it (the parser's own docstring
already marks it a stand-in for LH-013's real implementation — more polish on a stand-in
is not the right place to spend the fix).

**How to run it.** `pnpm test -- src/server/router` — 11 files, 135 cases (up from 133).

**Rollback.** `git revert` this commit. The two fixes are independent of round 1; nothing
else depends on either change.

## TRO-462 — LH-012: Validation Router core (2026-08-10)

**What changed.** This ticket adds the Validation Router's decision logic under
`src/server/router/`. It serves PRD §3.3, TH-R2, TH-R8, and TH-R19. The router answers one
question. Given what the Haiku extractor read, and what the applicant filed, what does each
field's verdict say? What does the whole label say? The router is deterministic TypeScript.
It never calls a model.

This ticket builds the router shell. That shell covers confidence bands, the
anti-hallucination overrides, the eight `ReviewReason` rules, their precedence, and the
label-level rollup. The design comes from `docs/checkpoints/cp1-cascade-router-prompts.md`
§4-§5. Troy approved that design at CP-1. This ticket implements it as written.

This ticket does not build the real field comparators. Those cover normalization, fuzzy
brand and class matching, ABV parsing, and net-contents parsing. LH-013 (TRO-463) owns that
work, and this ticket blocks it. This ticket also does not build the warning comparator.
LH-020 owns that work, in its own CP-2-gated subsystem.

**Files.**
- `types.ts` — the router's public shapes. `ApplicationRecord` is the applicant's filed
  record. `FieldComparator` is the interface LH-013 implements against. `WarningComparatorResult`
  is the contract LH-020 implements against. It is a discriminated union: a `NEEDS_REVIEW`
  verdict requires a `reviewReason`; every other verdict forbids one. `PreprocessingSignal`
  carries what LH-010 found before the image reached the extractor. `FieldResultRow` is one
  output row, with CP-1 §5.5's exact columns.
- `confidence.ts` — the three confidence bands from CP-1 §4.2, and the asymmetry rule from
  §4.3. A low-confidence MATCH escalates only below 0.60. A low-confidence MISMATCH escalates
  below 0.90. A NEEDS_REVIEW comparator result always escalates. The two escalation cutoffs
  look like the per-field trusted threshold (0.85, or 0.90 for the warning transcription),
  but they answer a different question. This file names them as separate constants
  (`MATCH_ESCALATION_CEILING`, `MISMATCH_ESCALATION_CEILING`) so a future re-tune of one does
  not silently move the other.
- `overrides.ts` — the three CP-1 §4.4 anti-hallucination checks. Evidence must be present.
  Evidence must support the value at a boundary, not a substring. Confidence must be a real
  number in range. A failed check rejects the field. It never clamps a bad number into range.
  `beverage_type` is exempt from the evidence-support check only. Its value is an inferred
  category. It is never verbatim in the label's evidence. This is a known, ticketed exemption,
  TRO-502. The exemption is commented at its call site in `index.ts`.
- `text-boundary.ts` — the word-boundary text check the evidence-support override uses for
  text fields. This is not LH-013's real normalization pipeline. LH-013's pipeline covers
  Unicode NFKC, apostrophe folding, and diacritic stripping. This file answers one narrower
  question only: does the evidence contain this exact word.
- `provisional-numeric.ts` — a minimal, clearly-labeled stand-in ABV and net-contents parser.
  The overrides' numeric check uses it. The `AMBIGUOUS_ABV` and `AMBIGUOUS_NET_CONTENTS`
  structural checks use it too. LH-013 replaces every caller with the real, ttb.gov-cited
  grammar.
- `required-fields.ts` — the required-field-by-beverage-type table. It implements CP-1 §5.3's
  table exactly as given, including the `alcohol_content` cells CP-1 marks **VERIFY** for
  beer and wine. A `"verify"` cell stays its own distinct value. The code does not fold it
  into `"required"` silently. It does route as required today. That is the fail-safe reading.
- `field-state.ts` — the field-shape-aware absence check. `government_warning` has no
  `value`. It has `present` instead. A uniform `value === null` check would never fire for
  the warning field. It would silently pass a warning the router never actually examined.
- `label-blockers.ts` — the two label-level blockers, `LOW_IMAGE_QUALITY` and
  `CONFLICTING_EXTRACTION`.
- `field-resolution.ts` — the field-specific `AMBIGUOUS_ABV` and `AMBIGUOUS_NET_CONTENTS`
  structural checks. This includes the proof-arithmetic self-contradiction check. CP-1 names
  `"45% Alc./Vol. (100 Proof)"` as the worked example. This file also resolves each field's
  final verdict and reason, for the four comparator-driven fields and for the government
  warning's contract.
- `precedence.ts` — the exact CP-1 §5.2 rank order, and the headline-reason picker.
- `rollup.ts` — the CP-1 §5.4 label rollup. A label-level blocker outranks every field
  verdict. The rollup checks the blocker first, so it cannot miss one.
- `reason-text.ts` — one line of UI English per row. PRD §3.3 and TH-R20 require this. The
  text is never a bare confidence number.
- `index.ts` — `routeLabel`, the module's one public entry point. It wires every file above
  together.
- `test-support.ts` — placeholder comparators for this ticket's own tests. They check exact
  match after a trim and a casefold. They are honestly named. Nobody should read them as real
  judgment logic. `STONE'S THROW` and `Stone's Throw` would NOT match here. That judgment is
  LH-013's job.

**Load-bearing decisions.**
- The word-boundary evidence check first used `\b`. `\b`'s boundary depends on the character
  at the edge of the pattern itself. The government warning transcription ends in a period.
  That put a non-word character on both sides of the trailing `\b`. The check never matched,
  even for the correct reading. TDD caught this. The first `index.test.ts` run failed a
  clean-fixture case with `CONFLICTING_EXTRACTION`, for the right reason. The fix uses
  lookaround instead: `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])`, with the `u` flag. Lookaround
  checks the character outside the match. It also now recognizes Unicode letters, not only
  ASCII ones, so an accented brand name does not break the boundary check.
- The asymmetry rule's two escalation cutoffs are fixed values. They apply the same way
  across every field. They do not scale off the per-field trusted threshold. CP-1 §4.3 gives
  them as flat numbers, not a formula.
- `MISSING_REQUIRED_FIELD` does not fire when `LOW_IMAGE_QUALITY` already fired for the
  label. CP-1 §5.3 states this carve-out for this one pair of reasons. This ticket implements
  that carve-out literally. It does not generalize it into a broader rule the document does
  not state elsewhere.
- `REVIEW_REASON_PRECEDENCE` derives from a `Record<ReviewReason, number>`, not a hand-written
  array. TypeScript requires every `ReviewReason` member to have a rank. A ninth reason added
  to the enum without a rank is a compile error here, not a silent gap.

**Review round.** Two independent CodeRabbit passes ran against the first commit: one from
this worktree's own gate, one from the orchestrator's. Together they found real, fix-now
issues, folded into this same entry rather than a separate one, since no PR had opened yet.
- **Major.** `buildFieldReasonText`'s verdict fallback treated every non-MISMATCH verdict as
  a match. CP-1 §5.3's own carve-out (above) leaves a field at `NEEDS_REVIEW` with
  `reviewReason: null`. That field printed "Matches the application." Fixed: a `NEEDS_REVIEW`
  verdict now falls back to its own line, "This field needs a closer look."
- **Major.** The `AMBIGUOUS_ABV` and `AMBIGUOUS_NET_CONTENTS` alternates check flagged any
  non-empty `alternates` array, even one that only restated the same number. CP-1 §5.3 says
  "conflicting ways," not "stated twice." Fixed: each alternate is now parsed and compared to
  the primary value; only a genuine numeric disagreement counts as a conflict.
- **Major.** `provisionalParseNetContents`'s regex could capture trailing label text past the
  real unit, e.g. `"750 mL Alcohol 45%"`, and then fail to match any known unit at all. Fixed:
  the unit is now matched against the start of the captured text only, so trailing text after
  the unit does not break the parse.
- **Major.** `numericEvidenceSupportsNetContents` (the §4.4 override's numeric check) compared
  unit strings, so `"750 mL"` as the value and `"0.75 L"` as the evidence — the same quantity —
  failed the check. Fixed: both sides now convert to mL before comparing, matching CP-1 §5.3's
  own wording, "the converted values."
- **Major.** `WarningComparatorResult` allowed a `NEEDS_REVIEW` verdict with no `reviewReason`,
  and the router silently defaulted one. Fixed: the type is now a discriminated union.
  `reviewReason` is required on the `NEEDS_REVIEW` branch and does not exist on any other
  branch. An unnamed REVIEW result is a compile error for LH-020 to hit, not a silent default.
- **Major.** `isLowImageQuality`'s partial-legibility check counted an override-rejected
  field's confidence, even though `overrides.ts` zeroes that confidence only so it never
  displays a garbage number. That zero is evidence the extraction was broken, not evidence the
  image was hard to read. Fixed: an override-rejected field is now excluded from this check.
- **Major.** The `beverage_type` cross-check compared the extractor's raw string against the
  application's beverage type with no normalization, so `"Spirits"` (a valid, schema-legal
  extractor output) against `"spirits"` (the application's value) would have falsely triggered
  `CONFLICTING_EXTRACTION`. Fixed: both sides are normalized the same way the evidence
  word-boundary check normalizes text, before comparing. The 0.85 confidence gate on this
  check now reuses `TRUSTED_THRESHOLD_DEFAULT` instead of a second, separate 0.85 literal.
- **Minor.** The three `AMBIGUOUS_*` reason texts all read "needs a closer look," with no
  detail. Fixed: each now names what a reviewer must check, e.g. "A reviewer must check the
  alcohol content against the label."
- **Minor.** This entry's own opening sentence, and several entries below, buried more than
  one idea inside a single long sentence with nested em-dash parentheticals. The same catch
  TRO-461's review made. Fixed: rewritten throughout as short, standalone sentences.

**Regression tests.** `src/server/router/*.test.ts` — 11 files, 133 cases. One file covers
one concern: confidence bands, overrides, provisional numeric parsing, the required-field
table, field-shape-aware absence, the two label blockers, field resolution, reason text,
precedence, rollup, and an `index.test.ts` integration suite. Named cases include the
proof-arithmetic self-contradiction example, the `beverage_type` TRO-502 exemption, and a
case for every review-round fix above.

**How to run it.** `pnpm test -- src/server/router` runs 11 files and 133 cases. `pnpm
typecheck` and `pnpm lint` both run clean. The full repo suite, `pnpm test`, runs 23 files
and 247 cases.

**Known limits.** The real field comparators, LH-013, and the warning comparator, LH-020, do
not exist yet. This ticket routes on their contracts, not their real output. The
`alcohol_content` VERIFY cells for beer and wine, and the ABV and net-contents tolerances,
stay unverified regulatory placeholders. Each one is flagged in code, pending LH-013's
ttb.gov citations.

**Rollback.** Run `git revert` on this commit and the router-core commit before it.
`src/server/router/*.ts` and `*.test.ts` are removed, and `.gitkeep` returns.

## TRO-461 — PR review: local CodeRabbit triage, 3 findings fixed (2026-08-10)

**What changed.** The local `scripts/factory/gate.sh` run captured 3 findings; all 3 were
real and fixed here.
- `index.ts` (major): `extractLabel` built a fresh `new Anthropic()` on every call when
  no client was injected. Fixed: `getDefaultExtractorClient()` builds the client once and
  reuses it. A batch run extracts hundreds of labels (PRD §3.5); a client per call is
  needless setup. The shared client sets `timeout: 30s`. That timeout is a safety net
  against a hung request; the SDK's own default is 10 minutes, sized for long completions.
  The shared client also sets `maxRetries: 0`, not the SDK default of 2. An SDK-level
  retry would run underneath the batch worker's own rate-limit backoff (CP-3 builds that
  worker) with no coordination between the two, and could add seconds that neither TH-R2's
  5-second budget nor TH-R4's batch throughput accounts for. The caller decides whether to
  retry a 429 or 5xx. `options.client` still overrides the shared client, for tests.
  Verified the reuse test is load-bearing: removing the caching made
  "returns the same client instance on every call" fail, as expected, then restored it.
- `golden-case.test.ts` (minor): the government-warning assertions hardcoded `true`/
  `"ALL_CAPS"` instead of deriving them from the golden-set fixture. A fixture change
  would have surfaced as a confusing mismatch that looked like a `parseExtractionResponse`
  bug. Fixed: added an explicit precondition assertion on
  `label.governmentWarningPresent`/`governmentWarningPrefixAllCaps`, and the downstream
  result assertions now compare against those same fields instead of literals.
- `makeMessage` (trivial): duplicated verbatim across `index.test.ts`, `response.test.ts`,
  and `golden-case.test.ts` — three real copies, not a premature abstraction. Extracted to
  `src/server/extractor/test-support.ts` (`makeMockMessage` + `WELL_FORMED_EXTRACTION_BODY`);
  all three test files import it now.

Also tightened `index.test.ts`'s first assertion, which had asserted the mock client was
called with `buildExtractionRequestParams(IMAGE)` — the same function `extractLabel` calls
internally, so the check couldn't catch `extractLabel` wiring the wrong params. It now
asserts the identity-critical fields (model, one message, the image block's data and media
type) independently; byte-for-byte request validation stays in `request.test.ts`, which
already uses an independent oracle for the CP-1 prompt/schema bytes.

**How to run it.** `pnpm test -- src/server/extractor` — 4 files, 34 cases (was 32; +2 for
`getDefaultExtractorClient`). `pnpm typecheck` / `pnpm lint` both clean.

**Rollback.** `git revert` this commit; `index.ts` returns to constructing `new Anthropic()`
per call, and the three test files return to their own local `makeMessage`/`WELL_FORMED_BODY`
copies.

## TRO-461 — LH-011: Haiku extractor (2026-08-10)

**What changed.** The Haiku extractor (PRD §3.2, TH-R1, TH-R11) under
`src/server/extractor/`. It answers one question — what does this label say? — with
one Haiku call per label, strict JSON output, and no view of the application record
(CP-1 §3.1: no anchoring). Comparing the read to an application is the Validation
Router's job (LH-012/013), not this ticket's.

- **`prompt.ts`** — `SYSTEM_PROMPT` and `USER_MESSAGE_TEXT`, the CP-1-approved bytes
  (`docs/checkpoints/cp1-cascade-router-prompts.md` §3.2–§3.3) copied verbatim.
- **`schema.ts`** — `EXTRACTION_JSON_SCHEMA`, the CP-1-approved strict JSON schema
  (§3.4), also copied verbatim.
- **`types.ts`** — TypeScript types for the schema: `HaikuExtractionResult` and its
  parts (`ExtractedField`, `ExtractedGovernmentWarning`, `ExtractedImageQuality`).
- **`request.ts`** — `buildExtractionRequestParams(image)`, a pure function that
  assembles the request: `model: "claude-haiku-4-5"`, `temperature: 0`, the image
  block before the text block, `output_config.format` carrying the schema. No
  `output_config.effort` (the model rejects it), no `cache_control` (the prompt is
  under the caching minimum on this model).
- **`response.ts`** — `parseExtractionResponse(message)` turns a raw Anthropic
  response into a typed `HaikuExtractionResult`, or throws `HaikuExtractionError`
  naming every shape problem it finds (refusal, early stop, no text block, invalid
  JSON, a wrong type or enum value at an exact path) — never a silent partial
  result. It checks shape only; the confidence-range and evidence-substring
  overrides (CP-1 §4.4) belong to the Validation Router, not this ticket.
- **`index.ts`** — `extractLabel(image, options?)`, the public entry point. One
  Anthropic call, no retry-as-a-second-opinion, and it never references Sonnet
  (TH-R19: the cascade is the architecture, not an optimization). Takes an
  injectable `client` for tests; defaults to a new client reading
  `ANTHROPIC_API_KEY` from the environment.

**Load-bearing decisions.**
- The image content block comes before the text block in the user message, matching
  CP-1 §3.3's draft order exactly.
- `max_tokens: 2048` — CP-1 §7.1 assumes ~600 output tokens for six fields plus
  evidence strings; this leaves headroom for a long warning transcription without
  needing to stream.
- The response parser collects every validation problem in one pass, the same
  convention `src/lib/golden-set/loader.ts` already uses for the manifest — a
  malformed response names every field that is wrong, not just the first one found.

**API facts confirmed live against `api.anthropic.com` today (CP-1 §3.5), not just
taken on documentation:**
1. `claude-haiku-4-5` is a valid, current model ID — `GET /v1/models/claude-haiku-4-5`
   resolves to `claude-haiku-4-5-20251001`, `structured_outputs.supported: true`,
   `image_input.supported: true`.
2. `claude-haiku-4-5` rejects `output_config.effort` — a real request with `effort: "low"`
   returned `400 invalid_request_error: "This model does not support the effort
   parameter."`
3. `claude-haiku-4-5` accepts `temperature: 0` — the full request (system prompt, schema,
   a synthetic image, `temperature: 0`) returned `200` with schema-conformant JSON.
4. `cache_control` on this system prompt does nothing — a request with the marker
   returned `cache_creation_input_tokens: 0`, `cache_read_input_tokens: 0`, no error.
   No caching saving is claimed anywhere in this module or its docs.
5. **Not live-verified, taken on documentation**: that high-resolution vision
   (2576px) is Sonnet-only and Haiku is capped lower. Confirming this needs a large
   test image and doesn't change any code in this ticket (image preprocessing to
   the Haiku cap is TRO-460, a sibling ticket) — flagged, not silently assumed true
   without a source.

The live smoke test used the exact request shape `request.ts` builds (verified by
copying `buildExtractionRequestParams`'s fields into a standalone script), plus a
1x1 pixel synthetic PNG — not a real label photo, since `golden-set/images/` is
still empty pending LH-004/005/006. It was run once, by hand, from the scratchpad,
and is not part of the repo — a real-money API call has no place in a script another
agent or CI could run by accident.

**Known limits.** No end-to-end test against a real label photo — out of scope per
the ticket (no golden-set images exist yet). The TH-R11 sanity check
(`golden-case.test.ts`) confirms the extractor's parser round-trips a
correctly-shaped Haiku response built from `case-01-clean-match-spirits`'s ground
truth, across brand name, class/type, alcohol content, net contents, and government
warning — it does not call the API or render pixels.

**How to run it.** `pnpm test -- src/server/extractor` — 4 test files, 32 cases.
`pnpm typecheck` / `pnpm lint` both clean.

**Rollback.** `git revert` this commit; delete `src/server/extractor/*.ts` and
restore `src/server/extractor/.gitkeep`; `pnpm remove @anthropic-ai/sdk` (added by
this ticket, not yet used elsewhere).

## TRO-460 — LH-010 review round 1: 4 CodeRabbit findings, 1 major (2026-08-10)

**What changed.** The factory gate's review step (CodeRabbit) found 4 issues in the initial
implementation. All 4 fixed:

- **Major.** `clampRegionToBounds` (`region.ts`) clamped a region with `Math.max`/`Math.min`,
  which silently propagate `NaN` instead of clamping it — a caller passing a non-finite
  coordinate (a corrupt detector output, not just an out-of-bounds one) would reach sharp's
  `.extract()` as an invalid crop request with no clear error. Now rejects a non-finite
  `region` field with `RangeError`, and rounds a fractional coordinate (a detector may report
  a bounding box in floating point) to the nearest whole pixel before clamping.
- **Minor.** `preprocessImage`'s JPEG encode of `original` used sharp's default alpha
  matte, which is **black**, not white — verified with a live sharp run: a fully
  transparent pixel encoded through `.jpeg()` with no explicit flatten came out `(0, 0, 0)`.
  A label graphic with a transparent background would go dark. This finding carried no
  code suggestion, only the instruction; fixed with an explicit
  `.flatten({ background: "#ffffff" })` before every JPEG encode, including `cropRegion`'s,
  and a new regression test that round-trips a fully-transparent PNG through the real
  pipeline and asserts the decoded pixel channels land near-white (confirmed re-verified
  with the same live-sharp technique: `(255, 255, 255)` with the flatten in place).
- **Minor.** The no-upscale test only checked `haikuVariant`; extended it to check
  `sonnetVariant` too, per the finding's own suggested test code.
- **Minor.** The upload-size error-message test only checked the message's length and that
  it wasn't a bare "error"/"failed" string. The finding's suggested code checked for the
  raw byte counts (`String(MAX_UPLOAD_BYTES * 2)`), but its own instruction text allowed
  "raw byte values **or** their documented formatted representations" — this
  implementation's `humanBytes()` renders a human-readable size (TH-R20: the message is
  for a person, not a log line), so the fix checks for `"40.0 MB"` / `"20.0 MB"` instead of
  the raw byte counts, honoring the instruction's intent rather than its literal sample.

**How to run it.** `pnpm test -- src/server/preprocessing` — 45 tests (up from 42).

**Rollback.** `git revert` this commit. No behavior change outside the four points above.

## TRO-460 — LH-010: image preprocessing pipeline (2026-08-10)

**What changed.** A new module, `src/server/preprocessing/`, implements PRD §3.1's
preprocessing stage — the step between upload and the Haiku extractor (LH-011, not built
yet). It lives as its own module, a sibling of `src/server/{extractor,router,warning,resolver}/`,
because the PRD diagram draws preprocessing as its own boxed pipeline stage, and the
extractor's own `.gitkeep` scopes that directory to LH-011's Haiku call only.

`preprocessImage(upload: Buffer)` runs one uploaded label image through:

- **EXIF rotation.** `sharp`'s `.rotate()` bakes the EXIF orientation into the pixel data
  and strips the tag — a viewer with no EXIF support still displays the image upright.
  Confirmed live: a 100×60 fixture tagged orientation 6 decodes, after `.rotate()`, to a
  60×100 buffer with no orientation tag left.
- **Three buffers, one format.** `original` (full resolution, reserved for OCR — a later
  ticket), `haikuVariant` (≤1568px long edge), `sonnetVariant` (≤2576px long edge, reserved
  for the Sonnet resolver — LH-014, not called here). Every buffer is JPEG, regardless of
  the upload's source format, because the Claude vision API never accepts `image/heic` and
  a single fixed `mediaType` means every consumer avoids a format branch.
- **Format validation.** Accepts JPEG, PNG, WEBP, and HEIF/HEIC (`sharp` decodes HEIC, the
  default capture format on recent iPhones). Rejects anything else — including formats
  `sharp` can decode but a label photo would never be, like GIF or TIFF — with
  `UnsupportedFormatError`, not a generic failure.
- **Size ceilings.** `FileTooLargeError` above 20 MB (byte size). `ImageDimensionsTooLargeError`
  above 100 megapixels decoded (a decompression-bomb guard — bounds decode cost independent
  of the file's size on disk). `UnreadableImageError` for a corrupt or truncated file.
- **A warning-region crop hook.** `cropRegion(source, region)` extracts a caller-supplied
  pixel box from a full-resolution buffer at native DPI. This ticket does not detect the
  warning block — LH-020 (its own CP-2-gated subsystem) does — but the crop math exists now
  so LH-020 has something to call. `clampRegionToBounds` (pure, unit tested) guarantees the
  box sharp receives is always valid, even when a detector's box runs slightly outside the
  image.

**Two resolution caps confirmed live, not just read from the docs.** `docs/checkpoints/
cp1-cascade-router-prompts.md` §3.5 named this ticket to confirm the Haiku 1568px / Sonnet
2576px vision caps against a real call. A 3200×2400 synthetic JPEG sent to both models
(temperature 0 on Haiku; `effort: low` on Sonnet, which rejects `temperature`) measured
1582 input tokens on `claude-haiku-4-5` and 4761 on `claude-sonnet-5` — a 3.0× ratio, and
after subtracting prompt overhead, within a few tokens of Anthropic's own published
1568-token and ~4784-token figures at those two caps. Both caps stand as measured, current.

**How to run it.** `pnpm test -- src/server/preprocessing` runs the 42 preprocessing tests
in isolation (77 pass repo-wide). No database, no API key, and no network call are needed
for the shipped code — the live resolution-cap confirmation above was a one-time diagnostic,
not part of the test suite.

**Rollback.** `git revert` this commit. Nothing outside `src/server/preprocessing/`,
`package.json`, and `pnpm-lock.yaml` (the new `sharp` dependency) changed.

**Known limits.** LH-051 (imperfect-image handling, TH-R10's graceful-degradation judgment
call) is explicitly out of scope — this ticket rejects only structurally invalid input
(wrong format, corrupt file, oversized file). A blurry-but-valid JPEG passes through
unchanged; deciding whether a low-quality read should downgrade to a review outcome is
LH-051's job. The HEIC-acceptance claim rests on `sharp`'s reported `libheif` support
(`sharp.versions.heif`) — not measured against a real iPhone HEIC capture, since none was
available in this worktree.

## TRO-459 — PR review round 4: final 4 unresolved threads triaged, 2 doc fixes (2026-08-10)

**What changed.** Triage of the last 4 unresolved CodeRabbit threads before merge:
- `src/server/router/.gitkeep` credited all comparators to LH-013. Corrected: LH-013 owns
  the four CP-1 comparators; the government-warning comparator is its own CP-2 subsystem
  (LH-020, `src/server/warning/`). (Fixed.)
- §6.3's sample user message said the extractor reading is inserted "verbatim — needs no
  re-encoding." That contradicts §6.3's own `serializeUntrusted` requirement: extractor
  evidence strings carry verbatim label text, adversarial input like any other. The sample
  now routes the extractor block through the same escaping. (Fixed.)
- The two remaining threads (warning-shape rejection payload; JSON.stringify delimiter
  escape) were already fixed in rounds 2–3 — resolved with pointers, no code change.

**How to run it.** Nothing to run; re-read the two corrected spots.

**Rollback.** `git revert` this commit.

## TRO-459 — PR review round 3: 4 findings, including a real flaw in round 2's own fix (2026-08-10)

**What changed.** CodeRabbit reviewed round 2's fixes and found that one of them — the
JSON-serialization defense against delimiter injection — was itself incomplete. Verified with a
real `node -e` run before believing it: `JSON.stringify` escapes quotes, backslashes, and
control characters, but leaves `<`, `>`, and `/` untouched, so a value containing the literal
string `</UNTRUSTED_DATA>` still contains it after `JSON.stringify` — the exact attack round 2
claimed to have closed. Fixed for real this time: Unicode-escape `<`/`>`/`/` **after**
`JSON.stringify`, verified empirically that the escaped output no longer contains the attack
string.

3 more findings, all fixed:
- §4.4's rejection-payload fix (round 2) described the right payload shape for
  `government_warning` but never updated the downstream predicate that reads it —
  `MISSING_REQUIRED_FIELD` (§5.3) still said `value === null` uniformly, which is `false` for a
  field that structurally has no `value`. Now field-shape-aware: `value === null` for the five
  fields, `present === null || present === false` for the warning.
- The prompt-injection test requirement asked for the resolver's "disposition" on
  `government_warning` — but that field never gets a disposition at all (rule 5: re-transcribed,
  never judged). Rewritten to assert what the field actually produces: the transcription output
  is byte-identical whether or not a sibling field carries the injection payload.

**How to run it.** Nothing to run; re-read the corrected sections. The escaping claim is
verifiable directly: `node -e 'console.log(JSON.stringify({v:"</UNTRUSTED_DATA>"}).replace(/[<>\/]/g,c=>"\\u00"+c.charCodeAt(0).toString(16)))'`.

**Rollback.** `git revert` this commit.

## TRO-459 — PR review round 2: 3 more CodeRabbit findings, all fixed (2026-08-10)

**What changed.** A second CodeRabbit pass on the doc found 3 more real issues:
- §4.4's malformed-confidence rejection described one payload shape (`value: null`) for all
  fields, but `government_warning` has no `value` — its rejection now sets
  `present: null, transcription: null` explicitly, so a downstream `value === null` check
  (which `MISSING_REQUIRED_FIELD` literally uses) doesn't silently miss it.
- The resolver's untrusted-data delimiting (previous round) wrapped values in
  `<UNTRUSTED_DATA>` tags but inserted them as freeform text — a value containing the literal
  string `</UNTRUSTED_DATA>` could still close the tag early. Switched the application-form
  block to real JSON serialization (`JSON.stringify`, not string concatenation, called out as
  an implementation requirement) — JSON string-escaping neutralizes the attack structurally,
  which a text template cannot. Also clarified the image needs no text delimiter: it's a
  separate image content block, not text, so it cannot contain closing-tag characters.
- The prompt-injection test requirement said the resolver's decision "does not change based
  on" an injected value — too broad, since a legitimately different field value should change
  the verdict. Replaced with a precise oracle: the *targeted* field's disposition must be
  unaffected by a sibling field's injection payload, while the *injected* field's own
  disposition still reflects its real (garbled) content.

**How to run it.** Nothing to run; re-read the three corrected sections.

**Rollback.** `git revert` this commit.

## TRO-459 — LH-CP1: ⛔ CHECKPOINT 1 walkthrough material (2026-08-10)

**This entry does not clear a checkpoint.** It adds the material Troy reads *at* the
checkpoint. CP-1 stays blocking until Troy runs the walkthrough and gives explicit
acknowledgment. Until then, LH-010 … LH-015 (TRO-460 … TRO-465) do not start.

**What changed.** One new document: `docs/checkpoints/cp1-cascade-router-prompts.md`. No
product code. It covers the four things PRD §10 requires CP-1 to cover, plus the "defend it"
Q&A (TH-R1, TH-R8, TH-R10, TH-R19, TH-R21, TH-R22):

- **The Haiku extraction prompt** — full system and user drafts, plus the strict JSON schema.
  Every field carries `value`, `evidence`, and `confidence`. One load-bearing decision: the
  extractor sees the image only, never the application record. That removes anchoring, makes
  the extraction independent evidence rather than a confirmation, and turns the extractor's
  inferred beverage type into a free cross-check against the declared one.
- **Confidence thresholds** — three bands (trusted ≥ 0.85, uncertain 0.60–0.85, unusable
  < 0.60), a higher bar of 0.90 for the warning transcription, and an asymmetry rule: escalate
  a MISMATCH below 0.90 but a MATCH only below 0.60, because agreement with the application
  corroborates a weak read and a mismatch does not. Plus three deterministic overrides that
  ignore confidence entirely — the strongest is that `normalize(value)` must be a substring of
  `normalize(evidence)`, which catches a confident invention without consulting confidence.
  Every number is marked **proposed**, with the golden-set sweep (LH-003 → LH-030) that
  replaces it: reliability diagram, then threshold sweep, then pick the knee of verdict
  accuracy against auto-verified rate.
- **The `ReviewReason` routing rules** — a precise deterministic trigger for each of the eight
  enum members, a precedence order, and the naming principle that keeps two of them apart:
  `CONFLICTING_EXTRACTION` means we do not trust our own reading; `AMBIGUOUS_*` means we read
  it fine and it still is not decidable. `LOW_MODEL_CONFIDENCE` is deliberately last — its rate
  is a monitoring signal that the taxonomy has a gap.
- **The Sonnet resolver prompt** — full drafts, its output schema, and the rule that keeps the
  design defensible: the resolver *judges* only brand and class equivalence (where TH-R8
  literally asks for judgment); everywhere else it returns a corrected reading and
  deterministic code re-decides. It never judges the government warning — it re-transcribes,
  and code compares against the statute.
- **"Defend it" Q&A** — 15 questions with drafted answers, including the five the ticket
  named, plus prompt injection, extractor blindness, resolver anchoring, escalation-rate
  blowout, and "how do I know this is not just escalating everything to look safe".
- **Open questions for Troy** — seven real forks, each with a recommendation and the cost of
  choosing wrong.

**Two findings worth reading before the walkthrough.**

1. **The resolver cost estimate in PRD §4 looks low.** Derived arithmetic from published
   prices puts an escalation at about $0.05, not ~$0.02. Two named causes: adaptive thinking is
   on by default on `claude-sonnet-5` and bills as output tokens, and full-resolution vision
   costs roughly three times the tokens of a smaller image. Both are deliberate accuracy
   choices; neither was in the original estimate. A 300-label batch is therefore about $4
   (cascade) against about $15 (Sonnet on every label) — still ~3.7× cheaper, but only about
   six full batches against the $25 cap. Open question 4.
2. **Prompt caching on the extractor will silently do nothing.** The documented minimum
   cacheable prefix on `claude-haiku-4-5` is 4096 tokens; our extractor prompt is well under
   that. It fails with no error — just `cache_creation_input_tokens: 0`. Do not add
   `cache_control` there and do not claim a caching saving.

Related API constraints captured for LH-011/LH-014: `claude-haiku-4-5` rejects
`output_config.effort`; `claude-sonnet-5` returns a 400 for `temperature`; use
`output_config.format`, never the deprecated `output_format`; structured outputs cannot bound
`confidence` to 0–1, so the router rejects (never clamps) an out-of-range value as a broken
extraction — clamping would move malformed output onto the trusted path.

**Also updated** — pointers only, no logic: `src/server/{extractor,resolver,router}/.gitkeep`
now name this design document as the source for the ticket that fills each directory.

**How to run it.** Nothing to run. Read
`docs/checkpoints/cp1-cascade-router-prompts.md` top to bottom — about 40 minutes. The
appendix is a four-item checklist for the live session.

**Rollback.** Delete `docs/checkpoints/cp1-cascade-router-prompts.md`, revert the three
`.gitkeep` pointer updates, and revert this entry. Nothing depends on any of it; no code,
schema, or configuration changed.

**Known limits.** Nothing here is measured. Costs are derived arithmetic with the token
assumptions written down; latency is "not measured"; thresholds are proposed. Regulatory
values — ABV optionality per beverage type, ABV tolerance, standards of fill — are marked
VERIFY and default to the strictest interpretation, for LH-013 to verify against ttb.gov and
cite. The document deliberately does not decide anything owned by CP-2 (warning subsystem) or
CP-3 (batch queue).

## TRO-458 — Align spec schema with the approved image-gen design (2026-08-10)

**What changed.** Troy approved a render-first hybrid design for golden-set images
(`docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md`) and rescoped this
ticket to core-only (degradations → LH-004, Imagen → LH-005, verify gate → LH-006). Per the
ticket's note, aligned the spec schema with design §3 before merging:
- Added `provenance` (`rendered | rendered+degraded | ai-generated`), `verified` (boolean),
  and `vectors` (`audit/rubric.md` Appendix A, V1–V10) to `GoldenSetCase` and to every one of
  the 29 committed cases.
- Loader now enforces `provenance: "ai-generated"` requires `verified: true` — an AI-generated
  image can silently fail to render the exact text its spec claims; the eval harness must not
  trust one until a human confirms it.
- Mapped every case to the rubric vector(s) it evidences and found a real, previously-invisible
  gap: **V7** (net-contents format match, `"750 mL"` vs `"750ml"`) has no covering case. Added
  a test that asserts this gap explicitly (`loader.test.ts`) so it can't silently reappear once
  closed, and documented it in `golden-set/README.md` rather than quietly patching around it.
- 8 new regression tests (unknown provenance, unknown vector, unverified ai-generated case
  rejected, verified one accepted, vector-coverage assertion, ai-generated-implies-verified
  assertion on the real manifest).

**Still not done — the renderer itself.** This ticket's scope was the schema; producing actual
pixels is LH-003's remaining work (or a split-off), tracked against the design doc's §2
component list (`render.ts`/`degrade.ts`/`imagen.ts`/`verify.ts`/`build.ts`). `golden-set/images/`
is still empty.

**How to run it.** `pnpm test -- src/lib/golden-set` — 26 tests, up from 12.

**Rollback.** `git revert` this commit; the manifest and loader return to the pre-alignment
shape (still valid, just missing `provenance`/`verified`/`vectors`).

## TRO-458 — LH-003: Golden set v1 — ground-truth schema, manifest, loader (2026-08-10)

**What changed.** Ground-truth data and tooling for the golden set (TH-R12), scoped to the
parts that do not need an image-generation tool:

- **Ground-truth schema** (`src/lib/golden-set/types.ts`): a `GoldenSetCase` type covering
  the five example fields on both the application and the label (PRD §2, TH-R11), the
  Validation Router's expected per-field and label-level verdicts, and the `ReviewReason`
  enum (PRD §3.3).
- **Manifest** (`golden-set/manifest.json`): 29 complete ground-truth cases across all 12
  required test categories (PRD §6) — clean match (4), ABV mismatch (3), title-case warning
  (2), reworded warning (2), missing warning (2), case-variant brand (3), glare (2), rotation
  (2), low light (2), tiny warning text (2), odd typography (2), conflicting
  application-vs-label data (3). Includes the two named brief examples: `STONE'S THROW` vs
  `Stone's Throw` (TH-R8, `case-14-case-variant-brand-stones-throw`) and Jenny Park's
  title-case catch (TH-R9, `case-08-title-case-warning-prefix-only`).
- **Loader + validator** (`src/lib/golden-set/loader.ts`, TDD'd in
  `loader.test.ts`): `loadGoldenSetManifest()` reads and validates
  `golden-set/manifest.json`; `validateManifest()` checks the shape and collects every
  problem in one pass — missing fields, wrong types, an unknown category, a `reviewReason`
  that doesn't match the label verdict, an `imagePath` whose filename doesn't match its
  `caseId`, and duplicate case IDs. 12 test cases; confirmed red (missing module) before
  `loader.ts` existed, green after.
- **`golden-set/README.md`**: the manifest format, the image naming convention
  (`golden-set/images/<caseId>.jpg`), and the known gap below.

**Known gap, stated plainly: no label images.** `golden-set/images/` is empty. Every
`imagePath` in the manifest names a file that does not exist. Generating 29 label images
needs an AI image-generation tool or a camera; this ticket's agent had neither, and a
placeholder file with a `.jpg` extension would silently pass a file-existence check while
being useless for testing — worse than an honest gap. A follow-up ticket (LH-021 depends on
this landing) must generate or source each image at the path its case already names; the
case's `label` field is the spec for what the image must show.

**How to run it.** `pnpm test -- src/lib/golden-set` runs the loader tests directly. Load the
manifest from application code with `loadGoldenSetManifest()` (no arguments needed — it
resolves `golden-set/manifest.json` relative to the repo root).

**Rollback.** `git revert` this ticket's commits. Nothing outside `golden-set/` and
`src/lib/golden-set/` depends on this yet.

## TRO-457 — PR review round 4: seed idempotency guard fixed (2026-08-10)

**What changed.** `src/lib/db/seed.ts`'s "already seeded" guard checked only the
`applications` table. A database left with `batch_jobs` or `label_images` rows but no
`applications` rows (a partial prior run in an unusual failure order) would pass the guard and
insert on top of it. Guard now checks all three tables the script inserts into.

**How to run it.** `pnpm db:seed` on an empty database inserts as before; verified manually
(this script has no Vitest coverage by design — see the CodeRabbit-triage section below) by
running it twice in a row: first run succeeds, second is rejected with the updated message.

**Rollback.** `git revert` this commit; the guard reverts to checking `applications` alone.

## TRO-457 — PR review round 3: CodeRabbit findings, 1 fixed, 1 deferred (2026-08-10)

**What changed.** A further local-CLI CodeRabbit pass found 2 findings:
- `label_images` (major, real): the (batch, filename) index used for CSV-to-image pairing
  (PRD §3.5) was a plain index, not unique. Two images uploaded into the same batch with
  the same filename would make that pairing lookup return two candidates instead of one —
  exactly the ambiguous case PRD §3.5 says must be reported before the job starts, not
  silently accepted. Fixed: `label_images_batch_filename_idx` is now
  `label_images_batch_filename_unique`, a `UNIQUE` index on `(batch_job_id,
  original_filename)`. Postgres treats each `NULL` as distinct, so single-label images
  (`batchJobId` null) are never deduplicated against each other — only images inside the
  same real batch are constrained. Regenerated the migration (folded into
  `0001_product_schema.sql`, same reasoning as the earlier rounds — this table has never
  been applied outside this worktree). Verified directly: reset the database, reapplied,
  reseeded, then confirmed with a negative insert (`ERROR: duplicate key value violates
  unique constraint "label_images_batch_filename_unique"`) and a positive one (two
  single-label images sharing a filename, both `NULL` batch, insert succeeds).
- **Deferred, not fixed:** enforcing that a `verifications` row's application, image, and
  batch job all belong together at the database level. This is the same finding raised in
  the prior two review rounds, and the answer is unchanged: it needs a trigger or composite
  foreign keys spanning three tables, and that design belongs with the code that creates
  verification rows (LH-041's batch worker, behind the CP-3 checkpoint), not invented ahead
  of it in a schema ticket. Documented at both places in `schema.ts` that CodeRabbit has now
  flagged it (`labelImages` and `verifications`), so a future reader finds the decision
  instead of re-discovering the gap. Named again in the final ticket report as a known,
  deliberate gap for LH-041 to close.

**How to run it.** `pnpm db:migrate` picks up the corrected `0001_product_schema.sql`;
`pnpm db:seed` is unchanged.

**Rollback.** `git revert` this commit.

## TRO-457 — PR review round 2: CodeRabbit findings, 1 fixed, 1 stale (2026-08-10)

**What changed.** GitHub-App CodeRabbit reviewed PR #2 (a separate pass from the local CLI
triage already recorded below). Of 5 findings, 3 were already fixed by earlier commits in this
PR and auto-marked resolved. Of the remaining 2:
- `src/lib/db/seed.ts` (minor, real): the batch fixture's counters claimed `totalCount: 2` with
  one auto-verified item, but only one application row is actually batch-linked. Fixed by
  setting the counters to match the single real fixture (`totalCount: 1, autoVerifiedCount: 0,
  needsHumanCount: 1`) rather than inventing a second row. Verified by truncating and re-running
  `pnpm db:seed`, then querying `batch_jobs` and counting batch-linked `applications` directly.
- `src/lib/db/seed.ts` (flagged critical — "transaction callback not closed, file won't parse"):
  verified against the current file and it is **stale**. The finding describes an intermediate
  commit; the fix (wrapping every insert in one `db.transaction()`) already landed and is
  described in the CodeRabbit-triage section below. `pnpm typecheck`, `pnpm build`, and this
  gate's own `typecheck` check all confirm the file parses and type-checks cleanly. Dismissed
  with this reason, not fixed (there was nothing to fix).

**How to run it.** `pnpm db:seed` — same command, corrected counters.

**Rollback.** `git revert` this commit.

## TRO-457 — LH-002: Database schema + migrations (2026-08-10)

**What changed.** Added the real Drizzle + Postgres schema for LabelHunter (PRD §3.6,
TH-R6, TH-R22) in `src/lib/db/`, extending the scaffold's `_meta`-only `schema.ts`:

- **`enums.ts`** — the eight closed-set vocabularies as `pgEnum` types, each backed by one
  `as const` array so the TypeScript union, the Postgres enum, and a runtime guard all stay
  in sync: `beverage_type` (beer/wine/spirits), `label_verdict` (PASS/FAIL/REVIEW),
  `field_verdict` (MATCH/MISMATCH/NEEDS_REVIEW), `field_name` (the 5 example fields from
  PRD §2), `review_reason` (the 8-value `ReviewReason` enum from PRD §3.3, verbatim),
  `resolution_path` (which model(s) resolved a verification), `batch_job_status`, and
  `review_disposition`. `toReviewReason` and `toBeverageType` narrow an untyped string to
  the matching type or throw, naming every legal value in the error — the checkpoint
  between loosely-typed input (model output, a CSV cell) and an insert. TDD: red-first
  tests in `enums.test.ts` (9 cases) cover valid values, invalid values, and a near-miss
  (wrong case) for each guard.
- **`schema.ts`** — six product tables: `batch_jobs` (status + per-item counters the
  batch-progress UI polls), `applications` (brand/class/ABV+proof/net contents/beverage
  type — the claimed values a label gets checked against), `label_images` (storage
  reference, original filename, post-preprocessing dimensions; linked to an application
  for single-label verify or to a batch job before per-row pairing, per PRD §3.5), `verifications` (one row per completed label-level result: verdict, which model(s)
  resolved it, links to application/image/batch job), `field_results` (one row per field
  per verification: extracted value, verbatim evidence — required, not optional, per
  PRD §3.2 — confidence 0–1, verdict, one-line reason), and `review_queue` (one row per
  needs-human item: reason, nullable resolver output, nullable human disposition). Every
  closed-set column uses a Postgres enum, not free text. Reasonable indexes throughout,
  including a partial index on `review_queue` for the unresolved-items view the review
  queue UI needs, and a foreign key on every reference — all `ON DELETE CASCADE` (a
  prototype has no retention requirement, and a child row is meaningless without its
  parent). Full `relations()` graph for the query API.
- **No PII, checked column by column (TH-R6).** No table anywhere stores a real person's
  name, email, address, or other identifier. `review_queue` in particular records a
  human's approve/reject disposition and when, but not who — adding a reviewer-identity
  column was considered and rejected; nothing in the PRD or the rubric asks for it, and
  it would be the one clear PII risk in this schema.
- **Migration** `drizzle/migrations/0001_product_schema.sql`, generated with
  `pnpm db:generate` (not hand-written), applied with `pnpm db:migrate`, and verified with
  direct `psql` queries against this worktree's own database: `\dt` lists all 7 tables,
  `\d <table>` for each of the 6 new ones shows the expected columns, indexes, and
  constraints, and manual negative inserts confirm each constraint fires (the
  `label_images` ownership `CHECK`, the `field_results` confidence-range `CHECK`, the
  `field_results` and `review_queue` unique indexes) — not just declared, but load-bearing.
- **`db:seed`** (`pnpm db:seed`, added to `package.json`, run via the new `tsx` dev
  dependency) inserts a small, obviously-fake dev dataset spanning all six tables: one
  batch job, three applications (a clean single-label PASS, a batch-paired wine with a
  low-confidence ABV read that lands in the review queue, and a single-label FAIL on a
  title-cased government warning — Jenny's real catch, PRD §3.4), three label images,
  three verifications, fifteen field results, and one review-queue entry. Refuses to run
  twice against the same database instead of silently duplicating fixtures.

**A real drizzle-kit bug found and fixed, in scope for this ticket.** The first generated
migration created all 7 tables but zero `CREATE TYPE` statements, even though every enum
column referenced a type name that did not yet exist — an unusable migration that would
fail on apply. Cause: `drizzle-kit generate` only discovers `pgEnum`/`pgTable` objects
that are visible on the configured schema file's own exports; the enums lived in
`enums.ts` and were only imported (not re-exported) by `schema.ts`, so drizzle-kit's
export scan never saw them, even though the tables used them. Fixed with
`export * from "./enums"` in `schema.ts`. Caught by reading the generated SQL before
trusting it (this repo's "claims carry provenance" rule) — a `pnpm db:migrate` exit code
of 0 would have hidden this, since the broken migration was never applied.

**CodeRabbit review triage (6 findings; 5 fixed, 1 explicitly skipped):**
- `enums.test.ts` claimed a wrong-case test for both guards but only had one. Fixed —
  added the missing `toBeverageType("Beer")` case; the claim is now true.
- `review_queue`: added a `CHECK` requiring `disposition` and `disposed_at` to be null or
  non-null together — one fact, two columns, must move as a pair.
- `batch_jobs`: added `CHECK` constraints — every counter non-negative, and each of
  `processedCount`/`autoVerifiedCount`/`resolvedBySonnetCount`/`needsHumanCount`/
  `failedCount` no greater than `totalCount`. Bounded independently, not summed to equal
  `totalCount`: the batch worker (LH-041) updates one counter at a time, and a sum
  constraint would reject a legal state between two separate `UPDATE`s.
- `batch_jobs`/`verifications`/`review_queue`: `updatedAt` now carries `.$onUpdate(() =>
  new Date())`. This is a drizzle-orm runtime default, not a database trigger — it fires
  on every `db.update()` call that does not set the column itself, verified against the
  real database (an `UPDATE` through Drizzle bumped `updated_at` and left `created_at`
  unchanged). It does not protect a write that bypasses the ORM; documented as a known
  limit in the column comment rather than built out further, since every write path in
  this app goes through Drizzle.
- `seed.ts`: wrapped every insert in one `db.transaction()`. A failure partway through now
  rolls back the whole batch instead of leaving a half-seeded database that would silently
  defeat the "already seeded" guard on the next run.
- **Skipped:** enforcing that a verification's application, image, and batch job all
  belong to the same batch. A real DB-level guarantee needs a trigger or composite foreign
  keys spanning three tables — real design work that belongs with the code that creates
  verification rows (LH-041's batch worker, behind the CP-3 batch-queue checkpoint), not
  invented ahead of that design in a schema ticket. Flagged in the final ticket report as a
  known gap, not silently dropped.

**How to run it.** `source .factory-env` (or point `DATABASE_URL` at your own Postgres),
then `pnpm db:migrate` to apply `0001_product_schema.sql`, then `pnpm db:seed` for dev
fixtures. `pnpm db:generate` regenerates a migration after a future `schema.ts` edit.

**Rollback.** Drop the six product tables and their enum types (or restore the pre-0001
database from a snapshot) and delete `drizzle/migrations/0001_product_schema.sql` plus its
entry in `drizzle/migrations/meta/_journal.json`. `_meta` and the scaffold are untouched.

**Design calls the PRD left open (flagging for visibility, not asking permission):**
- No per-application government-warning column — the warning subsystem (PRD §3.4) always
  compares extracted text against one fixed statutory string, so there is no per-application
  value to store.
- `label_images` carries both a nullable `application_id` and a nullable `batch_job_id`
  (at least one required, via `CHECK`) rather than a single polymorphic reference — set
  directly for single-label upload, left to `batch_job_id` alone for a batch upload before
  its CSV-row pairing exists.
- `field_name` and beverage-type-driven optionality rules (e.g. ABV optionality per PRD §2)
  are two different things: this ticket enumerates the closed set of field names in the
  schema, but does not implement any optionality *rule* — that logic, and its tests, belong
  to LH-013 (field comparators), which this ticket does not touch.
- Integer identity columns (`generatedAlwaysAsIdentity()`), not `serial` — Postgres's own
  recommended replacement since v10, and pre-empts the identical suggestion CodeRabbit made
  on the TRO-456 scaffold PR for `_meta.id`.

**Known limits / not verified from this ticket.** `db:seed`'s only tested behavior is the
scripted insert path itself (run against a real database, output checked); it has no
Vitest coverage of its own, since it is a sequence of fixture inserts, not a pure function.
The `relations()` graph was verified to type-check and to match the FK structure by
inspection, not by exercising `db.query.*` relational reads end-to-end — no code in this
repo uses that API yet.

## FACTORY — merge-changes.mjs (2026-08-10)

**What changed.** Three tickets in a row (TRO-456 twice, TRO-457) hit the same `CHANGES.md`
merge conflict — every branch adds an entry at the top, so every concurrent merge collides on
the same lines. Per the recurrence-ladder rule in `references/lessons.md` ("3 = build the
mechanical fix"), added `scripts/factory/merge-changes.mjs --check`: parses the file into
whole entries (never line-by-line), checks per-entry fence balance, duplicate headings, and
(with `--expect TICKET`) that a specific ticket's entry survived intact. Wired into `gate.sh`
G7 alongside the existing ticket-ID grep. Negative-tested: a synthetic file with a spliced
fence and one with a duplicated heading both correctly fail; a well-formed file passes.

**How to run it.** `node scripts/factory/merge-changes.mjs --check CHANGES.md` (add
`--expect TRO-nnn` to also confirm one ticket's entry). Runs automatically as part of the gate.

**Rollback.** `git revert` this commit; G7 falls back to the grep-only check.

## TRO-456 — PR review round 2: CodeRabbit findings, 4 fixed (2026-08-10)

**What changed.** GitHub-App CodeRabbit reviewed PR #1 and requested changes. All four inline
findings were real defects in code this PR added; all four are fixed here.
- `playwright.config.ts` (major): read `PORT`/`APP_PORT` straight from `process.env` with no
  `.env.local` loader. A factory worktree works by accident (`.factory-env` exports the
  variable into the shell); a plain checkout following this PR's own "How to run it"
  instructions would silently fall back to port 3000. Added the same `dotenv` load
  `drizzle.config.ts` already uses.
- `src/lib/db/index.ts` (major): the `pg.Pool` had no `error` listener. An idle client that
  loses its connection emits `error` on the pool; with nothing listening, Node treats it as
  unhandled and can crash the process. Added a listener that logs and lets the pool recover.
- `src/lib/db/index.ts` (trivial): `connectionTimeoutMillis` defaulted to 0 (no timeout) on an
  unreachable database. Set to 10s.
- `src/lib/utils/format.ts` (minor): the third rounding-boundary bug in this function — `999.5`
  rounded to `"1000ms"` while `formatDuration(1000)` itself renders `"1.00s"`, because the
  millisecond branch decided its unit on the unrounded value. Rounds once now, before any
  branch. A standing lesson on this pattern is in `references/lessons.md`.

**How to run it.** `pnpm test` — one new case (`formatDuration(999.5)`). No other setup change.

**Rollback.** `git revert` this commit; each fix is independent of the others and of the
original scaffold commits.

## TRO-456 — LH-001: Scaffold Next.js + TS + Vitest + Playwright + Drizzle + CI (2026-08-10)

**What changed.** Stood up the working application scaffold (TH-R13, TH-R18, TH-R19) that
every later LabelHunter ticket builds on:
- **App shell:** Next.js 16 (App Router, TypeScript, strict mode) under `src/app/`, with a
  placeholder home page and a DB-free liveness route at `src/app/api/health`.
- **Toolchain:** pnpm (`packageManager` pinned), Node >=22. `pnpm typecheck` (`tsc --noEmit`),
  `pnpm lint` (real flat-config ESLint — `eslint.config.mjs`, Next's recommended rules +
  `@typescript-eslint`, plus two project rules: no `any`, no unused vars — verified it
  actually catches violations, not a vacuous config), `pnpm build` (`next build`).
- **Tests:** Vitest (`vitest.config.ts`) with one real unit test suite
  (`src/lib/utils/format.test.ts`, 4 cases) proving the runner executes real code. Playwright
  (`playwright.config.ts`) with one e2e spec (`e2e/health.spec.ts`) that builds, boots the app,
  and asserts a 200 from `/api/health`.
- **Database:** Drizzle + `pg`, `drizzle.config.ts`, a scaffold-only `_meta` table
  (`src/lib/db/schema.ts`) and its generated migration (`drizzle/migrations/0000_meta_healthcheck.sql`).
  `pnpm db:generate` / `pnpm db:migrate` (`drizzle-kit generate` / `drizzle-kit migrate`).
  Migration applied to and verified against this worktree's own Postgres database (queried
  directly, not just exit-code-trusted). Ticket LH-002 (TRO-457) extends `schema.ts` with the
  real product tables.
- **Repo layout for later tickets:** `src/server/{router,extractor,resolver,warning}/` and
  `src/worker/` reserved (each has a `.gitkeep` naming the ticket that owns it) per PRD §3.6 —
  no subsystem logic implemented here.
- **`.env.local.example`** documents the required env vars for a plain clone (`DATABASE_URL`,
  `PORT`, and the not-yet-wired `ANTHROPIC_API_KEY`).

**A real toolchain bug found and fixed, in scope for this ticket:** `pnpm run <script> --
<args>` forwards the literal `--` token into the script's argv (unlike `npm`, which strips
it). Vitest's CLI then treats that leading `--` as "everything after this is a positional
test-name filter," so `--reporter=json --outputFile=<path>` — exactly how `scripts/factory/gate.sh`
and `.github/workflows/ci.yml` invoke `pnpm test` — is silently ignored: tests still run, but
no JSON report is ever written. Fixed by routing the `test` script through
`scripts/run-tests.cjs`, a small wrapper that strips one leading `--` before handing argv to
vitest. Confirmed the exact gate invocation (`pnpm test -- --reporter=json
--outputFile=<absolute path>`) now writes a valid report. The same pnpm quirk broke
`pnpm start -- -p <port>` in `playwright.config.ts`'s `webServer.command`; fixed by passing the
port via the `env` option instead (`next start`/`next dev` both honor `PORT`).

**How to run it.** `pnpm install`, then `cp .env.local.example .env.local` and point
`DATABASE_URL` at a running Postgres (or, in a factory worktree, `source .factory-env` — it's
already provisioned). `pnpm db:migrate` to apply migrations, then `pnpm dev` (or `pnpm build &&
pnpm start`) to run the app. `pnpm test` for unit tests, `pnpm test:e2e` for Playwright,
`pnpm typecheck` / `pnpm lint` / `pnpm build` for the rest of the gate.

**Rollback.** `git revert` this ticket's commits on `feat/lh-scaffold` (or delete the branch
before merge). No product code depends on this yet — reverting only removes the scaffold
itself. The worktree's database (`labelhunter_wt_tro_456`) can be dropped and recreated; the
`_meta` table is scaffold-only and holds no data of consequence.

**Known limits / not done here (see final ticket report for detail).** The broader gate
self-verification suite named in `factory/config.yaml`'s `verification:` block (no-op branch
fails, forged break-one/fix-one caught, quarantine-not-widenable-from-branch, `worktree.sh`
run twice in a row, a real CI run on an opened PR) was **not** run from this ticket — it needs
the orchestrator (this agent was told not to edit `factory/config.yaml`, `scripts/factory/gate.sh`,
or `.github/workflows/ci.yml`). This ticket ran `scripts/factory/gate.sh` (no flags) itself and
reports that verdict verbatim.

**Gate bug found, not fixed here (out of scope — see final ticket report).**
`scripts/factory/gate.sh`'s lint-detection line (`if ls eslint.config.* .eslintrc* ...`)
always reports `lint: skip` for a project using only one of the two config styles — `ls`
exits non-zero if *either* glob has no match, even when the other matched a real file. This
repo ships a real, working flat config (`eslint.config.mjs`, verified below) but the gate
still shows `skip`. Not edited per this ticket's instructions (gate.sh is the orchestrator's
file); flagging for a fix there.

**CodeRabbit review triage (3 findings, all addressed or explicitly skipped):**
- `src/lib/utils/format.ts` (minor): `formatDuration` could render `119.6s` as `"1m 60s"`
  instead of `"2m 0s"` (rounding minutes/seconds separately let the remainder hit 60). Fixed —
  round the total once, then derive minutes/remainder from that. Added a regression case.
- `src/app/api/health/route.ts` (trivial): add `Cache-Control: no-store` so a proxy/CDN never
  caches a stale liveness result. Fixed; e2e spec now asserts the header.
- `drizzle/migrations/0000_meta_healthcheck.sql` (trivial): suggested `bigint identity` instead
  of `serial` for `_meta.id`. Skipped — `_meta` is a scaffold-only healthcheck table that LH-002
  replaces with the real schema; not worth a churn migration for a table this ticket doesn't
  expect to survive past the next one.

## FACTORY — gate.sh lint-detection fix (2026-08-10)

**What changed.** `scripts/factory/gate.sh`'s lint-config check used
`ls eslint.config.* .eslintrc*`, which fails if *either* glob has no match — so a repo with
only `eslint.config.mjs` (no `.eslintrc*`) always read as "no config found" and G2 stayed
`skip` forever, even with a real, working lint config in place. Found by the TRO-456 scaffold
agent while gating its own branch. Fixed with `compgen -G`, which tests each pattern on its
own.

**How to run it.** No action needed; the next `scripts/factory/gate.sh` run picks it up.

**Rollback.** `git revert` this commit; the check reverts to always-skip, which is safe
(under-detection, not over-detection) but wrong.

## FACTORY — CLAUDE.md and writing-style rules (2026-08-10)

**What changed.** Added `CLAUDE.md` at the repo root. It orients any agent to the PRD, the
requirements inventory, and the factory. It sets one writing rule for all prose Claude writes
here: follow ASD-STE100 (one meaning per word, active voice, short sentences) and Zinsser's
four principles (simplicity, brevity, clarity, humanity). Updated
`.claude/skills/labelhunter-factory/references/agent-contract.md` to list `CLAUDE.md` as the
first required read, matching the reference factory's own pattern.

**How to run it.** Nothing to run. Every future agent session reads `CLAUDE.md` first.

**Rollback.** Delete `CLAUDE.md`; revert the one-line addition to `agent-contract.md`.

## FACTORY — labelhunter factory build (2026-08-10)

**What changed.** Stood up the ticket factory: `factory/` (config, quarantine baseline,
scorecard, review ledger), `scripts/factory/` (gate, worktree provisioner, testdiff,
review-ledger, status), the `labelhunter-factory` orchestrator skill with its references
(agent contract, escalation incl. CP-1/2/3, triage, lessons), CI workflow, and the ticket
decomposition in `factory/tickets.md` mirrored to Linear project **LabelHunter**.

**How to run it.** `node scripts/factory/status.mjs` for state;
`scripts/factory/worktree.sh TRO-<n> <branch>` to provision;
`scripts/factory/gate.sh` inside a worktree to gate. The orchestrator loop is
`.claude/skills/labelhunter-factory/SKILL.md`.

**Rollback.** Delete `factory/`, `scripts/factory/`, `.claude/skills/labelhunter-factory/`,
and `.github/workflows/ci.yml`; archive the Linear project. No application code is touched —
none exists yet.

**Known limits.** The gate is UNVERIFIED pre-scaffold (`factory/config.yaml` → `verification`);
nothing merges on gate evidence until the scaffold ticket runs the verification checks.
