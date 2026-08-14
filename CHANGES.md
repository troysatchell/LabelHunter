# Changes

Per-ticket changelog. Every factory PR adds an entry at the top naming its ticket ID(s):
what changed, how to run it, how to roll it back. The gate greps for the ticket ID with
anchored boundaries — `TRO-30` will not match inside `TRO-301`.

## LOCAL-taste1 — a UX polish pass across every screen, audited against design-taste-frontend's applicable rules and TH-R3 (2026-08-13)

**Troy's direction:** apply the `design-taste-frontend` skill's taste "across the entire
app." Keep the Notion-style look TRO-573/578 already established. Keep the UI clear enough
for a 73-year-old first-time user, a 50-year-old, and a 25-year-old alike.

**Scope decision, made explicit before any code changed.** `design-taste-frontend` is
written for marketing landing pages and portfolios. Its own Section 13 lists dense product
UI, multi-step forms, and data tables as out of scope — LabelHunter is exactly that. Hero
sections, bento grids, marquees, and GSAP scroll patterns do not apply here and none of
that landed. What does transfer to any UI: consistency locks (one accent, one radius
scale, one token source), button/form contrast checks, and content-density discipline for
lists. Also transferable: full interaction-state coverage and the AI-tell bans (em-dash,
filler verbs). This ticket audited all 8 app surfaces against that applicable subset, plus
TH-R3, before writing any fix. This is a "redesign-preserve" per the skill's own protocol,
not a new visual language.

**What the audit found already solid, and left untouched:** the token system itself
(zero hardcoded colors across every surface), the light-only decision, the icon-plus-text
verdict pattern (never color alone), the loading/empty/error state conventions, and
focus-visible handling.

**Real defects fixed, not just polish:**

- `ReviewItemDetail.tsx`'s per-field verdict colors were silently broken. `VERDICT_ROW_CLASS`
  pointed at `checklist-row--*`, a class family sharing no selector with `.review-field`'s
  own later, equal-specificity `border-left` shorthand in `globals.css` — every row on this
  screen (its own header comment calls it "the differentiator") rendered with a flat neutral
  border and a plain dark icon regardless of match/mismatch/review. Repointed at the
  already-defined, already-correct `review-field--*` family.
- `VerifyForm.tsx` kept native HTML `required` on five controls while the photo field alone
  used a custom, TH-R3-motivated validation message. A native browser tooltip fires before
  `submit` and blocks it outright, so on a form with more than one empty field the native
  tooltip preempted the one custom message the app invested in. Dropped `required`
  everywhere in this form; one JS validation strategy now covers brand name, class/type, and
  net contents (beverage type and the units select can never actually be empty — both carry
  a default).
- `ReviewQueueBrowser.tsx` showed "Could not refresh the review queue" even when the
  reviewer had clicked "Load more," not Refresh. The error phase now carries which control
  failed and the title matches it.
