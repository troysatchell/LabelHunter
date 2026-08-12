# LabelHunter: defect-class extraction for the factory gate

**Date:** 2026-08-12
**Status:** design, not yet built. Revision 2.
**Tracks:** TRO-508 (nine categories past the gate-check threshold, no check built)

---

## 0. A naming collision to settle first

This document calls the rule engine **LabelHunter**, because the request did. That name
already belongs to the TTB verification app this repository builds. Two things named
LabelHunter in one codebase will confuse every future reader and every agent brief.

Recommended rename: **Lint-of-Record**, or **LHG** (LabelHunter Gate), or **Invariant**.
The rename is a find-and-replace in this document plus a directory name. Troy decides.
Everything below is unaffected.

---

## 1. The principle

> A third recurrence must not produce another prompt rule. It must force the question:
> can this observation become an executable invariant?

The factory already has the loop. It has the ledger, the recurrence threshold, the evidence
gate, the scorecard, and CodeRabbit. One link is missing:

```
review ledger  →  validated invariant  →  executable gate check
```

Rung 2 of the ladder works. `lessons.md` grew from 9 rules to 27. Rung 3 has never been
climbed. Three rules in `lessons.md` now end with the same admission: *"still not
gate-checked (TRO-508)."* A rule that the brief has failed to hold three times does not need
a louder restatement. It needs a check.

**LabelHunter does not replace CodeRabbit.** It removes *known, recurring* defect classes
from CodeRabbit's job so that CodeRabbit's tokens and Troy's attention go to novel semantic
and design judgment.

### 1.1 Three quantities, never conflated

Revision 2 exists partly to fix a terminological error in revision 1, which called a
hand-clustered count "coverage." Three distinct quantities:

| Term | Meaning | How obtained | Status |
|---|---|---|---|
| **Historical mechanism prevalence** | Retained findings a human judges attributable to the mechanism | Hand-clustering the ledger | **Derived.** An estimate. |
| **Theoretical detectability** | Of those, the subset the proposed algorithm could in principle flag | Reasoning about the algorithm | **Derived.** A claim, not a result. |
| **Historical replay recall** | Of those, the subset the built rule actually flags when replayed against the historical tree | Running the rule (§9) | **Observed.** The only number that counts. |

Until a rule is replayed, this document reports **prevalence** and **detectability** only, and
labels both as derived. No rule may be described as "covering" anything before §9 produces a
recall figure. No rule becomes blocking on a prevalence number.

---

## 2. Why the eleven labels are not eleven rules

`review-ledger.mjs report` names eleven categories past the 3-ticket threshold. Building one
check per category would be wrong. The categories are **review vocabulary**, not defect
mechanisms.

Evidence — the same mechanism, counted under many labels:

| Mechanism probe | Retained findings | Distinct labels it hides under |
|---|---|---|
| comparison without canonicalisation | 30 | **11** |
| assertion vacuity | 54 | **12** |
| vacuous truth / empty collection | 19 | 5 |
| numeric domain (NaN / Inf / range) | 16 | 6 |
| untrusted interpolation | 12 | 6 |
| resource lifecycle | 12 | 5 |

*(Provenance: keyword probe over the 385 retained findings in
`factory/review-findings.jsonl`. Observed, machine-counted.)*

`correctness` is the clearest case. It holds 86 findings and is not a defect class at all —
it is the residue left when no other label fits. Inside it sit unit-conversion bugs, Unicode
bugs, race conditions, error-classification bugs, and CSV parser bugs. **A rule named
`correctness` would be a rule about nothing.**

The unit of implementation is the **mechanism**: one invariant, one detector, one test.

---

## 3. Mechanisms derived from the corpus

I read all 274 retained non-prose findings and clustered them by mechanism, ignoring labels.

*(Provenance: hand-clustered by reading. **Derived**, not machine-counted. These are
historical mechanism prevalence estimates per §1.1, and must be re-checked before each rule
is built.)*

| ID | Mechanism | Historical prevalence | Band |
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

Two clusters deserve comment.

**M7 is the largest cluster, and its label lies.** 67 findings sit under `test-coverage`.
Most are not missing tests. They are **tests that pass without proving their own claim**: a
test named *"without touching the database"* that never asserts it; an `expect` inside a
conditional; `toEqual` against a hand-copied literal; a regex anchored so it could never
match. The defect is not absence of a test. It is a test that provides false assurance.

**M4 is the largest correctness cluster, and no linter can catch it.** Percent versus proof,
millilitres versus litres, NFC versus NFKC, case-folded versus case-preserving. Every one is
two values compared before both were mapped to one canonical form. This is domain logic. It
belongs in property tests, not in a pattern matcher.

---

## 4. The architecture boundary

Three destinations, and the boundary is load-bearing:

```
deterministic known invariants      →  LabelHunter (this document)
behavioural / property-testable     →  targeted generated tests (slice 2)
novel semantic / design judgment    →  CodeRabbit and human review
```

**Band 1 — deterministic.** Pattern, AST, or bounded local analysis. LabelHunter owns these.
M1, M5, M6, M8, M13, and the mechanical part of M7.

**Band 2 — AST with real structure.** LabelHunter owns the tractable slice and leaves the
rest. M2, M3, M12.

**Band 3 — property or generated tests.** Not static analysis at all. These become test
obligations the gate enforces, not patterns the gate matches. M4, and the domain part of M10.

**Band 4 — CodeRabbit and human.** Context-dependent judgment. LabelHunter must never try.
M9, M11, the semantic part of M7, all novel `correctness`, every `open-design-question`.

The residue matters. About **92 findings — 19% of the full 484-finding ledger — are novel
one-off `correctness`** with no recurring mechanism. That is the honest ceiling, and it is why
this reduces dependence on CodeRabbit rather than ending it.

---

## 5. The Rule Contract

Every rule is a module satisfying this contract. No rule ships without every field populated.

