# Changes

Per-ticket changelog. Every factory PR adds an entry at the top naming its ticket ID(s):
what changed, how to run it, how to roll it back. The gate greps for the ticket ID with
anchored boundaries — `TRO-30` will not match inside `TRO-301`.

## TRO-461 — PR review: local CodeRabbit triage, 3 findings fixed (2026-08-10)

**What changed.** The local `scripts/factory/gate.sh` run captured 3 findings; all 3 were
real and fixed here.
- `index.ts` (major): `extractLabel` built a fresh `new Anthropic()` on every call when
  no client was injected. Fixed: `getDefaultExtractorClient()` builds the client once and
  reuses it. A batch run extracts hundreds of labels (PRD §3.5); a client per call is
  needless setup. The shared client sets `timeout: 30s`. That timeout is a safety net
  against a hung request; the SDK's own default is 10 minutes, sized for long completions.
  The shared client also sets `maxRetries: 0`, not the SDK default of 2. An SDK-level
  retry would run underneath the batch worker's own rate-limit backoff (CP-3 builds that
  worker) with no coordination between the two, and could add seconds that neither TH-R2's
  5-second budget nor TH-R4's batch throughput accounts for. The caller decides whether to
  retry a 429 or 5xx. `options.client` still overrides the shared client, for tests.
  Verified the reuse test is load-bearing: removing the caching made
  "returns the same client instance on every call" fail, as expected, then restored it.
- `golden-case.test.ts` (minor): the government-warning assertions hardcoded `true`/
  `"ALL_CAPS"` instead of deriving them from the golden-set fixture. A fixture change
  would have surfaced as a confusing mismatch that looked like a `parseExtractionResponse`
  bug. Fixed: added an explicit precondition assertion on
  `label.governmentWarningPresent`/`governmentWarningPrefixAllCaps`, and the downstream
  result assertions now compare against those same fields instead of literals.
- `makeMessage` (trivial): duplicated verbatim across `index.test.ts`, `response.test.ts`,
  and `golden-case.test.ts` — three real copies, not a premature abstraction. Extracted to
  `src/server/extractor/test-support.ts` (`makeMockMessage` + `WELL_FORMED_EXTRACTION_BODY`);
  all three test files import it now.

Also tightened `index.test.ts`'s first assertion, which had asserted the mock client was
called with `buildExtractionRequestParams(IMAGE)` — the same function `extractLabel` calls
internally, so the check couldn't catch `extractLabel` wiring the wrong params. It now
asserts the identity-critical fields (model, one message, the image block's data and media
type) independently; byte-for-byte request validation stays in `request.test.ts`, which
already uses an independent oracle for the CP-1 prompt/schema bytes.

**How to run it.** `pnpm test -- src/server/extractor` — 4 files, 34 cases (was 32; +2 for
`getDefaultExtractorClient`). `pnpm typecheck` / `pnpm lint` both clean.

**Rollback.** `git revert` this commit; `index.ts` returns to constructing `new Anthropic()`
per call, and the three test files return to their own local `makeMessage`/`WELL_FORMED_BODY`
copies.

## TRO-461 — LH-011: Haiku extractor (2026-08-10)

**What changed.** The Haiku extractor (PRD §3.2, TH-R1, TH-R11) under
`src/server/extractor/`. It answers one question — what does this label say? — with
one Haiku call per label, strict JSON output, and no view of the application record
(CP-1 §3.1: no anchoring). Comparing the read to an application is the Validation
Router's job (LH-012/013), not this ticket's.

- **`prompt.ts`** — `SYSTEM_PROMPT` and `USER_MESSAGE_TEXT`, the CP-1-approved bytes
  (`docs/checkpoints/cp1-cascade-router-prompts.md` §3.2–§3.3) copied verbatim.
- **`schema.ts`** — `EXTRACTION_JSON_SCHEMA`, the CP-1-approved strict JSON schema
  (§3.4), also copied verbatim.
- **`types.ts`** — TypeScript types for the schema: `HaikuExtractionResult` and its
  parts (`ExtractedField`, `ExtractedGovernmentWarning`, `ExtractedImageQuality`).
- **`request.ts`** — `buildExtractionRequestParams(image)`, a pure function that
  assembles the request: `model: "claude-haiku-4-5"`, `temperature: 0`, the image
  block before the text block, `output_config.format` carrying the schema. No
  `output_config.effort` (the model rejects it), no `cache_control` (the prompt is
  under the caching minimum on this model).
- **`response.ts`** — `parseExtractionResponse(message)` turns a raw Anthropic
  response into a typed `HaikuExtractionResult`, or throws `HaikuExtractionError`
  naming every shape problem it finds (refusal, early stop, no text block, invalid
  JSON, a wrong type or enum value at an exact path) — never a silent partial
  result. It checks shape only; the confidence-range and evidence-substring
  overrides (CP-1 §4.4) belong to the Validation Router, not this ticket.
- **`index.ts`** — `extractLabel(image, options?)`, the public entry point. One
  Anthropic call, no retry-as-a-second-opinion, and it never references Sonnet
  (TH-R19: the cascade is the architecture, not an optimization). Takes an
  injectable `client` for tests; defaults to a new client reading
  `ANTHROPIC_API_KEY` from the environment.

**Load-bearing decisions.**
- The image content block comes before the text block in the user message, matching
  CP-1 §3.3's draft order exactly.
- `max_tokens: 2048` — CP-1 §7.1 assumes ~600 output tokens for six fields plus
  evidence strings; this leaves headroom for a long warning transcription without
  needing to stream.
- The response parser collects every validation problem in one pass, the same
  convention `src/lib/golden-set/loader.ts` already uses for the manifest — a
  malformed response names every field that is wrong, not just the first one found.

**API facts confirmed live against `api.anthropic.com` today (CP-1 §3.5), not just
taken on documentation:**
1. `claude-haiku-4-5` is a valid, current model ID — `GET /v1/models/claude-haiku-4-5`
   resolves to `claude-haiku-4-5-20251001`, `structured_outputs.supported: true`,
   `image_input.supported: true`.
2. `claude-haiku-4-5` rejects `output_config.effort` — a real request with `effort: "low"`
   returned `400 invalid_request_error: "This model does not support the effort
   parameter."`
3. `claude-haiku-4-5` accepts `temperature: 0` — the full request (system prompt, schema,
   a synthetic image, `temperature: 0`) returned `200` with schema-conformant JSON.
4. `cache_control` on this system prompt does nothing — a request with the marker
   returned `cache_creation_input_tokens: 0`, `cache_read_input_tokens: 0`, no error.
   No caching saving is claimed anywhere in this module or its docs.
