# Factory defect gates: turning recurring review findings into executable invariants, and repairing them without stalling the pipeline

**Date:** 2026-08-12
**Status:** defect detection is shipped (Plan 1: engine, one rule, replay harness, G11).
Repair orchestration (Plan 3) is not yet built. Revision 3 — factory-first reframing.
**Supersedes:** `2026-08-12-defect-class-extraction-design.md` (revisions 1–2), which wrongly
framed this as a LabelHunter subsystem.
**Tracks:** TRO-508

---

## 0. What this is, and what it is not

**This modifies the factory.** LabelHunter is the target repository the factory happens to be
building. Nothing here is a LabelHunter application feature.

The subsystem is called **defect-gate**. Revisions 1–2 called it "LabelHunter." That name was
wrong twice over. It collided with the product name. It also implied the capability belonged
to the product. The capability belongs to the factory instead. It must port to `ship`, and to
any future target, by copying factory code and supplying new configuration.

### The core question

> How does the factory turn recurring CodeRabbit findings into generic, executable defect
> checks, and then automatically repair those known defects in parallel, without globally
> blocking the factory?

### The pipeline this belongs to

```
orchestrator → coding agents → evidence gates → defect detection
             → repair agents → verification → CodeRabbit → merge
```

Defect detection and repair are new stages. Everything else already exists and is reused, not
rebuilt.

---

## 1. The principle

> A third recurrence must not produce another prompt rule. It must force the question:
> can this observation become an executable invariant?

The factory already has the loop: ledger, recurrence threshold, evidence gate, scorecard,
CodeRabbit. One link is missing:

```
review ledger  →  validated invariant  →  executable gate check  →  automatic repair
```

Rung 2 of the ladder works — the target's `lessons.md` grew from 9 rules to 27. Rung 3 has
never been climbed. Three rules there now end with the same admission: *"still not
gate-checked."* A rule the brief has failed to hold three times does not need a louder
restatement. It needs a check, and — this is revision 3's addition — a repair path.

**Defect-gate does not replace CodeRabbit.** It removes *known, recurring* defect classes from
CodeRabbit's job, so external review spends its budget on novel semantic and design judgment.

---

## 2. Three layers

The single most important structural rule in this document.

### Layer 1 — generic factory engine

Owns: detector execution, rule lifecycle, replay and calibration, repair orchestration,
parallelism, conflict detection and reconciliation, retry budgets, observability, scorecard
integration.

```
factory/defect-gates/
  engine.mjs            rule loading, execution, base-ref diffing
  identity.mjs          violation identity (§9.3)
  activation.mjs        the activation pin (§9.4)
  replay.mjs            calibration harness (§12)
  rules/                RULE ALGORITHMS — generic, registry-driven
    weak-numeric-predicate.mjs
    unbounded-resource.mjs
    untrusted-interpolation.mjs
    vacuous-test-assertion.mjs
    vacuous-empty-quantifier.mjs
factory/repair/
  plan.mjs              findings → disjoint repair units (§10.5)
  dispatch.mjs          parallel repair agents via existing worktree machinery
  reconcile.mjs         merge-back and conflict detection (§10.6)
factory/replay/
  <ruleId>.v<n>.json    calibration evidence, committed
```

**No file in layer 1 may reference a target's domain, directory layout, product semantics, or
ticket-ID scheme.** A rule algorithm that hard-codes `Extraction.brand_name` is a layer
violation. The algorithm reads registries; the registries name the domain.

### Layer 2 — target-repository rule configuration

Evidence extracted from the target. Ships with the target, not with the factory.

```
factory/rules/
  domains.json            field-name pattern → declared domain → canonical predicate
  taint.json              untrusted types/fields, sanitiser name, prompt sink globs
  resources.json          acquisition expression → required bound + handler
  assertion-helpers.json  project helpers that assert internally
  boundaries.json         glob list: where "outside the type system" begins
```

A second target supplies its own five files and inherits every algorithm unchanged.

### Layer 3 — the target repository

The application being built. **Untouched by this design**, except for the code changes the
factory generates through normal ticket and repair work.

### The layer test

> Could this file move to `ship` unchanged?
> Yes → layer 1. No → layer 2. Neither → it is target code and does not belong here.

---

## 3. How the factory derives invariants from a target

The method is layer 1. The results below are layer 2 evidence, produced by applying the method
to this target's ledger.

### 3.1 Review labels are not implementation units

`review-ledger.mjs report` names eleven categories past the 3-ticket threshold. One check per
category would be wrong. Categories are **review vocabulary**, not defect mechanisms.

Measured on the target's 385 retained findings — the same mechanism, counted under many labels:

| Mechanism probe | Retained findings | Distinct labels it hides under |
|---|---|---|
| comparison without canonicalisation | 30 | **11** |
| assertion vacuity | 54 | **12** |
| vacuous truth / empty collection | 19 | 5 |
| numeric domain (NaN / Inf / range) | 16 | 6 |
| untrusted interpolation | 12 | 6 |
| resource lifecycle | 12 | 5 |

*(Provenance: keyword probe over `factory/review-findings.jsonl`. Observed, machine-counted.)*

`correctness` is the clearest case: 86 findings, and not a defect class at all. It is the
residue when no other label fits — unit conversions, Unicode, races, error classification, CSV
parsing. **A rule named `correctness` would be a rule about nothing.**

### 3.2 Three quantities, never conflated

| Term | Meaning | How obtained | Status |
|---|---|---|---|
| **Historical mechanism prevalence** | Retained findings a human attributes to the mechanism | Hand-clustering | **Derived.** An estimate. |
| **Theoretical detectability** | The subset the proposed algorithm could flag | Reasoning | **Derived.** A claim. |
| **Historical replay recall** | The subset the built rule *does* flag on replay | Running it (§12) | **Observed.** The only number that counts. |

No rule may be described as "covering" anything before §12 produces a recall figure. No rule
becomes blocking on a prevalence number.

### 3.3 Mechanisms found in this target

*(Hand-clustered by reading all 274 retained non-prose findings. **Derived.**)*