| Field | Meaning |
|---|---|
| **id** | stable kebab-case identifier, never reused |
| **version** | integer; bumped on any change to matching behaviour |
| **invariant** | the property that must hold, stated over program semantics — not over syntax |
| **scope** | `changeset` (default) or `repo`, with written justification for `repo` |
| **inputs** | files, ASTs, and registries the algorithm reads |
| **algorithm** | source set, sink set, narrowing condition, decision procedure |
| **failure condition** | the exact predicate that makes a site a violation |
| **exemptions** | site classes that are never violations, encoded in the rule, not the allowlist |
| **baseline behaviour** | how pre-existing violations at `BASE_REF` are treated |
| **activatedAt** | the commit at which the rule became blocking; the activation pin's boundary (§7.2.1) |
| **pinExpiresAfterMainCommits** | hard bound on the activation transition, in commits on `main`; default 25 |
| **severity** | `fail`, or `advisory` — and advisory requires §8's observability plumbing |
| **output schema** | the `Finding` shape emitted |
| **replay corpus** | the specific historical findings the rule is calibrated against |
| **expected precision / recall** | the numeric ship criteria |
| **regression tests** | red fixture, green fixture, exemption fixture |

```ts
export const meta = {
  id: 'weak-numeric-predicate',
  version: 1,
  mechanism: 'M1',
  lessonsRule: 13,
  scope: 'changeset',
  severity: 'fail',
  activatedAt: null,               // stamped at the blocking transition (§7.2.1, §9)
  pinExpiresAfterMainCommits: 25,
  replayCorpus: ['TRO-462#3', 'TRO-471#7', ...],   // ledger row ids
}
export function check(ctx: RuleContext): Finding[] {}
```

```ts
type Finding = {
  ruleId: string
  ruleVersion: number
  mechanism: string
  file: string
  line: number
  identity: string      // stable across line shifts — see §7.3
  message: string
  exemptedBy: string | null
}
```

---

## 6. First slice — five rules

Every rule below states its invariant over **program semantics**, not over an API name. A
rule that can be satisfied by renaming a function is not a rule.

---

### LH-R1 · `weak-numeric-predicate`

**Invariant.** A numeric value that enters the program from outside its own type system must
be narrowed by a predicate whose accepted set equals the value's declared domain, before it
reaches a persistence, arithmetic, or response sink.

The invariant is about **the gap between the accepted set and the declared domain** — not
about which function was called. `Number.isInteger` is not itself a defect. It is a defect
when the declared domain is "safe positive integer" and `Number.isInteger` admits `-1` and
`2^60`.

**Inputs.**
- The changeset ASTs.
- **A domain registry**, `factory/labelhunter/domains.json`, mapping field-name patterns to
  their declared domain and its canonical predicate. This registry is the rule's actual
  content; the AST walk is plumbing.

```json
{ "confidence":      { "domain": "unit interval",        "predicate": "unitInterval" },
  "*Id|*_id":        { "domain": "safe positive integer","predicate": "isPositiveInteger" },
  "*At|*_at":        { "domain": "canonical ISO-8601",   "predicate": "isIsoTimestamp" },
  "*Count|*Ms|*Px":  { "domain": "non-negative finite",  "predicate": "isNonNegativeFinite" } }
```

**Algorithm.** Intra-procedural, within one function body.
1. **Sources** — a parameter typed `unknown`/`any`; a `JSON.parse` result; a `request.json()`
   / `formData()` result; a route `params` member; a raw `db.execute` row.
2. **Sinks** — a Drizzle insert/update value; a SQL template interpolation; an argument to a
   function whose parameter is a registry-matched field; a returned response body member.
3. For each source→sink path, collect the narrowing predicates applied on that path.
4. **Failure condition:** the field name matches a registry entry, and no predicate on the
   path is the registry's canonical predicate or a demonstrable superset-refinement of it.

**Exemptions (encoded in the rule).**
- A value already narrowed by the canonical predicate earlier in the same function.
- A loop index, an `Array.length`, or a `.length` comparison.
- A value whose declared TypeScript type is a branded/opaque numeric type.
- Any file under `**/*.test.ts` — test fixtures deliberately construct invalid values.

**Positive examples (must flag).**
```ts
const body = await request.json()
if (typeof body.applicationId === 'number') { await db.insert(...).values({ applicationId: body.applicationId }) }
// declared domain: safe positive integer. accepted set: all doubles incl. NaN, -1, 2^60.

const id = Number(params.verificationId)
if (Number.isInteger(id)) { return loadVerification(id) }
// admits negative and unsafe integers. Registry says isPositiveInteger.

if (isNonEmptyString(meta.generatedAt)) { persist(meta) }
// declared domain: canonical ISO-8601. isNonEmptyString admits "unknown".
```

**Negative examples (must NOT flag).**
```ts
for (let i = 0; i < rows.length; i++) {}                  // loop index
const n = rows.length; if (n > 100) {}                    // length comparison
if (isPositiveInteger(body.id)) { insert(body.id) }       // canonical predicate present
const px = computeResizeDimensions(w, h).longEdgePx       // internally produced
```

**Known false-positive modes.**
1. A narrowing predicate applied in a helper the intra-procedural walk cannot follow.
   *Mitigation:* the helper's name is added to the registry as a canonical predicate.
2. A registry field-name pattern matching an unrelated field (`elapsedAt` as a duration, not a
   timestamp). *Mitigation:* registry patterns are reviewed at each wave boundary; a
   mismatch is a registry bug, fixed there rather than allowlisted at the site.
3. A value narrowed by a type guard whose return type the walk does not resolve.

**Scope.** `changeset`. **Baseline:** violations present at `BASE_REF` are reported and not
failed. The 9 pre-existing `Number.isInteger` sites are a separate backlog ticket, not this
rule's problem.

**Severity.** `fail`.

