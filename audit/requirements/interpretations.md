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