| ID | Mechanism | Prevalence | Band |
|---|---|---|---|
| M1 | Weak-predicate boundary check | ~23 | deterministic + local data-flow |
| M2 | Shallow container validation | ~7 | AST |
| M3 | Vacuous truth on empty collection | ~5 | AST |
| M4 | Comparison without canonicalisation | ~14 | property test |
| M5 | Resource acquired without bounded release | ~12 | deterministic + CFG |
| M6 | Untrusted value into prompt, outside convention | ~6 | taint registry |
| M7 | Test assertion does not establish its own claim | ~26 | AST + human |
| M8 | Untrusted identifier reaches a path operation | ~4 | deterministic |
| M9 | Producer's self-report trusted over real bytes | ~3 | human |
| M10 | Invalid state representable in the type | ~6 | type |
| M11 | Over-broad catch collapses distinct failures | ~7 | human |
| M12 | Map construction silently drops duplicates | ~4 | AST |
| M13 | Wall-clock used where the database clock is correct | ~3 | deterministic |

**M7's label lies.** 67 findings sit under `test-coverage`. Most are not missing tests. They
are tests that pass without proving their claim — a test named *"without touching the
database"* that never asserts it; an `expect` inside a conditional; `toEqual` against a
hand-copied literal. The defect is false assurance, not absence.

**M4 is the largest correctness cluster and no linter can catch it.** Percent versus proof,
millilitres versus litres, NFC versus NFKC. Domain logic. Property tests, not pattern matching.

---

## 4. The architecture boundary

```
deterministic known invariants   →  defect-gate + automatic repair
behavioural / property-testable  →  generated tests (slice 2)
novel semantic / design judgment →  CodeRabbit and human review
```

**Band 1 — deterministic.** M1, M5, M6, M8, M13, and the mechanical part of M7.
**Band 2 — AST with real structure.** M2, M3, M12.
**Band 3 — property or generated tests.** M4, and the domain part of M10.
**Band 4 — CodeRabbit and human.** M9, M11, the semantic part of M7, all novel `correctness`.

The residue is the honest ceiling: ~92 findings, 19% of this target's 484-finding ledger, are
novel one-off `correctness` with no recurring mechanism. That is why this reduces dependence
on external review rather than ending it.

---

## 5. The Rule Contract

Layer 1 loads any module satisfying this contract. No rule ships without every field.

| Field | Meaning |
|---|---|
| **id** | stable kebab-case identifier, never reused |
| **version** | integer; bumped on any change to matching behaviour |
| **invariant** | the property that must hold, over program semantics — not over syntax |
| **scope** | `changeset` (default) or `repo`, with written justification for `repo` |
| **registries** | which layer-2 files the algorithm reads |
| **algorithm** | source set, sink set, narrowing condition, decision procedure |
| **failure condition** | the exact predicate making a site a violation |
| **exemptions** | site classes never violations, encoded in the rule, not the allowlist |
| **baseline behaviour** | how pre-existing violations at `BASE_REF` are treated |
| **activatedAt** | commit at which the rule became blocking (§9.4) |
| **pinExpiresAfterMainCommits** | hard bound on the activation transition; default 25 |
| **repairability** | `auto`, `assisted`, or `manual` (§10.4) |
| **severity** | `fail`, or `advisory` — advisory requires §11's plumbing |
| **output schema** | the `Finding` shape emitted |
| **replay corpus** | the specific historical findings it is calibrated against |
| **expected precision / recall** | numeric ship criteria |
| **regression tests** | red fixture, green fixture, exemption fixture |

```js
export const meta = {
  id: 'weak-numeric-predicate',
  version: 1,
  scope: 'changeset',
  registries: ['domains.json', 'boundaries.json'],
  repairability: 'assisted',
  severity: 'fail',
  activatedAt: null,
  pinExpiresAfterMainCommits: 25,
  replayCorpus: ['TRO-462#3', 'TRO-471#7'],
}
export function check(ctx) {}      // → Finding[]
export function repairBrief(f) {}  // → string, the repair agent's task (§10.6)
```

---

## 6. First slice — five rules

Algorithms are layer 1. Every domain term below arrives from a layer-2 registry.

---

### R1 · `weak-numeric-predicate`

**Invariant.** A numeric value entering the program from outside its own type system must be
narrowed by a predicate whose accepted set equals the value's declared domain, before reaching
a persistence, arithmetic, or response sink.

The invariant is the **gap between accepted set and declared domain**, not a function name.
`Number.isInteger` is not a defect. It is a defect when the declared domain is "safe positive
integer" and `Number.isInteger` admits `-1` and `2^60`.

**Registries.** `domains.json` (field pattern → domain → canonical predicate),
`boundaries.json` (globs where "outside the type system" begins).

**Algorithm.** Intra-procedural.
1. **Sources** — a parameter typed `unknown`/`any`; a `JSON.parse` result; a request-body
   parse; a route parameter; a raw driver row. All named by `boundaries.json`.
2. **Sinks** — an ORM insert/update value; a SQL interpolation; an argument to a
   registry-matched field; a returned response member.
3. Collect narrowing predicates on each source→sink path.
4. **Failure condition:** the field matches a registry entry and no predicate on the path is
   the canonical predicate or a demonstrable refinement of it.

**Exemptions.** Already narrowed by the canonical predicate earlier in the function. Loop
indices, `.length` comparisons. Branded numeric types. Test files.

**Must flag.**
```ts
const body = await request.json()
if (typeof body.applicationId === 'number') { insert({ applicationId: body.applicationId }) }
if (Number.isInteger(id)) { return load(id) }              // domain is safe positive integer
if (isNonEmptyString(meta.generatedAt)) { persist(meta) }  // domain is canonical ISO-8601
```

**Must NOT flag.**
```ts
for (let i = 0; i < rows.length; i++) {}
if (isPositiveInteger(body.id)) { insert(body.id) }
if (!Number.isInteger(n) || n < 1 || n > MAX) throw new Error()   // composite equals domain
```

That last case is measured, not invented: it appears in in-flight branch TRO-543, and a naive
"flag `Number.isInteger`" rule would have false-positived on it.

**False-positive modes.** (1) Narrowing inside an unfollowed helper — *mitigation:* register
the helper as canonical. (2) A registry pattern matching an unrelated field (`elapsedAt` as a
duration) — *mitigation:* fix the registry, never the site. (3) An unresolved type guard.

**Scope.** `changeset`. Pre-existing violations reported, not failed.
**Repairability.** `assisted` — the fix is mechanical, but choosing the right predicate needs
the registry, and a wrong choice changes behaviour.
**Severity.** `fail`.
**Replay corpus.** ~23 M1 findings, including two that name their own recurrence: *"3rd
location for this recurring class"* and *"4th location this session."*
**Expected.** Recall ≥ 50%. Incidental fires ≤ 3, each adjudicated.
**Regression tests.** Red per must-flag, green per must-not-flag, one exemption fixture.