**Replay corpus.** The ~23 M1 findings, of which the strongest are the two that name their own
recurrence: *"3rd location for this recurring class"* and *"4th location this session."*

**Expected.** Recall ≥ 50% of the M1 corpus. Incidental fires on current `main` ≤ 3, each
adjudicated by hand before activation.

**Regression tests.** One red fixture per positive example. One green fixture per negative
example. One exemption fixture (a test file containing a deliberate violation, asserted not
flagged).

---

### LH-R2 · `unbounded-resource`

**Invariant.** A resource acquired with an unbounded default lifetime must have both a bound
and a failure handler installed in its acquiring scope, and its release must execute on every
exit path from that scope.

Two distinct obligations, and the corpus contains both: *bound at acquisition*, and *release
dominates all exits*.

**Inputs.** Changeset ASTs. A **resource registry** naming acquisition expressions and their
required bound + handler:

```json
{ "new Pool":     { "bound": "connectionTimeoutMillis", "handler": "on('error')" },
  "fetch":        { "bound": "AbortSignal",             "handler": null },
  "createWorker": { "bound": null,                      "handler": "terminate" } }
```

**Algorithm.**
- **Sub-rule A — bound at acquisition.** For each registry-matched acquisition, require the
  named bound and handler in the same object literal or the following statement block.
- **Sub-rule B — timer spans the whole operation.** For a `fetch` guarded by an
  `AbortController`, require that no `clearTimeout` on that controller's timer is ordered
  before a `.json()`/`.text()`/`.arrayBuffer()` on the same response.
- **Sub-rule C — release dominates exits.** In a `finally` block containing two or more
  `await` expressions, require each to be individually guarded, so an earlier rejection
  cannot skip a later release.

**Failure condition.** Any sub-rule's requirement unmet at a matched site.

**Exemptions.** `src/lib/db/index.ts`, the hardened client that defines the convention. A
`finally` with a single statement. A pool created and closed within one test body.

**Positive examples (must flag).**
```ts
const pool = new Pool({ connectionString })                       // A: no bound, no handler
try { const r = await fetch(u, {signal}); clearTimeout(t); return await r.json() }  // B
finally { await rm(dir); await pool.end() }                       // C: rm throws, pool leaks
```

**Negative examples (must NOT flag).**
```ts
new Pool({ connectionString, connectionTimeoutMillis: 10_000 }).on('error', log)
try { ... } finally { await pool.end() }                          // single statement
finally { await rm(dir).catch(noop); await pool.end() }           // individually guarded
```

**Known false-positive modes.** Sub-rule C is the noisy one: a `finally` whose first `await`
is provably non-throwing still flags. *Mitigation:* **sub-rule C is not built until §8's
observability plumbing exists.** Sub-rules A and B ship blocking without it.

**Scope.** `changeset`. **Baseline:** the 2 pre-existing `new Pool` sites are reported, not
failed.

**Severity.** `fail` for A and B. C is **not implemented** until §8's plumbing lands — not
shipped as advisory, not shipped at all.

**Replay corpus.** The ~12 M5 findings.

**Expected.** Recall ≥ 50% with A and B alone. Incidental fires ≤ 2.

**Regression tests.** Red and green fixture per sub-rule, plus the `src/lib/db` exemption.

---

### LH-R3 · `untrusted-prompt-interpolation`

**Invariant.** A string whose provenance includes label-image text, application-form input, or
any model output — **including values derived from those by comparison, annotation, or
summarisation** — reaches a prompt-assembly expression only as an argument to
`serializeUntrusted`.

The derived clause is the whole point. Standing rule 18 was written, injected into every
brief, and the class still recurred on `comparator.reason` — a value the code computed itself,
from untrusted input. **A rule keyed on function names would have missed exactly the finding
that proved the brief insufficient.** The invariant is about provenance.

**Inputs.** Changeset ASTs. A **taint registry** of type names and field paths whose values
carry untrusted provenance:

```json
{ "tainted": ["Extraction.*", "ApplicationForm.*", "FieldResultRow.reason",
              "FlaggedField.trigger", "ResolverResponse.*", "OcrResult.text"],
  "sanitiser": "serializeUntrusted",
  "sinks": ["**/prompt.ts", "**/user-message.ts", "**/*-prompt.ts"] }
```

**Algorithm.**
1. Seed the taint set from the registry, by declared type and by field path.
2. Propagate intra-procedurally through assignment, destructuring, template literals, and
   string concatenation.
3. **Sinks:** any template literal or concatenation in a sink file, or in a function whose
   return type is a prompt/message type.
4. **Failure condition:** a tainted expression reaches a sink without passing through
   `serializeUntrusted`.

**Exemptions.** Compile-time string constants. Enum members. Numeric counts. A value already
wrapped in the same expression.

**Positive examples (must flag).**
```ts
return `<flagged>${field.reason}</flagged>`                   // derived from untrusted
return `Brand: ${extraction.brand_name}`                      // directly untrusted
const note = `${a.trigger} vs ${b.trigger}`; return `${note}` // propagated
```

**Negative examples (must NOT flag).**
```ts
return `<section name="${SECTION_HEADER}">`                   // constant
return `Fields flagged: ${flagged.length}`                    // numeric
return `<data>${serializeUntrusted(field.reason)}</data>`     // sanitised
```

**Known false-positive modes.** A tainted value laundered through a genuinely
sanitising helper the registry does not list. *Mitigation:* add the helper as a sanitiser;
do not allowlist the site.

**Scope.** **`repo` — justified.** Two reasons, and the second is what makes it safe.
1. A prompt-injection hole is a security defect. A pre-existing one must not survive because
   no ticket happened to touch that file.
2. **Its measured backlog on current `main` is zero.** A whole-repo rule with a zero backlog
   cannot fail an unrelated ticket for a pre-existing violation — the situation the changeset
   default exists to prevent. If the backlog ever becomes non-zero, it must be driven to zero
   in that same wave, or the rule reverts to `changeset`. **This condition is checked at
   activation and at every wave boundary.**

