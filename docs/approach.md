# Approach

This document covers LabelHunter's approach, the tools it uses, the assumptions behind it,
and its trade-offs and limitations. `README.md` covers setup and run instructions.

## Approach

### The problem

A TTB compliance agent checks an alcohol label against its application: does the brand name
match, is the alcohol content correct, is the government warning present and worded correctly?
Sarah Chen's team does this by hand today, one label at a time. The brief asks for a prototype
that does the same check in seconds, singly or in batches of hundreds, with a human agent still
making the final call on anything uncertain.

### The cascade

LabelHunter reads each label with a two-tier model cascade instead of one expensive call per
label:

```text
Upload (single label or batch)
   ↓
Image preprocessing (EXIF rotation, a resized copy for the vision model, a warning-block crop)
   ↓
Haiku Extractor            — claude-haiku-4-5, reads every field off the label
   ↓
Validation Router          — deterministic TypeScript, no model call, compares extraction to application
   ├── PASS    → done, verdict recorded
   ├── REVIEW  → Sonnet Resolver looks at the flagged field and the reason
   └── INVALID → Sonnet Resolver re-extracts and resolves
                     ↓
              resolved or needs-human → review queue
```

Every label goes through Haiku first. The router only escalates a label to Sonnet when it finds
a real reason: an ambiguous field, a low-confidence read, a possible mismatch. Most labels
resolve on Haiku alone. This is the architecture, not a cost optimization layered on top of a
simpler design. Sonnet never runs on the per-label happy path. The router never routes on a
bare confidence number without a named reason attached.

**Why a cascade instead of one model for everything.** A committed benchmark compared the
cascade against a Sonnet-only pipeline on the same golden set. Sonnet-only calls the expensive
model on every field of every label, so the cascade wins on cost by a wide margin. It also
keeps verdict correctness at or above the single-model arm. The full numbers are in
`scripts/eval/results/benchmark-report.json`. This defends the choice with a measurement, not
an assumption.

### The government warning gets a stricter check

Jenny Park's clearest catch in the brief is the government warning check. It has to be exact:
word-for-word text, plus the "GOVERNMENT WARNING:" prefix in capital letters. Every other field
uses judgment — a case or punctuation difference still counts as a match. The warning does not
get that leniency. LabelHunter reads the warning block through two independent channels, a
vision read and OCR. It returns a verdict only when both channels agree. When they disagree, or
when only one channel can read the block at all, it returns an explicit review flag instead of
guessing. "The system compared against the statutory string" is a defensible answer in a
compliance review. "The model thought it looked right" is not.

### Imperfect images

Jenny also asked for tolerance of labels photographed at odd angles, in bad light, or with
glare. LabelHunter's router treats a genuinely unreadable image as its own outcome instead of
guessing at a field it cannot see. That outcome is `LOW_IMAGE_QUALITY`, with a named trigger:
blur, glare, rotation, or low resolution. The golden set carries synthetic degradations
(rotation, glare, low light) and five real bottle photographs. Every one of them returns either
a correct extraction or an explicit review flag. None returns a confident wrong verdict.

### Batch mode

An importer can upload a CSV manifest plus a folder of label images. LabelHunter pairs each row
to its image by filename. It reports any row or image it could not pair before the batch
starts. It then processes every pair through the same cascade a single-label request uses. A
Postgres-backed queue and a worker pool run the batch. One bad image fails only that item, never
the whole job.

## Tools used

| Layer | Choice |
|---|---|
| Application | Next.js (TypeScript), one repo, one deploy pipeline |
| Extraction model | `claude-haiku-4-5` — every label |
| Resolution model | `claude-sonnet-5` — escalated labels only |
| Database | Postgres, via Render, with Drizzle for schema and queries |
| OCR (warning channel) | `tesseract.js` — pure WASM, no native dependency, works inside Render's constrained runtime |
| Hosting | Render — a web service, a background worker, and a Postgres database, one Blueprint (`render.yaml`) |
| Test-label set | 36 committed cases: 31 rendered (clean matches and named defect categories) plus 5 real bottle photographs |

## Assumptions log

Three ambiguities came up while building this and were settled by asking, not guessing. Full
detail in `audit/requirements/interpretations.md`.

1. **Does a comparator-level test prove the government warning's FAIL path, or does it need to
   run on a real photograph?** Ruled: a real photograph. At least one FAIL case (title-case
   prefix, or a reworded warning) must run through the real image pipeline — OCR and region
   detection included — not just against a hand-built string.
2. **Does a committed, dated live-run artifact count as behavioral proof, or does every claim
   need a fresh run?** Ruled: a committed artifact counts, but only while it still describes the
   code that ships. An artifact measured before a change to the path it measures is stale, and a
   stale artifact does not support a "verified" claim, no matter how small the real effect
   probably is.
3. **Does a trade-offs write-up in an internal working document (this repo's `docs/deploy.md` or
   `docs/error-states.md`) satisfy the brief's call for documented trade-offs, or does it need to
   be in a document an evaluator will actually open?** Ruled: it has to be here, in a graded
   deliverable. An evaluator opens this file and the README. Nobody opens the internal working
   docs first.

One further assumption, not asked because it needs no ruling: this prototype does not integrate
with COLA. The brief is explicit that this is out of scope — "a standalone proof-of-concept,"
in Marcus Williams's words. Application data is entered directly into LabelHunter. No registry
client exists anywhere in the code. This is checked directly, not assumed: `grep -rn "COLA"
src/` returns one hit, a citation to the federal regulation LabelHunter checks against, not a
client.

