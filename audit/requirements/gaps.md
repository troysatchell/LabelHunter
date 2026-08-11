# Requirements gaps — LabelHunter (2026-08-11, commit cbc7088, clean)

Compare sweep (`2026-08-11-pm`) after PR #15 (LH-016 Detail view) merged, LH-013/014/031 and the
golden-set degradation pass all landed. Nine rows upgraded MISSING/PARTIAL tier since baseline
(TH-R1, R2, R3, R8, R10, R11, R17, R20, R22); zero downgrades. Every gap below has a Linear
ticket except TH-R5. The two structural blockers are still human checkpoints, not code:
**CP-2 (TRO-467, now In Progress) gates TH-R9** and **CP-3 (TRO-472, still Backlog) gates all
of Wave 3 / TH-R4** — every code prerequisite for both remains Done.

**Read this first:** the single highest-value next measurement is a fresh `pnpm latency:check`
run. The only real (non-mocked) live-model evidence in this whole matrix — a 20-run harness
against the golden set's own flagship case — landed on REVIEW/LOW_MODEL_CONFIDENCE every time,
and that run predates the Sonnet resolver's merge (TRO-464). Nobody has yet measured whether
the resolver clears these cases now that it exists. See TH-R2/TH-R11 below.

## Unticketed requirements

### TH-R5 — IMPLEMENTED-UNVERIFIED (unticketed)
- **Quote:** "For this prototype, we're not looking to integrate with COLA directly—that's a whole different beast with its own authorization requirements. Think of this as a standalone proof-of-concept that could potentially inform future procurement decisions."
- **Source:** source-TH.md, L20 (Marcus Williams interview)
- **Meaning in code:** Standalone app; no COLA/registry integration; application data is entered or uploaded directly into this tool.
- **What is missing:** Nothing in code — `grep -rn COLA src/` re-confirmed clean this sweep (one doc comment only), and `docs/PRD.md:46` states the constraint explicitly, naming TH-R5 by ID. Missing is only the tracker record: no LabelHunter ticket cites TH-R5.
- **Suggested scope:** No code change needed. Optional: one-line DoD note on LH-065 (TRO-486) so the tracker is self-documenting.

## Missing requirements (ticketed, not yet built)

Full evidence and suggested_scope per row in `matrix.after-2026-08-11-pm.json`.

| ID | Short | Tickets | Missing part / unblock |
|---|---|---|---|
| TH-R7 | Network-constraint doc | TRO-478, TRO-485 | No section names outbound deps (Anthropic API; Google Gemini, dev-time only) or degradation behavior — the SERVICE error state already exists (TH-R20), only the doc is missing |
| TH-R9 | Warning exact-compare | TRO-468, TRO-469 | **Blocked only by CP-2 (TRO-467, now In Progress, not yet Done)** — router still passes `warningResult: null` on every request (route.ts:166); Detail view's column framing already built to receive it |
| TH-R14 | README | TRO-484 | Still no README.md at repo root — smallest real gap in this matrix |
| TH-R15 | Approach doc | TRO-485 | Still no docs/approach.md — PRD.md:241-242 already outlines its required contents |
| TH-R16 | Deployed URL | TRO-481, TRO-483 | LH-060; Anthropic key provisioning is a Troy-only hard stop |

## Partial requirements (ticketed, partly built)

