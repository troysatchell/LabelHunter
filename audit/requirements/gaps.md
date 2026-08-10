# Requirements gaps — LabelHunter (2026-08-10, commit 0cdc0c5, dirty)

Baseline sweep taken right after CP-1 cleared, before Wave 1 started. Every MISSING/PARTIAL
row below already has a Linear ticket in `factory/tickets.md`'s wave plan except TH-R5. This
file is the input to the factory's normal dispatch order (unblocks-others, then priority) —
it does not by itself mean anything is off-track.

## Unticketed requirements

### TH-R5 — IMPLEMENTED-UNVERIFIED (unticketed)
- **Quote:** "For this prototype, we're not looking to integrate with COLA directly—that's a whole different beast with its own authorization requirements. Think of this as a standalone proof-of-concept that could potentially inform future procurement decisions."
- **Source:** source-TH.md, L20 (Marcus Williams interview)
- **Meaning in code:** Standalone app; no COLA/registry integration; application data is entered or uploaded directly into this tool.
- **What is missing:** Nothing in code — architecture inspection (grep for "COLA" across src/ and docs/PRD.md) finds no integration, and `docs/PRD.md:46` states the scope constraint explicitly. What's missing is a Linear ticket: no ticket in project LabelHunter cites TH-R5, so there is currently no tracker record of this requirement, only this audit.
- **Suggested scope:** No code change needed. Optional: add a one-line note to an existing ticket's DoD (LH-002 database schema, or the LH-065 sweep-and-fix ticket itself) so the tracker is self-documenting too.

## Missing requirements (ticketed, not yet built)

The following are MISSING and already ticketed — listed here for completeness, not as new
scope decisions. Full evidence and suggested_scope for each is in `matrix.baseline.json`.

| ID | Short | Tickets | Missing part |
|---|---|---|---|
| TH-R1 | Core loop | TRO-461, TRO-464, TRO-465 | Extractor, router, verify screen — all Wave 1, unblocked by CP-1 |
| TH-R2 | 5s latency | TRO-462, TRO-471 | No pipeline exists yet to measure |
| TH-R3 | UX benchmark | TRO-465, TRO-466, TRO-475, TRO-480 | No primary flow built yet to walk through |
| TH-R7 | Network-constraint doc | TRO-498, TRO-478, TRO-485 | No doc names every outbound dependency + degradation behavior yet |
| TH-R8 | Lenient matching | TRO-462, TRO-463 | Comparators not built; golden-set case-14 (STONE'S THROW) is ready and waiting |
| TH-R9 | Warning exact-compare | TRO-468, TRO-469 | Gated by CP-2, not yet run |
| TH-R10 | Imperfect-image handling | TRO-497, TRO-460, TRO-477 | Preprocessing + degradation pass not built |
| TH-R11 | Five sample fields | TRO-461, TRO-463 | Ground truth ready (golden-set case-01); extraction pipeline not built |
| TH-R14 | README | TRO-484 | File does not exist |
| TH-R15 | Approach doc | TRO-485 | File does not exist; docs/PRD.md is the internal spec, not this deliverable |
| TH-R16 | Deployed URL | TRO-481, TRO-483 | No render.yaml, not deployed |
| TH-R17 | Rubric: core works | TRO-499, TRO-470, TRO-486 | Rolls up TH-R1 + TH-R11, both MISSING |
| TH-R20 | Rubric: error handling | TRO-465, TRO-466, TRO-473, TRO-475, TRO-478, TRO-479 | No UI or error-state code yet |
| TH-R22 | Rubric: differentiator | TRO-464, TRO-476 | review_queue table exists; not surfaced or called out yet |

## Partial requirements (ticketed, partly built)

| ID | Short | Tickets | What's done | What's missing |
|---|---|---|---|---|
| TH-R4 | Batch mode | TRO-473, TRO-474, TRO-475 | batchJobs schema + bounded counters | Upload, queue, worker pool, progress UI — gated by CP-3 |
| TH-R6 | No PII / secrets | TRO-457, TRO-482, TRO-484 | Data model confirmed clean; .env.local gitignored | README data-handling statement; no dedicated secret scan run this sweep |
| TH-R12 | Golden test images | TRO-458, TRO-497, TRO-498, TRO-499, TRO-469, TRO-479 | 29-case ground truth + spec schema, well-tested | Zero actual image files exist (golden-set/images/ is empty) |
| TH-R19 | Tech choices defended | TRO-456, TRO-462, TRO-470 | Cascade design + decision log in docs/PRD.md | Evaluator-facing approach.md doesn't exist; measured cascade-vs-Sonnet benchmark not run |
| TH-R21 | Traceability | TRO-486 | This sweep is running (LH-065's first half) | Gap-to-ticket conversion and fixes — Troy's call, this file is the input |
| TH-R23 | Prioritize + trade-offs doc | TRO-485 | Wave plan honors core-before-ambition procedurally | Written trade-offs/limitations section doesn't exist yet |

## Orphan tickets

- TRO-459 "LH-CP1 · CHECKPOINT 1: cascade router + prompts walkthrough" — PRD §10 process checkpoint, not cited to a specific TH-R quote. Done, cleared 2026-08-10.
- TRO-467 "LH-CP2 · CHECKPOINT 2: warning subsystem walkthrough" — same category, still Backlog.
- TRO-472 "LH-CP3 · CHECKPOINT 3: batch queue walkthrough" — same category, still Backlog.
- TRO-487 "LH-070 · Final submission gate" — Troy-only final gate, same category.