---

### R2 · `unbounded-resource`

**Invariant.** A resource acquired with an unbounded default lifetime must have both a bound
and a failure handler installed in its acquiring scope, and its release must execute on every
exit path from that scope.

**Registries.** `resources.json` — acquisition expression → required bound + handler.

**Algorithm.**
- **A — bound at acquisition.** Registry-matched acquisition requires its named bound and
  handler in the same object literal or following block.
- **B — timer spans the operation.** For a bounded remote call, no timer clear may be ordered
  before the response body is read.
- **C — release dominates exits.** In a `finally` with two or more `await`s, each must be
  individually guarded.

**Exemptions.** The target's own hardened client, named in `resources.json`. A single-statement
`finally`. A resource acquired and released inside one test body.

**Must flag.**
```ts
const pool = new Pool({ connectionString })                                   // A
try { const r = await fetch(u, {signal}); clearTimeout(t); return r.json() }   // B
finally { await rm(dir); await pool.end() }                                   // C
```

**Must NOT flag.**
```ts
new Pool({ connectionString, connectionTimeoutMillis: 10_000 }).on('error', log)
finally { await rm(dir).catch(noop); await pool.end() }
```

Measured against in-flight work: TRO-518 adds four `new Pool(` calls, **all exempt** — they
are in one test file, deliberately proving a cross-connection round trip.

**False-positive modes.** C flags a `finally` whose first `await` provably cannot throw.
*Mitigation:* **C is not built until §11's plumbing exists.**

**Scope.** `changeset`. **Repairability.** `auto` for A. `manual` for B and C — reordering
control flow is not a safe automatic edit.
**Severity.** `fail` for A and B. C not built.
**Replay corpus.** ~12 M5 findings. **Expected.** Recall ≥ 50% with A and B. Fires ≤ 2.
**Regression tests.** Red and green per sub-rule, plus the hardened-client exemption.

---

### R3 · `untrusted-interpolation`

**Invariant.** A string whose provenance includes any registered untrusted source —
**including values derived from those by comparison, annotation, or summarisation** — reaches
a prompt-assembly expression only through the registered sanitiser.

The derived clause is the point. The target's standing rule 18 was written, injected into
every brief, and the class still recurred on a comparator's own `reason` field — a value the
code computed itself from untrusted input. **A rule keyed on function names would have missed
exactly the finding that proved the brief insufficient.**

**Registries.** `taint.json` — tainted types and field paths, sanitiser name, sink globs.

**Algorithm.** Seed taint from the registry; propagate intra-procedurally through assignment,
destructuring, template literals, and concatenation.

**Failure condition.** A tainted expression reaches a registered sink, and no node on its path
is a call to the registered sanitiser.

**Exemptions.** Compile-time constants. Enum members. Numeric counts. Already-wrapped values.

**Must flag.**
```ts
return `<flagged>${field.reason}</flagged>`     // derived from untrusted
const note = `${a.trigger} vs ${b.trigger}`; return `${note}`   // propagated
```

**Must NOT flag.**
```ts
return `<section name="${SECTION_HEADER}">`
return `<data>${serializeUntrusted(field.reason)}</data>`
```

**Scope.** **`repo` — justified.** (1) A prompt-injection hole is a security defect; a
pre-existing one must not survive because no ticket touched that file. (2) Its measured backlog
is **zero**, so a whole-repo rule cannot fail an unrelated ticket for a pre-existing violation.
If the backlog becomes non-zero it must be driven to zero that wave, or the rule reverts to
`changeset`. Re-checked at activation and every wave boundary.

**Repairability.** `auto` — wrapping an expression in the sanitiser is a safe, local edit.
**Severity.** `fail`.
**Replay corpus.** ~6 M6 findings, 100% keep rate — the highest-signal corpus in the slice.
**Expected.** Recall ≥ 80%. Fires: 0.
**Regression tests.** Red fixtures from the target's real injection-test payloads, including a
derived-value case.

---

### R4 and R5 · the vacuity family

**Shared invariant.** *A predicate that reports success must have been exercised by at least
one evaluation that could have produced failure.*

In a test, the predicate is an assertion and the failure is a failing test. In production, the
predicate is a quantifier and the failure is a `false` result. The vacuity is identical.

They remain two rules — different scopes, severities, exemptions, and false-positive profiles —
sharing one layer-1 module, `defect-gates/vacuity-core.mjs`:

| Primitive | Question |
|---|---|
| `isAssertion(node)` | Is this an assertion or a quantifier decision? |
| `isUnconditionallyReached(node, body)` | Does every path evaluate it? |
| `canFail(node)` | Could this have produced failure, given its arguments? |
| `isProvablyNonEmpty(expr)` | Is this collection non-empty by construction or guard? |

Building these once is the difference between two rules and five unrelated AST hacks.

#### R4 · `vacuous-test-assertion`

**Invariant.** A test that reports success must have evaluated at least one assertion that
could have reported failure, on every path through its body.

**Registries.** `assertion-helpers.json` — project helpers that assert internally. Without it,
V1 flags every test using such a helper.

**Algorithm.** Collect assertion nodes per test body via `isAssertion`, then apply:

| Sub | Failure condition | Severity |
|---|---|---|
| V1 | Zero nodes where `isAssertion` holds | `fail` |
| V2 | Every assertion fails `isUnconditionallyReached` | **not built — §11** |
| V3 | An assertion exists but `canFail` is false | `fail` |
| V4 | A weak collection matcher is the sole assertion | `fail` |

`canFail` is false for: structurally identical literals across an equality matcher; a
throw-assertion with no matcher argument; a cast inside an assertion argument; a fully-anchored
regex that cannot match its subject.

**Exemptions.** Skipped/pending tests. Snapshot assertions. `resolves`-style assertions.

**Must flag.**
```ts
it('rejects a comma decimal', () => { parse('1,5') })                  // V1
expect(judged).toEqual([{a:1},{b:2}])   // vs an identical literal     // V3
await expect(insert()).rejects.toThrow()                               // V3
expect(fields).toEqual(expect.arrayContaining(['a','b']))              // V4
```

**Must NOT flag.**
```ts
it.fixme('pending', () => {})
await expect(load()).resolves.toBeDefined()
expect(err.cause.constraint).toBe('uq_review_queue')
```

**False-positive modes.** An assertion inside an unregistered helper — this target's corpus
contains one. *Mitigation:* the registry.