5. **Not live-verified, taken on documentation**: that high-resolution vision
   (2576px) is Sonnet-only and Haiku is capped lower. Confirming this needs a large
   test image and doesn't change any code in this ticket (image preprocessing to
   the Haiku cap is TRO-460, a sibling ticket) — flagged, not silently assumed true
   without a source.

The live smoke test used the exact request shape `request.ts` builds (verified by
copying `buildExtractionRequestParams`'s fields into a standalone script), plus a
1x1 pixel synthetic PNG — not a real label photo, since `golden-set/images/` is
still empty pending LH-004/005/006. It was run once, by hand, from the scratchpad,
and is not part of the repo — a real-money API call has no place in a script another
agent or CI could run by accident.

**Known limits.** No end-to-end test against a real label photo — out of scope per
the ticket (no golden-set images exist yet). The TH-R11 sanity check
(`golden-case.test.ts`) confirms the extractor's parser round-trips a
correctly-shaped Haiku response built from `case-01-clean-match-spirits`'s ground
truth, across brand name, class/type, alcohol content, net contents, and government
warning — it does not call the API or render pixels.

**How to run it.** `pnpm test -- src/server/extractor` — 4 test files, 32 cases.
`pnpm typecheck` / `pnpm lint` both clean.

**Rollback.** `git revert` this commit; delete `src/server/extractor/*.ts` and
restore `src/server/extractor/.gitkeep`; `pnpm remove @anthropic-ai/sdk` (added by
this ticket, not yet used elsewhere).

## TRO-460 — LH-010 review round 1: 4 CodeRabbit findings, 1 major (2026-08-10)

**What changed.** The factory gate's review step (CodeRabbit) found 4 issues in the initial
implementation. All 4 fixed:

- **Major.** `clampRegionToBounds` (`region.ts`) clamped a region with `Math.max`/`Math.min`,
  which silently propagate `NaN` instead of clamping it — a caller passing a non-finite
  coordinate (a corrupt detector output, not just an out-of-bounds one) would reach sharp's
  `.extract()` as an invalid crop request with no clear error. Now rejects a non-finite
  `region` field with `RangeError`, and rounds a fractional coordinate (a detector may report
  a bounding box in floating point) to the nearest whole pixel before clamping.
- **Minor.** `preprocessImage`'s JPEG encode of `original` used sharp's default alpha
  matte, which is **black**, not white — verified with a live sharp run: a fully
  transparent pixel encoded through `.jpeg()` with no explicit flatten came out `(0, 0, 0)`.
  A label graphic with a transparent background would go dark. This finding carried no
  code suggestion, only the instruction; fixed with an explicit
  `.flatten({ background: "#ffffff" })` before every JPEG encode, including `cropRegion`'s,
  and a new regression test that round-trips a fully-transparent PNG through the real
  pipeline and asserts the decoded pixel channels land near-white (confirmed re-verified
  with the same live-sharp technique: `(255, 255, 255)` with the flatten in place).
- **Minor.** The no-upscale test only checked `haikuVariant`; extended it to check
  `sonnetVariant` too, per the finding's own suggested test code.
- **Minor.** The upload-size error-message test only checked the message's length and that
  it wasn't a bare "error"/"failed" string. The finding's suggested code checked for the
  raw byte counts (`String(MAX_UPLOAD_BYTES * 2)`), but its own instruction text allowed
  "raw byte values **or** their documented formatted representations" — this
  implementation's `humanBytes()` renders a human-readable size (TH-R20: the message is
  for a person, not a log line), so the fix checks for `"40.0 MB"` / `"20.0 MB"` instead of
  the raw byte counts, honoring the instruction's intent rather than its literal sample.

**How to run it.** `pnpm test -- src/server/preprocessing` — 45 tests (up from 42).

**Rollback.** `git revert` this commit. No behavior change outside the four points above.

## TRO-460 — LH-010: image preprocessing pipeline (2026-08-10)

**What changed.** A new module, `src/server/preprocessing/`, implements PRD §3.1's
preprocessing stage — the step between upload and the Haiku extractor (LH-011, not built
yet). It lives as its own module, a sibling of `src/server/{extractor,router,warning,resolver}/`,
because the PRD diagram draws preprocessing as its own boxed pipeline stage, and the
extractor's own `.gitkeep` scopes that directory to LH-011's Haiku call only.

`preprocessImage(upload: Buffer)` runs one uploaded label image through:

- **EXIF rotation.** `sharp`'s `.rotate()` bakes the EXIF orientation into the pixel data
  and strips the tag — a viewer with no EXIF support still displays the image upright.
  Confirmed live: a 100×60 fixture tagged orientation 6 decodes, after `.rotate()`, to a
  60×100 buffer with no orientation tag left.
- **Three buffers, one format.** `original` (full resolution, reserved for OCR — a later
  ticket), `haikuVariant` (≤1568px long edge), `sonnetVariant` (≤2576px long edge, reserved
  for the Sonnet resolver — LH-014, not called here). Every buffer is JPEG, regardless of
  the upload's source format, because the Claude vision API never accepts `image/heic` and
  a single fixed `mediaType` means every consumer avoids a format branch.
- **Format validation.** Accepts JPEG, PNG, WEBP, and HEIF/HEIC (`sharp` decodes HEIC, the
  default capture format on recent iPhones). Rejects anything else — including formats
  `sharp` can decode but a label photo would never be, like GIF or TIFF — with
  `UnsupportedFormatError`, not a generic failure.