- `BatchUploadForm.tsx`'s start-error panel showed a generic title regardless of kind, so a
  `RATE_LIMITED` or `BUDGET_EXHAUSTED` rejection (PRD §8's key-protection guard) lost its
  specific reason the instant a reviewer pressed "Start batch" instead of "Preview." Now
  reuses the same `PREVIEW_ERROR_TITLE` lookup the preview-error panel already had.

**Readability and consistency fixes:**

- The batch results table — the app's one real data table, built for 200-300 rows (TH-R4) —
  carried its per-row verdict text at the smallest size in the type scale and showed only a
  camera filename, never the brand name, as the row's identity. Raised the table's body text
  to the standard size (headers stay at the smaller "meta" size) and added the brand name as
  a visible second line under the filename.
- A batch that could not start rendered with the exact same neutral banner as an in-progress
  batch, and the passive `role="status"` every other genuine failure in this app avoids.
  Added a distinct, `.error-panel`-consistent treatment and switched to `role="alert"`.
- Approve/Reject gave no in-flight feedback while a decision was submitting — only the
  shared 65%-opacity disabled style, no label change, no announcement. Both buttons now swap
  to "Recording…" and add a `role="status"` line, matching the "X-ing…" convention every
  other submit control in this app already uses.
- The access-code field — the first screen every user hits — was `type="password"`, even
  though `ACCESS_CODE` is a shared, non-secret string from an invitation, not a personal
  password. Unmasked it (`type="text"`, with autocapitalize/autocorrect/spellcheck off so a
  phone keyboard cannot mangle it).
- The `⚠` NEEDS_REVIEW icon was a bare codepoint that some platforms render as a full-color
  emoji, breaking the "one quiet accent color" rule on the one verdict icon most likely to
  trigger it. Appended the text-presentation variation selector in both files that define it.
- Added an `error.tsx` boundary for the verify-detail route — the one purely
  server-rendered read path in the app had a designed 404 but no designed treatment for a
  thrown exception, which fell through to Next's own default page.
- Removed the three em-dashes that had reached rendered UI copy (a validation message and
  two brand/class-type context lines) — code comments were left untouched; the ban is on
  user-visible text, not internal documentation.

**How to run it.** `pnpm dev`, then walk every screen: `/access-code`, `/`, `/verify/[id]`,
`/batch`, `/batch/[id]`, `/review-queue`, `/review-queue/[id]`. No new command, no
migration, no config change.

**Rollback.** Revert the PR. No schema change, no migration.

**Confirmed.** Every fix has a red-first regression test: I verified each one fails for the
right reason with the fix reverted (`git stash`), then passes restored. The full suite —
2634 tests across 199 files — passes. `pnpm typecheck` and `pnpm lint` are clean (one
pre-existing `next/image` warning on `LabelImageFigure.tsx`, from TRO-582, not touched
here). Checked for conflicts before starting: the two PRs open at the time (TRO-580,
TRO-510) touch only `src/app/api/verify/route.ts` and `scripts/golden/`, neither overlapping
this ticket's files.


## TRO-583 — retry the OCR channel once before it degrades to single-channel (2026-08-13)

**The problem.** The OCR channel can fail three ways. Tesseract can time
out (TRO-519). It can throw. It can return a read below `reconcile.ts`'s
`OCR_CONFIDENCE_FLOOR`. Every one of these degrades the label to
single-channel. The VLM reading alone then decides the verdict. The
deployed Fairview seeded row hit this during the TRO-571 OOM window: the
OCR channel failed, and the verdict fell back to the VLM channel alone.

**Troy's escalation rule for this ticket.** "If it doesn't know it should
pass it on to the next tier." A bad OCR reading needs a better read, not a
smarter judge. The Sonnet resolver stays structurally forbidden from
ruling on the warning (CP-1, `resolver/schema.ts`, untouched here). So the
fix is a retry, not an escalation to a model.

**What changed.** `src/server/warning/ocr-retry.ts` is new. It adds two
pure functions:

- `shouldRetryOcr` — true when the first OCR attempt is `null` (TRO-519's
  shared timeout-or-thrown shape), or its confidence sits below
  `OCR_CONFIDENCE_FLOOR`. That is the SAME constant `reconcile.ts` already
  uses, imported here, not re-guessed.
- `buildOcrRetryVariant` — upscales the crop 2x (`OCR_RETRY_UPSCALE_FACTOR`)
  with sharp and re-encodes to PNG. This matches `region-detect.ts`'s own
  `cropForOcr` encoding.

`src/server/warning/index.ts`'s `runOcrChannel` calls `shouldRetryOcr`
right after the first `deps.ocr(crop)` call. On a pass, nothing else
runs. The happy path is unchanged, byte for byte. On a failure, it builds
the variant from the SAME crop — no second region detection, no re-crop —
and retries OCR once. `retryOutcome ?? firstResult` is what reaches
`reconcile.ts`. The retry's read wins when it exists. When the retry also
fails, the exact single-channel path that ran before this ticket runs
again. `reconcile.ts`'s verdict tables are untouched.

**Why upscale, not threshold (the ticket named both as options).** The
corpus's own measured OCR failure mode is tiny print, not poor lighting.
`OCR_CONFIDENCE_FLOOR`'s own comment names case-23/24 ("tiny warning
print") as the cases whose confidence sits in the failure range. That is a
resolution problem. The corpus's other named failure mode is lighting
(case-22). Region DETECTION already handles that one, upstream, before a
crop like this even exists (TRO-546's per-row background estimate).
Thresholding the crop here a second time would fight that already-tuned
estimate, not help it. Upscaling has no such conflict. It is the textbook
remedy for a resolution problem.

**Bound (TH-R2).** Each OCR attempt is bounded independently by TRO-519's
`OCR_TIMEOUT_MS` (2000ms). The retry's own `deps.ocr` call is an ordinary
second `runWarningOcr` call, with its own independent timeout — never one
call sharing a timer with another (lessons rule 23).

One gap remained after the first draft. `deps.buildRetryVariant` itself is
a sharp call with no timeout of its own. It sat unbounded between the two
OCR calls. A local CodeRabbit review round 1 finding caught this.

The fix: `runRetryPhaseWithDeadline` (`index.ts`) races `buildRetryVariant`
then `deps.ocr` together, against ONE shared `OCR_TIMEOUT_MS` timer. That
is the same constant the first attempt already trusts, not a new number. A
timeout here abandons the retry and keeps the first attempt's own result.
It never starts a third attempt.

This makes the channel's worst case exactly `2 * OCR_TIMEOUT_MS` = 4000ms,
provably — not just in the common case where `buildRetryVariant` happens
to be fast. This bound applies only on the failure path. The happy path's
timing is unchanged by construction.

Two tests prove this end to end, with fake timers, against the real
`runWarningOcr`: `index.test.ts`'s "OCR channel timeout (TRO-519,
TRO-583)" test (the first attempt times out, then the retry's own OCR
call also times out) and its "buildRetryVariant itself never resolves"
test (the variant-build step itself hangs, and the retry never reaches a
second `deps.ocr` call at all).