**Scope.** `changeset`. **Repairability.** `manual` — writing a real assertion requires knowing
what the test meant to prove. The factory must never auto-generate an assertion; that would
manufacture false assurance, which is the very defect.
**Severity.** `fail` for V1, V3, V4.
**Replay corpus.** The mechanical subset of ~26 M7 findings. **V1/V2 backlog is unmeasured;
measuring it is the first implementation task.**
**Expected.** Recall ≥ 45% with V1, V3, V4. Fires ≤ 5 across the target's 107 test files.
**Regression tests.** One fixture per sub-rule, four negatives, one skipped test, one
registered-helper case.

#### R5 · `vacuous-empty-quantifier`

**Invariant.** A universal or reductive quantifier whose result determines a program decision
must run over a provably non-empty collection, or state explicitly what empty means.

**Registries.** None. Fully generic.

**Algorithm.** Find quantifier call expressions. For each, test the receiver with
`isProvablyNonEmpty`, then test whether the result reaches a decision sink. Flag only when both
hold — not provably non-empty **and** decision-bearing.

**Failure condition.** A `.every`/`.some`/`.reduce` whose receiver fails `isProvablyNonEmpty`
**and** whose result flows to a decision sink — a return, a conditional test, or a persisted
status field. The sink clause matters: `.every` computing a display string is not this defect.

**Exemptions.** Tuples. Array literals. A receiver guarded by a length check. Non-empty branded
arrays.

**Must flag.**
```ts
return { outcome: fields.every(isResolved) ? 'resolved' : 'partial' }
```

**Must NOT flag.**
```ts
if (!fields.length) throw new Error('empty'); return fields.every(isResolved)
const label = items.every(done) ? 'all done' : 'in progress'    // display only
```

**Scope.** `changeset`. **Repairability.** `assisted` — the guard is mechanical, but what empty
*means* is a decision the agent must state.
**Severity.** `fail`.
**Replay corpus.** ~5 M3 findings. **Expected.** Recall ≥ 60%. Fires ≤ 2.
**Regression tests.** Guarded, unguarded, display-only, array-literal.

### 6.1 Slice summary

| Rule | Prevalence | Detectable | Replay recall | Scope | Repairability | Day-one |
|---|---|---|---|---|---|---|
| `weak-numeric-predicate` | ~23 | ~15 | **not measured** | changeset | assisted | fail |
| `unbounded-resource` | ~12 | ~8 (A+B) | **not measured** | changeset | auto (A) | fail (A,B) · C not built |
| `untrusted-interpolation` | ~6 | ~6 | **not measured** | repo (justified) | auto | fail |
| `vacuous-test-assertion` | ~26 | ~12 | **not measured** | changeset | manual | fail (V1,V3,V4) · V2 not built |
| `vacuous-empty-quantifier` | ~5 | ~4 | **not measured** | changeset | assisted | fail |

**Prevalence total: ~72 of this target's 385 retained findings — 18.7%.** Against its full
484-finding ledger, 14.9%. **No recall cell may be filled by reasoning.**

---

## 7. What NOT to build

**Never build a rule named `correctness`, `test-coverage`, or `boundary-validation`.** Review
vocabulary. Such a check matches nothing or everything.

**Do not build a prose rule from sentence length.** Measured on this target: 0 of 5,939
`CHANGES.md` sentences exceed 25 words. The discipline already holds. 63 findings, still not
worth a blocking check — volume is not severity.

**Do not build rules for 0%-keep categories.** This target's `false-positive-review` (15) and
`access-control` (4) were every one correctly dismissed. A check would automate noise.

**Do not build a static rule for M4.** See §14 — slice 2, as tests.

**Do not build M11.** *"treated any error as a missing-file 404"* needs to know which
distinctions matter. Judgment. Leave it external.

**Do not build M10 in slice 1.** A lint rule for "these optional fields should be a union" is
the highest-false-positive idea here.

**Do not add a rule because the ledger crossed 3.** The threshold opens the question; §12's
ship criteria answer it, and "leave it to CodeRabbit" is a legitimate outcome.

**Do not let a repair agent write an allowlist comment or edit a registry.** See §10.6 and §10.8.

---

## 8. Where detection runs

**G11**, after `G9: scope`, before `G10: review capture`.

```
G1 typecheck → … → G9 scope → G11 defect-gate (BLOCKING) → G10 review capture (advisory)
```

G11 precedes G10 so a defect the factory can catch never consumes external review budget. It
follows G3 so it can rely on a parse-clean tree. **G10 is unchanged by this design.**

---

## 9. Detection engine

### 9.1 Inputs

Changeset file list, ASTs, layer-2 registries, and the rule modules. Nothing else.

### 9.2 Scope discipline — the base-ref rule

**Default scope is `changeset`**, reusing the discipline the quarantine system already proves.
`gate.sh` materialises the quarantine baseline with `git show BASE_REF:` — never the branch
copy — so an agent cannot whitelist its own breakage. Same construction here:

1. Materialise the tree at `BASE_REF`. Run the rule. Record identity set `B`.
2. Run against `HEAD`. Record `H`.
3. **Fail on `H \ B`.** Report `H ∩ B` as pre-existing, without failing.

A ticket is never failed for a violation it did not introduce. The pre-existing backlog becomes
a reported number that can be burned down by its own ticket.

**`repo` scope requires written justification.** One rule claims it; see §6.

### 9.3 Violation identity

Line numbers shift under unrelated edits, which would make `H \ B` produce false failures:

```
sha256(ruleId + '|' + repoRelativePath + '|' + enclosingFunctionName + '|' + normalisedNodeText)
```

This mirrors `testdiff.mjs`, which compares failures by identity rather than position — the
property that let the gate catch a forged break-one/fix-one swap.

### 9.4 The activation pin — a bounded transition, not an allowlist

The base-ref rule protects a branch from violations it did not introduce. It does **not**
protect code written before the rule existed — those lines are in `H`, absent from `B`, so a
newly blocking rule would fail them retroactively.

This is a permanent condition. Work is always in flight: measured 2026-08-12, 34 worktrees, 4
with commits ahead, 3 open PRs. "Wait for a quiet moment" is not a mechanism.

**Decision procedure**, from git alone:

```bash
MB="$(git merge-base HEAD "${BASE_REF}")"
if git merge-base --is-ancestor "${ACTIVATED_AT}" "${MB}"; then MODE=blocking
else MODE=report-only; fi
```