- **Size ceilings.** `FileTooLargeError` above 20 MB (byte size). `ImageDimensionsTooLargeError`
  above 100 megapixels decoded (a decompression-bomb guard — bounds decode cost independent
  of the file's size on disk). `UnreadableImageError` for a corrupt or truncated file.
- **A warning-region crop hook.** `cropRegion(source, region)` extracts a caller-supplied
  pixel box from a full-resolution buffer at native DPI. This ticket does not detect the
  warning block — LH-020 (its own CP-2-gated subsystem) does — but the crop math exists now
  so LH-020 has something to call. `clampRegionToBounds` (pure, unit tested) guarantees the
  box sharp receives is always valid, even when a detector's box runs slightly outside the
  image.

**Two resolution caps confirmed live, not just read from the docs.** `docs/checkpoints/
cp1-cascade-router-prompts.md` §3.5 named this ticket to confirm the Haiku 1568px / Sonnet
2576px vision caps against a real call. A 3200×2400 synthetic JPEG sent to both models
(temperature 0 on Haiku; `effort: low` on Sonnet, which rejects `temperature`) measured
1582 input tokens on `claude-haiku-4-5` and 4761 on `claude-sonnet-5` — a 3.0× ratio, and
after subtracting prompt overhead, within a few tokens of Anthropic's own published
1568-token and ~4784-token figures at those two caps. Both caps stand as measured, current.

**How to run it.** `pnpm test -- src/server/preprocessing` runs the 42 preprocessing tests
in isolation (77 pass repo-wide). No database, no API key, and no network call are needed
for the shipped code — the live resolution-cap confirmation above was a one-time diagnostic,
not part of the test suite.

**Rollback.** `git revert` this commit. Nothing outside `src/server/preprocessing/`,
`package.json`, and `pnpm-lock.yaml` (the new `sharp` dependency) changed.

**Known limits.** LH-051 (imperfect-image handling, TH-R10's graceful-degradation judgment
call) is explicitly out of scope — this ticket rejects only structurally invalid input
(wrong format, corrupt file, oversized file). A blurry-but-valid JPEG passes through
unchanged; deciding whether a low-quality read should downgrade to a review outcome is
LH-051's job. The HEIC-acceptance claim rests on `sharp`'s reported `libheif` support
(`sharp.versions.heif`) — not measured against a real iPhone HEIC capture, since none was
available in this worktree.

## TRO-459 — PR review round 4: final 4 unresolved threads triaged, 2 doc fixes (2026-08-10)

**What changed.** Triage of the last 4 unresolved CodeRabbit threads before merge:
- `src/server/router/.gitkeep` credited all comparators to LH-013. Corrected: LH-013 owns
  the four CP-1 comparators; the government-warning comparator is its own CP-2 subsystem
  (LH-020, `src/server/warning/`). (Fixed.)
- §6.3's sample user message said the extractor reading is inserted "verbatim — needs no
  re-encoding." That contradicts §6.3's own `serializeUntrusted` requirement: extractor
  evidence strings carry verbatim label text, adversarial input like any other. The sample
  now routes the extractor block through the same escaping. (Fixed.)
- The two remaining threads (warning-shape rejection payload; JSON.stringify delimiter
  escape) were already fixed in rounds 2–3 — resolved with pointers, no code change.

**How to run it.** Nothing to run; re-read the two corrected spots.

**Rollback.** `git revert` this commit.

## TRO-459 — PR review round 3: 4 findings, including a real flaw in round 2's own fix (2026-08-10)

**What changed.** CodeRabbit reviewed round 2's fixes and found that one of them — the
JSON-serialization defense against delimiter injection — was itself incomplete. Verified with a
real `node -e` run before believing it: `JSON.stringify` escapes quotes, backslashes, and
control characters, but leaves `<`, `>`, and `/` untouched, so a value containing the literal
string `</UNTRUSTED_DATA>` still contains it after `JSON.stringify` — the exact attack round 2
claimed to have closed. Fixed for real this time: Unicode-escape `<`/`>`/`/` **after**
`JSON.stringify`, verified empirically that the escaped output no longer contains the attack
string.

3 more findings, all fixed:
- §4.4's rejection-payload fix (round 2) described the right payload shape for
  `government_warning` but never updated the downstream predicate that reads it —
  `MISSING_REQUIRED_FIELD` (§5.3) still said `value === null` uniformly, which is `false` for a
  field that structurally has no `value`. Now field-shape-aware: `value === null` for the five
  fields, `present === null || present === false` for the warning.
- The prompt-injection test requirement asked for the resolver's "disposition" on
  `government_warning` — but that field never gets a disposition at all (rule 5: re-transcribed,
  never judged). Rewritten to assert what the field actually produces: the transcription output
  is byte-identical whether or not a sibling field carries the injection payload.

**How to run it.** Nothing to run; re-read the corrected sections. The escaping claim is
verifiable directly: `node -e 'console.log(JSON.stringify({v:"</UNTRUSTED_DATA>"}).replace(/[<>\/]/g,c=>"\\u00"+c.charCodeAt(0).toString(16)))'`.

**Rollback.** `git revert` this commit.

## TRO-459 — PR review round 2: 3 more CodeRabbit findings, all fixed (2026-08-10)

**What changed.** A second CodeRabbit pass on the doc found 3 more real issues:
- §4.4's malformed-confidence rejection described one payload shape (`value: null`) for all
  fields, but `government_warning` has no `value` — its rejection now sets
  `present: null, transcription: null` explicitly, so a downstream `value === null` check
  (which `MISSING_REQUIRED_FIELD` literally uses) doesn't silently miss it.
- The resolver's untrusted-data delimiting (previous round) wrapped values in
  `<UNTRUSTED_DATA>` tags but inserted them as freeform text — a value containing the literal
  string `</UNTRUSTED_DATA>` could still close the tag early. Switched the application-form
  block to real JSON serialization (`JSON.stringify`, not string concatenation, called out as
  an implementation requirement) — JSON string-escaping neutralizes the attack structurally,
  which a text template cannot. Also clarified the image needs no text delimiter: it's a
  separate image content block, not text, so it cannot contain closing-tag characters.
- The prompt-injection test requirement said the resolver's decision "does not change based
  on" an injected value — too broad, since a legitimately different field value should change
  the verdict. Replaced with a precise oracle: the *targeted* field's disposition must be
  unaffected by a sibling field's injection payload, while the *injected* field's own
  disposition still reflects its real (garbled) content.

**How to run it.** Nothing to run; re-read the three corrected sections.

**Rollback.** `git revert` this commit.

## TRO-459 — LH-CP1: ⛔ CHECKPOINT 1 walkthrough material (2026-08-10)

**This entry does not clear a checkpoint.** It adds the material Troy reads *at* the
checkpoint. CP-1 stays blocking until Troy runs the walkthrough and gives explicit
acknowledgment. Until then, LH-010 … LH-015 (TRO-460 … TRO-465) do not start.

**What changed.** One new document: `docs/checkpoints/cp1-cascade-router-prompts.md`. No
product code. It covers the four things PRD §10 requires CP-1 to cover, plus the "defend it"
Q&A (TH-R1, TH-R8, TH-R10, TH-R19, TH-R21, TH-R22):

- **The Haiku extraction prompt** — full system and user drafts, plus the strict JSON schema.
  Every field carries `value`, `evidence`, and `confidence`. One load-bearing decision: the
  extractor sees the image only, never the application record. That removes anchoring, makes
  the extraction independent evidence rather than a confirmation, and turns the extractor's
  inferred beverage type into a free cross-check against the declared one.
- **Confidence thresholds** — three bands (trusted ≥ 0.85, uncertain 0.60–0.85, unusable
  < 0.60), a higher bar of 0.90 for the warning transcription, and an asymmetry rule: escalate
  a MISMATCH below 0.90 but a MATCH only below 0.60, because agreement with the application
  corroborates a weak read and a mismatch does not. Plus three deterministic overrides that
  ignore confidence entirely — the strongest is that `normalize(value)` must be a substring of
  `normalize(evidence)`, which catches a confident invention without consulting confidence.
  Every number is marked **proposed**, with the golden-set sweep (LH-003 → LH-030) that
  replaces it: reliability diagram, then threshold sweep, then pick the knee of verdict
  accuracy against auto-verified rate.
- **The `ReviewReason` routing rules** — a precise deterministic trigger for each of the eight
  enum members, a precedence order, and the naming principle that keeps two of them apart:
  `CONFLICTING_EXTRACTION` means we do not trust our own reading; `AMBIGUOUS_*` means we read
  it fine and it still is not decidable. `LOW_MODEL_CONFIDENCE` is deliberately last — its rate
  is a monitoring signal that the taxonomy has a gap.
- **The Sonnet resolver prompt** — full drafts, its output schema, and the rule that keeps the
  design defensible: the resolver *judges* only brand and class equivalence (where TH-R8
  literally asks for judgment); everywhere else it returns a corrected reading and
  deterministic code re-decides. It never judges the government warning — it re-transcribes,
  and code compares against the statute.
- **"Defend it" Q&A** — 15 questions with drafted answers, including the five the ticket
  named, plus prompt injection, extractor blindness, resolver anchoring, escalation-rate
  blowout, and "how do I know this is not just escalating everything to look safe".
- **Open questions for Troy** — seven real forks, each with a recommendation and the cost of
  choosing wrong.

**Two findings worth reading before the walkthrough.**

1. **The resolver cost estimate in PRD §4 looks low.** Derived arithmetic from published
   prices puts an escalation at about $0.05, not ~$0.02. Two named causes: adaptive thinking is
   on by default on `claude-sonnet-5` and bills as output tokens, and full-resolution vision
   costs roughly three times the tokens of a smaller image. Both are deliberate accuracy
   choices; neither was in the original estimate. A 300-label batch is therefore about $4
   (cascade) against about $15 (Sonnet on every label) — still ~3.7× cheaper, but only about
   six full batches against the $25 cap. Open question 4.
2. **Prompt caching on the extractor will silently do nothing.** The documented minimum
   cacheable prefix on `claude-haiku-4-5` is 4096 tokens; our extractor prompt is well under
   that. It fails with no error — just `cache_creation_input_tokens: 0`. Do not add
   `cache_control` there and do not claim a caching saving.

Related API constraints captured for LH-011/LH-014: `claude-haiku-4-5` rejects
`output_config.effort`; `claude-sonnet-5` returns a 400 for `temperature`; use
`output_config.format`, never the deprecated `output_format`; structured outputs cannot bound
`confidence` to 0–1, so the router rejects (never clamps) an out-of-range value as a broken
extraction — clamping would move malformed output onto the trusted path.

**Also updated** — pointers only, no logic: `src/server/{extractor,resolver,router}/.gitkeep`
now name this design document as the source for the ticket that fills each directory.

**How to run it.** Nothing to run. Read
`docs/checkpoints/cp1-cascade-router-prompts.md` top to bottom — about 40 minutes. The
appendix is a four-item checklist for the live session.

**Rollback.** Delete `docs/checkpoints/cp1-cascade-router-prompts.md`, revert the three
`.gitkeep` pointer updates, and revert this entry. Nothing depends on any of it; no code,
schema, or configuration changed.

**Known limits.** Nothing here is measured. Costs are derived arithmetic with the token
assumptions written down; latency is "not measured"; thresholds are proposed. Regulatory
values — ABV optionality per beverage type, ABV tolerance, standards of fill — are marked
VERIFY and default to the strictest interpretation, for LH-013 to verify against ttb.gov and
cite. The document deliberately does not decide anything owned by CP-2 (warning subsystem) or
CP-3 (batch queue).

## TRO-458 — Align spec schema with the approved image-gen design (2026-08-10)

**What changed.** Troy approved a render-first hybrid design for golden-set images
(`docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md`) and rescoped this
ticket to core-only (degradations → LH-004, Imagen → LH-005, verify gate → LH-006). Per the
ticket's note, aligned the spec schema with design §3 before merging:
- Added `provenance` (`rendered | rendered+degraded | ai-generated`), `verified` (boolean),
  and `vectors` (`audit/rubric.md` Appendix A, V1–V10) to `GoldenSetCase` and to every one of
  the 29 committed cases.
- Loader now enforces `provenance: "ai-generated"` requires `verified: true` — an AI-generated
  image can silently fail to render the exact text its spec claims; the eval harness must not
  trust one until a human confirms it.
- Mapped every case to the rubric vector(s) it evidences and found a real, previously-invisible
  gap: **V7** (net-contents format match, `"750 mL"` vs `"750ml"`) has no covering case. Added
  a test that asserts this gap explicitly (`loader.test.ts`) so it can't silently reappear once
  closed, and documented it in `golden-set/README.md` rather than quietly patching around it.
- 8 new regression tests (unknown provenance, unknown vector, unverified ai-generated case
  rejected, verified one accepted, vector-coverage assertion, ai-generated-implies-verified
  assertion on the real manifest).

**Still not done — the renderer itself.** This ticket's scope was the schema; producing actual
pixels is LH-003's remaining work (or a split-off), tracked against the design doc's §2
component list (`render.ts`/`degrade.ts`/`imagen.ts`/`verify.ts`/`build.ts`). `golden-set/images/`
is still empty.

**How to run it.** `pnpm test -- src/lib/golden-set` — 26 tests, up from 12.

**Rollback.** `git revert` this commit; the manifest and loader return to the pre-alignment
shape (still valid, just missing `provenance`/`verified`/`vectors`).

## TRO-458 — LH-003: Golden set v1 — ground-truth schema, manifest, loader (2026-08-10)

**What changed.** Ground-truth data and tooling for the golden set (TH-R12), scoped to the
parts that do not need an image-generation tool:

- **Ground-truth schema** (`src/lib/golden-set/types.ts`): a `GoldenSetCase` type covering
  the five example fields on both the application and the label (PRD §2, TH-R11), the
  Validation Router's expected per-field and label-level verdicts, and the `ReviewReason`
  enum (PRD §3.3).
- **Manifest** (`golden-set/manifest.json`): 29 complete ground-truth cases across all 12
  required test categories (PRD §6) — clean match (4), ABV mismatch (3), title-case warning
  (2), reworded warning (2), missing warning (2), case-variant brand (3), glare (2), rotation
  (2), low light (2), tiny warning text (2), odd typography (2), conflicting
  application-vs-label data (3). Includes the two named brief examples: `STONE'S THROW` vs
  `Stone's Throw` (TH-R8, `case-14-case-variant-brand-stones-throw`) and Jenny Park's
  title-case catch (TH-R9, `case-08-title-case-warning-prefix-only`).
- **Loader + validator** (`src/lib/golden-set/loader.ts`, TDD'd in
  `loader.test.ts`): `loadGoldenSetManifest()` reads and validates
  `golden-set/manifest.json`; `validateManifest()` checks the shape and collects every
  problem in one pass — missing fields, wrong types, an unknown category, a `reviewReason`
  that doesn't match the label verdict, an `imagePath` whose filename doesn't match its
  `caseId`, and duplicate case IDs. 12 test cases; confirmed red (missing module) before
  `loader.ts` existed, green after.
- **`golden-set/README.md`**: the manifest format, the image naming convention
  (`golden-set/images/<caseId>.jpg`), and the known gap below.

**Known gap, stated plainly: no label images.** `golden-set/images/` is empty. Every
`imagePath` in the manifest names a file that does not exist. Generating 29 label images
needs an AI image-generation tool or a camera; this ticket's agent had neither, and a
placeholder file with a `.jpg` extension would silently pass a file-existence check while
being useless for testing — worse than an honest gap. A follow-up ticket (LH-021 depends on
this landing) must generate or source each image at the path its case already names; the
case's `label` field is the spec for what the image must show.

**How to run it.** `pnpm test -- src/lib/golden-set` runs the loader tests directly. Load the
manifest from application code with `loadGoldenSetManifest()` (no arguments needed — it
resolves `golden-set/manifest.json` relative to the repo root).

**Rollback.** `git revert` this ticket's commits. Nothing outside `golden-set/` and
`src/lib/golden-set/` depends on this yet.

## TRO-457 — PR review round 4: seed idempotency guard fixed (2026-08-10)

**What changed.** `src/lib/db/seed.ts`'s "already seeded" guard checked only the
`applications` table. A database left with `batch_jobs` or `label_images` rows but no
`applications` rows (a partial prior run in an unusual failure order) would pass the guard and
insert on top of it. Guard now checks all three tables the script inserts into.

**How to run it.** `pnpm db:seed` on an empty database inserts as before; verified manually
(this script has no Vitest coverage by design — see the CodeRabbit-triage section below) by
running it twice in a row: first run succeeds, second is rejected with the updated message.

**Rollback.** `git revert` this commit; the guard reverts to checking `applications` alone.

## TRO-457 — PR review round 3: CodeRabbit findings, 1 fixed, 1 deferred (2026-08-10)

**What changed.** A further local-CLI CodeRabbit pass found 2 findings:
- `label_images` (major, real): the (batch, filename) index used for CSV-to-image pairing
  (PRD §3.5) was a plain index, not unique. Two images uploaded into the same batch with
  the same filename would make that pairing lookup return two candidates instead of one —
  exactly the ambiguous case PRD §3.5 says must be reported before the job starts, not
  silently accepted. Fixed: `label_images_batch_filename_idx` is now
  `label_images_batch_filename_unique`, a `UNIQUE` index on `(batch_job_id,
  original_filename)`. Postgres treats each `NULL` as distinct, so single-label images
  (`batchJobId` null) are never deduplicated against each other — only images inside the
  same real batch are constrained. Regenerated the migration (folded into
  `0001_product_schema.sql`, same reasoning as the earlier rounds — this table has never
  been applied outside this worktree). Verified directly: reset the database, reapplied,
  reseeded, then confirmed with a negative insert (`ERROR: duplicate key value violates
  unique constraint "label_images_batch_filename_unique"`) and a positive one (two
  single-label images sharing a filename, both `NULL` batch, insert succeeds).
- **Deferred, not fixed:** enforcing that a `verifications` row's application, image, and
  batch job all belong together at the database level. This is the same finding raised in
  the prior two review rounds, and the answer is unchanged: it needs a trigger or composite
  foreign keys spanning three tables, and that design belongs with the code that creates
  verification rows (LH-041's batch worker, behind the CP-3 checkpoint), not invented ahead
  of it in a schema ticket. Documented at both places in `schema.ts` that CodeRabbit has now
  flagged it (`labelImages` and `verifications`), so a future reader finds the decision
  instead of re-discovering the gap. Named again in the final ticket report as a known,
  deliberate gap for LH-041 to close.

**How to run it.** `pnpm db:migrate` picks up the corrected `0001_product_schema.sql`;
`pnpm db:seed` is unchanged.

**Rollback.** `git revert` this commit.

## TRO-457 — PR review round 2: CodeRabbit findings, 1 fixed, 1 stale (2026-08-10)

**What changed.** GitHub-App CodeRabbit reviewed PR #2 (a separate pass from the local CLI
triage already recorded below). Of 5 findings, 3 were already fixed by earlier commits in this
PR and auto-marked resolved. Of the remaining 2:
- `src/lib/db/seed.ts` (minor, real): the batch fixture's counters claimed `totalCount: 2` with
  one auto-verified item, but only one application row is actually batch-linked. Fixed by
  setting the counters to match the single real fixture (`totalCount: 1, autoVerifiedCount: 0,
  needsHumanCount: 1`) rather than inventing a second row. Verified by truncating and re-running
  `pnpm db:seed`, then querying `batch_jobs` and counting batch-linked `applications` directly.
- `src/lib/db/seed.ts` (flagged critical — "transaction callback not closed, file won't parse"):
  verified against the current file and it is **stale**. The finding describes an intermediate
  commit; the fix (wrapping every insert in one `db.transaction()`) already landed and is
  described in the CodeRabbit-triage section below. `pnpm typecheck`, `pnpm build`, and this
  gate's own `typecheck` check all confirm the file parses and type-checks cleanly. Dismissed
  with this reason, not fixed (there was nothing to fix).

**How to run it.** `pnpm db:seed` — same command, corrected counters.

**Rollback.** `git revert` this commit.

## TRO-457 — LH-002: Database schema + migrations (2026-08-10)

**What changed.** Added the real Drizzle + Postgres schema for LabelHunter (PRD §3.6,
TH-R6, TH-R22) in `src/lib/db/`, extending the scaffold's `_meta`-only `schema.ts`:

- **`enums.ts`** — the eight closed-set vocabularies as `pgEnum` types, each backed by one
  `as const` array so the TypeScript union, the Postgres enum, and a runtime guard all stay
  in sync: `beverage_type` (beer/wine/spirits), `label_verdict` (PASS/FAIL/REVIEW),
  `field_verdict` (MATCH/MISMATCH/NEEDS_REVIEW), `field_name` (the 5 example fields from
  PRD §2), `review_reason` (the 8-value `ReviewReason` enum from PRD §3.3, verbatim),
  `resolution_path` (which model(s) resolved a verification), `batch_job_status`, and
  `review_disposition`. `toReviewReason` and `toBeverageType` narrow an untyped string to
  the matching type or throw, naming every legal value in the error — the checkpoint
  between loosely-typed input (model output, a CSV cell) and an insert. TDD: red-first
  tests in `enums.test.ts` (9 cases) cover valid values, invalid values, and a near-miss
  (wrong case) for each guard.
- **`schema.ts`** — six product tables: `batch_jobs` (status + per-item counters the
  batch-progress UI polls), `applications` (brand/class/ABV+proof/net contents/beverage
  type — the claimed values a label gets checked against), `label_images` (storage
  reference, original filename, post-preprocessing dimensions; linked to an application
  for single-label verify or to a batch job before per-row pairing, per PRD §3.5), `verifications` (one row per completed label-level result: verdict, which model(s)
  resolved it, links to application/image/batch job), `field_results` (one row per field
  per verification: extracted value, verbatim evidence — required, not optional, per
  PRD §3.2 — confidence 0–1, verdict, one-line reason), and `review_queue` (one row per
  needs-human item: reason, nullable resolver output, nullable human disposition). Every
  closed-set column uses a Postgres enum, not free text. Reasonable indexes throughout,
  including a partial index on `review_queue` for the unresolved-items view the review
  queue UI needs, and a foreign key on every reference — all `ON DELETE CASCADE` (a
  prototype has no retention requirement, and a child row is meaningless without its
  parent). Full `relations()` graph for the query API.
- **No PII, checked column by column (TH-R6).** No table anywhere stores a real person's
  name, email, address, or other identifier. `review_queue` in particular records a
  human's approve/reject disposition and when, but not who — adding a reviewer-identity
  column was considered and rejected; nothing in the PRD or the rubric asks for it, and
  it would be the one clear PII risk in this schema.
- **Migration** `drizzle/migrations/0001_product_schema.sql`, generated with
  `pnpm db:generate` (not hand-written), applied with `pnpm db:migrate`, and verified with
  direct `psql` queries against this worktree's own database: `\dt` lists all 7 tables,
  `\d <table>` for each of the 6 new ones shows the expected columns, indexes, and
  constraints, and manual negative inserts confirm each constraint fires (the
  `label_images` ownership `CHECK`, the `field_results` confidence-range `CHECK`, the
  `field_results` and `review_queue` unique indexes) — not just declared, but load-bearing.
- **`db:seed`** (`pnpm db:seed`, added to `package.json`, run via the new `tsx` dev
  dependency) inserts a small, obviously-fake dev dataset spanning all six tables: one
  batch job, three applications (a clean single-label PASS, a batch-paired wine with a
  low-confidence ABV read that lands in the review queue, and a single-label FAIL on a
  title-cased government warning — Jenny's real catch, PRD §3.4), three label images,
  three verifications, fifteen field results, and one review-queue entry. Refuses to run
  twice against the same database instead of silently duplicating fixtures.

**A real drizzle-kit bug found and fixed, in scope for this ticket.** The first generated
migration created all 7 tables but zero `CREATE TYPE` statements, even though every enum
column referenced a type name that did not yet exist — an unusable migration that would
fail on apply. Cause: `drizzle-kit generate` only discovers `pgEnum`/`pgTable` objects
that are visible on the configured schema file's own exports; the enums lived in
`enums.ts` and were only imported (not re-exported) by `schema.ts`, so drizzle-kit's
export scan never saw them, even though the tables used them. Fixed with
`export * from "./enums"` in `schema.ts`. Caught by reading the generated SQL before
trusting it (this repo's "claims carry provenance" rule) — a `pnpm db:migrate` exit code
of 0 would have hidden this, since the broken migration was never applied.

**CodeRabbit review triage (6 findings; 5 fixed, 1 explicitly skipped):**
- `enums.test.ts` claimed a wrong-case test for both guards but only had one. Fixed —
  added the missing `toBeverageType("Beer")` case; the claim is now true.
- `review_queue`: added a `CHECK` requiring `disposition` and `disposed_at` to be null or
  non-null together — one fact, two columns, must move as a pair.
- `batch_jobs`: added `CHECK` constraints — every counter non-negative, and each of
  `processedCount`/`autoVerifiedCount`/`resolvedBySonnetCount`/`needsHumanCount`/
  `failedCount` no greater than `totalCount`. Bounded independently, not summed to equal
  `totalCount`: the batch worker (LH-041) updates one counter at a time, and a sum
  constraint would reject a legal state between two separate `UPDATE`s.
- `batch_jobs`/`verifications`/`review_queue`: `updatedAt` now carries `.$onUpdate(() =>
  new Date())`. This is a drizzle-orm runtime default, not a database trigger — it fires
  on every `db.update()` call that does not set the column itself, verified against the
  real database (an `UPDATE` through Drizzle bumped `updated_at` and left `created_at`
  unchanged). It does not protect a write that bypasses the ORM; documented as a known
  limit in the column comment rather than built out further, since every write path in
  this app goes through Drizzle.
- `seed.ts`: wrapped every insert in one `db.transaction()`. A failure partway through now
  rolls back the whole batch instead of leaving a half-seeded database that would silently
  defeat the "already seeded" guard on the next run.
- **Skipped:** enforcing that a verification's application, image, and batch job all
  belong to the same batch. A real DB-level guarantee needs a trigger or composite foreign
  keys spanning three tables — real design work that belongs with the code that creates
  verification rows (LH-041's batch worker, behind the CP-3 batch-queue checkpoint), not
  invented ahead of that design in a schema ticket. Flagged in the final ticket report as a
  known gap, not silently dropped.

**How to run it.** `source .factory-env` (or point `DATABASE_URL` at your own Postgres),
then `pnpm db:migrate` to apply `0001_product_schema.sql`, then `pnpm db:seed` for dev
fixtures. `pnpm db:generate` regenerates a migration after a future `schema.ts` edit.

**Rollback.** Drop the six product tables and their enum types (or restore the pre-0001
database from a snapshot) and delete `drizzle/migrations/0001_product_schema.sql` plus its
entry in `drizzle/migrations/meta/_journal.json`. `_meta` and the scaffold are untouched.

**Design calls the PRD left open (flagging for visibility, not asking permission):**
- No per-application government-warning column — the warning subsystem (PRD §3.4) always
  compares extracted text against one fixed statutory string, so there is no per-application
  value to store.
- `label_images` carries both a nullable `application_id` and a nullable `batch_job_id`
  (at least one required, via `CHECK`) rather than a single polymorphic reference — set
  directly for single-label upload, left to `batch_job_id` alone for a batch upload before
  its CSV-row pairing exists.
- `field_name` and beverage-type-driven optionality rules (e.g. ABV optionality per PRD §2)
  are two different things: this ticket enumerates the closed set of field names in the
  schema, but does not implement any optionality *rule* — that logic, and its tests, belong
  to LH-013 (field comparators), which this ticket does not touch.
- Integer identity columns (`generatedAlwaysAsIdentity()`), not `serial` — Postgres's own
  recommended replacement since v10, and pre-empts the identical suggestion CodeRabbit made
  on the TRO-456 scaffold PR for `_meta.id`.

**Known limits / not verified from this ticket.** `db:seed`'s only tested behavior is the
scripted insert path itself (run against a real database, output checked); it has no
Vitest coverage of its own, since it is a sequence of fixture inserts, not a pure function.
The `relations()` graph was verified to type-check and to match the FK structure by
inspection, not by exercising `db.query.*` relational reads end-to-end — no code in this
repo uses that API yet.

## FACTORY — merge-changes.mjs (2026-08-10)

**What changed.** Three tickets in a row (TRO-456 twice, TRO-457) hit the same `CHANGES.md`
merge conflict — every branch adds an entry at the top, so every concurrent merge collides on
the same lines. Per the recurrence-ladder rule in `references/lessons.md` ("3 = build the
mechanical fix"), added `scripts/factory/merge-changes.mjs --check`: parses the file into
whole entries (never line-by-line), checks per-entry fence balance, duplicate headings, and
(with `--expect TICKET`) that a specific ticket's entry survived intact. Wired into `gate.sh`
G7 alongside the existing ticket-ID grep. Negative-tested: a synthetic file with a spliced
fence and one with a duplicated heading both correctly fail; a well-formed file passes.

**How to run it.** `node scripts/factory/merge-changes.mjs --check CHANGES.md` (add
`--expect TRO-nnn` to also confirm one ticket's entry). Runs automatically as part of the gate.

**Rollback.** `git revert` this commit; G7 falls back to the grep-only check.

## TRO-456 — PR review round 2: CodeRabbit findings, 4 fixed (2026-08-10)

**What changed.** GitHub-App CodeRabbit reviewed PR #1 and requested changes. All four inline
findings were real defects in code this PR added; all four are fixed here.
- `playwright.config.ts` (major): read `PORT`/`APP_PORT` straight from `process.env` with no
  `.env.local` loader. A factory worktree works by accident (`.factory-env` exports the
  variable into the shell); a plain checkout following this PR's own "How to run it"
  instructions would silently fall back to port 3000. Added the same `dotenv` load
  `drizzle.config.ts` already uses.
- `src/lib/db/index.ts` (major): the `pg.Pool` had no `error` listener. An idle client that
  loses its connection emits `error` on the pool; with nothing listening, Node treats it as
  unhandled and can crash the process. Added a listener that logs and lets the pool recover.
- `src/lib/db/index.ts` (trivial): `connectionTimeoutMillis` defaulted to 0 (no timeout) on an
  unreachable database. Set to 10s.
- `src/lib/utils/format.ts` (minor): the third rounding-boundary bug in this function — `999.5`
  rounded to `"1000ms"` while `formatDuration(1000)` itself renders `"1.00s"`, because the
  millisecond branch decided its unit on the unrounded value. Rounds once now, before any
  branch. A standing lesson on this pattern is in `references/lessons.md`.

**How to run it.** `pnpm test` — one new case (`formatDuration(999.5)`). No other setup change.

**Rollback.** `git revert` this commit; each fix is independent of the others and of the
original scaffold commits.

## TRO-456 — LH-001: Scaffold Next.js + TS + Vitest + Playwright + Drizzle + CI (2026-08-10)

**What changed.** Stood up the working application scaffold (TH-R13, TH-R18, TH-R19) that
every later LabelHunter ticket builds on:
- **App shell:** Next.js 16 (App Router, TypeScript, strict mode) under `src/app/`, with a
  placeholder home page and a DB-free liveness route at `src/app/api/health`.
- **Toolchain:** pnpm (`packageManager` pinned), Node >=22. `pnpm typecheck` (`tsc --noEmit`),
  `pnpm lint` (real flat-config ESLint — `eslint.config.mjs`, Next's recommended rules +
  `@typescript-eslint`, plus two project rules: no `any`, no unused vars — verified it
  actually catches violations, not a vacuous config), `pnpm build` (`next build`).
- **Tests:** Vitest (`vitest.config.ts`) with one real unit test suite
  (`src/lib/utils/format.test.ts`, 4 cases) proving the runner executes real code. Playwright
  (`playwright.config.ts`) with one e2e spec (`e2e/health.spec.ts`) that builds, boots the app,
  and asserts a 200 from `/api/health`.
- **Database:** Drizzle + `pg`, `drizzle.config.ts`, a scaffold-only `_meta` table
  (`src/lib/db/schema.ts`) and its generated migration (`drizzle/migrations/0000_meta_healthcheck.sql`).
  `pnpm db:generate` / `pnpm db:migrate` (`drizzle-kit generate` / `drizzle-kit migrate`).
  Migration applied to and verified against this worktree's own Postgres database (queried
  directly, not just exit-code-trusted). Ticket LH-002 (TRO-457) extends `schema.ts` with the
  real product tables.
- **Repo layout for later tickets:** `src/server/{router,extractor,resolver,warning}/` and
  `src/worker/` reserved (each has a `.gitkeep` naming the ticket that owns it) per PRD §3.6 —
  no subsystem logic implemented here.
- **`.env.local.example`** documents the required env vars for a plain clone (`DATABASE_URL`,
  `PORT`, and the not-yet-wired `ANTHROPIC_API_KEY`).

**A real toolchain bug found and fixed, in scope for this ticket:** `pnpm run <script> --
<args>` forwards the literal `--` token into the script's argv (unlike `npm`, which strips
it). Vitest's CLI then treats that leading `--` as "everything after this is a positional
test-name filter," so `--reporter=json --outputFile=<path>` — exactly how `scripts/factory/gate.sh`
and `.github/workflows/ci.yml` invoke `pnpm test` — is silently ignored: tests still run, but
no JSON report is ever written. Fixed by routing the `test` script through
`scripts/run-tests.cjs`, a small wrapper that strips one leading `--` before handing argv to
vitest. Confirmed the exact gate invocation (`pnpm test -- --reporter=json
--outputFile=<absolute path>`) now writes a valid report. The same pnpm quirk broke
`pnpm start -- -p <port>` in `playwright.config.ts`'s `webServer.command`; fixed by passing the
port via the `env` option instead (`next start`/`next dev` both honor `PORT`).

**How to run it.** `pnpm install`, then `cp .env.local.example .env.local` and point
`DATABASE_URL` at a running Postgres (or, in a factory worktree, `source .factory-env` — it's
already provisioned). `pnpm db:migrate` to apply migrations, then `pnpm dev` (or `pnpm build &&
pnpm start`) to run the app. `pnpm test` for unit tests, `pnpm test:e2e` for Playwright,
`pnpm typecheck` / `pnpm lint` / `pnpm build` for the rest of the gate.

**Rollback.** `git revert` this ticket's commits on `feat/lh-scaffold` (or delete the branch
before merge). No product code depends on this yet — reverting only removes the scaffold
itself. The worktree's database (`labelhunter_wt_tro_456`) can be dropped and recreated; the
`_meta` table is scaffold-only and holds no data of consequence.

**Known limits / not done here (see final ticket report for detail).** The broader gate
self-verification suite named in `factory/config.yaml`'s `verification:` block (no-op branch
fails, forged break-one/fix-one caught, quarantine-not-widenable-from-branch, `worktree.sh`
run twice in a row, a real CI run on an opened PR) was **not** run from this ticket — it needs
the orchestrator (this agent was told not to edit `factory/config.yaml`, `scripts/factory/gate.sh`,
or `.github/workflows/ci.yml`). This ticket ran `scripts/factory/gate.sh` (no flags) itself and
reports that verdict verbatim.

**Gate bug found, not fixed here (out of scope — see final ticket report).**
`scripts/factory/gate.sh`'s lint-detection line (`if ls eslint.config.* .eslintrc* ...`)
always reports `lint: skip` for a project using only one of the two config styles — `ls`
exits non-zero if *either* glob has no match, even when the other matched a real file. This
repo ships a real, working flat config (`eslint.config.mjs`, verified below) but the gate
still shows `skip`. Not edited per this ticket's instructions (gate.sh is the orchestrator's
file); flagging for a fix there.

**CodeRabbit review triage (3 findings, all addressed or explicitly skipped):**
- `src/lib/utils/format.ts` (minor): `formatDuration` could render `119.6s` as `"1m 60s"`
  instead of `"2m 0s"` (rounding minutes/seconds separately let the remainder hit 60). Fixed —
  round the total once, then derive minutes/remainder from that. Added a regression case.
- `src/app/api/health/route.ts` (trivial): add `Cache-Control: no-store` so a proxy/CDN never
  caches a stale liveness result. Fixed; e2e spec now asserts the header.
- `drizzle/migrations/0000_meta_healthcheck.sql` (trivial): suggested `bigint identity` instead
  of `serial` for `_meta.id`. Skipped — `_meta` is a scaffold-only healthcheck table that LH-002
  replaces with the real schema; not worth a churn migration for a table this ticket doesn't
  expect to survive past the next one.

## FACTORY — gate.sh lint-detection fix (2026-08-10)

**What changed.** `scripts/factory/gate.sh`'s lint-config check used
`ls eslint.config.* .eslintrc*`, which fails if *either* glob has no match — so a repo with
only `eslint.config.mjs` (no `.eslintrc*`) always read as "no config found" and G2 stayed
`skip` forever, even with a real, working lint config in place. Found by the TRO-456 scaffold
agent while gating its own branch. Fixed with `compgen -G`, which tests each pattern on its
own.

**How to run it.** No action needed; the next `scripts/factory/gate.sh` run picks it up.

**Rollback.** `git revert` this commit; the check reverts to always-skip, which is safe
(under-detection, not over-detection) but wrong.

## FACTORY — CLAUDE.md and writing-style rules (2026-08-10)

**What changed.** Added `CLAUDE.md` at the repo root. It orients any agent to the PRD, the
requirements inventory, and the factory. It sets one writing rule for all prose Claude writes
here: follow ASD-STE100 (one meaning per word, active voice, short sentences) and Zinsser's
four principles (simplicity, brevity, clarity, humanity). Updated
`.claude/skills/labelhunter-factory/references/agent-contract.md` to list `CLAUDE.md` as the
first required read, matching the reference factory's own pattern.

**How to run it.** Nothing to run. Every future agent session reads `CLAUDE.md` first.

**Rollback.** Delete `CLAUDE.md`; revert the one-line addition to `agent-contract.md`.

## FACTORY — labelhunter factory build (2026-08-10)

**What changed.** Stood up the ticket factory: `factory/` (config, quarantine baseline,
scorecard, review ledger), `scripts/factory/` (gate, worktree provisioner, testdiff,
review-ledger, status), the `labelhunter-factory` orchestrator skill with its references
(agent contract, escalation incl. CP-1/2/3, triage, lessons), CI workflow, and the ticket
decomposition in `factory/tickets.md` mirrored to Linear project **LabelHunter**.

**How to run it.** `node scripts/factory/status.mjs` for state;
`scripts/factory/worktree.sh TRO-<n> <branch>` to provision;
`scripts/factory/gate.sh` inside a worktree to gate. The orchestrator loop is
`.claude/skills/labelhunter-factory/SKILL.md`.

**Rollback.** Delete `factory/`, `scripts/factory/`, `.claude/skills/labelhunter-factory/`,
and `.github/workflows/ci.yml`; archive the Linear project. No application code is touched —
none exists yet.

**Known limits.** The gate is UNVERIFIED pre-scaffold (`factory/config.yaml` → `verification`);
nothing merges on gate evidence until the scaffold ticket runs the verification checks.