**Severity.** `fail`.

**Replay corpus.** All ~6 M6 findings. 100% keep rate — the highest-signal corpus in the slice.

**Expected.** Recall ≥ 80% — higher than the others, because the convention is explicit and
the corpus is small and unambiguous. Incidental fires: 0.

**Regression tests.** Red fixtures adapted from the real `injection.test.ts` payloads,
including a derived-value case.

---

### LH-R4 and LH-R5 · the vacuity family

**These two rules share one framework.** Revision 2 merges their implementations, per the
observation that they are one idea in two settings.

**Shared invariant.** *A predicate that reports success must have been exercised by at least
one evaluation that could have produced failure.*

In a test, the predicate is an assertion and the failure is a failing test. In production, the
predicate is a quantifier and the failure is a `false` result. The vacuity is identical: the
code reports a property it never tested.

They remain **two rules** rather than one, because their scope, severity, exemptions, and
false-positive profiles differ — R4 runs only on test files, R5 only on non-test files, and R4
carries a sub-rule that cannot ship blocking. They share `vacuity-core`, not an id.

#### `factory/labelhunter/vacuity-core.mjs`

One module, four primitives, used by both rules:

| Primitive | Question it answers |
|---|---|
| `isAssertion(node)` | Is this expression an assertion or a quantifier decision? |
| `isUnconditionallyReached(node, fnBody)` | Does every path through the body evaluate it? |
| `canFail(node)` | Could this predicate have produced failure, given its arguments? |
| `isProvablyNonEmpty(expr)` | Is this collection non-empty by construction or by a guard? |

Building these once is the difference between two rules and five unrelated AST hacks. Every
future vacuity sub-rule reuses them.

#### LH-R4 · `vacuous-test-assertion`

**Invariant.** A test that reports success must have evaluated at least one assertion that
could have reported failure, on every path through its body.

**Inputs.** Changeset ASTs restricted to `**/*.test.ts` and `**/*.test.tsx`. `vacuity-core`.
An **assertion-helper registry**, `factory/labelhunter/assertion-helpers.json`, naming project
helpers that assert internally — the corpus contains `expectCheckConstraintViolation`, and
without the registry V1 would flag every test that uses it.

**Algorithm.** For each `test`/`it`/`describe` body: collect assertion nodes via
`isAssertion` (which consults the helper registry), then evaluate the four sub-rules below.
Each sub-rule is a distinct failure condition over the same collected node set — this is why
they share `vacuity-core` rather than each walking the tree themselves.

| Sub | Failure condition | Severity |
|---|---|---|
| V1 | A `test`/`it` body contains zero nodes where `isAssertion` holds | `fail` |
| V2 | Every assertion fails `isUnconditionallyReached`, and the else-path ends the test successfully | **not built — see §8** |
| V3 | An assertion exists but `canFail` is false | `fail` |
| V4 | `expect.arrayContaining` is the only assertion applied to a collection | `fail` |

`canFail` returns false for: structurally identical literal arguments on both sides of
`toEqual`; `.rejects.toThrow()` with no matcher argument; an `as`/`as never` cast inside an
assertion argument; a fully-anchored regex tested against a value that cannot match it.

**Exemptions.** `test.skip`, `test.fixme`, `test.todo`. A snapshot assertion. A test whose only
assertion is `await expect(p).resolves.*` — that is a real assertion.

**Positive examples (must flag).**
```ts
it('rejects a comma decimal', () => { parse('1,5') })                       // V1
it('is null', () => { if (r) expect(r.v).toBeNull() })                      // V2
expect(judged).toEqual([{a:1},{b:2}])   // vs an identical literal          // V3
await expect(insert()).rejects.toThrow()                                   // V3
expect(fields).toEqual(expect.arrayContaining(['a','b']))                  // V4
```

**Negative examples (must NOT flag).**
```ts
it.fixme('pending', () => {})
await expect(load()).resolves.toBeDefined()
expect(names).toEqual(['a','b'])                        // literal vs computed value
expect(err.cause.constraint).toBe('uq_review_queue')    // precise matcher
```

**Known false-positive modes.** An assertion inside a helper `isAssertion` cannot follow —
the corpus contains such helpers (`expectCheckConstraintViolation`). *Mitigation:* helper
names are registered as assertion-bearing. This is why V1 needs a registry and not just a
walk.

**Scope.** `changeset`. **Baseline:** pre-existing vacuous tests across 107 test files are
reported and not failed. That backlog is a separate ticket.

**Replay corpus.** The mechanically detectable subset of the ~26 M7 findings. Measured today:
5 bare `rejects.toThrow()`, 3 `arrayContaining`. **V1 and V2 counts are not yet measured —
measuring them is the first implementation task, before any severity is fixed.**

**Expected.** Recall ≥ 45% with V1, V3, V4. Incidental fires ≤ 5 across 107 test files.

**Severity.** `fail` for V1, V3, V4. V2 is **not implemented** until §8's plumbing lands.

**Regression tests.** A fixture test file carrying one instance of each of V1, V3, V4, plus
four negatives, plus one `test.fixme` and one registered-helper case asserted not flagged.

#### LH-R5 · `vacuous-empty-quantifier`

**Invariant.** A universal or reductive quantifier whose result determines a program decision
must be evaluated over a collection that is provably non-empty, or must state explicitly what
an empty collection means.

**Inputs.** Changeset ASTs excluding test files. `vacuity-core`, specifically
`isProvablyNonEmpty`.

**Algorithm.** Find `.every`/`.some`/`.reduce` call expressions. For each, test the receiver
with `isProvablyNonEmpty`, then test whether the result flows to a decision sink — a `return`,
a conditional test, or a persisted status field. Flag only when the receiver is not provably
non-empty **and** the result reaches a decision sink.