**Measured, not fabricated.** Ran `buildOcrRetryVariant` + `runWarningOcr`
against every golden-set crop region detection can find. That is 31 of 35
warning-bearing cases — case-20/22/38/39 find no region at all, a
pre-existing, unrelated gap. This ran locally, tesseract only: no network
call, no Anthropic API call, no database write.

Total retry-path cost (variant build + retry OCR), n=31, milliseconds:
min 338, p50 427, p95 571, max 712, mean 440.

Every measured case landed well under the 2000ms `OCR_TIMEOUT_MS` bound.
Side observation: case-23 is one of the two tiny-print cases
`OCR_CONFIDENCE_FLOOR`'s own comment names, measured there at confidence
58 on the un-upscaled crop. In this same run, it read back at confidence
93 after this ticket's 2x upscale. One case is not proof the variant fixes
tiny print in general. It is direct evidence the chosen variant targets
the failure mode it was chosen for.

Deployed p95 re-measurement: not measured on the deployed instance. That
is out of this ticket's scope. A live end-to-end harness run was
considered and skipped. Reason: the retry fires only after a first-attempt
failure, and this measurement already shows most golden-set crops read
well above the confidence floor on a first attempt. A live run would
mostly reproduce the existing `eval:check` baseline, not add
retry-specific evidence.

**Tests.** `src/server/warning/ocr-retry.test.ts` (new, 7 tests) covers
`shouldRetryOcr` and `buildOcrRetryVariant` in isolation, no OCR call.
`src/server/warning/index.test.ts` adds a dedicated "OCR retry (TRO-583)"
block (5 tests):

- Retries once on a `null` first attempt. Reconcile receives the retry's
  read — `result.comparator.channel === "dual"` proves this, since only
  `reconcileDualChannel` ever sets that.
- Retries once on a read below `OCR_CONFIDENCE_FLOOR`.
- Retries at most once when the retry also fails. Falls back to exactly
  today's single-channel path (`channel === "single"`).
- Never calls `buildRetryVariant`, and calls `ocr` exactly once, when the
  first attempt already succeeds.
- Degrades within `OCR_TIMEOUT_MS`, and never calls `ocr` a second time,
  when `buildRetryVariant` itself never resolves (the round-1 finding's
  own regression test).

The existing TRO-519 timeout test is updated to advance fake time twice
(`2 * OCR_TIMEOUT_MS`) and assert `ocr` was called exactly twice — the
same bounded-degradation property, now proven across both attempts.

