# Completion Rubric — TTB Label Verification Take-Home

**Judges completion of:** the LabelHunter prototype against `audit/requirements/source-TH.md`
**Requirement IDs:** `audit/requirements/inventory.md` (TH-R1 … TH-R23)
**Structure:** binary **gates** (any failure = not submit-ready, regardless of score) + **100 scored points** across the brief's own six evaluation criteria. Weights follow the brief's stated preference: *"A working core application with clean code is preferred over ambitious but incomplete features."*

---

## Part 1 — Submission gates (pass/fail)

All six must pass before submitting. No partial credit.

| Gate | Check | Requirement | How to verify |
|------|-------|-------------|---------------|
| G1 | Deployed URL loads for an outside evaluator and a single-label verify completes **on the deployed instance** | TH-R16 | Open URL from a non-dev machine/incognito; run one verify end-to-end |
| G2 | Repo accessible; fresh clone builds and runs by following the README alone | TH-R13, TH-R14 | Clean-machine (or clean-dir) walkthrough, no undocumented steps |
| G3 | Core loop works: application data + label image in → per-field match/mismatch verdicts out, covering at least brand name, ABV, government warning | TH-R1 | Submit the OLD TOM example; verdicts render per field |
| G4 | Warning check passes all three canonical vectors: exact statutory text → **pass**; "Government Warning" title-case → **fail**; reworded warning → **fail** | TH-R9 | Run the three vectors (Appendix A). Title-case slipping through is the client's own rejection example — auto-fail |
| G5 | No secrets committed; no PII/sensitive data persisted | TH-R6 | Secret scan on repo; inspect data model/storage |
| G6 | No half-built feature ships ahead of the core: everything reachable in the deployed UI either works or is clearly marked experimental/absent | TH-R23 | Click every visible control on the deployed app |

**Verdict rule:** any gate failed → **NOT SUBMIT-READY**. Fix the gate before spending effort anywhere else.

---

## Part 2 — Scored criteria (100 pts)

Scoring anchors per item: **Full** = evidence exists and check passes as written. **Half** = works but with a material caveat (undocumented, flaky, partial coverage). **Zero** = missing or wrong.

### A. Correctness & completeness of core requirements — 35 pts (TH-R17)

| # | Check | Req | Pts | Evidence |
|---|-------|-----|-----|----------|
| A1 | All five sample-label fields (brand, class/type, alcohol content, net contents, warning) extract and verify end-to-end on the OLD TOM example or equivalent | TH-R11 | 10 | Demo run; per-field results for all five |
| A2 | Judgment matching: `STONE'S THROW` vs `Stone's Throw` → match (or flagged-equivalent), plus case/punctuation/format variants for ABV and net contents (e.g. `45% Alc./Vol.` vs `45%`, `750 mL` vs `750ml`) | TH-R8 | 6 | Test cases in repo, green |
| A3 | Warning subsystem beyond the gate vectors: word-for-word body comparison, all-caps prefix check, bold/formatting either checked or explicitly documented as a limitation. Strict regime coexists with A2's lenient regime by design | TH-R9 | 5 | Tests + docs note on formatting |
| A4 | Batch mode: upload N applications at once → N individual verdicts with progress/summary view; design accounts for the 200–300 scale reference (documented if demo uses smaller N) | TH-R4 | 8 | Batch demo run + capacity note in docs |
| A5 | Standalone: no COLA/external system-of-record integration; application data entered/uploaded directly | TH-R5 | 2 | Architecture inspection |
| A6 | Single-label verify ≤ ~5 s p50 on a realistic image, measured (not asserted), method documented | TH-R2 | 4 | Latency measurement in docs with method |

### B. User experience & error handling — 15 pts (TH-R3, TH-R20, TH-R10)

| # | Check | Req | Pts | Evidence |
|---|-------|-----|-----|----------|
| B1 | "73-year-old benchmark": one obvious primary flow, large controls, no hidden actions; a first-time user completes a verify with zero instructions | TH-R3 | 5 | Heuristic UX walkthrough |
| B2 | Every failure mode has a designed state: bad/oversized image, AI/API failure, timeout, malformed input — useful message, no blank screens or raw stack traces | TH-R20 | 5 | Error-path walkthrough, each mode triggered |
| B3 | Unreadable image → explicit "unreadable / request better image" outcome; the system never returns a confident wrong verdict on garbage input | TH-R10 (baseline half) | 5 | Imperfect-image test set run |

### C. Code quality & organization — 15 pts (TH-R18)