**Failure condition.** A call to `.every`/`.some`/`.reduce` whose receiver fails
`isProvablyNonEmpty`, and whose result flows to a boolean decision — a return, a conditional,
or a persisted status field.

The last clause matters. `.every` used to compute a display string is not this defect. `.every`
used to decide that a resolution is `resolved` is.

**Exemptions.** A tuple type. An array literal. A receiver guarded by `if (!xs.length)`. A
receiver whose type is a non-empty branded array.

**Positive examples (must flag).**
```ts
return { outcome: fields.every(isResolved) ? 'resolved' : 'partial', fields }
if (ids.length > 0 && ids.every(valid)) { scope = ids }   // empty means "unrestricted" silently
```

**Negative examples (must NOT flag).**
```ts
if (!fields.length) throw new Error('empty'); return fields.every(isResolved)
const label = items.every(done) ? 'all done' : 'in progress'   // display only
[a, b].every(check)                                             // literal
```

**Known false-positive modes.** A collection non-empty by an invariant established in a
caller. *Mitigation:* the allowlist, with the invariant named at the site — this is the
legitimate use of the escape hatch.

**Scope.** `changeset`. **Baseline:** 4 pre-existing sites reported, not failed.

**Severity.** `fail`.

**Replay corpus.** The ~5 M3 findings.

**Expected.** Recall ≥ 60% — the corpus is small and the shape is uniform. Incidental fires ≤ 2.

**Regression tests.** A guarded and an unguarded fixture, a display-only fixture asserted not
flagged, and an array-literal fixture asserted not flagged.

---

### 6.1 Slice summary

| Rule | Historical prevalence (derived) | Theoretically detectable (derived) | Replay recall | Scope | Day-one severity |
|---|---|---|---|---|---|
| LH-R1 `weak-numeric-predicate` | ~23 | ~15 | **not yet measured** | changeset | fail |
| LH-R2 `unbounded-resource` | ~12 | ~8 (A+B) | **not yet measured** | changeset | fail (A,B) · C not built |
| LH-R3 `untrusted-prompt-interpolation` | ~6 | ~6 | **not yet measured** | repo (justified) | fail |
| LH-R4 `vacuous-test-assertion` | ~26 | ~12 (V1,V3,V4) | **not yet measured** | changeset | fail (V1,V3,V4) · V2 not built |
| LH-R5 `vacuous-empty-quantifier` | ~5 | ~4 | **not yet measured** | changeset | fail |

**Total historical prevalence: ~72 of the 385 retained findings — 18.7%.** Against the full
484-finding ledger, 14.9%. Both denominators appear in this document, so each is always named.

**No cell in the recall column may be filled by reasoning.** It is filled by §9, or the rule
does not activate.

---

## 7. Architecture

### 7.1 Where it runs

LabelHunter is **G11**, after `G9: scope` and before `G10: review capture`.

```
G1 typecheck → … → G9 scope → G11 LabelHunter (BLOCKING) → G10 review capture (advisory)
```

G11 runs **before** G10 so a defect LabelHunter can catch never reaches CodeRabbit. That is
the point: the recurring class stops consuming external review budget. G11 runs **after** G3
so it can rely on a parse-clean tree.

G10 stays advisory and unchanged. This design does not touch it.

### 7.2 Scope discipline — the base-ref rule

**Default scope is `changeset`.** A rule reports violations that the current branch
introduced, measured against `BASE_REF`.

This reuses the discipline the quarantine system already proves, and for the same reason.
`gate.sh` materialises the quarantine baseline with `git show BASE_REF:` — never the branch
copy — so an agent cannot whitelist its own breakage. LabelHunter's baseline is computed the
same way:

1. Materialise the tree at `BASE_REF`.
2. Run the rule against it. Record the violation identity set, `B`.
3. Run the rule against `HEAD`. Record `H`.
4. **Fail on `H \ B`.** Report `H ∩ B` as pre-existing, without failing.

Consequences, all intended:
- A ticket is never failed for a violation it did not introduce.
- The pre-existing backlog becomes a reported number, visible every run, that can be burned
  down by its own ticket rather than by blocking unrelated work.
- An agent cannot clear a violation by reverting the baseline, because the baseline comes from
  `BASE_REF`, not the branch.

**`repo` scope requires written justification.** Exactly one rule claims it — LH-R3 — and its
justification is in §6, resting on a measured zero backlog that is re-checked at every wave.

### 7.2.1 The activation pin — a bounded transition, not an allowlist

The base-ref rule protects a branch from violations it did not introduce. It does **not**
protect code the branch wrote *before the rule existed* — those lines are in `H` and absent
from `B`, so a newly blocking rule would fail them retroactively.

This is a permanent condition of the factory, not a one-off. Work is always in flight. A
scheduling trick — "wait for a quiet moment" — is not a mechanism, and this factory is rarely
quiet. Measured 2026-08-12: 34 worktrees, 4 with commits ahead, 3 open PRs.

**The mechanism.** Each rule records the commit at which it became blocking:

```js
export const meta = {
  id: 'weak-numeric-predicate',
  activatedAt: 'a1b2c3d…',            // stamped at the blocking transition (§9)
  pinExpiresAfterMainCommits: 25,     // hard bound on the transition
}
```

**The decision procedure.** Deterministic, computed from git alone:

```bash
MB="$(git merge-base HEAD "${BASE_REF}")"
if git merge-base --is-ancestor "${LH_ACTIVATED_AT}" "${MB}"; then
  MODE=blocking      # the branch's base already contains the rule
else
  MODE=report-only   # the branch predates the rule
fi
```

The test asks one question: **is the activation commit an ancestor of this branch's
merge-base?** If yes, the branch was cut from a tree that already had the rule, and the rule
applies normally. If no, the branch predates the rule and runs report-only.