| ID | Short | Tickets | What's done | What's missing |
|---|---|---|---|---|
| TH-R4 | Batch mode | TRO-473, TRO-474, TRO-475, TRO-472, TRO-506 | batchJobs schema + bounded counters | Everything else — **only CP-3 (TRO-472) blocks the wave now**; TRO-506 (resolver double-pay TOCTOU) is a correctness fix inside this wave's future scope |
| TH-R6 | No PII / secrets | TRO-457✅, TRO-482, TRO-484 | Clean data model; env hygiene; fresh secret-pattern grep clean this sweep | README posture statement; LH-061 key protection (the same access-control gap this session's PR #15 CodeRabbit review correctly deferred rather than patching ad hoc) |
| TH-R10 ▲ | Imperfect images | TRO-460✅, TRO-477, TRO-497✅ | Preprocessing, designed errors, LOW_IMAGE_QUALITY routing, **29 real degraded golden images now committed (0 at last sweep)** | No test yet feeds a degraded image through the full router to prove graceful degradation end to end — images are existence-checked, not behaviorally exercised |
| TH-R11 ▲ | Five sample fields | TRO-461✅, TRO-463✅, TRO-504✅ | Extractor round-trips OLD TOM ground truth (mocked); comparators now real | The one live (non-mocked) extraction run against this exact case never produced a clean pass — see "Read this first" above |
| TH-R12 | Golden images | TRO-458✅, TRO-497✅, TRO-498, TRO-499, TRO-469, TRO-479, TRO-505✅ | **29/29 rendered+degraded images committed** (up from 0), font-determinism fixed (TRO-505) | ~5 AI-generated "wild" labels (LH-005); CI consistency/coverage gate (LH-006) |
| TH-R17 ▲ | Rubric: core works | TRO-469, TRO-470, TRO-486, TRO-499 | Follows TH-R1/R8/R11 upgrades — core single-label loop now VERIFIED | "Completely" stays out of reach while TH-R9 (warning) and TH-R4 (batch) remain open |
| TH-R19 | Tech choices defended | TRO-456✅, TRO-462✅, TRO-470 | PRD.md:33 names each major choice against its requirement ID; prompt.ts:4 shows a checkpoint-reviewed, frozen prompt | approach.md — the dedicated artifact that consolidates these into one place |
| TH-R21 | Traceability | TRO-486 | This sweep; factory/tickets.md carries 38 TH-R citations across 241 lines | Ships incrementally as each row above closes — TRO-486 exists to keep re-running this |
| TH-R23 | Core-first + trade-offs doc | TRO-485 | Prioritization half done — CP-2/CP-3 correctly hold stretch work behind the core loop | The written trade-offs/limitations section (same approach.md gap as TH-R15/TH-R19) |

▲ = upgraded a verdict tier since baseline. ✅ = ticket Done. (TH-R1, TH-R2, TH-R8, TH-R20, TH-R22
also upgraded this sweep but are no longer MISSING/PARTIAL — see `REPORT.md`'s Delta section,
not repeated here since this file's job is the still-open gaps.)

## Pre-submission checks this sweep recommends (no ticket DoD names them yet)

For the PM to place — the natural home for all of these is a DoD line on LH-065 (TRO-486) or
LH-070 (TRO-487). None is new build work.

1. **Fresh `pnpm latency:check` run** (TH-R2, TH-R11) — highest priority of the three. The
   existing measurement predates the Sonnet resolver's merge and every one of its 20 real runs
   needed review. A fresh run is cheap (real API cost, ~20 calls) and would replace uncertainty
   with either a confirmed clean pass or a concrete calibration bug to fix.
2. **Repo-wide secret scan with a dedicated tool** (TH-R6): recommended at baseline and every
   sweep since; still only a manual grep pattern, never a scanner tool's output.
3. **TH-R5 tracker note** (bookkeeping): one line on LH-065's description citing TH-R5, so the
   no-COLA requirement has a tracker record beyond this audit.
4. **Wire a degraded golden image through the router in a real test** (TH-R10): the 29 images
   exist and are existence-checked; none is yet asserted against `isLowImageQuality` end to end.

## Orphan tickets

- TRO-459 "LH-CP1 · CHECKPOINT 1 walkthrough" — process checkpoint; Done, cleared 2026-08-10.
- TRO-467 "LH-CP2 · CHECKPOINT 2 walkthrough" — process checkpoint; **moved Backlog → In Progress since this morning; still the only blocker for TH-R9's subsystem.**
- TRO-472 "LH-CP3 · CHECKPOINT 3 walkthrough" — process checkpoint; unchanged; **the only remaining blocker for Wave 3 batch work.**
- TRO-487 "LH-070 · Final submission gate" — Troy-only, by design.
