# Requirements gaps — LabelHunter (2026-08-14T01:58Z, commit ea9a6d0)

Final-sweep gaps file (label `2026-08-13-final`). Two open rows, no MISSING rows.

## Unticketed requirements

### TH-R2 — PARTIAL (no open ticket tracks the remaining work)
- **Quote:** "If we can't get results back in about 5 seconds, nobody's going to use it. We learned that the hard way."
- **Source:** source-TH.md, L11 (Sarah Chen interview)
- **Meaning in code:** Single-label verification completes in ~5 seconds wall-clock from submission to rendered result.
- **What is missing:** A measurement of the pipeline as it now ships. The committed
  measurement is green (p50 3618ms, 20/20 PASS, measured 2026-08-13T19:43Z) but four merged
  changes touch the measured path after it: TRO-533's bold measurement, TRO-581's reconcile
  change, TRO-580's spend settling, TRO-583's OCR retry (whose own header names TH-R2).
  Under INT-002, a stale artifact never supports VERIFIED. `docs/approach.md:253` quotes
  the stale figure as current.
- **Suggested scope:** One `pnpm latency:check -- --url=https://labelhunter-web.onrender.com`
  run (~20 Haiku calls, a few cents) once Render shows the intended submission commit live;
  write a dated artifact per TRO-559's convention and refresh the number in
  `docs/approach.md`. Smallest honest close available; fits inside TRO-487's checklist
  rather than needing a new ticket.

## Ticketed requirements still open

### TH-R9 — PARTIAL (TRO-569 Urgent In Progress; TRO-528 In Progress)
- **Quote:** "the warning statement check is actually trickier than it sounds. It has to be exact. Like, word-for-word, and the 'GOVERNMENT WARNING:' part has to be in all caps and bold."
- **Source:** source-TH.md, L33 (Jenny Park interview)
- **Meaning in code:** Warning verified word-for-word; all-caps checked; bold checked with a
  verdict consequence (INT-005 struck the documentation escape).
- **What is missing:** Only the verdict consequence. Bold is now measured from the image's
  pixels (TRO-532), persisted and displayed as an advisory (TRO-533), and honestly
  documented in both graded deliverables — but `src/server/warning/index.ts:323` states the
  boundary: "nothing may fold it back into a verdict." A non-bold prefix still passes.
- **Suggested scope:** Ships when TRO-569+528 ships (branch
  `feat/tro-569-528-bold-review-routing`: warning MATCH + measured not-bold ->
  NEEDS_REVIEW, never FAIL). At sweep close the owning session reported implementation
  complete with its live re-baseline running and merge expected ahead of TRO-487; an
  independent peer check confirmed active recent commits but **no PR open yet**. Re-verify
  behaviorally against main on merge — do not close on either account.

## Orphan tickets

Eight tickets map to no TH requirement; all are factory process tooling (gate mechanics,
worktree provisioning, review-capture trust, changelog style) — deliberate meta-work, not
scope drift:

- TRO-508 "Build mechanical gate checks for 9 recurring review-finding categories" (In Progress)
- TRO-523 "CHANGES.md: ASD-STE100 sentence-length pass on the TRO-479 entry"
- TRO-548 "gate.sh review step re-reviews the whole branch every run"
- TRO-553 "G6 rejects every docs-only and test-only ticket"
- TRO-554 "Defect-gates engine hardening backlog"
- TRO-557 "worktree.sh: stamp the provisioning session"
- TRO-560 "Gate's review step silently reuses the previous run's findings"
- TRO-572 "worktree.sh: no lock against two truly concurrent invocations"