Is the activation commit an ancestor of this branch's merge-base? Yes → the branch was cut from
a tree that already had the rule; it applies normally. No → report-only.

**Why this is not grandfathering.** Merge-base only moves forward, and the factory already
requires every branch to merge `origin/main` before landing. The moment a branch syncs, its
merge-base passes `activatedAt` and the rule blocks **for that branch, automatically, with no
list to maintain.** The transition is a property of the commit graph, not a registry. No
per-branch suppression, no blame walk — the rule reads two SHAs.

**Honest limitation.** Because blame archaeology is excluded, a report-only branch is
report-only for *all* its violations, including post-activation commits. A branch could extend
its exemption by refusing to sync. Two bounds close this:

1. **`pinExpiresAfterMainCommits`.** Once `main` advances this far past `activatedAt`, the pin
   is void:
   ```bash
   ELAPSED="$(git rev-list --count "${ACTIVATED_AT}..origin/main")"
   [ "$ELAPSED" -gt "$PIN_EXPIRES_AFTER" ] && MODE=blocking
   ```
   Counted in **commits on `main`**, not "waves" — *wave* is prose in this factory, with no
   machine-readable counter, so a wave-denominated bound would not be computable. Default 25.
2. **Remaining life is printed every run** and written to the output (§9.5).

**The pin retires itself.** Once no live branch predates `activatedAt`, it has no effect. A
`version` bump re-stamps `activatedAt` and opens exactly one fresh bounded transition — correct,
because a changed rule is a new rule for this purpose.

**Report-only is non-blocking, so §11 applies.** A pin nobody can see is a permanent exemption
wearing a transition's name.

### 9.5 Output

`.factory/defect-gate.json`, plus one `RESULTS` row in `gate-result.json`:

```json
{ "version": 1, "ranAt": "...", "baseRef": "main", "baseSha": "...", "mergeBase": "...",
  "rules": [
    { "id": "weak-numeric-predicate", "version": 1, "status": "fail", "mode": "blocking",
      "pin": { "activatedAt": "a1b2c3d", "mergeBaseIsAfterActivation": true,
               "mainCommitsElapsed": 3, "expiresAfter": 25 },
      "introduced": [ { "file": "...", "line": 42, "identity": "sha256:...",
                        "message": "...", "repairability": "assisted", "exemptedBy": null } ],
      "preExisting": 9, "advisory": 0, "exempted": 0 } ],
  "notRun": [] }
```

**A rule that does not run is recorded, with a reason.** `status` is
`pass | fail | advisory | error | skipped`; `error` fails the gate, because a rule that crashes
must never read as clean. `mode` is `blocking | report-only`, and `report-only` always carries
its `pin` object. This is the G10 defect, designed out rather than repeated.

---

## 10. Repair orchestration

The new capability. **The factory detects a known defect, repairs it, verifies the combined
result, and keeps running.**

```
detect → partition → parallel repair → reconcile
       → full defect-gate rerun → full existing-gate verification
```

### 10.1 Parallelism is an optimisation, never a correctness assumption

**This is the governing rule of the whole section.**

Partitioning repair work into parallel units is a throughput optimisation. It is permitted to
be imperfect. **Correctness must never depend on the partitioner having proved that repair
units are semantically independent** — because it cannot prove that, and V1 does not try.

File-disjointness is sufficient to parallelise. It is **not** evidence of semantic
independence. Two agents editing disjoint files can still produce a combined state neither one
verified: a changed function signature, a narrowed type, an altered invariant a sibling relied
on. The partitioner does not detect this and is not asked to.

**The correctness backstop is the full rerun after reconciliation (§10.7), not the partition.**
If the partitioner is wrong, verification catches it, the ticket does not merge, and the loop
escalates. That is the design's safety property. A partitioner that were somehow perfect would
make verification faster, never unnecessary.

Consequence: it is always legitimate to fall back to a single unit. Serial repair is the
degenerate, always-correct case of the same pipeline.

### 10.2 `ticket-local blocking ≠ pipeline-global blocking`

**A governing invariant of the factory, not a scheduling preference.**

A ticket with an unrepaired defect is blocked from *merge*. The *pipeline* continues. The
scheduler implements exactly this:

| Condition | Scheduler behaviour |
|---|---|
| Ticket has a repair pending | **Blocked from merge.** Not blocked from progressing its own repair states. |
| Independent ticket, ready | **Continues.** Selected and dispatched normally. |
| Ticket depends on a blocked ticket | **Remains blocked.** Existing dependency-graph behaviour, unchanged. |
| Unrelated batch or wave work | **Continues.** |
| Repair completes | Affected ticket becomes **eligible for verification again**. |

**The factory must never turn one repair into a global pipeline stop** — unless the repair
itself caused a shared factory-level failure, such as corrupting `main` or exhausting a global
budget. Those are pre-existing global-halt conditions and are not created by this design.

This needs no new scheduler. The orchestrator already selects unblocked tickets from a
dependency graph. Repair adds non-terminal states the selector skips, exactly as it skips
`blocked`. **The orchestrator must never await a repair.**

### 10.3 The repair state machine

```
detected → repair-queued → in-repair → repair-complete
         → reconciliation → verification → resolved
                                        ↘ escalated
                                        ↘ repair-budget-exhausted
```

| State | Meaning | Scheduler |
|---|---|---|
| `detected` | G11 produced findings for this ticket | not mergeable |
| `repair-queued` | Units planned; agents not yet dispatched | skip, keep scheduling others |
| `in-repair` | One or more repair agents running | **skip — non-terminal** |
| `repair-complete` | All units returned; nothing integrated yet | skip |
| `reconciliation` | Reconciler merging units into the ticket branch | skip |
| `verification` | Full rerun in progress (§10.7) | skip |
| `resolved` | Verification passed | **eligible again**; proceeds to G10 and merge |
| `escalated` | Repair failed, conflicted, or was `manual` | not mergeable; human owns it |
| `repair-budget-exhausted` | Retry budget spent | not mergeable; human owns it |

**`in-repair` is non-terminal.** A scheduler encountering it skips that ticket and continues
scheduling eligible work. Every intermediate state above is skip-and-continue; none is a wait.

`resolved`, `escalated`, and `repair-budget-exhausted` are the three terminal states.

`repair-budget-exhausted` is deliberately distinct from `escalated`. Both are terminal and both
block the ticket, but their causes and their fixes differ: one means the defect is hard, the
other means the budget is too small. Collapsing them would hide which.