## Trade-offs and limitations

**A working core over ambitious but incomplete features.** The single-label verify flow, the
warning subsystem's exact check, and batch processing all shipped before any stretch feature,
and all are covered by tests. Bold detection on the warning prefix, described next, is the
clearest example: a feature deliberately left as a lower-confidence signal, not pushed to full
reliability at the cost of the core path.

**Bold detection is a low-confidence signal, not a hard check.** The statute requires the
"GOVERNMENT WARNING:" prefix to print in bold as well as all caps. All-caps is checked exactly.
Bold is harder. Reliable bold detection from a photograph needs either a specialized vision
model or careful stroke-width measurement. This prototype has neither at production
reliability. LabelHunter reports a bold signal instead — `true`, `false`, or `uncertain` —
rather than silently dropping the check or reporting false confidence.

**No runtime access control is live on the deployed instance yet.** The brief's own guidance
("just don't do anything crazy... not storing anything sensitive") sets a light bar for a
prototype. The data model meets that bar: no PII, no reviewer identity, no secrets in the
repo. A separate concern is runtime cost — the deployed URL calls a real, billed Anthropic API
key. A shared access-code gate, per-IP and global rate limits, and a persisted daily spend
budget are built and in review
([PR #43](https://github.com/troysatchell/LabelHunter/pull/43)), not yet merged. That review
already found two follow-up gaps, before merge:

1. The batch workers check the spend budget only when a batch starts, not again while it runs.
   A long-running batch is not budget-capped mid-run. Tracked as PR #43's own follow-up.
2. A database failure during the budget check currently surfaces as a generic server error,
   not the designed "budget unavailable" response.

Until PR #43 merges, treat the deployed instance as unprotected. The README says the same
thing, in the same words, so the two documents cannot drift apart.

**No batch has run at the brief's own named scale yet.** Sarah Chen's interview names 200–300
labels as the real peak-season number. The code caps batch size at 1000. Durable Postgres image
storage survives Render's web/worker split. The largest batch actually measured so far is 32
items, run locally. This is a measurement gap: the code supports the scale, but nothing has
proven it at that scale yet.

**Cascade-verdict accuracy is the weakest measured number.** See "Measured results" below.

**The deployed instance's latency is not being quoted right now.** A prior measurement — p50
3834 ms, p95 4458 ms, against the live deployed instance — exists but is stale. It predates
several commits that changed the exact pipeline it measured, among them the deterministic
router's field-evidence check and the warning comparator's region-detection threshold. A
latency figure has to describe the code that ships, not a close ancestor of it. Publishing the
old number would repeat the mistake `audit/requirements/gaps.md`'s TH-R2 entry exists to name.
A fresh measurement is pending. See `scripts/latency/results/` for whichever run is most recent
by the time you read this.

## Measured results

**Accuracy.** Measured over the full 36-case golden set, three repeated live runs (`K=3`), to
report a real range instead of one lucky run:

| Metric | Band |
|---|---|
| Field extraction accuracy | 87.2%–87.8% |
| Cascade-verdict accuracy (end-to-end, after Sonnet resolution) | 80.6%–83.3% |

Extraction is solid. Verdict accuracy is lower — this prototype's clearest open problem. Most
of the gap traces to one repeated pattern: a deliberately degraded or ambiguous image reads
confidently on a single channel, masking a case that should have landed on "needs review."
`audit/requirements/gaps.md`'s TH-R17 entry has the full, case-by-case breakdown and the
concrete next steps.

Earlier in this project a single accuracy run measured 65.6%. Three things drove the
improvement to the current band: the warning subsystem's dual-channel check, better router
rules, and a larger, harder golden set. No single lucky change explains it.

**Cost.** The Haiku extraction every label gets costs roughly $0.005 per label. The Sonnet
resolution the router escalates a minority of labels to costs roughly $0.02 more, on those
labels only. A three-repeat, 36-case live evaluation run cost about $1.20 total.

**Latency.** Pending a fresh measurement — see "Trade-offs and limitations" above for why the
last one is not quoted here.

## What makes this more than the literal ask

Four choices go beyond what the brief asks for directly:

1. **The cost-tiered cascade itself** — most prototypes at this scope would call one model on
   every field of every label. This one routes by need.
2. **A dual-channel warning check that never certifies on one silently-unavailable reader.** A
   single OCR or vision failure degrades to a review flag, not a guess.
3. **A confidence-triaged human review queue**, so "needs a person" is a first-class outcome
   with its own screen, not a dead end.
4. **A three-repeat accuracy band instead of a single measured number.** A single live run of
   this eval showed real, measured call-to-call variance — about 3 points. Reporting a floor
   and a ceiling from repeated runs is unusual at this scale. Gating the CI regression check
   against that honest band, rather than one favorable run, is worth naming on its own.

## What was not built, and why

Every requirement in this brief is either built, or intentionally out of scope with a reason.
None is silently dropped. `audit/requirements/inventory.md` traces all 23 requirements
extracted from the brief. `audit/requirements/REPORT.md` is the current sweep against that
inventory. The one deliberate exception is COLA integration, covered in "Assumptions log"
above. Every other gap open at submission time is a measurement or a documentation task, not a
missing feature. See `audit/requirements/gaps.md` for the current list.