**Why this is not grandfathering.** Merge-base only moves forward. The factory already
requires every branch to merge `origin/main` before it lands — standing rules 14 and 27. The
moment a branch performs that merge, its merge-base advances past `activatedAt` and the rule
becomes blocking **for that branch, automatically, with no list to maintain and no entry to
remove.** The transition is a property of the commit graph, not of a registry.

There is no per-branch suppression, no allowlist, and no blame walk. The rule reads two SHAs.

**The honest limitation.** Because blame archaeology is excluded by design, a report-only
branch is report-only for *all* of its violations, including commits authored after
activation. A branch could therefore extend its exemption by refusing to sync with `main`.
Two bounds close this:

1. **`pinExpiresAfterMainCommits`.** Once `main` has advanced this many commits past
   `activatedAt`, the pin is void and the rule blocks regardless of merge-base:

   ```bash
   ELAPSED="$(git rev-list --count "${LH_ACTIVATED_AT}..origin/main")"
   [ "$ELAPSED" -gt "$LH_PIN_EXPIRES_AFTER" ] && MODE=blocking
   ```

   The bound is counted in **commits on `main`**, not in "waves." *Wave* is prose in this
   repository — it appears in `config.yaml` comments and in scorecard `note` free text, but no
   machine-readable wave counter exists, so a wave-denominated bound would not be computable.
   Commit count needs no new bookkeeping and measures the thing that matters: how far the
   branch has drifted from the tree the rule was activated against. Default 25, roughly a
   wave's worth of merges at this factory's observed rate (41 merged PRs to date).

2. **The pin's remaining life is printed on every gate run** and written to
   `labelhunter.json` (§7.4). A pin cannot persist quietly, because every run states how much
   of it is left.

**The pin retires itself.** Once no live branch has a merge-base predating `activatedAt`, the
pin has no effect and its expiry is moot. `activatedAt` stays in the rule's meta as the
provenance record of when the rule became blocking — it is not re-armed, and a rule has
exactly one activation per version. Bumping a rule's `version` because its matching behaviour
changed re-stamps `activatedAt` and re-opens one bounded transition, which is the correct
behaviour: a changed rule is a new rule for this purpose.

**Report-only is a non-blocking result, so §8 applies.** A pinned run must appear in the
scorecard and on the status board. An invisible report-only result is the exact defect this
document was written to answer.

### 7.3 Violation identity

Line numbers shift under unrelated edits, which would make `H \ B` produce false failures.
Identity is therefore:

```
sha256(ruleId + '|' + repoRelativePath + '|' + enclosingFunctionName + '|' + normalisedNodeText)
```

This mirrors `testdiff.mjs`, which compares failures by **identity** rather than by position —
the property that let the gate catch a forged break-one/fix-one swap.

### 7.4 Output

`.factory/labelhunter.json`, plus one `RESULTS` row in `gate-result.json`:

```json
{ "version": 1, "ranAt": "...", "baseRef": "main", "baseSha": "...",
  "mergeBase": "...",
  "rules": [
    { "id": "weak-numeric-predicate", "version": 1, "status": "fail",
      "mode": "blocking",
      "pin": { "activatedAt": "a1b2c3d", "mergeBaseIsAfterActivation": true,
               "wavesRemaining": null },
      "introduced": [ { "file": "...", "line": 42, "identity": "sha256:...",
                        "message": "...", "exemptedBy": null } ],
      "preExisting": 9, "advisory": 0, "exempted": 0 } ],
  "notRun": [] }
```

**A rule that does not run is recorded, with a reason.** `status` is
`pass | fail | advisory | error | skipped`. `error` fails the gate — a rule that crashes must
never read as clean. This is the G10 defect, and it is designed out here rather than repeated.

`mode` is `blocking | report-only`, and `report-only` always carries the `pin` object that
explains why, plus the pin's remaining life. A report-only run is never silent.

### 7.5 Findings, triage, and the ledger

LabelHunter findings **do not go through triage.** Triage exists to judge an external
reviewer's claims. A LabelHunter finding is not a claim — it is a deterministic violation of
an invariant this repository has already ratified. The disposition is: fix it, or exempt it
with a written reason at the site.

They **do** enter the ledger, so the corpus stays complete and §9's metrics are computable:

```bash
node scripts/factory/review-ledger.mjs record --ticket TRO-<n> --source labelhunter \
  --severity major --category <mechanism> --file <path> --disposition fixed --summary "..."
```

`--source labelhunter` is a new source value beside `cli`, `pr`, `github`, `self`.

### 7.6 Escape hatch

```js
// factory-allow: weak-numeric-predicate — internal counter, range-checked at line 30
```

Counted per rule in `labelhunter.json` and printed by `gate.sh`. Unlike widening
`factory/quarantine.json`, each use names its rule and its reason at the site. **A rising
allowlist count is the primary miscalibration signal** and is reviewed at every wave boundary.

### 7.7 Scorecard

```json
{"ticket":"TRO-520","attempt":1,"verdict":"fail",
 "failedGates":["labelhunter"],
 "lhIntroduced":{"weak-numeric-predicate":1},
 "lhPreExisting":{"weak-numeric-predicate":9},
 "lhAdvisory":{"unbounded-resource.C":2},
 "lhExempted":0,
 "lhReportOnly":{"weak-numeric-predicate":{"reason":"pin","wavesRemaining":1}},
 "lhRuleVersions":{"weak-numeric-predicate":1}}
```

Rule versions are written per attempt. A replay result is comparable only within one version.

---

## 8. Advisory findings must be observable — a hard precondition

Revision 1 proposed an advisory sub-check without saying where its output would surface. That
repeats the G10 defect this whole document exists to answer: **an advisory signal that nothing
downstream reads is indistinguishable from no signal at all.**

Verified this session: `gate.sh:307` makes G10 `pass/warn/skip only, NEVER fail`;
`record()` at `gate.sh:123` sets `OVERALL=fail` only on `fail`; and `status.mjs:44` filters to
`status === 'fail'`. A warn therefore reaches nothing a human or an agent ever reads.