Confirmed red first for all of this, twice over. First pass: reverted the
retry wiring in `runOcrChannel`, and separately stubbed `ocr-retry.ts`'s
own two functions, then reran. Every new or changed assertion failed on a
real call count or a real return value, never an import or type error.
Second pass, after the round-1 finding: reverted `runOcrChannel` to the
unbounded pre-fix shape and reran the new "buildRetryVariant itself never
resolves" test. It failed with a real 5-second test timeout — the hang
this fix exists to close. Restored the real implementation both times;
all tests green after.

**Rollback.** Revert the PR. `runOcrChannel` returns to a single
`deps.ocr` call. `ocr-retry.ts` stays unused and can be deleted.

## TRO-510 — realistic-corpus pilot-batch hardening (2026-08-13)

**The point.** A real bottle reference and one real Gemini-generated backdrop already exist
(`spirits-bottle-01`, `compliance-desk`, `steady` — committed before this ticket). No
manifest case uses `rendered+ai-backdrop` provenance yet. `build.ts`'s compositing step has
never produced real output. A whole-branch review bundled four findings and six minor fixes.
This ticket lands them before the first real pilot batch scales up. The tests made no real
Gemini or Anthropic API calls. They used fakes and fixtures.

**Finding 1 — the label warp aliased.** `compositeBackdrop.ts` minified the renderer's
1000x800 label onto a typical ~300x500 quad with pure nearest-neighbor sampling: a
point-sample downsample that can drop or duplicate a thin warning-text stroke.
`compositeLabelOntoBackdrop` now pre-resizes the label with `sharp`'s lanczos3 kernel to
approximately the quad's own extent first. Aspect-ratio decision: resize non-uniformly to
the quad's edge lengths (accept the stretch), not letterboxed. The warp is already a general
affine map driven by the quad's shape; letterboxing first would only add blank padding bars
that the same warp would then stretch into the photo.

**Finding 2 — a wrong caseId failed with a bare file-not-found error.** A hand-authored
manifest entry must reuse the sidecar's exact generated `caseId`. Getting it wrong failed
`pnpm golden:build` with a bare Node ENOENT — no case name, no hint. `build.ts` now wraps
the read in a try/catch that names the case and the expected path. `golden-set/README.md`'s
fold-in recipe now states the `caseId`-matching rule explicitly.

**Finding 3 — already fixed.** The finding claimed `generateWithGemini` hardcodes
`mimeType: "image/jpeg"` (`imagen.ts:98`). Current code (`imagen.ts:221-246`) already derives
the reference photo's MIME type from its real content (`detectImageMimeType`), landed by an
earlier commit on this same file. No change needed — line numbers in the finding were stale
against `main`.

**Finding 4 — the pilot gate had no tooling affordance.** The design's hard gate (one bottle,
6 images, 5 pass criteria, before generating the full corpus) was undocumented.
`golden-set/README.md` now states the gate, its five criteria, and the workaround for running
only the pilot batch: `pnpm golden:imagen` has no `--bottle`/`--limit` flag by design (not
required by this ticket), so the pilot run temporarily moves every other bottle reference
JSON out of `assets/golden/references/`. Paid-spend safety, which the ticket called
worth fixing regardless of the flag question: `imagen.ts`'s generation loop had no
per-target error boundary and no skip-existing check, so one transient failure aborted a
paid batch and a rerun re-paid for every target already generated. The loop is now the
exported `runGenerationBatch`, with three outcomes per target. It skips one whose backdrop
and sidecar both already exist (no re-spend). It recovers one whose backdrop exists but
whose sidecar does not — a prior run's paid call that never reached the sidecar write —
by rebuilding the sidecar from the existing backdrop, with no new Gemini call.
Otherwise it generates fresh, and one target's failure no longer stops the rest. `generateOne`
now writes the backdrop PNG immediately after the paid call returns, before detection or the
sidecar write, so a later failure in either step still leaves a real, recoverable backdrop on
disk. If a target still fails after the paid call succeeded, the run's spend total counts it —
checking for the now-written backdrop on disk — instead of undercounting a real charge.

**Minor fixes, same pass.**
- `imagen.ts`'s sidecar now writes `labelPlacement` as the 4 corners only, matching the
  manifest's own `LabelPlacementQuad` shape exactly. Detector bookkeeping (`pixelCount`,
  `imageWidth`, `imageHeight`) moves to a sibling `detection` key, so it stops accreting into
  `manifest.json` when a human copies the sidecar's `labelPlacement` field in.
