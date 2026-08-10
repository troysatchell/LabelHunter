# PRD Brainstorm Worksheet — TTB Label Verification Take-Home

Seeded by `audit/requirements/inventory.md` (TH-R1..R23). Each question cites the
requirement(s) it exists to pin down. Answers get folded into the PRD; unanswered
items become explicit assumptions in the PRD's Assumptions section (TH-R15 requires
documenting them anyway).

## A. Stakes, framing, scope

- **A1. What is this, really?** Real interview take-home with a submission deadline?
  Gauntlet exercise? Practice? → sets pacing, checkpoint density, and how much of the
  build Troy must personally defend. (Drives HUMAN CHECKPOINT placement.)
- **A2. Deadline.** Exact date/time the deliverables are due. Factory pacing and scope
  tiers hang off this.
- **A3. Scope tiers.** Committed core vs stretch. Candidates for stretch: imperfect-image
  handling (TH-R10, speaker said "maybe out of scope"), bold-detection on the warning
  (TH-R9), beverage-type-specific rules (TH-R11 note), history/persistence. The brief
  itself orders this: working core > ambitious incomplete (TH-R23).
- **A4. Product name.** Repo folder is `label-verify` (renamable). Does it get a real name?
- **A5. The "creative problem-solving" differentiator (TH-R22).** What's the one idea
  beyond the literal ask? Candidates: confidence-based triage queue (auto-pass high
  confidence, human-review the rest — mirrors Sarah's "drowning in routine" complaint),
  annotated label image overlays, per-agent review queue.

## B. Architecture & stack

- **B1. Stack.** Full-stack TypeScript (Next.js) vs Python backend (FastAPI) + React
  front. Considerations: Troy's TS fluency, single-deploy simplicity, eval-friendliness
  ("appropriate technical choices" TH-R19).
- **B2. AI pipeline shape** (the biggest decision, TH-R1/R8/R9):
  1. Vision LLM extracts structured fields → **deterministic + fuzzy comparison in code**
     (testable, explainable, cheap to iterate);
  2. Vision LLM does extract+compare in one call (fastest to build, least explainable);
  3. OCR (Tesseract et al.) + text LLM (no vision dependency, worse on stylized labels).
- **B3. Model + vendor.** Which vision model? Latency budget per call (TH-R2's 5s). One
  vendor endpoint also answers TH-R7 (constrained network: single well-known domain,
  documented degradation).
- **B4. Persistence.** None (ephemeral) vs SQLite vs hosted Postgres. Batch jobs (TH-R4)
  and a review queue push toward a real DB; TH-R6 says keep it unsensitive either way.
- **B5. Batch mechanics (TH-R4).** How do 200–300 label+application pairs arrive
  (CSV manifest + zip of images? multi-file drop?), how are they paired, queued,
  rate-limited, and how does progress surface (polling vs SSE)?
- **B6. Deployment target (TH-R16).** Vercel / Render / Railway / Fly. Troy has Render
  experience (PlugForge).
- **B7. Cost ceiling.** LLM spend cap for build + graders hammering the deployed URL.

## C. Verification logic (domain)

- **C1. Field set.** The five example fields only (TH-R11), or also bottler name/address
  + country of origin? Beverage-type awareness (wine/beer ABV exceptions)?
- **C2. Verdict vocabulary.** Binary match/mismatch, or three-state
  (match / mismatch / needs-human-review) with confidence? Dave's STONE'S THROW case
  (TH-R8) argues for three-state.
- **C3. Warning statement source of truth (TH-R9).** Pin the exact statutory text
  (27 CFR 16.21). How far to push formatting checks: caps = yes; bold = attempt via
  vision judgment or document as limitation?
- **C4. Application data entry (TH-R1/R5).** Manual form (single) + structured upload
  (batch)? What schema?

## D. UX & design

- **D1. Core flow shape (TH-R3).** One screen: upload image + enter fields → big verdict
  panel? Jenny's printed checklist is a ready-made UI metaphor — digital checklist with
  per-field ✓/✗/⚠.
- **D2. Results presentation.** Side-by-side (label image + extracted fields + application
  values) with per-field verdicts? Annotate the image itself?
- **D3. Aesthetic.** Government-trustworthy clean (USWDS-ish) vs modern minimal. Large
  type and obvious buttons regardless (half the team is over 50, TH-R3).
- **D4. Error states inventory (TH-R20).** Unreadable image, API down/blocked, timeout,
  oversized file, malformed batch manifest, partial batch failure — each needs a
  designed state, not a toast.

## E. Testing, evals, evidence

- **E1. Test label set (TH-R12).** How many, staged how? Needs at minimum: clean match,
  ABV mismatch, title-case warning (Jenny's real catch), STONE'S THROW-style
  case-difference, missing warning, glare/angle shots (stretch). AI image gen per brief.
- **E2. Test strategy.** TDD for comparison logic (pure functions — cheap wins); what
  E2E coverage; latency benchmark harness proving TH-R2's ≤5s claim with captured output.
- **E3. Accuracy eval.** Golden set with ground truth; measure extraction accuracy;
  where does the eval live so the factory gate can run it?

## F. Factory process & handoff

- **F1. Factory choice.** build-factory in the new repo (evidence gate + worktrees + board)
  vs tdd-loop vs plain ticket decomposition. What ran well/poorly in ShipShape/PlugForge
  weeks that should carry over or change?
- **F2. HUMAN CHECKPOINTS.** Which areas does Troy want to personally learn/defend
  (interview risk)? Those become blocking notify-and-wait checkpoint tickets — explicit,
  unskippable, per standing preference. Candidates: vision-prompt design, batch queue
  architecture, deployment.
- **F3. Ticket tracker.** Linear team/project for this build? (Config stub at
  audit/requirements.config.yaml has tickets TBD; scope check must run before mapping.)
- **F4. Verification gate.** Proposal: requirements-audit baseline sweep IS the factory's
  definition of done — every TH-R entry VERIFIED/N-A-with-reason before the factory
  stops. Agree?
- **F5. Autonomy envelope.** Overnight runs allowed? Auto-merge policy? What must never
  happen without Troy (deploy? spend above cap? README claims?).

## Standing assumptions to confirm

- The thin "Technical Requirements" section is intentional; requirements ARE the
  interviews + deliverables + rubric. We fill gaps independently and document
  assumptions rather than emailing clarification questions (the brief permits both).
- No demo video required — deliverables are repo, README, approach doc, deployed URL only.
- Inventory (audit/requirements/inventory.md) needs Troy's skim — his edits are
  authoritative over the extraction from then on.
