# Interpretations — governing rulings

A ruling here is binding on every later sweep. It applies silently: a tracer that hits the same
ambiguity reads the ruling and proceeds, and does not ask again. Add a ruling only when a human
answered the question. Never delete one; supersede it with a dated replacement.

---

## INT-001 — TH-R9: what proves "title-case warning must FAIL"

- **Ruled:** 2026-08-12 by Troy.
- **Question:** TH-R9's acceptance names three test cases, two of which must FAIL. Those two run
  against simulated dual-channel text. Only the PASS case runs through a real photograph. On the
  live path a single readable channel returns `NEEDS_REVIEW`, not `MISMATCH`, under CP-2 §4.5's
  rule "we never accuse on one channel". Does comparator-level proof satisfy the requirement?
- **Ruling:** No. At least one FAIL case must run through the real image pipeline.
- **What that means in code:** a test calls `compareGovernmentWarningFromImage` against
  `golden-set/images/case-08-title-case-warning-prefix-only.jpg` and asserts `MISMATCH`. It
  mirrors the existing case-01 test in `src/server/warning/index.test.ts`.
- **Why:** the image is already committed, so the test costs almost nothing. It answers the
  question in code instead of by opinion, and it proves the statutory FAIL path on a real
  photograph rather than on a fixture.
- **Effect:** TH-R9 is PARTIAL until that test lands. It is not ASSUMED — the ambiguity is
  settled, and the bar is simply not met yet.

---

## INT-002 — Live-run artifacts as behavioral evidence

- **Ruled:** 2026-08-12 by Troy.
- **Question:** a sweep may not re-run commands that make billed API calls. Does a committed,
  dated artifact from a real live run count as behavioral evidence for a VERIFIED verdict?
- **Ruling:** Yes, but only when the artifact measures the pipeline that ships.
- **How to apply it:** read the artifact's own scope field and its measurement date. Compare both
  against the code on the sweep commit. An artifact that predates a change to the measured path
  is stale, and a stale artifact never supports VERIFIED.
- **Why:** a dated live run is real evidence, and refusing it would force spend on every sweep.
  Accepting it unconditionally is worse: it would let a row read VERIFIED on a measurement of code
  that no longer exists.
- **Effect on this sweep:**
  - TH-R10 → VERIFIED. `scripts/eval/results/eval-report.json` was measured 2026-08-12T13:26:45Z,
    mode `live`, after the warning comparator reached the route.
  - TH-R2 → stays PARTIAL. `scripts/latency/results/single-label-verify.json` was measured
    2026-08-12T02:17:14Z, about an hour before commit c5e49f8 wired that comparator in. Its own
    `pipelineScope` field records the gap: "No OCR/warning-subsystem comparator."

---

## INT-003 — TH-R23: where a trade-offs section must live

- **Ruled:** 2026-08-12 by Troy.
- **Question:** TH-R23 requires a written trade-offs and limitations section. Real sections exist
  at `docs/deploy.md:84` and `docs/error-states.md:154`. `README.md` and `docs/approach.md` do not
  exist. Do the internal documents satisfy the requirement?
- **Ruling:** No. The section must appear in a graded deliverable.
- **Why:** the brief names the README and the approach document as deliverables. An evaluator opens
  those. Nobody opens `docs/deploy.md`. A requirement met by content the reader never finds is not
  met.
- **Effect:** TH-R23 is PARTIAL. Its prioritization half is satisfied; its written half is not.
  TRO-485 closes it. The same ruling keeps TH-R15 at MISSING.

---

## INT-004 — TH-R7: does "Docs" mean any repo document, or a graded deliverable?

- **Ruled:** 2026-08-13 by Troy.
- **Question:** TH-R7's acceptance says "Docs name every outbound dependency and the
  degradation/failure behavior when it is blocked." That content exists in full at
  `docs/error-states.md:17-37` and `:130-174` — an internal working document. INT-003
  already ruled, for TH-R23, that internal placement does not count because an evaluator
  never opens it. Does that standard extend to TH-R7?
- **Ruling:** Yes. INT-003's standard extends.
- **What that means in code:** the dependency list and degradation behavior must appear in
  a graded deliverable — `README.md` or `docs/approach.md`. TH-R7 is PARTIAL until then.
  The implementation half is unaffected and fully met; only the placement of the prose
  moves. TRO-485 (LH-064) already assigns this content to `docs/approach.md`, so the row
  closes when PR #68 merges.
- **Why:** a requirement satisfied by content the reader never finds is not satisfied.
  Applying the rule to TH-R23 but not TH-R7 would make the audit inconsistent about the
  same question.

## INT-005 — TH-R9: the bold clause is a build obligation, not a documentation one

- **Ruled:** 2026-08-13 by Troy.
- **Question:** TH-R9's `Meaning in code` allowed the bold rule to be satisfied by being
  "explicitly documented as a limitation." Troy asked where that allowance came from.
- **Ruling:** It came from this inventory, not from the brief. **The allowance is struck.**
  The source quote (`source-TH.md:33`) reads "the 'GOVERNMENT WARNING:' part has to be in
  all caps and bold" and grants no documentation escape. The speaker describes rejecting a
  label for getting the caps wrong.
- **What that means in code:** bold must be CHECKED, with a verdict consequence. Today the
  signal is captured and discarded: `src/server/extractor/schema.ts:80` requires a
  `bold: "true"|"false"|"uncertain"` field, `prompt.ts:50` asks the model for it, and
  `response.ts:178` validates it — but no router or comparator reads it, so a correctly
  capitalised, non-bold warning passes. TRO-532 (LH-025, stroke-width bold advisory) and
  TRO-533 (LH-026, surface the bold signal) are both still Todo.
  TH-R9 is **PARTIAL**: word-for-word and all-caps are verified against real photographs;
  bold is captured-not-checked.
- **Why:** an inventory's interpretation field may narrow a requirement into something
  testable, never widen it into something weaker than the source. This allowance had been
  inherited silently by every sweep since extraction.

## INT-006 — TH-R3: does INT-002's staleness rule reach a qualitative UX record?

- **Ruled:** 2026-08-13 by Troy.
- **Question:** TH-R3 leans partly on the dated TRO-480 UX walkthrough. Three user-facing
  changes landed after it — the access-code screen, review-queue paging, and two new error
  states. INT-002 governs staleness for measurement artifacts. Does it reach a qualitative
  review record too?
- **Ruling:** Treat TH-R3 as PARTIAL and backlog a real UX pass. Troy's words: he has not
  reviewed the UX himself, and it matters for accessibility.
- **What that means in code:** the behavioral evidence stands — `pnpm test:e2e` drives the
  full flow in a real browser at this commit, and `VerifyForm.test.tsx` asserts the
  one-button claim at HEAD. What is missing is a human walkthrough of the CURRENT screens,
  including the access-code screen no walkthrough has ever covered, assessed for
  accessibility rather than only for "does it work".
- **Why:** TH-R3's own bar is a 73-year-old first-time user operating it without
  instructions. That is a human judgment about screens as they now stand, and no automated
  suite substitutes for it.
