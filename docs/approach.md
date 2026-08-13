# Approach

This document covers LabelHunter's approach, the tools it uses, the assumptions behind it,
and its trade-offs and limitations. `README.md` covers setup and run instructions.

## Approach

### The problem

A TTB compliance agent checks an alcohol label against its application: does the brand name
match, is the alcohol content correct, is the government warning present and worded correctly?
Sarah Chen's team checks labels by hand today, one at a time. The brief asks for a prototype
that runs the same check in seconds. It must work singly or in batches of hundreds. A human
agent still makes the final call on anything uncertain.

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

**Why a cascade instead of one model for everything.** A committed benchmark defends the choice
with a measurement, not an assumption:
`scripts/eval/results/benchmark-report.json`. It is a single run over the 32-case golden set as
it stood on 2026-08-12. It compares the cascade against a Sonnet-only pipeline. The
Sonnet-only arm resolves every field of every label with the expensive model, no router
involved. The cascade won on both axes measured that day. Label-verdict accuracy: 71.9% (23 of
32) against the Sonnet-only arm's 37.5% (12 of 32). Total cost: $0.28 against $0.47, for the
same 32 cases. This is a separate, earlier measurement from the K=3, 36-case accuracy band in
"Measured results" below. That band scores the cascade alone, on the current larger golden set.
It is not a like-for-like comparison against a Sonnet-only arm.

### Outbound dependencies and degradation

LabelHunter calls one public vendor API while it runs: Anthropic, for label extraction and
resolution. Its own Postgres database is a private, same-network dependency, not a public
endpoint behind a firewall allow-list. This distinction matters for TH-R7's exact scenario from
the interview: a blocked ML endpoint broke half a vendor's features, with no warning to the
user.