**Therefore: no LabelHunter sub-check may ship advisory until all three exist.**

1. `lhAdvisory` **and `lhReportOnly`** counts written per attempt in
   `factory/scorecard.jsonl` (§7.7).
2. `status.mjs` surfaces non-`fail` LabelHunter results on the status board — a one-line change
   to its filter, plus a column.
3. `review-ledger.mjs report` counts advisory findings by rule, so an advisory rule that is
   firing constantly is visible at the wave boundary.

The same requirement covers a rule running `report-only` under an activation pin (§7.2.1). A
pinned rule is non-blocking, so its findings and the pin's remaining life must both be
visible. A pin that nobody can see is a permanent exemption wearing a transition's name.

Until that plumbing lands, **LH-R2 sub-rule C and LH-R4 sub-rule V2 are not implemented at
all.** Not implemented-as-advisory. Not implemented. The blocking sub-rules ship without them,
and the slice is still worth shipping.

This is a deliberate constraint on our own design, derived from a defect we measured in our
own gate.

---

## 9. Activation lifecycle — replay before blocking

**No rule becomes blocking because it sounds plausible.** Every rule walks this path, and the
gate refuses to enforce a rule that has not.

```
proposed → replayed → calibrated → observable → blocking
```

### 9.1 Replay

`scripts/factory/labelhunter/replay.mjs`:

1. Read `factory/review-findings.jsonl`.
2. Select the rule's declared `replayCorpus` — specific ledger row ids, not a category.
3. For each, resolve the fixing commit and check out its **parent**.
4. Run the rule against that tree, scoped to the files the fixing commit touched.
5. Record hit or miss per corpus entry.

Output: `factory/labelhunter/replay/<ruleId>.v<version>.json`, committed. It is evidence, and
it expires when the version bumps.

### 9.2 Calibration

Run the rule against current `main`. Every fire not in the replay corpus is an **incidental
fire** and is adjudicated by hand into one of:

- **true positive** — a real defect the corpus never happened to catch. Good; file a ticket.
- **exemptible** — a legitimate pattern. Encode it as a rule exemption, never as an allowlist
  entry. An exemption in the rule helps every future site; an allowlist entry helps one.
- **false positive** — the algorithm is wrong. Fix the rule and re-replay.

### 9.3 Ship criteria

| Criterion | Threshold |
|---|---|
| Historical replay recall | ≥ the rule's stated expectation (§6) |
| Incidental fires on `main` | ≤ the rule's stated ceiling, each adjudicated |
| Precision on adjudicated fires | ≥ 80% true-positive or exemptible |
| Regression tests | red, green, and exemption fixture all present and passing |
| Observability | §8 satisfied, if any sub-rule is advisory |

A rule failing any criterion stays at `advisory`, or unbuilt. This mirrors the discipline the
factory already applies to `gate.sh` itself: the gate was negative-tested with a forged
break-one/fix-one before it was trusted.

### 9.4 The blocking transition stamps the pin

The `observable → blocking` transition is the single point where `activatedAt` is written.

1. Every §9.3 criterion passes.
2. The rule's `severity` is set to `fail`.
3. **`activatedAt` is stamped with the SHA of the commit that lands that change**, and
   `pinExpiresAfterMainCommits` is set.
4. The activation pin (§7.2.1) then governs which branches the rule blocks, without further
   intervention.

The pin therefore belongs to the lifecycle's last step, not beside it. A rule at `proposed`,
`replayed`, `calibrated`, or `observable` has `activatedAt: null` and needs no pin, because a
non-blocking rule cannot retroactively block anything. **Bumping a rule's `version` returns it
to `replayed`** — the replay evidence expired with the version (§9.1) — and its eventual
re-activation stamps a new `activatedAt`, opening exactly one fresh bounded transition.

---

## 10. Evaluation metrics

The goal is **not** fewer CodeRabbit comments. The goal is **fewer known recurring defects
escaping the factory's own gates.**

### 10.1 The metric set

| # | Metric | Definition | Target |
|---|---|---|---|
| 1 | **`lh_dependency`** | CR findings in claimed mechanisms ÷ all CR findings | falls |
| 2 | **CR residual finding rate** | CR findings per PR *not* in any claimed mechanism | **holds steady** |
| 3 | **First-pass escaped recurring-defect rate** | Claimed-mechanism defects that reach PR review at all, per PR | falls toward 0 |
| 4 | **LabelHunter findings by rule** | Introduced violations per rule per wave | rises, then falls |
| 5 | **CR findings attributable to claimed mechanisms** | The absolute numerator of #1 | falls |

Metric 3 is the real target. A claimed-mechanism defect reaching CodeRabbit means G11 was
supposed to catch it and did not — either the rule missed, or the rule is not yet built for
that shape. It is the direct measure of the thing this document promises.

Metric 4 rising then falling is the expected healthy shape: rules start firing on real
defects, then agents stop producing them because the gate is deterministic and immediate.

### 10.2 Protection against the G10 coverage-loss inversion

**The failure mode this metric set is built to expose:** total findings fall, `lh_dependency`
is flat, and everyone congratulates themselves. That is not improvement. That is CodeRabbit
having been unavailable — precisely the inversion measured in G10, where a rate-limited run
and a clean run are indistinguishable downstream.

**This has already happened, twice, and the data cannot show it.** Observed in
`factory/scorecard.jsonl` on 2026-08-12:

| Ticket | PR | Verdict | `crFindings` | What the `note` says |
|---|---|---|---|---|
| TRO-535 | #40 | pass | **0** | *"CodeRabbit hit an org spend cap on both the agent's and my own review pass — zero findings to triage on either side"* |
| TRO-538 | #42 | pass | **0** | *"no review capture succeeded on either the agent's or my own pass"* |