| # | Check | Req | Pts | Evidence |
|---|-------|-----|-----|----------|
| C1 | Lint, typecheck, and test suite all green in CI | TH-R18 | 5 | CI run |
| C2 | Coherent structure: verification logic separated from UI and from AI-provider calls; no dead code or copy-paste sprawl | TH-R18 | 5 | Code review |
| C3 | Tests meaningfully cover the two matching regimes (lenient A2, strict A3) and the core loop — not just smoke tests | TH-R18 | 5 | Test inspection |

### D. Appropriate technical choices — 10 pts (TH-R19, TH-R7)

| # | Check | Req | Pts | Evidence |
|---|-------|-----|-----|----------|
| D1 | Stack sized to a prototype — neither over-engineered nor toy — and each major choice defended in the approach doc | TH-R19 | 5 | Approach doc review |
| D2 | Every outbound dependency named in docs, with behavior when a firewall blocks it (graceful failure, not silent breakage) — the constrained-network lesson from the failed vendor pilot | TH-R7 | 5 | Docs list + simulated block or reasoned failure analysis |

### E. Attention to requirements — 15 pts (TH-R21, TH-R15, TH-R23b)

| # | Check | Req | Pts | Evidence |
|---|-------|-----|-----|----------|
| E1 | Traceability: every TH-R entry is either addressed in code or explicitly descoped in docs — nothing silently dropped | TH-R21 | 7 | Traceability sweep (requirements-audit) |
| E2 | Docs cover approach, tools used, and assumptions made | TH-R15 | 4 | Doc review |
| E3 | Trade-offs & limitations section exists and is honest (names real cuts, not humble-brags) | TH-R23 | 4 | Doc review |

### F. Creative problem-solving — 10 pts (TH-R22, TH-R12)

| # | Check | Req | Pts | Evidence |
|---|-------|-----|-----|----------|
| F1 | At least one well-judged differentiator beyond the literal ask (e.g. confidence-based triage, agent review queue), called out in docs/demo — judged on fit to the compliance workflow, not novelty | TH-R22 | 6 | Docs/demo |
| F2 | Test-label image set ships in the repo (generated or sourced) and is wired into tests or demo instructions | TH-R12 | 4 | Assets present and referenced |

### Bonus — up to +5 (not counted in the 100)

| # | Check | Req | Pts |
|---|-------|-----|-----|
| X1 | Robust handling of genuinely imperfect images — angled, low-light, glare — with correct extraction (beyond B3's graceful failure) | TH-R10 (stretch half) | +5 |

---

## Part 3 — Verdict bands

| Band | Condition | Meaning |
|------|-----------|---------|
| **Submit-ready** | All gates pass **and** score ≥ 85 | Ship it |
| **Close** | All gates pass, score 70–84 | Fix the highest-weight zero/half items first (usually A or E) |
| **Not ready** | Any gate failed, or score < 70 | Gates first, always |

Tie-breaker when prioritizing fixes: gate > A > E > B > C > D > F. (E ranks above B/C because "attention to requirements" is the criterion a requirements-heavy brief most tests, and traceability failures are cheap to fix.)

---

## Appendix A — Canonical test vectors

| Vector | Input | Expected |
|--------|-------|----------|
| V1 | Exact statutory government warning, `GOVERNMENT WARNING:` all-caps | PASS |
| V2 | Same text, `Government Warning:` title-case | FAIL (Jenny's real rejection) |
| V3 | Reworded/paraphrased warning body | FAIL |
| V4 | Warning in notably smaller font / buried (if detectable) | FAIL or flagged; documented limitation acceptable |
| V5 | Label `STONE'S THROW` vs application `Stone's Throw` | MATCH (or flagged-equivalent, never hard rejection) |
| V6 | ABV `45% Alc./Vol. (90 Proof)` vs application `45%` | MATCH |
| V7 | Net contents `750 mL` vs `750ml` | MATCH |
| V8 | Brand genuinely different (`OLD TOM` vs `OLD TOM'S RESERVE`) | MISMATCH |
| V9 | Blurry/unreadable label image | "Unreadable — request better image", not a verdict |
| V10 | Batch of ≥20 mixed pass/fail applications | N individual verdicts + summary; no serialized-one-at-a-time UX |

## Appendix B — Scoring worksheet

| Section | Max | Score |
|---------|-----|-------|
| Gates G1–G6 | pass/fail | |
| A. Correctness & completeness | 35 | |
| B. UX & error handling | 15 | |
| C. Code quality | 15 | |
| D. Technical choices | 10 | |
| E. Attention to requirements | 15 | |
| F. Creative problem-solving | 10 | |
| **Total** | **100** | |
| Bonus X1 | +5 | |