### 10.4 Repairability is independent of detectability

Every rule declares `repairability = auto | assisted | manual`.

| Value | Meaning | Dispatch |
|---|---|---|
| `auto` | Safe, local, semantics-preserving edit | Repair agent, minimal brief |
| `assisted` | Mechanical, but a choice must be stated | Repair agent, brief carries the decision |
| `manual` | The fix requires knowing intent | **No repair agent.** Ticket blocks; the finding goes to the ticket's own agent |

**A deterministic detector does not imply a safe automatic repair.** The two properties are
unrelated, and conflating them is the most dangerous available mistake here.

**The worked example — `vacuous-test-assertion` is `manual`, and must be.**

Its violation is *the absence of a meaningful assertion*. An automatic repair would generate an
assertion. The detector would then stop firing, because an assertion now exists. But the
generated assertion was written by an agent that does not know what the test was meant to
prove — so it asserts something trivially true, and the test still provides no assurance.

The repair would satisfy the syntactic detector while **preserving the underlying defect**, and
would additionally destroy the evidence that the defect was ever there. That is circular: the
rule exists to catch false assurance, and the automatic repair manufactures false assurance.

**The factory must never repair a defect by producing the thing the invariant forbids.**
Any rule whose violation is "something meaningful is missing" is `manual` by default, and the
burden is on the rule author to argue otherwise.

### 10.5 Partitioning into repair units

1. Group findings by file.
2. Merge groups sharing a file into one unit.
3. Each unit gets one repair agent.
4. `manual` findings never form a unit; they escalate directly.

Units are file-disjoint by construction, so parallel repairs cannot conflict *textually*. Per
§10.1, this says nothing about semantic independence, and the design does not rely on it doing
so. A single unit repairs in place in the ticket's own worktree — no branch, no merge.

### 10.6 Dispatch and reconciliation ownership

Dispatch reuses existing primitives without exception: `worktree.sh` for provisioning (one
worktree per unit when units > 1, each branched from the ticket's HEAD with its own exclusive
database), the existing coding-agent path with a narrower brief, and one scorecard row per
repair attempt.

The repair brief is far narrower than a ticket brief: the finding, the invariant text, the file
and line, and the rule's own must-catch / must-not-catch examples. `repairBrief(finding)` is
part of the Rule Contract, so each rule authors its own. A tight brief is cheap and reliable,
and a repair agent may run on a cheaper model than a ticket agent.

**A repair agent operates only on its assigned target-repository worktree.** It must not modify:

- factory rule registries (layer 2),
- factory quarantine state,
- factory orchestration state — the scorecard, the ledger, ticket status,
- `main`, directly, ever.

The first three are the gaming moves: each one satisfies the detector without fixing the
defect. They are enforced mechanically — the reconciler rejects any repair diff touching those
paths. Test-weakening is already caught by `G5: tests-not-weakened`.

An allowlist entry is a human decision. A registry change is an orchestrator decision at a wave
boundary. **Neither is ever a repair agent's to make.**

**The reconciler owns integration.** Repair agents produce diffs; only the reconciler merges
them. It:

1. Merges each repair branch into the ticket branch in unit order.
2. Verifies each unit touched only its own file set. A unit that strayed is rejected and re-run
   serially.
3. Runs `pnpm install` after merging — a clean auto-merge still does not touch `node_modules`,
   a lesson this factory has already paid for twice.

**If integration conflicts, the conflict becomes an explicit state, never a silent choice.**
The reconciler does not pick a side, does not prefer "ours" or "theirs", and does not re-run an
agent to break the tie. The ticket enters `escalated` with both diffs attached. A conflict is
evidence that the partition was wrong — exactly the case §10.1 says verification exists to
catch.

### 10.7 Verification — the correctness backstop

**A repair is not successful merely because the rule that fired stops firing.**

After reconciliation, and before the ticket may proceed toward external review or merge:

1. **Rerun all defect-gate rules** — not only the one that fired. A repair can introduce a
   violation of a different rule.
2. **Rerun the existing evidence gates** — G1–G9 in full.
3. **Run the relevant regression tests.**
4. **Verify the test-diff and quarantine protections are intact** — the identity comparison in
   `G4`/`G5` and an unwidened `factory/quarantine.json`.
5. **Only then** does the ticket become `resolved` and proceed to G10 and merge.

Steps 1 and 2 are what catch interactions between parallel repairs. This is the mechanism
§10.1 relies on: the partitioner may be imperfect, and this is where that is detected. A
combined state that no individual agent verified is verified here, once, as a whole.

### 10.8 Repair failure is not detection failure

If a rule fires and no agent can safely repair it:

```
detected → escalated          ✅  the defect remains a real blocking condition
detected → disable the rule   ❌  never
detected → auto-exempt        ❌  never
```

A repair agent that fails, times out, conflicts, or exhausts its retry budget **does not
weaken the finding.** The defect is still real; only the automatic fix was unavailable. The
ticket stays blocked from merge and a human owns it.

**Nothing in the repair path may write a `factory-allow` entry, lower a rule's severity, or
mark a rule inactive.** Rule lifecycle changes belong to §12 and to a human at a wave boundary.
A failing repair is evidence about the *repair*, never about the *rule*.

A repair unit gets its own retry budget, separate from the ticket's gate retry cap. Two
failures, or a repair that introduces new findings, ends the loop for that ticket:
`escalated`, with findings, attempts, and diffs attached. **The pipeline continues.** A
permanently blocked ticket is a surfaced problem, not a stalled factory — the same principle as
the existing retry cap.

### 10.9 Worked concurrency example

The scheduler semantics, made unambiguous.

**Setup.** Ticket A has two independent findings in `foo/*`. Ticket B has one finding in
`bar/*`. Ticket C depends on A.

**Partition.** A's two findings share the `foo/*` file group and merge into a single unit,
`A1`. B's finding forms `B1`.

**Execution.**

| Time | A | B | C |
|---|---|---|---|
| t0 | `detected` → `repair-queued` | `detected` → `repair-queued` | blocked (depends on A) |
| t1 | `in-repair` (A1) | `in-repair` (B1) — **concurrent with A1** | blocked |
| t2 | `repair-complete` → `reconciliation` | `in-repair` | blocked |
| t3 | `verification` — full rerun | `repair-complete` → `reconciliation` | blocked |
| t4 | **`resolved`** | `verification` | **unblocked, eligible** |
| t5 | → G10 → merge | **`resolved`** | dispatched |