- `imagenPrompt.test.ts` gained a 3-line test parsing `BLANK_LABEL_COLOR_HEX` and asserting
  it equals `BLANK_LABEL_COLOR_RGB` — the two were independently authored literals with a
  comment claiming they cannot drift; nothing enforced that claim before.
- `build.ts`, `images.test.ts`: swept three stale "LH-005" comments to "a future ticket,"
  matching `golden-set/README.md`'s own wording for the still-unbuilt `ai-generated` track.
- `blankRegionDetector.ts`: fixed `MAX_REGION_FRACTION`'s comment. It had its subject and
  effect backwards against `MIN_REGION_FRACTION`'s own comment right above it.
- `golden-set/README.md`: added a note under the build step that a composited photographic
  JPEG is denser than a flat rendered label and should not be expected to land under the
  same ~500KB target.
- `imagen.ts`'s missing-`GOOGLE_API_KEY` error names sourcing `.factory-env` or exporting the
  variable directly. It no longer mentions `.env.local` — confirmed by a direct test that
  `tsx` does not load it, so that advice did not work.
- `build.ts`'s backdrop-read catch now checks the caught error's `code`. Only `ENOENT` gets
  the named "no file exists" message; any other filesystem error (a directory in the way,
  a permission failure) now passes through unchanged instead of being mislabeled.

**How to run it.** No new command. `pnpm golden:imagen` now skips a completed target,
recovers one with a missing sidecar, and continues past one target's failure. It also counts
a failed target's spend when its paid call already succeeded. `pnpm golden:build` now reports
a case-specific error for a missing backdrop, instead of a bare file-not-found. `pnpm test --
scripts/golden` runs the new and changed tests.

**Rollback.** Revert the PR. No schema field was removed. A committed sidecar this ticket's
code wrote (the split `labelPlacement`/`detection` shape) stays valid input for the manual
fold-in step. A revert restores the old writer, so a fresh `pnpm golden:imagen` run after
reverting writes the old flat shape again. No manifest entry needs editing either way — no
`rendered+ai-backdrop` case exists yet.

**Confirmed.** `pnpm typecheck` and `pnpm lint` are clean. This ticket added 12 tests: 3 in
`compositeBackdrop.test.ts`, 2 in `build.test.ts`, 6 in `imagen.test.ts`, 1 in
`imagenPrompt.test.ts`. Every new regression test was confirmed to fail for the stated reason
before its fix and pass after. No API call was made. Every test uses a fake generator or a
synthetic `sharp` fixture. The full unit suite passes at this commit: 2622 tests across
196 files. That total includes every sibling ticket merged into this branch since; it will
read differently after the next merge, by design, not by drift. This entry covers three
rounds on the same branch — two local review rounds and this PR-review resync — folded into
one account rather than left as separate, partly-stale write-ups (lessons.md rule 17).

## TRO-580 — verify route now settles real spend on a validation-failed extraction (2026-08-13)

**The gap (TH-R6).** `/api/verify` reserves budget, then calls Haiku, then settles the
reservation. On a genuine extraction failure, the route settled the reservation with a
hardcoded 0. The hardcoded 0 refunded the full reservation, every time. A full refund was
correct for a transport failure — no response at all. A full refund was wrong for a
`HaikuExtractionError`. The model did respond. `parseExtractionResponse` rejected the
response's shape. The paid call already happened. Every malformed-response extraction
under-counted the daily budget. TRO-576 found and fixed the identical gap in `/api/extract`
first. This ticket mirrors that fix in `/api/verify`.

**The fix.** The fix is in `src/app/api/verify/route.ts`, inside the `Promise.all` catch
block around the Haiku call. That block now reads `usageCapture.takeLastUsage()` before it
settles the reservation — the same read the success path already does — instead of passing
a hardcoded 0. A model response that fails validation still sets this usage before the
throw: `client.messages.create` resolves first, and `parseExtractionResponse` runs after,
so only `parseExtractionResponse` can throw. A genuine transport failure never reaches
`client.messages.create`. `takeLastUsage()` still answers `null` in that case, so the route
still refunds the reservation in full — the same behavior as before this ticket.

