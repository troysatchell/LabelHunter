# Requirements gaps — LabelHunter (2026-08-11, commit 9b34ced, clean)

Compare sweep (`status-2026-08-11`) after Wave 1's engine room landed (LH-010/011/012 Done).
Seven rows upgraded MISSING → PARTIAL since baseline; zero downgrades. Every gap below has a
Linear ticket except TH-R5. The two structural blockers are human checkpoints, not code:
**CP-2 (TRO-467) gates TH-R9** and **CP-3 (TRO-472) gates all of Wave 3 / TH-R4** — every
code prerequisite for both is already Done.

## Unticketed requirements

### TH-R5 — IMPLEMENTED-UNVERIFIED (unticketed)
- **Quote:** "For this prototype, we're not looking to integrate with COLA directly—that's a whole different beast with its own authorization requirements. Think of this as a standalone proof-of-concept that could potentially inform future procurement decisions."
- **Source:** source-TH.md, L20 (Marcus Williams interview)
- **Meaning in code:** Standalone app; no COLA/registry integration; application data is entered or uploaded directly into this tool.
- **What is missing:** Nothing in code — `grep -rn COLA src/` re-confirmed empty this sweep, and `docs/PRD.md:46` states the constraint. Missing is only the tracker record: no LabelHunter ticket cites TH-R5.
- **Suggested scope:** No code change needed. Optional: one-line DoD note on LH-065 (TRO-486) so the tracker is self-documenting.

## Missing requirements (ticketed, not yet built)

Full evidence and suggested_scope per row in `matrix.after-status-2026-08-11.json`.

| ID | Short | Tickets | Missing part / unblock |
|---|---|---|---|
| TH-R2 | 5s latency, measured | TRO-462✅, TRO-471 | Latency harness (LH-031) — needs LH-015; the pipeline it measures now exists |
| TH-R3 | UX benchmark | TRO-465, TRO-466, TRO-475, TRO-480 | Verify screen (LH-015) is the next unblocked step |
| TH-R7 | Network-constraint doc | TRO-478, TRO-485 | approach.md dependency list + degradation behavior; surface grew (@anthropic-ai/sdk is now real) |
| TH-R9 | Warning exact-compare | TRO-468, TRO-469 | **Blocked only by CP-2 (TRO-467)** — LH-012, its other prerequisite, is Done; router already exposes the WarningComparatorResult contract (types.ts:116) |
| TH-R14 | README | TRO-484 | Blocked by LH-060 (deploy) for URL + access code |
| TH-R15 | Approach doc | TRO-485 | Blocked by LH-030/031 (needs measured numbers to cite) |
| TH-R16 | Deployed URL | TRO-481, TRO-483 | LH-060; Anthropic key provisioning is a Troy-only hard stop |

## Partial requirements (ticketed, partly built)

| ID | Short | Tickets | What's done | What's missing |
|---|---|---|---|---|
| TH-R1 ▲ | Core loop | TRO-461✅, TRO-464, TRO-465, TRO-502 | Extractor + router merged, 169 tests between them | Resolver (LH-014), verify screen (LH-015), end-to-end wiring |
| TH-R4 | Batch mode | TRO-473, TRO-474, TRO-475 | batchJobs schema + bounded counters | Everything else — **only CP-3 (TRO-472) blocks the wave now** |
| TH-R6 | No PII / secrets | TRO-457✅, TRO-482, TRO-484 | Clean data model; env hygiene | README posture statement; key protection; secret scan before LH-070 |
| TH-R8 ▲ | Lenient matching | TRO-462✅, TRO-463, TRO-504 | Escalation machinery (REVIEW never silent FAIL) | Real comparators (LH-013, unblocked); STONE'S THROW case still won't match |
| TH-R10 ▲ | Imperfect images | TRO-460✅, TRO-477, TRO-497 | Preprocessing, designed errors, LOW_IMAGE_QUALITY routing | Degraded golden images (LH-004); judgment pass (LH-051) |
| TH-R11 ▲ | Five sample fields | TRO-461✅, TRO-463, TRO-504 | Extractor round-trips OLD TOM ground truth | Comparators + end-to-end; no live extraction against a real image yet |
| TH-R12 | Golden images | TRO-458✅, TRO-497, TRO-498, TRO-499, TRO-469, TRO-479 | 29-case ground truth, tested loader | **Zero image files — oldest fully-unblocked gap (LH-004/005/006 all ready to dispatch)** |
| TH-R17 ▲ | Rubric: core works | TRO-469, TRO-470, TRO-486, TRO-499 | Follows TH-R1/R11 upgrades | Follows their remaining gaps + eval harness (LH-030) |
| TH-R19 | Tech choices defended | TRO-456✅, TRO-462✅, TRO-470 | PRD defense now committed; cascade discipline enforced in code | approach.md; measured cascade-vs-Sonnet benchmark |
| TH-R20 ▲ | UX + error handling | TRO-465, TRO-466, TRO-473, TRO-475, TRO-478, TRO-479 | Error taxonomy + per-row UI reason text | Every user-visible error state (no UI exists) |
| TH-R21 | Traceability | TRO-486 | This sweep; tickets carry TH-R citations | Final LH-065 sweep + gap fixes at submission time |
| TH-R22 ▲ | Differentiator | TRO-457✅, TRO-464, TRO-476 | Cascade/triage logic + review-queue model merged | Review queue UI (LH-050); docs/demo call-out (LH-064) |
| TH-R23 | Core-first + trade-offs doc | TRO-485 | Wave order honors core-first; CHANGES.md logs per-ticket limits | The written trade-offs/limitations section (LH-064) |

▲ = upgraded from MISSING since baseline. ✅ = ticket Done.

## Pre-submission checks this sweep recommends (no ticket DoD names them yet)

For the PM to place — the natural home for all three is a DoD line on LH-065 (TRO-486)
or LH-070 (TRO-487). None is new build work.

1. **Literal fresh-clone walkthrough** (TH-R13, TH-R14): `git clone` to a new directory,
   follow the README start to finish. TH-R13's VERIFIED rests on build/test in the existing
   checkout; a real clone has never been run. Rubric gate G2 expects it.
2. **Repo-wide secret scan** (TH-R6): recommended at baseline and again this sweep; still
   not run. TH-R6's PARTIAL rests on file reads, not a credential-pattern scan.
3. **TH-R5 tracker note** (bookkeeping): one line on LH-065's description citing TH-R5, so
   the no-COLA requirement has a tracker record beyond this audit.

## Orphan tickets

- TRO-459 "LH-CP1 · CHECKPOINT 1 walkthrough" — process checkpoint; Done, cleared 2026-08-10.
- TRO-467 "LH-CP2 · CHECKPOINT 2 walkthrough" — process checkpoint; **schedule this: it is the only blocker for TH-R9's subsystem.**
- TRO-472 "LH-CP3 · CHECKPOINT 3 walkthrough" — process checkpoint; **the only remaining blocker for Wave 3 batch work.**
- TRO-487 "LH-070 · Final submission gate" — Troy-only, by design.