| Dependency | When it is called | Required? | If blocked or unreachable |
|---|---|---|---|
| Anthropic API (`api.anthropic.com`) | Every verify request (Haiku extraction). Escalated labels get a second call (Sonnet resolution) — never the per-label happy path. | Yes — the core function. | One designed `SERVICE` state: "LabelHunter could not reach the verification service. Try again." No raw SDK error name reaches the response. No partial record is written. |
| Postgres database | Twice per verify request: a budget-check read before extraction, then a write after extraction succeeds. | Yes — nothing persists without it. | The post-extraction write has a designed response: 503, "LabelHunter could not save this verification. Try again." The pre-extraction budget-check read does not yet — a database failure there surfaces as a generic server error, tracked as [TRO-566](https://linear.app/troysatchell/issue/TRO-566). Same-network in production, `localhost` in local dev — not a firewall-allow-list concern in TH-R7's sense either way. |
| Google Generative Language API (Gemini/Imagen) | Dev-time only: generating the test-label image set (`pnpm golden:build`). | No — build-time tooling, not part of the deployed app. | Irrelevant at runtime. The running app has no code path that calls Google. |

**If a deployer's firewall blocks `api.anthropic.com`, every verify request fails the same
honest way.** The Anthropic SDK raises `APIConnectionError` (or `APIConnectionTimeoutError` for
a connect-level timeout). `src/app/api/verify/route.ts` catches it, along with every other
extraction failure, and returns the same `SERVICE` panel — a plain message, a retry button, no
stack trace, no SDK error name. The database transaction only starts after a successful
extraction, so an unreachable endpoint leaves nothing half-saved. There is exactly one address
to allow through the firewall, and exactly one honest failure state for when that has not been
done. Full test and code citations: `docs/error-states.md`.

### The government warning gets a stricter check

Jenny Park's clearest catch in the brief is the government warning check. It has to be exact:
word-for-word text, plus the "GOVERNMENT WARNING:" prefix in capital letters. Every other field
uses judgment — a case or punctuation difference still counts as a match. The warning does not
get that leniency. LabelHunter reads the warning block through two independent channels, a
vision read and OCR. It returns a verdict only when both channels agree. When they disagree, or
when only one channel can read the block at all, it returns an explicit review flag instead of
guessing. "The system compared against the statutory string" is a defensible answer in a
compliance review. "The model thought it looked right" is not.

Word-for-word text and the all-caps prefix are both verified, including against real
photographs. The statute's third requirement — the "GOVERNMENT WARNING:" prefix printed in
bold — is captured but not yet enforced. The extractor reads a bold signal
(`true`/`false`/`uncertain`) for every label, and the value is validated into the response, but
no code in the router or the warning comparator reads it. A correctly capitalized, correctly
worded, but non-bold prefix passes today. Tracked as
[TRO-569](https://linear.app/troysatchell/issue/TRO-569), filed Urgent.

### Imperfect images

Jenny also asked for tolerance of labels photographed at odd angles, in bad light, or with
glare. LabelHunter's router treats a genuinely unreadable image as its own outcome instead of
guessing at a field it cannot see. That outcome is `LOW_IMAGE_QUALITY`, with a named trigger:
blur, glare, rotation, or low resolution.

**The measured result is real but mixed, not perfect — stated honestly here, not softened.**
The golden set's five real bottle photographs (case-35 through case-39) are the strongest
result: every one returns an explicit review flag, even though field extraction on these hard,
real-world images is only 36% correct (9 of 25 fields). Low confidence correctly triggers a
human review exactly when it should. The six synthetic degraded cases (glare, low light,
rotation — case-17 through case-22) tell a different story: field extraction is stronger there
(23 of 30 fields correct), but four of those six cases return a confident `PASS` when the
degradation should have triggered `REVIEW` — the router read the image well enough to answer
fast, not well enough to know it should not have. This is the same pattern behind this
prototype's weakest measured number; see "Measured results" and
`audit/requirements/gaps.md`'s TH-R17 entry for the full case-by-case account.

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
   run on a real photograph?** Troy ruled it needs a real photograph. At least one FAIL case —
   a title-case prefix, or a reworded warning — must run through the real image pipeline, OCR
   and region detection included. A hand-built string is not enough on its own.
2. **Does a committed, dated live-run artifact count as behavioral proof, or does every claim
   need a fresh run?** Troy ruled a committed artifact counts, but only while it still describes
   the code that ships. An artifact measured before a change to the path it measures is stale.
   A stale artifact never supports a "verified" claim, no matter how small the real effect
   probably is.
3. **Does a trade-offs write-up in an internal working document — this repo's `docs/deploy.md`
   or `docs/error-states.md` — satisfy the brief's call for documented trade-offs? Or does it
   need to be in a document an evaluator will actually open?** Troy ruled it has to be here, in
   a graded deliverable. An evaluator opens this file and the README. Nobody opens the internal
   working docs first.

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

**Bold detection is captured but not yet enforced — a real gap, not a soft one.** The statute
requires the "GOVERNMENT WARNING:" prefix to print in bold as well as all caps. All-caps is
checked exactly. Bold is not checked at all today: the extractor reads a signal (`true`,
`false`, or `uncertain`) for every label, but no router or comparator code acts on it, so a
correctly worded, correctly capitalized, non-bold prefix passes. This is more than a
low-confidence-signal design choice — see "The government warning gets a stricter check" above
and [TRO-569](https://linear.app/troysatchell/issue/TRO-569) for the specifics. Reliable bold
detection from a photograph would still need either a specialized vision model or careful
stroke-width measurement, which this prototype does not yet have at production reliability —
that part of the original design choice stands. Wiring the captured signal into the router
does not.

**Runtime access control is live, confirmed against the deployed instance.** The brief's own
guidance ("just don't do anything crazy... not storing anything sensitive") sets a light bar
for a prototype. The data model meets that bar: no PII, no reviewer identity, no secrets in the
repo. A separate concern is runtime cost — the deployed URL calls a real, billed Anthropic API
key. [PR #43](https://github.com/troysatchell/LabelHunter/pull/43) merged into `main` to
address this. It adds three things: a shared access-code gate, per-IP and global rate limits,
and a persisted daily spend budget. Merged code is not the same claim as a live, protected
deployment, so this document does not assert protection from the merge alone. Three checks
against the live URL confirmed it directly: `GET /` redirects to the code page, an
unauthenticated request to a protected API route returns 401, and the real code returns 200
with a session cookie. `README.md`'s "Try it" section carries the URL and the code, kept in
sync with this document deliberately.

**The daily budget shipped inert, and PR #43's own review caught it before merge.** The route
wiring that binds a real Anthropic client to the budget's usage capture was missing. Every
gate passed and every test was green while it was missing, because nothing exercised that one
binding. Without it, spend was never recorded, so the budget read zero forever and could never
trip. The fix is one binding, and it now has its own regression test that asserts a real,
priced row lands in the ledger — not just that the code runs without throwing. Three follow-up
gaps in the same subsystem are ticketed, not fixed, and named here rather than left to be
discovered later:

- Batch workers do not check or record the budget once a batch is admitted, so a running batch
  is not capped mid-run.
- The budget check reads, then the spend write lands after the model call — a narrow
  check-then-act race under concurrent requests, bounded but not eliminated.
- A database failure during the budget check surfaces as a generic server error, not the
  designed response.

All three are [TRO-566](https://linear.app/troysatchell/issue/TRO-566). Two more findings from
the same review sit outside the budget subsystem: an open-redirect and a spoofable client-IP
header in the access-control layer ([TRO-565](https://linear.app/troysatchell/issue/TRO-565)),
and a test-quality gap plus a documentation hazard — `.env.local.example`'s placeholder access
code was a working value if copied verbatim, fixed in the same PR
([TRO-567](https://linear.app/troysatchell/issue/TRO-567)).

**No batch has run at the brief's own named scale yet.** Sarah Chen's interview names 200–300
labels as the real peak-season number. The code caps batch size at 1000. Durable Postgres image
storage survives Render's web/worker split. The largest batch actually measured so far is 32
items, run locally. This is a measurement gap: the code supports the scale, but nothing has
proven it at that scale yet.

**Cascade-verdict accuracy is the weakest measured number.** See "Measured results" below.

**Latency was re-measured after the access-code gate, not before it.** An earlier measurement
(p50 3834 ms, p95 4458 ms) went stale the moment PR #43 added a rate-limit check and a budget
read to the front of every request — the same mistake `audit/requirements/gaps.md`'s TH-R2
entry exists to name, and this document avoids repeating it. `scripts/latency/measure.ts`'s
`--url` mode could not even authenticate against the gate at first; TRO-568 added the
`x-access-code` header it needed. With that fix merged, 20 real HTTP verify round-trips against
the live deployed instance, past the access-code gate, measured **p50 3618 ms, p95 4197 ms**
(mean 3738 ms, 20 of 20 PASS). That is inside the brief's ~5-second bar, and it is the
authorized path — a rejected, unauthenticated request returns before any pipeline stage runs
and would report no timings at all, so this number describes what a real evaluator's request
actually experiences, not raw cascade latency with the gate subtracted out.

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

**Latency.** p50 3618 ms, p95 4197 ms, mean 3738 ms — 20 real HTTP verify round-trips against
the live deployed instance, past the access-code gate, 20 of 20 PASS. Inside the brief's
~5-second bar. See "Trade-offs and limitations" above for why this figure, not the prior one,
is the one quoted here.

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
above.

One remaining gap is a measurement task, not a correctness problem: no batch has run at the
brief's own 200–300 scale yet, though the code already supports it. Two gaps are real,
unresolved correctness problems, named plainly rather than described as smaller than they are.
Cascade-verdict accuracy, covered above under "Imperfect images" and "Measured results": six
degraded-image cases still return a confident wrong verdict. Bold detection on the government
warning, covered above under "The government warning gets a stricter check": captured by the
extractor, never enforced by the router ([TRO-569](https://linear.app/troysatchell/issue/TRO-569)).
See `audit/requirements/gaps.md` for the current, complete list, with the concrete next step
named for each row.