**What this shows.**

- `A1` and `B1` run **concurrently**. They are separate tickets in separate worktrees.
- Each is reconciled and fully verified **independently**. B does not wait for A.
- **C remains blocked while A is unresolved** — ordinary dependency-graph behaviour, not a
  repair-specific rule.
- **A's resolution unblocks C. B's resolution does not**, because C never depended on B.
- At no point does the scheduler wait. At t1–t3 it is free to dispatch any other eligible
  ticket in the wave.

**The failure variant.** If A's verification fails at t3, A becomes `escalated`. C stays
blocked, because its dependency is unresolved. **B is entirely unaffected and still merges at
t5.** One escalated ticket does not stop the pipeline.

### 10.10 V1 boundaries

Explicitly out of scope for V1:

- **Semantic dependency analysis.** File-disjointness is the whole partitioner. §10.1 explains
  why that is safe.
- **Distributed scheduling.** One orchestrator, existing wave machinery.
- **Cross-ticket repair.** A repair unit belongs to exactly one ticket. Two tickets with the
  same defect get two repairs.
- **Autonomous factory self-modification.** No repair path edits rules, registries, thresholds,
  or the gate.

> **V1 principle:** parallelise when conservatively safe; verify the combined state afterward;
> never let repair of one ticket stop unrelated work.

## 11. Advisory results must be observable — a hard precondition

Revision 1 proposed an advisory sub-check without saying where its output would surface. That
repeats the G10 defect this document exists to answer: **an advisory signal nothing downstream
reads is indistinguishable from no signal.**

Verified: `gate.sh:307` makes G10 `pass/warn/skip only, NEVER fail`; `record()` at
`gate.sh:123` sets `OVERALL=fail` only on `fail`; `status.mjs:44` filters to `status === 'fail'`.
A warn reaches nothing anyone reads.

**No sub-check ships advisory until all three exist:**

1. `dgAdvisory` and `dgReportOnly` counts per attempt in `factory/scorecard.jsonl`.
2. `status.mjs` surfaces non-`fail` defect-gate results on the status board.
3. `review-ledger.mjs report` counts advisory findings by rule.

The same requirement covers a rule running `report-only` under an activation pin.

**Until that plumbing lands, `unbounded-resource` sub-rule C and `vacuous-test-assertion` sub-rule
V2 are not implemented at all.** Not implemented-as-advisory. Not implemented. The blocking
sub-rules ship without them.

### 11.1 The scheduler must be observable too

Proving §10.2 — that the factory progressed while repairs ran — requires the scorecard to
distinguish every repair state, not merely "blocked". Each ticket carries a `dgState` field,
written on every transition:

The values are exactly §10.3's state machine, plus one terminal specialisation. **One state, one
name** — the scorecard never invents a synonym for a state the machine already names.

| `dgState` | Distinguishes |
|---|---|
| `detected` | Findings exist; ticket blocked by defect; no repair planned yet |
| `repair-queued` | Units planned, agents not dispatched |
| `in-repair` | Repair agents running |
| `repair-complete` | Units returned, nothing integrated |
| `reconciliation` | Reconciler integrating |
| `verification` | Full rerun in progress |
| `resolved` | Verification passed |
| `escalated` | Repair failed, conflicted, or was `manual` |
| `repair-budget-exhausted` | Retry budget spent — a distinct escalation cause |

```json
{"ticket":"TRO-520","attempt":1,"verdict":"fail",
 "failedGates":["defect-gate"],
 "dgState":"in-repair",
 "dgStateSince":"2026-08-12T22:14:00Z",
 "dgUnits":[{"id":"A1","files":["src/foo/a.ts"],"attempt":1,"state":"in-repair"}],
 "dgIntroduced":{"weak-numeric-predicate":1},
 "dgAdvisory":{}, "dgReportOnly":{}, "dgExempted":0}
```

`dgStateSince` is what makes metric 8 computable. Without a transition timestamp, a stalled
ticket and a fast-moving one are indistinguishable in the record — the same class of defect as
G10's silent absence.

---

## 12. Activation lifecycle — replay before blocking

```
proposed → replayed → calibrated → observable → blocking
```

### 12.1 Replay

`factory/defect-gates/replay.mjs`:

1. Read the target's review ledger.
2. Select the rule's declared `replayCorpus` — specific row ids, not a category.
3. For each, resolve the fixing commit and check out its **parent**.
4. Run the rule against that tree, scoped to the files the fixing commit touched.
5. Record hit or miss.

Output: `factory/replay/<ruleId>.v<version>.json`, committed. It is evidence, and it expires
when the version bumps.

### 12.2 Calibration

Run against the target's current `main`. Every fire outside the replay corpus is adjudicated:

- **true positive** — a real defect the corpus missed. File a ticket.
- **exemptible** — encode as a rule exemption, never an allowlist entry. An exemption helps
  every future site; an allowlist entry helps one.
- **false positive** — fix the rule, re-replay.

### 12.3 Ship criteria

| Criterion | Threshold |
|---|---|
| Historical replay recall | ≥ the rule's stated expectation |
| Incidental fires | ≤ the rule's stated ceiling, each adjudicated |
| Precision on adjudicated fires | ≥ 80% true-positive or exemptible |
| Regression tests | red, green, exemption — all present and passing |
| Observability | §11 satisfied if any sub-rule is advisory |
| **Repair dry-run** | for `auto`/`assisted` rules, repair verified on ≥ 3 replay hits |

The last criterion is new in revision 3: **a rule that can be detected but not safely repaired
ships as `manual`, not as `auto`.**

### 12.4 The blocking transition stamps the pin

`observable → blocking` is the single point where `activatedAt` is written: criteria pass →
`severity: fail` → `activatedAt` stamped with the landing commit → the pin (§9.4) governs from
there. A rule before this step has `activatedAt: null` and needs no pin, because a non-blocking
rule cannot retroactively block anything. A `version` bump returns the rule to `replayed`.

---

## 13. Evaluation metrics

The goal is **not** fewer CodeRabbit comments. It is **fewer known recurring defects escaping
the factory's own gates.**