**Confirmed against the post-TRO-566 route.** TRO-566 changed this route's budget calls.
The old plain `checkBudget`/`recordSpend` pair became an atomic `reserveBudget`/
`settleBudget` reservation. The gap TRO-580 fixes was still present in the merged code: the
catch block settled with a hardcoded 0, no matter what usage the wrapped client had already
captured.

**Confirmed.** New regression test in `src/app/api/verify/route.test.ts`: "settles the REAL
captured usage when the model responded but its output failed validation (TRO-580)". A fake
`extractLabel` makes one call through the usage-capture wrapper, then throws
`HaikuExtractionError`. The test checks that `settleBudget`'s real-cost argument equals
`haikuCallCostUsd`'s own computed cost for that usage — the SAME pricing function the route
itself calls, not a second copy of the formula. Red first: before the fix, the test failed
with `expected 0 to be greater than 0`, confirming the old hardcoded-0 path. Green after the
fix. Full `route.test.ts` suite: 37 tests, all passing, including the pre-existing
transport-failure test (`records nothing when the Haiku call itself fails`) — this confirms
the null-usage-still-settles-0 path did not change. `pnpm typecheck` is clean.

**How to run.** `pnpm vitest run src/app/api/verify/route.test.ts`.

**Rollback.** Revert the PR. The route goes back to refunding every extraction failure in
full, including a validation failure that followed a real, paid response.

## TRO-582 — a dedicated image box on a grid, and the warning card shows the real texts (2026-08-13)

**Troy's direction:** "make a dedicated image box, use a grid." Troy also reported earlier
that the warning row's application-side placeholder ("the statutory warning text, 27 CFR
part 16") read like missing application data.

**The layout.** Both detail surfaces (`DetailView`, `ReviewItemDetail`) now share one CSS
Grid (`.detail-layout`, 2fr/3fr `minmax` columns). The single-column collapse below 48rem is
declared explicitly. The label image lives in a shared `LabelImageFigure` component. It is a
quiet well on the alt background. `object-fit: contain` with a capped height means a tall
label never pushes the fields below the fold and is never cropped. The persisted original
filename renders as a functional caption. The box is sticky in its column on desktop, so the
artwork stays in view while the reviewer scrolls the field rows they check against it.
The design read follows the design-taste discipline: this is trust-first product UI, so the
layout uses a plain grid and adds no decoration.

**The warning card.** The warning row now shows the real texts on all three surfaces
(`ResultsChecklist`, `DetailView`, `ReviewItemDetail`). The transcription renders with its
deviating words marked. The statute renders verbatim under "What TTB requires" — one source,
the comparator's own `CANONICAL_WARNING_TEXT`, never a second copy. The marks come from
`diffWords` (`src/app/_lib/word-diff.ts`), an LCS word alignment. The alignment is
display-only: the verdict and reason still come from the comparator (standing rule 11).
Marks use background tint plus weight — never color alone. Required words the label drops
with no replacement surface as an explicit `[missing: …]` indicator where they belong. A
substitution gets no second marker: the replacement's own mark carries the signal. Review
round 1 caught this class — an omitted clause was previously invisible. Casing
deviations are deliberately NOT marked by the diff. The caps check's reason line already
carries them, and marking every token of a title-case warning would bury the wording
signal.

**Rollback.** Revert the PR. The surfaces return to the flex layout, the bare image, and
the placeholder citation.

**Confirmed.** The branch adds 15 tests. `word-diff` has 10: the case-10 paraphrase marks
exactly "pregnant, consume, due, to"; a verbatim warning marks nothing; a title-case warning
marks nothing; the three omission scenarios pass. `WarningTranscription` has 3 and
`LabelImageFigure` has 2. I updated one superseded DetailView assertion: the statute itself
replaces the placeholder citation, and the test restates the standing-rule-11 boundary. All
389 app tests pass, including the TRO-578 token gate and the contrast test. I verified the
change live: one real verify call against the local app with the case-10 image rendered the
grid, the sticky image box, and the marked paraphrase. The PR carries the screenshot.
`pnpm typecheck` and `pnpm lint` are clean.