Both merged. Both carry `crFindings: 0`, which is structurally identical to a clean review.
The only record that review never ran is free-text prose in `note`, which no aggregation
reads. Two of the 62 scorecard rows are affected — **3% of the corpus is silently
review-free**, and any metric computed today averages them in as clean.

This is not a hypothetical drawn from a stubbed test. It is measured, it is recent, and it is
the reason the guards below are structural rather than advisory.

Three guards:

1. **Metric 2 is the control.** Residual findings — the ones LabelHunter never claimed — must
   hold roughly steady. If metric 5 falls while metric 2 *also* falls, review coverage
   dropped; nothing improved. **Metric 2 falling is an alarm, not a success.**
2. **A wave is only admissible if review actually ran.** Waves where G10's status is unknown
   are excluded from the denominator and flagged in the report, never silently averaged in.
3. **This creates a hard dependency.** Guard 2 requires G10 to distinguish *review absent*
   from *review clean* — which it currently cannot (§8). **Until that is fixed, every metric
   here carries a known confound, and the report must say so on its face.**

That dependency is stated rather than hidden. It is a small change to `gate.sh` and
`status.mjs`, and it is a precondition for believing any number in this section.

---

## 11. What NOT to build

This section is the point of the document. An unopinionated spec produces nine mediocre rules.

**Never build a rule named `correctness`, `test-coverage`, or `boundary-validation`.**
They are review vocabulary. A check by that name would either match nothing or match
everything.

**Do not build a prose-style rule from sentence length.** Measured: 0 of 5,939 sentences in
`CHANGES.md` exceed 25 words. The discipline already holds. The real defects — nested
parentheticals, multi-claim sentences — need a different detector, and `prose-style` findings
are `trivial`/`minor` severity. **63 findings, and still not worth a blocking check.** Volume
is not severity.

**Do not build a rule for `false-positive-review` (15 findings) or `access-control` (4).**
Both have a **0% keep rate**. Every one was correctly dismissed. A check here would automate
noise.

**Do not build a static rule for M4, canonicalisation.** See §12 — it is slice 2, as tests.

**Do not build M11, over-broad catch.** *"treated any error as a missing-file 404"* requires
knowing which errors are distinguishable and which distinction matters. That is judgment.
Leave it with CodeRabbit.

**Do not build a discriminated-union rule (M10) in slice 1.** Standing rule 19 already covers
it, the recurrence is 4 across many months, and a lint rule for "these optional fields should
be a union" is the highest-false-positive idea in this document.

**Do not add a rule because the ledger crossed 3.** The threshold opens the question. It does
not answer it. The answer is §9's ship criteria, and "leave it to CodeRabbit" is a legitimate
outcome — as it is for M9 and M11.

---

## 12. Slice 2 — M4 canonicalisation, as property tests

Slice 2 is **M4**, and it is deliberately not another easy mechanical check.

M4 is the largest correctness cluster (~14 retained findings, 85% keep) and the worst fit for
static pattern matching. Percent versus proof, millilitres versus litres, NFC versus NFKC,
case-folded versus case-preserving — none of these is a syntax. Each is a comparison performed
before both operands were mapped to one canonical form.

The form it takes is a **property obligation** over the comparators:

```
∀ (a, b) : compare(a, b) ≡ compare(canonical(a), canonical(b))
∀ a      : canonical(canonical(a)) ≡ canonical(a)          // idempotence
```

Generated inputs across the real unit and scale space: `%`/proof, `mL`/`L`/`oz`, NFC/NFD,
mixed case, zero, and the boundary values the corpus already names.

Choosing M4 over the small AST mechanisms (M2, M12) is deliberate. M2 and M12 are cheaper and
would grow the rule count faster, but they are ~11 findings between them against M4's ~14,
and M4's findings sit in the verdict path — the part of this product that must be right.
**Slice 2 optimises for defect value, not for another mechanical rule.**

---

## 13. What this does not do

- It does not replace CodeRabbit. ~92 findings — 19% of the full ledger — are novel one-off
  `correctness` with no recurring mechanism, and they stay external.
- It does not catch the M4 canonicalisation class. That is slice 2.
- It does not fix G10's silent-absence defect — but §10.2 shows the metrics depend on it.
- It does not reduce the total number of findings, and must not be judged on that.

---

## 14. Open questions and insufficient evidence

**Decisions for Troy.**

1. **The name.** LabelHunter collides with the product. Rename before any file exists?
2. **Slice scope, given §8.** LH-R2/C and LH-R4/V2 are now *unbuilt* rather than advisory.
   Build the §8 observability plumbing inside this slice, or ship four-and-a-half rules and
   defer it?

**Where the evidence is currently insufficient — stated rather than papered over.**

3. **LH-R4 sub-rules V1 and V2 have no measured backlog.** 107 test files were never scanned
   for zero-assertion or conditional-only-assertion bodies. Revision 1 asserted a severity for
   V1 without this number. **Measuring it is the first implementation task**, and V1's severity
   is provisional until then.
4. **Every prevalence figure in §3 and §6 is hand-clustered.** They are one reader's judgment
   over 274 findings, not a machine count. They are adequate for *prioritisation* and
   inadequate as *evidence a rule works*. Only §9's replay recall is evidence.
5. **The M1 domain registry does not exist yet.** LH-R1's quality is almost entirely the
   registry's quality, not the AST walk's. A thin or wrong registry produces a rule that looks
   sophisticated and catches little. This is the single largest implementation risk in the
   slice.
6. **Intra-procedural analysis will miss real violations** in all of R1, R3, and R4 wherever a
   value crosses a function boundary. Recall targets are set at 50–60% for exactly this reason.
   Raising them requires inter-procedural analysis, which is out of scope and should stay out.
7. **No rule has been replayed.** Every recall column in §6.1 reads *not yet measured*. Until
   §9 runs, this document is a design, not a validated one — and nothing in it should be
   described as working.