| # | Metric | Definition | Target |
|---|---|---|---|
| 1 | `dg_dependency` | CR findings in claimed mechanisms ÷ all CR findings | falls |
| 2 | **CR residual finding rate** | CR findings per PR *not* in any claimed mechanism | **holds steady** |
| 3 | **First-pass escaped recurring-defect rate** | Claimed-mechanism defects reaching PR review at all | falls toward 0 |
| 4 | Defect-gate findings by rule | Introduced violations per rule per wave | rises, then falls |
| 5 | CR findings attributable to claimed mechanisms | Absolute numerator of #1 | falls |
| 6 | **Repair success rate** | Repair units resolved without human intervention | rises |
| 7 | **Pipeline continuity** | Tickets that advanced a state ÷ tickets eligible to advance, while ≥1 ticket was `in-repair` | **> 0 always** |
| 8 | **Repair state dwell time** | Wall-clock a ticket spends in each repair state | bounded |

Metric 3 is the real target. Metric 7 is revision 3's: it proves ticket-local blocking did not
become pipeline-global blocking. If it ever reads 0 while a repair was open, the scheduler is
awaiting a repair and §10.2 is violated.

**Metric 7 must not be gameable by removing blocked tickets from the queue.** A naive
formulation — "tickets progressed ÷ tickets in the active queue" — reports perfect health if a
ticket entering repair simply disappears from the denominator. The definition therefore counts
against **tickets eligible to advance**, and a ticket in any repair state **is** eligible to
advance: it should be moving through §10.3's state machine. A ticket parked in `in-repair` is a
stalled ticket, and it drags metric 7 down rather than vanishing from it.

Metric 8 exists for the same reason. A ticket sitting in one repair state beyond a threshold is
a **stall**, reported by state, and it is invisible to any ratio that only counts transitions.
Progress must be measured as movement, never as absence from a queue.

### 13.1 Protection against the coverage-loss inversion

**The failure mode:** total findings fall, `dg_dependency` is flat, everyone celebrates. That
is not improvement — that is external review having been unavailable.

**This has already happened, twice, and the data cannot show it.** Observed in
`factory/scorecard.jsonl`, 2026-08-12:

| Ticket | PR | Verdict | `crFindings` | `note` |
|---|---|---|---|---|
| TRO-535 | #40 | pass | **0** | *"CodeRabbit hit an org spend cap on both the agent's and my own review pass"* |
| TRO-538 | #42 | pass | **0** | *"no review capture succeeded on either the agent's or my own pass"* |

Both merged. Both carry `crFindings: 0` — structurally identical to a clean review. The only
record is free-text prose no aggregation reads. **Two of 62 scorecard rows, 3% of the corpus,
are silently review-free**, and any metric computed today averages them in as clean.

Three guards:

1. **Metric 2 is the control.** If metric 5 falls while metric 2 *also* falls, coverage dropped.
   **Metric 2 falling is an alarm, not a success.**
2. **A wave is admissible only if review actually ran.** Waves where G10's status is unknown are
   excluded from the denominator and flagged, never silently averaged.
3. **This is a hard dependency.** Guard 2 requires G10 to distinguish *review absent* from
   *review clean*, which it currently cannot. **Until that is fixed every metric here carries a
   known confound, and the report must say so on its face.**

---

## 14. Slice 2 — canonicalisation, as property tests

Slice 2 is **M4**, deliberately not another easy mechanical check.

M4 is the largest correctness cluster (~14 retained findings, 85% keep) and the worst fit for
pattern matching. Percent versus proof, millilitres versus litres, NFC versus NFKC — none is a
syntax. Each is a comparison performed before both operands were canonicalised.

It becomes a **property obligation** the gate enforces:

```
∀ (a, b) : compare(a, b) ≡ compare(canonical(a), canonical(b))
∀ a      : canonical(canonical(a)) ≡ canonical(a)
```

Generated inputs across the target's real unit and scale space, seeded from the boundary values
its corpus already names.

Choosing M4 over the cheaper AST mechanisms (M2, M12) is deliberate. Those are ~11 findings
between them against M4's ~14, and M4's findings sit in the verdict path — the part of the
target that must be right. **Slice 2 optimises for defect value, not for another mechanical
rule.**

---

## 15. What this does not do

- It does not replace CodeRabbit. ~19% of this target's ledger is novel one-off `correctness`
  with no recurring mechanism, and it stays external.
- It does not catch M4. That is slice 2.
- It does not fix G10's silent-absence defect — but §13.1 shows the metrics depend on it.
- It does not reduce total findings, and must not be judged on that.
- It does not repair `manual` rules. Those block their ticket and wait for a human.

---

## 16. Open questions and insufficient evidence

**Decisions.**

1. **Subsystem name.** This document uses `defect-gate`. Alternatives: `invariant-gate`,
   `factory-defect-gates`.
2. **Scope of the first build.** Revision 3 adds repair orchestration, which is a substantial
   expansion over revisions 1–2. Build detection and repair together, or land detection first
   and add repair once rules are calibrated? **Recommendation: detection first.** Repair without
   calibrated rules automates edits from an uncalibrated signal, and §12.3's repair dry-run
   criterion cannot be met before replay has run.
3. **Where layer-2 registries live.** `factory/rules/` in the target repo, as drafted — or
   alongside the target's source, closer to the conventions they describe?

**Where evidence is insufficient.**

4. **`vacuous-test-assertion` V1/V2 have no measured backlog.** The target's 107 test files were
   never scanned for zero-assertion bodies. **First implementation task**; V1's severity is
   provisional until then.
5. **Every prevalence figure is hand-clustered** — one reader's judgment over 274 findings.
   Adequate for prioritisation, inadequate as evidence a rule works.
6. **The `domains.json` registry does not exist.** `weak-numeric-predicate`'s quality is almost
   entirely the registry's quality. A thin registry yields a rule that looks sophisticated and
   catches little. Largest implementation risk in the slice.
7. **Intra-procedural analysis will miss real violations** wherever values cross function
   boundaries. Recall targets sit at 50–60% for this reason; raising them needs inter-procedural
   analysis, which should stay out of scope.
8. **No rule has been replayed.** Every recall cell reads *not measured*. Until §12 runs, this
   is a design, not a validated one.
9. **`pinExpiresAfterMainCommits: 25` is not calibrated.** It is a plausible default against 41
   merged PRs. If waves run larger, a pin could expire mid-wave and block a branch that has not
   had a chance to sync.
10. **Repair parallelism is unvalidated at scale.** File-disjoint partitioning prevents textual
    conflict but not *semantic* conflict — two units editing disjoint files can still produce a
    combined state neither agent verified. §10.7's full-gate rerun is the backstop, and it has
    not been tested against a real multi-unit repair.
