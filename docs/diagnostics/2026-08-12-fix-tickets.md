# Fix tickets from the 2026-08-12 diagnosis

Drafted and citation-checked by workflow `wf_f0165381-2bb`. 476 citations opened, 88 corrected.

Mirrored to Linear. This file is the reviewable source.


---

# S1 · Guard the beverage_type cross-check — an off-menu subtype suppresses a statutory FAIL

**Priority:** 1 · **Graded:** TH-R9, TH-R17, TH-R19

**Size:** Small. The router change is about ten lines in one file, plus one import. Two new tests go beside the existing block in `src/server/router/index.test.ts`. Two live single-case Haiku calls: one to confirm the cause, one to read case-22's new verdict. Step 1 also needs a temporary debug print, which the branch must not keep — the harness does not expose the raw extraction today. No migration, no schema change, no prompt change, no checkpoint sign-off. The reasoning is the expensive part, not the diff.

TH-R9, TH-R17, TH-R19. Blocked by nothing. Related: TRO-502 — read it, do not duplicate it.

## Why

**Measured.** `scripts/eval/results/eval-report.json`, run `2026-08-12T13:26:45.488Z`, mode `live`, model `claude-haiku-4-5`:

| case | expected | actual | headline reason |
| -- | -- | -- | -- |
| case-11-reworded-warning-clause-two | FAIL | REVIEW | `CONFLICTING_EXTRACTION` |
| case-10-reworded-warning-clause-one | FAIL | FAIL | null |

Both cases reword the government warning. Both carry rubric vector V3 (`audit/rubric.md:105`). One returns FAIL. One does not.

**The warning subsystem is right.** case-11's `government_warning` row scored `expectedVerdict: MISMATCH`, `actualVerdict: MISMATCH`, `correct: true`. I confirmed it a second way. I ran `compareGovernmentWarningFromImage` against `golden-set/images/case-11-reworded-warning-clause-two.jpg` from a scratch script outside the repo. Real region detection ran. Real Tesseract OCR ran. No model call ran. It returned `{"verdict":"MISMATCH","note":"Government Warning wording differs from the required text."}`.

**A router blocker on an unrelated field suppresses the FAIL.**

```ts
const beverageTypeDisagreesWithApplication =
  extraction.beverage_type.value !== null &&
  normalizeForBoundaryMatch(extraction.beverage_type.value) !== normalizeForBoundaryMatch(application.beverageType) &&
  extraction.beverage_type.confidence >= TRUSTED_THRESHOLD_DEFAULT;
```

`src/server/router/index.ts:166-169`. That flag feeds `isConflictingExtraction` (`index.ts:171-186`, `src/server/router/label-blockers.ts:69-76`). `isConflictingExtraction` sets `labelLevelBlocker` (`index.ts:188`). `src/server/router/rollup.ts:15` then returns REVIEW. Line 17 never reads the MISMATCH.

**Neither record is wrong.** case-11's label prints `Mead` (`golden-set/manifest.json:595`). The application declares beverage type `wine` (`:584`) and class type `Mead` (`:588`). TTB classes mead as a wine. The check calls that a conflict.

**The comparison is the defect.** `normalizeForBoundaryMatch` applies NFC composition, a lowercase fold, an ß fold, and a whitespace collapse (`src/server/router/text-boundary.ts:46-53`). It carries no vocabulary guard. The application side holds a closed enum: `BEVERAGE_TYPES = ["beer", "wine", "spirits"]` (`src/lib/db/enums.ts:18`). The form rejects `mead` by name (`src/app/api/verify/parse-request.test.ts:67-76`). The extractor side holds an open string: `beverage_type` is a bare `$ref` to `$defs/field`, and that definition carries no enum (`src/server/extractor/schema.ts:56`, `:88-100`). The prompt states the vocabulary in prose only (`src/server/extractor/prompt.ts:65-66`). The router compares a closed enum against an open string by equality.

CP-1 states the premise the check rests on. "A confident spirits reading against a declared wine application means one of the two records is wrong" (`docs/checkpoints/cp1-cascade-router-prompts.md:507-509`). The premise holds for `spirits` against `wine`. It does not hold for `Mead` against `wine`.

**The existing tests cover in-vocabulary inputs only.** `src/server/router/index.test.ts:137-147` covers a casing and whitespace slip. `:149-156` covers a real `wine`/`spirits` swap. `src/server/router/label-blockers.test.ts:133-135` sets the boolean directly and never runs the comparison. No test feeds an off-menu value.

**Graded exposure.** TH-R9's acceptance evidence reads "reworded warning → fail" (`audit/requirements/inventory.md:87`). Rubric V3 reads FAIL (`audit/rubric.md:105`). This is the only miss in the run that breaks a graded acceptance line outright. A fix here outranks every ungraded fix in the same triage.

### Honest limit on the evidence

The triage report rates this diagnosis medium confidence. I confirmed why. The eval harness never records `beverage_type`. `scripts/eval/extraction-scoring.ts:254-266` scores five fields, and `beverage_type` is not one of them. No committed artifact holds the value, the evidence string, or the confidence that fired the blocker.

Correlation isolates it. I counted all four numbers myself:

1. case-11 and case-22 are the only two of the 32 manifest cases whose `classType` is `Mead`.
2. Both declare `beverageType` `wine`.
3. They are the only two cases in the run that returned `CONFLICTING_EXTRACTION`.
4. No golden label prints a category word. The renderer emits brand, class type, ABV, net contents, and the warning block, and nothing else (`scripts/golden/render.ts:286-292`, `:373-383`). All 32 cases sit in the same position for `beverage_type` evidence. Only two blocked.

Two other inputs stay possible. The report names both in section 7 item 3.

- `beverage_type` carried an empty evidence string, so override rule 1 rejected the field (`src/server/router/overrides.ts:134`). **TRO-502 owns that half.**
- `image_quality.confidence` was not a valid number (`src/server/router/index.ts:180`).

Step 1 below settles which input fired, for the price of one Haiku call.

### A consequence the triage report does not state

I derived this from the measured rows. I did not measure it. case-22 returned REVIEW with headline `CONFLICTING_EXTRACTION`. `LOW_IMAGE_QUALITY` outranks `CONFLICTING_EXTRACTION` (`src/server/router/precedence.ts:19-20`), so `LOW_IMAGE_QUALITY` did not fire on case-22. All five of case-22's field rows returned an **actual** verdict of MATCH — including `government_warning`, where the manifest expects NEEDS_REVIEW. Remove the blocker and case-22 carries no blocker and no non-MATCH row. It then returns PASS. case-22 expects REVIEW.

So the headline moves like this. case-11 turns correct. case-22 turns incorrect. Label-verdict accuracy stays at 21/32.

**Do not report this fix as a scoreboard gain.** Report what it does. The router stops suppressing a statutory FAIL. It also stops returning the right verdict on case-22 for the wrong reason. Both are honest-evidence wins under PRD §6.

### Relationship to TRO-502

TRO-502 carries a dated update of 2026-08-12. That update names this same defect and hands it to a separate ticket. Keep that split. TRO-502 owns override rule 1 and CP-1 §3.2's rule 3. This ticket owns the router's vocabulary guard. They share one root cause — a free-form extractor field compared against a closed application enum — and both tickets name it.

## Do

1. Read `beverage_type` from a live single-case run. The bare command is not enough. `pnpm eval:check -- --live --case=case-11-reworded-warning-clause-two` prints a `CascadeCaseResult` (`scripts/eval/check.ts:157`), and that type carries scores only. `runOneCase` returns the raw extraction (`scripts/eval/cascade-runner.ts:184`), and `check.ts` never reads it (`cascade-runner.ts:181-183`). Add a temporary print of `outcome.rawExtraction.beverage_type` in the `--case` branch (`check.ts:154-160`), or call `runOneCase` from a scratch script. Set `DATABASE_URL` to the worktree's own database first (`check.ts:108-110`).
2. Record `beverage_type.value`, `.evidence`, and `.confidence` in the PR body. Do not commit the temporary print.
3. Stop if `value` is not an off-menu string. The cause is then override rule 1 (TRO-502) or the invalid-confidence branch. Report the finding. Close this ticket as not-the-cause. Do not change the router on a guess.
4. Import `BEVERAGE_TYPES` from `src/lib/db/enums.ts` into `src/server/router/index.ts`. `src/server/router/types.ts:17` already imports a type from that module, and `src/app/api/verify/parse-request.ts:11` already imports this same value at runtime.
5. Add a vocabulary guard to the cross-check at `src/server/router/index.ts:166-169`. Fire the blocker only when the normalized extractor value is a member of `BEVERAGE_TYPES` **and** differs from the normalized application value.
6. Normalize both sides with `normalizeForBoundaryMatch` before the membership test. Use the normalizer already there. Do not add a second one.
7. Widen the tuple for the membership test: `(BEVERAGE_TYPES as readonly string[]).includes(normalized)`. Copy the pattern at `src/app/api/verify/parse-request.ts:60`. A bare `.includes()` on the literal tuple fails typecheck.
8. Keep `TRUSTED_THRESHOLD_DEFAULT` as the confidence floor (`src/server/router/confidence.ts:35`). CP-1 §5.3 names that number (`cp1:505`).
9. Keep the check in `src/server/router/index.ts`. A local named predicate in the same file is fine. Do not move it to `label-blockers.ts`.
10. Write the comment that explains the rule. State that an off-menu answer is "no opinion", never a conflict. Name mead as the case that proved it.
11. Add two tests to `src/server/router/index.test.ts`, beside the block at `:136-157`.
    - An off-menu value `"Mead"` at confidence 0.95, against an application declaring `wine`, fires no blocker.
    - The same off-menu value, with `warningResult` `{ verdict: "MISMATCH", note: "..." }`, returns `labelVerdict: "FAIL"` and `headlineReason: null`. Copy the shape at `:197-210`.
12. Add no third test for the in-vocabulary swap. `:149-156` already asserts exactly that pair, `"wine"` against a declared `spirits`.
13. Run `pnpm eval:check -- --live --case=case-22-low-light-warning-block`. Record the new verdict and reason in the PR body, whatever they are. The derived prediction above is PASS, which is wrong against case-22's REVIEW expectation. Write down what happened.
14. State in `CHANGES.md` that this fix does not move label-verdict accuracy. Say why.

## Acceptance evidence

- `pnpm test` passes. The two new tests pass.
- The two existing tests at `src/server/router/index.test.ts:137-147` and `:149-156` still pass, unedited. A diff that touches either one is a regression, not a fix.
- `src/server/router/golden-image-quality.test.ts` still passes. It feeds `beverage_type` from each golden case's own declared type (`:137`, `:171`, `:216`, `:293`, `:327`), so every value it supplies stays in vocabulary.
- The PR body records `beverage_type.value`, `.evidence`, and `.confidence` from step 1's live run.
- `pnpm eval:check -- --live --case=case-11-reworded-warning-clause-two` prints `labelVerdict: FAIL` with a null review reason. Paste the console output.
- The temporary debug print from step 1 is absent from the diff.
- `pnpm eval:check -- --live --case=case-22-low-light-warning-block` output is pasted. The PR body reads the result honestly. A flip to PASS is the predicted outcome and is not a reason to hold the fix.
- `CHANGES.md` states the net effect on label-verdict accuracy: unchanged at 21/32, one case corrected and one case's masked defect exposed.

## Do NOT

- **Do not add an enum to `beverage_type` in `src/server/extractor/schema.ts:56` in place of this fix.** A schema enum is an alternative, not a substitute. It forces the model to guess a category. The label may not carry enough to judge it: every golden label prints no category word at all (`scripts/golden/render.ts:373-383`). It also changes CP-1 §3.4, so it needs Troy's sign-off. This ticket must not open that door on its own.
- **Do not delete the cross-check.** CP-1 §5.3 keeps it (`cp1:504-505`), and `src/server/router/index.test.ts:149-156` proves an in-vocabulary swap must still route to REVIEW. A confident `spirits` reading against a declared `wine` is still a real conflict.
- **Do not edit `golden-set/manifest.json`.** case-11's expectation is correct. `expected.labelVerdict: "FAIL"` at `:607` and `governmentWarning` `MISMATCH` at `:625-626` both match the statute and rubric V3. The router is wrong, not the corpus.
- **Do not touch `src/server/router/rollup.ts`.** Line 15 is where the defect becomes visible, not where it lives. `rollup.ts` follows CP-1 §5.4 line for line. A blocker must outrank a field verdict.
- **Do not fold TRO-502's override rule 1 change into this branch.** `src/server/router/overrides.ts:143` gates rule 2 on `supportKind !== "exempt"`. Rule 1 at `:134` still demands evidence from a field no label prints. That is a real, separate defect with its own ticket and its own reasoning.
- **Do not widen `factory/quarantine.json`, and do not relax a test, to get the gate green.**


---

# S2 · Sweep OCR_CONFIDENCE_FLOOR: a statutory field passes on one channel at 58 and 56

**Priority:** 1 · **Graded:** TH-R9, TH-R17

**Size:** The production change is one constant and its comment — two lines. The channel-provenance change is the wider half. 21 files name `WarningComparatorResult`. An optional provenance field is additive and touches few of them; a required field touches every construction site (`reconcile.ts`'s matchResult/mismatchResult/reviewResult, `warning/index.ts:159`, `router/test-support.ts`, and the tests). The eval side then ripples through `scripts/eval/types.ts`, `warning-segmentation.ts`, `cascade-runner.ts` and the report writer. The sweep script is one new file and runs offline — tesseract.js only, no API spend, no database. This check's own four-case replay ran in a single command with no network call. Medium ticket. The risk sits in the type change, not in the constant.

TH-R9, TH-R17, rubric vector V4. Blocked by nothing. Blocks TRO-516's correction C4.

**Graded.** TH-R9 is the take-home's headline requirement. A fix here outranks any ungraded fix.

## Why

**A statutory field passes on one channel today. The second channel ran, and it disagreed badly.**

This check replayed the OCR channel read-only on the committed images. It called the same five functions the verify route's default dependencies call: `preprocessImage`, `detectWarningRegion`, `cropForOcr`, `runWarningOcr`, `evaluateCandidate`. It wrote no repo file. It made no API call. The numbers reproduce the triage report exactly.

| case | region | method | Tesseract confidence | wording | distance |
|---|---|---|---|---|---|
| case-23-tiny-warning-text-standard-bottle | `{x:52,y:520,w:886,h:30}` | classical | **58.00** | MISMATCH | **47** |
| case-24-tiny-warning-text-miniature-bottle | `{x:52,y:520,w:886,h:30}` | classical | **56.00** | MISMATCH | **42** |
| case-25-odd-typography-script-brand | `{x:52,y:524,w:894,h:140}` | classical | 95.00 | EXACT_MATCH | 0 |
| case-26-odd-typography-blackletter-class-type | `{x:52,y:524,w:894,h:140}` | classical | 95.00 | EXACT_MATCH | 0 |

The last two rows are the control. At normal print size the OCR channel reads the statute perfectly. The tiny-print failure is a print-size result, not a broken detector.

**The line that decides it.** `OCR_CONFIDENCE_FLOOR = 60` sits at `src/server/warning/reconcile.ts:67`. `reconcile.ts:186` reads:

```ts
const ocrUsable = ocr.available && ocr.confidence >= OCR_CONFIDENCE_FLOOR;
```

At 58 and 56 both candidates fall under the floor. The reconciler discards them and runs the single-channel table. That table returns MATCH, because the VLM text equals canonical and its confidence is at or above 0.90 (`reconcile.ts:118-123`).

**Measured outcome.** `scripts/eval/results/eval-report.json` (2026-08-12T13:26:45.488Z, mode `live`, `claude-haiku-4-5`) records both cases as `PASS` with a null headline reason. It records `government_warning` `MATCH` against an expected `NEEDS_REVIEW`. The run scores 21 of 32 on label verdict.

**The compliance risk drives the severity, not the scoreboard.** The only reader without the statute memorised produced 47 and 42 edits of garbage. The label passed. A false PASS on the statutory warning is the worst failure class this tool has.

**This ticket is a debt the eval ticket already owed.** Its own comment marks the constant "proposed". The same comment names the replacement: *"LH-030's golden-set sweep is what would replace it with a measured one"* (`reconcile.ts:62-67`). CP-2 §12 assigns the same work: *"The 0.90 model confidence floor, the 60/100 OCR floor, and the distance-2 band are all **proposed**. LH-030's sweep replaces them with measured values"* (`docs/checkpoints/cp2-warning-subsystem.md:1523-1524`). The eval report under diagnosis carries `ticket: "TRO-470 / LH-030"`. The sweep never ran.

**Derived, not observed: what a corrected floor does.** Any floor at or below 56 sends both cases to `reconcileDualChannel`. The folded VLM text and the folded OCR text differ, so `agree` is false. The function then returns `NEEDS_REVIEW` / `WARNING_MISMATCH` (`reconcile.ts:134-138`). That rolls up to REVIEW, the expected label verdict on both cases. This is derived from the measured inputs and the code. Nobody ran it end to end.

**Rubric V4 has no passing carrier.** V4 reads *"Warning in notably smaller font / buried (if detectable) | FAIL or flagged; documented limitation acceptable"* (`audit/rubric.md:106`). Every vector in the manifest was enumerated in this check: case-23 and case-24 are V4's only two carriers, and both miss. A silent PASS is not a FAIL, not a flag, and not a documented limitation.

**Two supporting gaps the report names, both confirmed.**

1. CP-2 §4.5 merges two different states into one table row: *"OCR unavailable or below the confidence floor"* (`cp2:486`). "OCR produced no candidate" and "OCR produced a candidate 47 edits from the statute" are not the same evidence. The second says the print is unreadable. Treating them alike produced this PASS.
2. Nothing records which table decided a verdict. `WarningComparatorResult` carries `verdict`, `reviewReason` and `note` only (`src/server/router/types.ts:116-122`). `WarningSegmentationSummary` carries `total` and four class counts, and no single-channel-pass rate (`scripts/eval/types.ts:188-206`, `scripts/eval/warning-segmentation.ts:150-166`). CP-2 §8.4 already requires that rate: *"Single-channel passes are counted as clean passes and **also reported as their own rate**, per open question 10. They are the residual false-PASS exposure (§10, Q7)"* (`cp2:950-952`).

## Honest limits

- **Nobody can yet settle whether Haiku read the 9px print or completed it from memory.** No golden case pairs tiny print with a wording deviation, so nothing in this repo separates the two. CP-2 open question 7 names this as the residual false-PASS path.
- **The pair may not test what it was built to test.** Both images measure 1000x800. Both render at the same `TINY_WARNING_FONT_SIZE_PX = 9` (`scripts/golden/render.ts:227`, `:247-253`). CP-2 §8.3's DPI arithmetic — the stated reason both cases exist — assumes a 3000px-wide photograph (`cp2:899-911`). TRO-516's correction C5 owns that question.
- **The sweep will measure rendered images, not photographs.** Every one of the 32 golden images is a render. Measured in this check with sharp: 31 measure 1000x800, and case-19 measures 1173x1032, because its 15-degree rotation expands the canvas. Label the swept floor as a floor for this corpus. Real reference photographs arrive with LH-024 / TRO-529.

## Do

1. Write a sweep script over every golden case that reaches the OCR channel. Record per case: Tesseract confidence, wording class, edit distance, region, and detection method.
2. Read the sweep output. Pick the floor that separates a usable second reading from garbage. Record the number and the reasoning.
3. Accept an honest answer if the corpus gives no clean boundary. Say so. Pick with stated reasoning. Name the residual risk.
4. Change `OCR_CONFIDENCE_FLOOR` at `src/server/warning/reconcile.ts:67` to the swept value.
5. Replace the "proposed" comment at `reconcile.ts:62-67` with the measurement and its date.
6. Split CP-2 §4.5's merged row at `docs/checkpoints/cp2-warning-subsystem.md:486` into two rows. Row one: OCR produced no candidate. Row two: OCR produced a candidate below the floor. CP-2 is an approved checkpoint, so record the split as an amendment and get Troy's sign-off.
7. Add channel provenance to `WarningComparatorResult` (`src/server/router/types.ts:116-122`). Record which table decided: dual channel or single channel.
8. Carry that provenance into the eval report. `scripts/eval/cascade-runner.ts:221-230` already captures the comparator result in `capturedWarningResult`.
9. Add a single-channel-pass rate to `WarningSegmentationSummary` (`scripts/eval/types.ts:188-206`) and to `segmentWarningCheckOutcomes` (`scripts/eval/warning-segmentation.ts:150-166`). Use `total` as the denominator, the same denominator the four classes already share.
10. State that denominator in a code comment. CP-2 §8.4 writes a denominator for the suspect rate only (`cp2:945-948`). It writes none for this rate, so the code must state its own.
11. Run the live eval. Record the new case-23 and case-24 verdicts.
12. Tell TRO-516 that correction C4 is unblocked. Name the honest `reviewReason`.

**Test note, checked.** The three tests that touch the constant reference it symbolically, so a value change does not break them. `reconcile.test.ts:171-188` uses `OCR_CONFIDENCE_FLOOR - 1` and `OCR_CONFIDENCE_FLOOR`. `ocr.test.ts:78-97` asserts a blank image scores below the floor; that image measures confidence 0, so any positive floor keeps it green. `region-detect.test.ts:251` asserts a real crop scores above the floor; a lower floor keeps it green.

**Coordinate with TRO-519.** That ticket adds an OCR deadline. A timeout degrades to `{ available: false }` (`src/server/warning/index.ts:135-137`), which is the "no candidate" state, not the "below the floor" state. Step 6's two rows must keep that distinction.

## Acceptance evidence

- A committed sweep artifact records Tesseract confidence per case over a named case count.
- `src/server/warning/reconcile.ts` carries the measured number in its comment. The word "proposed" is gone.
- A reviewer can point at one recorded number and say why the floor is what it is.
- The live eval scores case-23 and case-24 `REVIEW`, not `PASS`.
- The eval report carries channel provenance for `government_warning` on every case.
- The eval report carries a single-channel-pass rate. Its denominator is `total`. A code comment states that choice and says CP-2 wrote no denominator for it.
- `pnpm test` passes. No test is weakened. No entry is added to `factory/quarantine.json`.

**Expected partial result, stated up front.** After the floor lands, case-23 and case-24 score `labelVerdictCorrect: true` and `reviewReasonCorrect: false`. `scripts/eval/verdict-scoring.ts:115-122` compares the expected reason against the headline reason on a REVIEW expectation. The manifest expects `LOW_IMAGE_QUALITY`; the pipeline will return `WARNING_MISMATCH`. TRO-516's C4 closes that gap. Do not close it here.

## Do NOT

- **Do not lower the floor to 55 to make two cases pass.** CP-2 §12 asks for a sweep (`cp2:1523-1524`). A number fitted to two cases is the same unmeasured guess wearing a new value. This ticket exists to replace a guess with a measurement.
- **Do not delete the floor.** CP-2 open question 7 names the cost of a floor set too low: *"garbage OCR manufactures disagreements and inflates the suspect rate"* (`cp2:1484-1490`).
- **Do not edit case-23's or case-24's `expected` block here.** TRO-516 owns the corpus. Editing an expectation to match a code defect hides the defect.
- **Do not report the clean-pass rate on its own.** CP-2 §8.4 counts a single-channel pass inside the clean-pass class, and it also requires a separate rate for those passes (`cp2:950-952`). Reporting one number without the other hides the residual false-PASS exposure.
- **Do not weaken `reconcile.test.ts`, `ocr.test.ts` or `region-detect.test.ts`** to accept the new value. All three already reference the constant symbolically.
- **Do not claim the tiny-print case is closed.** Whether Haiku read the print or recalled it stays unmeasured. Say so in `CHANGES.md`.


---

# S3 · Drop the apostrophe at normalizer step 6 so STONES THROW matches Stone's Throw

**Priority:** 2 · **Graded:** TH-R8, TH-R17

**Size:** Small code change, larger doc change. One regex line changes in src/server/comparators/normalize.ts, and the trailing-trim regex on the next line simplifies with it. Three doc comments in that file are rewritten. Three test assertions are rewritten and one test is added. Three lines in the CP-1 checkpoint document change. Roughly 2 lines of behavior and 60 lines of comment, test, and document text. No schema change, no migration, no manifest edit. The only unbounded part is the optional live single-case eval run, which costs one Haiku call and requires the committed report to be restored afterwards.

TH-R8 (graded, primary). TH-R17 (graded, secondary). Blocked by nothing.

## Why

**The measured fact first.** case-15 expects PASS. It returned REVIEW.

Source: `scripts/eval/results/eval-report.json` — `ticket: TRO-470 / LH-030`, `measuredAt: 2026-08-12T13:26:45.488Z`, `mode: live`, `haikuModel: claude-haiku-4-5`, `manifestVersion: 1.0.0`, 32 cases.

| case-15 | Expected | Actual |
|---|---|---|
| label verdict | PASS | REVIEW |
| review reason | null | `AMBIGUOUS_BRAND` |
| `brand_name` | MATCH | NEEDS_REVIEW |

Haiku read the label correctly. All five extraction fields scored `correct: true` on this case. The extractor is right. The comparator is wrong.

**The chain. I opened every line below and confirmed it.**

1. The application says `Stone's Throw` (`golden-set/manifest.json:817`). The label prints `STONES THROW` (`:824`). The case expects PASS (`:838`) and `brandName` MATCH (`:841`). It carries rubric vector V5 (`:862-864`, `audit/rubric.md:107`).
2. Step 6 of the normalizer drops punctuation. It keeps the apostrophe and the hyphen (`src/server/comparators/normalize.ts:87`):

```ts
const kept = text.replace(/\p{P}/gu, (mark) => (mark === "'" || mark === "-" ? mark : ""));
```

3. The label folds to `stones throw`. The application folds to `stone's throw`. One character separates them.
4. `similarity()` returns 0.923077 (`src/server/comparators/similarity.ts:44-48`). The longer string holds 13 characters. The edit distance is 1. The repo already pins that distance for this exact pair (`src/server/comparators/similarity.test.ts:16`).
5. 0.923077 is below `BRAND_CLASS_MATCH_THRESHOLD` = 0.95 (`src/server/comparators/brand.ts:23`). The condition at `brand.ts:53` is false. The function returns NEEDS_REVIEW at `:63-66`.
6. A NEEDS_REVIEW verdict always escalates the field (`src/server/router/confidence.ts:113-114`).
7. `FIELD_SPECIFIC_REASON.brand_name` is `AMBIGUOUS_BRAND` (`src/server/router/field-resolution.ts:66`). `resolveComparatorField` applies it at `:252-254`.
8. `rollupLabelVerdict` returns REVIEW on one NEEDS_REVIEW row (`src/server/router/rollup.ts:16`).

The router obeys CP-1 §5.4's ladder (`docs/checkpoints/cp1-cascade-router-prompts.md:663-669`). The threshold decides nothing on its own. Normalization already left the two strings one character apart.

**What else moves. Measured, not argued.**

I replayed the production `normalizeForFuzzyMatch` and `similarity` over all 32 manifest cases. The replay covered `brand_name` and `class_type`. It used the values Haiku returned in that run. I then ran the same 64 comparisons through a copy of the pipeline whose step 6 also drops the apostrophe. The script read files only. It changed no repo file.

Exactly two scores move:

| Case | Field | Today | Apostrophe dropped |
|---|---|---|---|
| case-15 | `brand_name` | 0.923077 | 1.000000 |
| case-16 | `brand_name` | 0.423077 | 0.461538 |

Exactly one score crosses 0.95: case-15. case-16 keeps its NEEDS_REVIEW field verdict and its REVIEW label verdict, which is what its expectation asks for. No `class_type` score moves anywhere in the corpus.

Every score below 0.95 today, measured:

| Score | Case | Field | Expected verdict |
|---|---|---|---|
| 0.923077 | case-15 | `brand_name` | MATCH |
| 0.423077 | case-16 | `brand_name` | NEEDS_REVIEW |
| 0.400000 | case-28 | `class_type` | MISMATCH |
| 0.157895 | case-20 | `brand_name` | NEEDS_REVIEW |
| 0.142857 | case-29 | `brand_name` | MISMATCH |
| 0.125000 | case-20 | `class_type` | NEEDS_REVIEW |

The corpus holds nothing between 0.4231 and 0.9231. That empty band is the whole argument against the alternative fix. See **Do NOT**.

**A second consumer the triage report does not name.** `scripts/eval/extraction-scoring.ts:54` calls the same normalizer to score extraction correctness. I measured that path too. Zero extraction scores flip across all 32 cases. Dropping a character can only merge two strings, never split them, so a score can only move from wrong to right. The six extraction misses in the run sit on case-19's warning text and on case-20, which returned no value at all. Exactly one extracted brand or class value in the corpus carries an apostrophe — case-14's `STONE'S THROW`.

**It closes a gap the repo already records against itself.** `src/server/comparators/normalize.test.ts:71-87` pins the U+2019 case in its own words:

> "the pair lands at ~0.923 similarity (see `brand.ts`'s 0.95 threshold), just below MATCH — a real gap, flagged in this ticket's final report, not fixed here without CP-1's own sign-off on widening the rule."

Measured: `"Stone’s Throw"` and `"Stone's Throw"` score 0.923077 today, and 1.000000 with the apostrophe dropped.

**The honest limit. Read this before ranking the ticket.** TH-R8's named acceptance test is `STONE'S THROW` against `Stone's Throw` (`audit/requirements/inventory.md:79`, `docs/PRD.md:86`, `audit/rubric.md:107`). case-14 carries that exact pair (`golden-set/manifest.json:758`, `:765`) and it already passes — measured PASS with `brand_name` MATCH in the same run. This ticket does not repair a broken graded acceptance line. It extends a graded requirement past the one pair every document names. V5 has a second carrier, and case-15 is it. The miss is real. It is a smaller claim than "TH-R8 is broken."

**The governing document supports the change.** `docs/PRD.md:85` lists the router's normalizers as "case, punctuation, whitespace, unicode". It states no apostrophe carve-out. CLAUDE.md makes the PRD settled architecture.

**One accepted behavior change, stated plainly.** After this change the normalizer treats a possessive and a plural as the same word. `stone's` and `stones` fold together. That is the lenient regime's intent (TH-R8). It can produce a wrong MATCH. It can never produce a wrong FAIL: `compareBrandOrClass` returns MATCH or NEEDS_REVIEW and nothing else (`src/server/comparators/brand.ts:60-62`, pinned by `brand.test.ts:68-78`). It never touches the government warning. The exact regime keeps its own subsystem, with no shared helpers (`src/server/comparators/normalize.ts:12-15`).

## Do

1. Edit `src/server/comparators/normalize.ts:87`. Drop the apostrophe with the rest of the punctuation. Keep the hyphen.

   ```ts
   const kept = text.replace(/\p{P}/gu, (mark) => (mark === "-" ? mark : ""));
   ```
2. Simplify the trailing trim at `normalize.ts:88`. Change `/^['-]+|['-]+$/g` to `/^-+|-+$/g`. No apostrophe survives step 6 now.
3. Rename the function at `normalize.ts:86` to `dropPunctuationExceptHyphen`. The name states the rule. The function is module-private — only `normalizeForFuzzyMatch` is exported (`normalize.ts:110`, re-exported at `src/server/comparators/index.ts:29`). Update the one call site at `normalize.ts:116`.
4. Rewrite the step 6 line in the module doc (`normalize.ts:10`).
5. Rewrite the step 6 function comment (`normalize.ts:77-85`).
6. Rewrite the U+2019 comment (`normalize.ts:42-50`). Record the gap as closed. Record how it closed. Step 3 still folds only CP-1's three named variants. Step 6 now removes U+2019 with every other apostrophe, so the pair converges on one string.
7. Fix the three assertions this change breaks. I replayed each against the patched pipeline, so this list is measured, not predicted.
   * `normalize.test.ts:22` — `.toBe("stone's throw")` becomes `.toBe("stones throw")`.
   * `normalize.test.ts:51` — the same change.
   * `normalize.test.ts:84` — `expect(withCurlyApostrophe).not.toBe(withStraightApostrophe)` becomes `expect(withCurlyApostrophe).toBe(withStraightApostrophe)`.
   Leave `normalize.test.ts:85` alone. `"stones throw"` is still the right answer there.
8. Rewrite the describe title at `normalize.test.ts:71`, the `it` title at `:72`, and the comment at `:73-81`. The block now pins a closed gap. It must still assert an outcome.
9. Add one test to `src/server/comparators/brand.test.ts`. `compareBrandOrClass(field("STONES THROW"), "Stone's Throw", CONTEXT)` returns MATCH. Name case-15 in the test title. Write the test before the source edit (`docs/PRD.md:224-225`).
10. Keep `src/server/comparators/brand.test.ts:50` green. That test holds case-16's pair at NEEDS_REVIEW, and it guards the only other score this change moves.
11. Amend CP-1. `docs/checkpoints/cp1-cascade-router-prompts.md:632` states step 6 as "drop punctuation except internal apostrophes and hyphens". Change that line. Change `:634` and `:103`, which both print the literal `stone's throw`. State that CP-1's outcome does not change: the named pair still folds to one string and still scores 1.0. This edits a checkpoint-approved document. Record the deviation and the reason. Leave the decision on the record for Troy.
12. Add the `CHANGES.md` entry. Quote the two moved scores and the one threshold crossing.

## Acceptance evidence

Deterministic, no spend:

* `pnpm test` passes. No test is deleted, skipped, or added to `factory/quarantine.json`.
* A test proves `normalizeForFuzzyMatch("STONES THROW")` equals `normalizeForFuzzyMatch("Stone's Throw")`.
* The rewritten test at `normalize.test.ts:71-87` proves `normalizeForFuzzyMatch("Stone’s Throw")` equals `normalizeForFuzzyMatch("Stone's Throw")`.
* `compareBrandOrClass(field("Stones Throw Distillery Co."), "Stone's Throw", CONTEXT)` still returns NEEDS_REVIEW (`brand.test.ts:50`).
* The three apostrophe-variant tests stay green: `normalize.test.ts:33` (backtick) and `:34` (acute) still fold to the same string as the straight apostrophe.
* `pnpm typecheck` passes. `pnpm lint` passes.
* `pnpm golden:verify` passes. This ticket edits no manifest file, so rubric vector coverage is unchanged.
* The factory gate passes. State the honest limit when you report it: gate G8 runs `pnpm eval:check` in cheap mode (`scripts/factory/gate.sh:288`), which compares the committed report against the committed baseline. Neither file changes here, so G8 cannot prove this fix. It only proves nothing regressed.

Live, one Haiku call. Preferred, not required:

* Copy `scripts/eval/results/eval-report.json` aside first. Restore it afterwards. See **Do NOT**.
* Run `pnpm eval:check -- --live --case=case-15-case-variant-brand-punctuation`.
* Read the written report. case-15's `actualLabelVerdict` is PASS. `brand_name` `actualVerdict` is MATCH.
* Expect exit code 1 with a "stale coverage" message (`scripts/eval/baseline-compare.ts:71-78`, exit set at `scripts/eval/check.ts:238`). That is the coverage rule, not an accuracy regression. Say so when you report the result.
* Do not claim 22/32. A live model run is not deterministic. The checkable claim is the field verdict on this one case.

If a reviewer wants the full number, the run is `pnpm eval:check -- --live --full`. A tie is not a regression, so an improvement passes on its own (`scripts/eval/baseline-compare.ts:58`).

## Do NOT

* **Do not lower `BRAND_CLASS_MATCH_THRESHOLD` instead** (`src/server/comparators/brand.ts:23`). It closes case-15 too. It also loosens `class_type`, because one constant serves both fields (`brand.ts:12-14`). Measured, the corpus holds no case between 0.4231 and 0.9231. Every threshold in that band is untested by any case in the golden set. A targeted change with measured zero collateral beats a broad change with an untested region.
* **Do not fold U+2019 in `foldApostropheVariants` (`normalize.ts:52-54`) and call the ticket done.** Measured: case-15's label prints no apostrophe of any kind. Folding U+2019 to `'` moves the U+2019 pair and leaves case-15 at 0.923077.
* **Do not delete step 3 as dead code after this change.** It looks redundant once step 6 drops every apostrophe. It is not. Measured on the patched pipeline with step 3 removed: `"Stone´s Throw"` normalizes to `"stone s throw"`, not `"stones throw"`. NFKC decomposes U+00B4 into a space plus a combining mark, and step 4 strips the mark. Step 3 is what turns that character into one step 6 can delete cleanly.
* **Do not delete or skip the U+2019 test** (`normalize.test.ts:71-87`). Invert it. A deleted test hides the change. An inverted test records it.
* **Do not widen `factory/quarantine.json`.**
* **Do not run a live `--case` check without copying `scripts/eval/results/eval-report.json` aside and restoring it afterwards.** `scripts/eval/check.ts:184` overwrites that file on every live run. Two things break if the one-case report survives. It is the source artifact behind `docs/diagnostics/2026-08-12-verdict-miss-triage.md`. And gate G8 runs cheap-mode `pnpm eval:check` (`scripts/factory/gate.sh:288`), which then reports stale coverage against the 32-case baseline and turns the gate red. Never commit the one-case report.
* **Do not pass `--update-baseline` on anything but a `--full` run.** `scripts/eval/check.ts:216-228` writes the baseline from whatever the run covered, with no full-run gate. A one-case update would replace a 32-case baseline (`scripts/eval/baseline.json`: `caseIds` length 32, `summary.labelVerdictAccuracy.rate` 0.65625).
* **Do not edit `golden-set/manifest.json`.** case-15's expectation is correct as written. The defect is in the comparator.


---

# INT-001 · Prove the government warning FAIL path on a real image, not on simulated channels

**Priority:** 2 · **Graded:** TH-R9, TH-R17

**Size:** Tiny. One new `it` block of roughly twenty lines, inside one existing `describe` in one existing test file. No source change. No new fixture: the image, the ground-truth text, and the loader are all committed. Measured, not estimated: one real-pipeline call takes about 330 ms, and the whole five-call probe I ran finished in 2.3 s wall clock. The existing case-01 test already carries a 15,000 ms timeout for the same real-OCR work. Honest size: under an hour, and most of it goes to reading CP-2 §4.5's single-channel rule and the prefix-casing cross-check rather than to typing.

TH-R9, TH-R17. Blocked by nothing. Source: ruling INT-001, `audit/requirements/interpretations.md:9-24`.

## Why

TH-R9's acceptance evidence names three test cases: "exact warning → pass; 'Government Warning' title-case → fail; reworded warning → fail" (`audit/requirements/inventory.md:87`).

**Today only the PASS case runs the real image pipeline.** One test reads a committed JPEG, runs real region detection, runs real Tesseract OCR, and asserts MATCH (`src/server/warning/index.test.ts:164-177`). I checked every other caller of `compareGovernmentWarningFromImage`. The route tests stub it (`src/app/api/verify/route.test.ts:113`, `:483`, `:505`), and the only other real-image test in the subsystem is case-01 again (`src/server/warning/region-detect.test.ts:232-236`).

**Both FAIL cases run on hand-built candidates.** `src/server/warning/reconcile.test.ts:59-63` asserts the title-case MISMATCH. `:80-87` asserts the reworded MISMATCH. Both call `reconcileWarningChannels` directly with two literal strings, built by the `vlm()` and `ocr()` helpers at `:44-51`. No image is read. No OCR runs. The comparator is proved. The pipeline that feeds it is not.

That gap matters, because the live path can reach a different answer. CP-2 §4.5's rule is "We never accuse on one channel" (`docs/checkpoints/cp2-warning-subsystem.md:495`). `src/server/warning/reconcile.ts:115-130` implements it: a single readable channel returns NEEDS_REVIEW, never MISMATCH. A comparator-level FAIL therefore does not prove a live FAIL.

**Troy ruled on this on 2026-08-12** (`audit/requirements/interpretations.md:16-19`). Comparator-level proof does not satisfy TH-R9. At least one FAIL case must run through the real image pipeline. TH-R9 stays PARTIAL until that test lands (`:23-24`, and the sweep's own words at `audit/requirements/REPORT.md:17`).

### Measured: the test will pass, and here are the numbers

I ran the real pipeline against case-08 from a scratch script outside the repo, with the repo's own `./node_modules/.bin/tsx`. No repo file was written. No model was called: `compareGovernmentWarningFromImage` consumes an already-extracted VLM reading and calls no model itself (`src/server/warning/index.ts:15-30`).

| measurement | value |
| -- | -- |
| region detection | `{x: 52, y: 524, width: 882, height: 140}`, method `classical` |
| OCR confidence | 95 |
| `OCR_CONFIDENCE_FLOOR` | 60 (`src/server/warning/reconcile.ts:67`) |
| OCR text | reads `Government Warning:` in title case, body exact |
| verdict, `prefix_casing: "TITLE_CASE"` | `{"verdict":"MISMATCH","note":"Government Warning must print in capital letters."}` |
| verdict, `prefix_casing: "ALL_CAPS"` | `{"verdict":"NEEDS_REVIEW","reviewReason":"WARNING_MISMATCH","note":"Government Warning could not be read consistently."}` |
| one call, wall clock | about 330 ms |

So the dual-channel path runs on this image. Both channels agree. `reconcileDualChannel` returns MISMATCH on the caps failure (`src/server/warning/reconcile.ts:143`).

**The last verdict row is the trap.** `applyPrefixCasingCrossCheck` (`src/server/warning/reconcile.ts:163-175`) downgrades a MISMATCH to REVIEW when the model's self-reported `prefix_casing` contradicts the derived caps result. The `extractedWarning()` helper at `src/server/warning/index.test.ts:24-34` defaults to `prefix_casing: "ALL_CAPS"` and `transcription: CANONICAL_WARNING_TEXT`. A test that copies those defaults asserts MISMATCH and gets NEEDS_REVIEW.

I measured the other acceptance cases through the same pipeline, so a reviewer knows the ground under this ticket:

| case | real-pipeline verdict |
| -- | -- |
| case-01-clean-match-spirits | MATCH |
| case-08-title-case-warning-prefix-only | MISMATCH |
| case-10-reworded-warning-clause-one | MISMATCH |
| case-11-reworded-warning-clause-two | MISMATCH |

All three TH-R9 acceptance shapes are reachable on real images. This ticket closes the one INT-001 requires.

### One correction to the ruling's wording

INT-001 says the test "proves the statutory FAIL path on a real photograph" (`audit/requirements/interpretations.md:21-22`), and its line 13 uses the same word for the PASS case. `audit/requirements/REPORT.md:17` repeats it. Neither image is a photograph. `golden-set/manifest.json:462` records case-08 as `provenance: "rendered"`, and case-01 is rendered too. The ruling's substance holds exactly as written — no FAIL case runs the real image pipeline today — but the word is wrong. Use the existing, accurate phrasing from `src/server/warning/index.test.ts:164`: "real image, real OCR, real region detection".

## Do

1. Add one `it` block to the `describe` at `src/server/warning/index.test.ts:164`. Do not create a new file.
2. Load the case from the manifest with `loadGoldenSetManifest()` (`src/lib/golden-set/loader.ts:731`). Take `imagePath` and `label.governmentWarningText` from the `case-08-title-case-warning-prefix-only` entry. A manifest source stops the test drifting from the image. Both fields are non-optional (`src/lib/golden-set/types.ts:96`), so no null guard is needed.
3. Read the image with `readFileSync`, as the case-01 test does at `:168`.
4. Build the extracted warning with `extractedWarning({ transcription, evidence: transcription, prefix_casing: "TITLE_CASE" })`. `TITLE_CASE` is required. `golden-set/manifest.json:431` records `governmentWarningPrefixAllCaps: false`, and I measured the `ALL_CAPS` variant returning NEEDS_REVIEW in place of MISMATCH.
5. Call `compareGovernmentWarningFromImage` with no `deps` argument. The real `detectWarningRegion`, `cropForOcr`, and `runWarningOcr` then run (`src/server/warning/index.ts:92-96`, `:148`).
6. Assert `result.verdict === "MISMATCH"`.
7. Assert `result.note === "Government Warning must print in capital letters."` The note proves the caps rule fired, not some other deviation.
8. Set the timeout to `15_000`, matching the case-01 test at `:175`. One call measured about 330 ms, so the margin is wide.
9. Name the test for what it proves. Say "case-08". Say "FAIL". Say "real image, real OCR". Do not write "photograph".
10. Optional, and nearly free: add the same block for `case-10-reworded-warning-clause-one`. Assert MISMATCH and the note "Government Warning wording differs from the required text." I measured that verdict. It closes TH-R9's third acceptance case on a real image. INT-001 requires only one, so leave it out if the reviewer prefers the smaller diff.

## Acceptance evidence

- `pnpm test` passes. The new test appears in the run and passes.
- The new test calls `compareGovernmentWarningFromImage` with no `deps` argument. A `vi.fn()` anywhere in the block fails this line.
- The assertion is `MISMATCH`, not `NEEDS_REVIEW` and not `FAIL`. `MISMATCH` is the comparator's own verdict value (`src/server/warning/reconcile.ts:111-113`). FAIL is the router's label verdict, and it is not this function's output.
- The test's image path and warning text resolve from `loadGoldenSetManifest()`, not from a string literal pasted into the test.
- No file under `src/server/warning/` outside `index.test.ts` changes. This ticket adds a test. It fixes nothing.
- The `CHANGES.md` entry cites INT-001. It states what the test proves: TH-R9's title-case FAIL case now runs the real image pipeline.

## Do NOT

- **Do not copy `extractedWarning()`'s defaults.** They set `prefix_casing: "ALL_CAPS"` and `transcription: CANONICAL_WARNING_TEXT` (`src/server/warning/index.test.ts:24-34`). I measured the result of that mistake on this exact image: `NEEDS_REVIEW / WARNING_MISMATCH`, because `applyPrefixCasingCrossCheck` downgrades the MISMATCH (`src/server/warning/reconcile.ts:163-175`). An agent that hits this will want to relax the assertion. Do not. Pass `TITLE_CASE` and the title-case transcription.
- **Do not mock `detectWarningRegion`, `cropForOcr`, or `runWarningOcr`.** Injected fakes are what INT-001 rejected. `src/server/warning/index.test.ts:93-122` already covers the wiring with fakes. This test exists to run the real thing.
- **Do not change `OCR_CONFIDENCE_FLOOR`** (`src/server/warning/reconcile.ts:67`). The measured OCR confidence on this image is 95, far above the floor of 60. The floor needs a measured sweep. That is a different ticket with its own graded evidence.
- **Do not weaken the single-channel rule** at `src/server/warning/reconcile.ts:115-130` to make a FAIL reachable on one channel. "We never accuse on one channel" is a CP-2 decision (`docs/checkpoints/cp2-warning-subsystem.md:495`), and this test does not need it changed.
- **Do not delete or edit the two comparator tests** at `src/server/warning/reconcile.test.ts:59-63` and `:80-87`. They are still the right unit tests. This ticket adds the missing integration proof beside them.
- **Do not write "photograph" anywhere.** case-08 is `provenance: "rendered"` (`golden-set/manifest.json:462`). A rendered image running through real OCR is the honest claim, and it is the claim INT-001 needs.


---

# S5 · Score the cascade end state and record the per-field confidence the report discards

**Priority:** 1 · **Graded:** TH-R17, TH-R19

**Size:** Medium-large. Step 1 (merge + post-resolution score) is roughly 60-100 lines in cascade-runner.ts plus a new merge helper. It carries the real design risk: the cascade's resolver returns only the flagged fields, so the merge is new code, not a call to the existing roll-up. Steps 4-6 (confidence, image_quality, beverage_type) widen four type shapes and their populate sites, plus summary.ts, report-validation.ts and baseline-compare.ts. Step 6 is record-only, so it adds no scoring logic. Step 7 (reliability diagram) is a new derivation over data the earlier steps already record. Step 8 (content hash) is small. Step 9 is paid live spend: derived from the two committed artifacts' own measured totals ($0.291976 for the 32-case eval run; $0.276604 + $0.440916 for the 29-case benchmark), one full eval re-run plus one full benchmark re-run costs about $1.01. The benchmark now covers 32 cases rather than 29, so budget a little above that. Two sub-steps need Troy rather than code: the label-level-blocker decision in step 2, and the spend in step 9.

TH-R17, TH-R19. Blocked by nothing. **Blocks TRO-516** (golden-set corpus corrections).

Source: `docs/diagnostics/2026-08-12-verdict-miss-triage.md` §5 S5 and §8. I opened every line this ticket cites. Seven citations needed correction. The Why section lists them.

**One honest divergence from the report.** The report heads this item "Not graded" (`docs/diagnostics/2026-08-12-verdict-miss-triage.md:469`). I still list TH-R17 and TH-R19. TH-R19's acceptance evidence reads "Approach doc justifies each major choice against scope" (`audit/requirements/inventory.md:167`). The cascade-versus-Sonnet benchmark **is** that justification. A benchmark that scores its two arms at different pipeline stages damages TH-R19's own evidence. Still rank this below S1 through S4. Those four break graded acceptance lines outright.

## Why

### The measurement bug. This part matters most.

`scripts/eval/cascade-runner.ts:299-304` builds `actualVerdict` from the `/api/verify` response body. It scores that at `:304`. The resolver gate sits seven lines later, at `:311`. The cascade arm therefore measures the **Validation Router alone**. Its 21/32 is a router number reported as a cascade number.

The Sonnet-only arm is measured one stage further on. `scripts/eval/benchmark.ts:182` calls `rollUpResolverResolution` (`scripts/eval/resolver-rollup.ts:177-221`) and scores the result. That arm is post-resolution.

So the headline benchmark sets a router verdict against a cascade verdict. Read from `scripts/eval/results/benchmark-report.json`, run `2026-08-12T05:23:34.689Z`:

| Arm | Label-verdict accuracy | Measured cost |
|---|---|---|
| cascade | 19/29 = 65.5% | $0.276604 |
| sonnet-only | 12/29 = 41.4% | $0.440916 |

The file records `labelVerdictAccuracyDeltaPercentagePoints: -24.137931034482758`. `benchmark.ts:292-293` computes that as sonnet-only minus cascade. `:323` prints the same wording. PRD §6 requires honest evidence. Fix the stage mismatch first. Only then quote the delta.

The roll-up code already exists. `resolver-rollup.ts` implements it. The cascade arm does not call it. I checked every caller: `rollUpResolverResolution` runs at `benchmark.ts:182` and nowhere else in `scripts/` or `src/`.

### The missing evidence.

`scripts/eval/results/eval-report.json` contains the string "confidence" zero times. I ran `grep -o 'confidence' scripts/eval/results/eval-report.json | wc -l` and read `0`.

- `ExtractionFieldScore` (`scripts/eval/types.ts:45-52`) carries no confidence field.
- `VerdictFieldScore` (`scripts/eval/types.ts:64-80`) carries none either.
- CP-1 §4.5 step 1 says "Run the extractor over the golden set. Record `confidence` and correctness for every field" (`docs/checkpoints/cp1-cascade-router-prompts.md:414`).
- CP-1 §4.5 step 2 asks for a reliability diagram (`:415-417`).
- Neither step ran.

The pipeline does produce the number. The harness destroys it:

1. `src/app/api/verify/route.ts:325-331` inserts one `field_results` row per field. It writes `confidence` at `:331`.
2. That value is the per-field confidence the router used (`src/server/router/index.ts:229` and `:254`, sourced at `:61` and `:74`).
3. `src/lib/db/schema.ts:266-268` cascade-deletes `verifications` with their `applications` row. `:304-306` cascade-deletes `field_results` with their `verifications` row.
4. `cascade-runner.ts:147`, inside `cleanupApplicationRow` (`:137-153`), deletes the `applications` row. The `finally` block calls it at `:388`.

I read the whole of `cascade-runner.ts`. It never reads `field_results` before that delete.

No table records `image_quality`. I ran `grep -rn "image_quality\|imageQuality" src/lib/db/` and got one hit, `src/lib/db/enums.test.ts:28`. The extractor produces the object (`src/server/extractor/types.ts:40-44`, carried on the result at `:93`). Nothing keeps it.

Report §7 item 1 states the consequence. Every confidence claim in the triage is a derived bound, not a number. Four of the eleven diagnoses stay at medium confidence for this reason alone.

One further scoring gap, stated in report §8 and measured here. `scripts/eval/verdict-scoring.ts:115-122` makes `reviewReasonCorrect` vacuously `true` whenever the golden set does not expect REVIEW. I read all eleven misses out of `eval-report.json`. Five of them report `reviewReasonCorrect: true` and name a reason the golden set never expected: case-11, case-15, case-19, case-28 and case-29.

### Manifest provenance.

`benchmark-report.json` records `expectedReviewReason: "LOW_MODEL_CONFIDENCE"` for case-23 and case-24. `golden-set/manifest.json` records `LOW_IMAGE_QUALITY` for both. Both artifacts stamp `manifestVersion: "1.0.0"`. I read all four values out of the two files.

Three further measurements point the same way:

- Seven commits touch `golden-set/manifest.json`. Every one carries version `1.0.0`. Commands: `git log --oneline -- golden-set/manifest.json | wc -l`, then `git show <sha>:golden-set/manifest.json` per commit.
- `baseline-compare.ts:64-66` rejects a comparison when the two `manifestVersion` strings differ. The string never differs. That staleness check is inert today.
- In `benchmark-report.json`, case-17's `brand_name` row holds `NEEDS_REVIEW` and carries no `actualReviewReason` key. `scripts/eval/types.ts:64-80` declares that property. So the artifact also predates a type change, under the same version string.

A version string that never moves cannot tell a reader which corpus produced a number.

### Citations I corrected

I re-opened every line the report cites for this item. Seven needed a correction.

1. The report cites `cascade-runner.ts:181-183` for the application-row delete. Those lines are the `rawExtraction` doc comment on `CaseRunOutcome`. The delete is `:147`, inside `cleanupApplicationRow` (`:137-153`), called at `:268` and `:388`.
2. The report cites `src/lib/db/schema.ts:310-314` for "the database has no `image_quality` column". Those lines are the `field_results.confidence` column, and that column exists. The honest statement: `field_results` (`schema.ts:300-333`) records per-field confidence at `:310-314`, and no table in the schema has an `image_quality` column.
3. The report says six manifest commits carry `1.0.0`. I measured seven.
4. The report's `beverage_type` recommendation does not hold. The next section explains.
5. An earlier draft of this ticket named the benchmark figure a "cascade-versus-Sonnet delta". That inverts the sign. `benchmark.ts:292-293` computes sonnet-only minus cascade, and `:323` says so.
6. An earlier draft called the router-alone number "the denominator of the auto-verified rate". CP-1 §4.5 step 3 defines that rate as "the share of labels finished without a resolver call" (`cp1:418-420`). The router verdict decides which labels escalate, so it produces the rate. It is not the rate's denominator.
7. An earlier draft said five misses "name the wrong reason". Measured, the five are case-11, case-15, case-19, case-28 and case-29. Each expects PASS or FAIL, so the check is vacuous, and each names a reason the golden set never expected.

### One report recommendation does not hold: scoring `beverage_type`

Report §5 S5 item 3 asks for `beverage_type` in the extraction score. I could not confirm that this is the right fix.

Extraction accuracy asks whether Haiku read the **label** correctly (`scripts/eval/types.ts:5-11`). `GoldenLabelFields` (`src/lib/golden-set/types.ts:78-99`) carries no beverage type. The only `beverageType` on a case is `GoldenSetCase.beverageType` (`:227`). It sits outside the `label` block (`:251`) and feeds the application record (`cascade-runner.ts:93`, `:107-116`).

Report §3C states that no golden label prints its category word at all. So no label ground truth exists to score against.

The honest fix records `beverage_type`'s value, evidence and confidence as evidence. Case-11's diagnosis needs the recorded values, not a score. Step 6 below says exactly that.

## Do

1. **Merge the resolver's fields into the router's rows. Then score the merged result.**
   - In the cascade arm, `resolveEscalatedLabel` returns only the flagged fields. `src/server/resolver/response.ts:191-205` states it. `deriveResolvedFields` "Looks up exactly the caller-flagged fields".
   - `buildFlaggedFieldsForEscalatedLabel` (`scripts/eval/flagged-fields.ts:80-101`) flags the per-field subset. On a label-level blocker it flags all five fields.
   - `rollUpResolverResolution` throws on any missing router field (`resolver-rollup.ts:191-195`). Write a merge step in `cascade-runner.ts` instead. A resolved field overrides its router row. An unflagged router row carries through unchanged.
   - Reuse the existing per-disposition mapping. Do not write a second one. `RESOLVED_MISMATCH` maps to `MISMATCH` (`resolver-rollup.ts:60-61`). `NEEDS_HUMAN` maps to `NEEDS_REVIEW` (`:62-63`).
   - Reuse `rollupLabelVerdict` and `pickHeadlineReason` for the label-level result, as `resolver-rollup.ts:216-220` already does.
2. **Decide what the router's label-level blocker means after resolution. Record the decision.**
   - `resolver-rollup.ts:216-219` passes `false` for the blocker. The Sonnet-only arm has no router pass.
   - The cascade arm does have one. Case-11's `CONFLICTING_EXTRACTION` blocker suppressed a real warning MISMATCH (report §3C).
   - This is an open design question. Ask Troy before you pick a side.
3. **Record both verdicts per case. Never replace one with the other.**
   - Add a post-resolution verdict score to `CascadeCaseResult` (`scripts/eval/types.ts:134-162`), beside the existing `verdict`.
   - Add the matching pair of summaries to `EvalReportSummary` (`:208-218`).
   - Name the two so a reader cannot confuse them. For example `routerVerdict` and `cascadeVerdict`.
   - Make `benchmark.ts` compare the cascade arm's post-resolution number against the Sonnet-only arm's.
   - Name each arm's pipeline stage inside the report file.
4. **Record per-field confidence.**
   - Add a `confidence` field to `ExtractionFieldScore` (`types.ts:45-52`).
   - Add one to `VerdictFieldScore` (`:64-80`).
   - Fill both from the captured `HaikuExtractionResult`. `runOneCase` already holds it (`cascade-runner.ts:199`, `:276-282`). No second API call. No database read.
   - `ExtractedGovernmentWarning` carries its own confidence (`src/server/extractor/types.ts:84`). The warning field gets one too.
5. **Record the whole `image_quality` object per case.**
   - Add it to `CascadeCaseResult`. Copy `legible`, `issues` and `confidence` (`src/server/extractor/types.ts:40-44`).
   - Add no database column in this ticket. The committed report is the evidence artifact. A schema change is a separate decision.
6. **Record `beverage_type`'s value, evidence and confidence per case. Do not score it.** The Why section states the reason.
7. **Build CP-1 §4.5 step 2's reliability diagram from the recorded data.**
   - Bucket every scored field by confidence decile. Report the measured accuracy of each bucket.
   - Ten deciles over 160 field scores gives thin buckets. Print each bucket's `n` beside its rate.
   - State the same limit in `docs/approach.md`. That file does not exist yet. LH-064 creates it.
8. **Make manifest provenance move with content.**
   - Record a content hash of `golden-set/manifest.json` in `EvalReport`, beside the version string.
   - Record the same hash in the benchmark report.
   - Add the field to `EvalBaseline` (`scripts/eval/types.ts:260-266`). `baseline-compare.ts:64-66` can then reject a stale comparison.
   - A hash is cheaper and harder to forget than a version bump. Prefer it. Bump the version too if Troy wants a human-readable marker.
9. **Re-run and re-baseline. This spends real money.**
   - Run `pnpm eval:check -- --live --full`.
   - Show Troy the new numbers. Then run `pnpm eval:check -- --live --full --update-baseline`.
   - Regenerate the benchmark with `pnpm eval:benchmark -- --full`. The committed `benchmark-report.json` is stale on three counts named above.
   - The committed baseline (`scripts/eval/baseline.json`) records `establishedAt: 2026-08-12T13:26:45.488Z`. That is the same run as the current report. Both move together.

## Acceptance evidence

- `grep -c confidence scripts/eval/results/eval-report.json` returns a number above zero.
- Every case in the report carries per-field confidence, an `image_quality` object, and a `beverage_type` reading.
- Every escalated case carries a router verdict score and a post-resolution verdict score. The two carry different names.
- A reader can state, from `eval-report.json` alone, whether Sonnet returned `RESOLVED_MATCH` or `RESOLVED_MISMATCH` on case-28 and case-29. Today the file records only `resolverOutcome: "resolved"` for both. Report §7 item 4 says the same.
- The benchmark report compares post-resolution against post-resolution. The file names each arm's stage.
- Both artifacts carry a manifest content hash. A test edits one case in a fixture manifest and proves the hash changes.
- Cheap-mode `pnpm eval:check` passes against the re-established baseline.
- `CHANGES.md` names the old 65.6% a router number. It names the new figure a cascade number. It states the difference between them.
- The extraction denominator stays at 160 for 32 cases. `beverage_type` appears as recorded evidence, never as a sixth score.
- The factory gate passes. CI is green.

## Do NOT

- **Do not flag all five fields in the cascade arm.** `buildAllFieldsFlagged` (`scripts/eval/flagged-fields.ts:111`) serves the Sonnet-only arm alone. I checked every caller: `benchmark.ts:67`, `benchmark.ts:174`, and its own test file. Using it in the cascade arm turns the cascade arm into the Sonnet-only arm. That destroys the benchmark. It also breaks CLAUDE.md's non-negotiable and TH-R19: Sonnet sees only escalations.
- **Do not call `rollUpResolverResolution` directly on a cascade resolution.** It throws on any router field the cascade did not flag (`resolver-rollup.ts:191-195`). A developer who relaxes that throw hides a real incompleteness. The harness would then score unresolved fields as resolved.
- **Do not replace the router verdict with the post-resolution verdict.** Both numbers are evidence. The router verdict decides which labels escalate. CP-1 §4.5 step 3 asks for exactly that rate (`cp1:418-420`).
- **Do not edit `golden-set/manifest.json` in this ticket.** TRO-516 owns the corpus. This ticket exists so TRO-516 can read a cascade end state before it edits an expectation. Editing an expectation to match a router-interim measurement deletes a correct expectation. Report §4 sets the same rule for C6 and C7. TRO-516's own body repeats it.
- **Do not add `beverage_type` to the extraction-accuracy denominator.** No label ground truth exists for it. A score against the application's declared value measures agreement, not reading accuracy. 96.25% would then move for the wrong reason.
- **Do not quote the benchmark's -24.1 point delta until step 1 lands.** Not in `docs/approach.md`, not in the README, not in the live defense. Neither `docs/approach.md` nor `README.md` exists yet, so this is a guard on LH-063 and LH-064, not a cleanup.


---

# L1 · Re-measure TH-R2 latency: the committed artifact predates the warning comparator

**Priority:** 2 · **Graded:** TH-R2, TH-R15

**Size:** Small diff. One string literal in scripts/latency/measure.ts, plus corrections in CHANGES.md and audit/requirements/REPORT.md. The string fix alone is a few minutes and unblocked. The cost is not code. The re-run spends 20 real billed Haiku calls, and it cannot start until TRO-519 lands an OCR deadline. Most of this ticket is waiting, and the waiting is the point: measuring an unbounded system twice costs twice.

TH-R2, TH-R15. **Blocked by TRO-519** (OCR channel has no timeout — Urgent, Backlog) for the re-run only. Step 1 is not blocked and should land first. The re-run needs Troy's go-ahead: it makes real billed API calls.

**Graded.** TH-R2 dropped VERIFIED → PARTIAL in the 2026-08-12 requirements sweep (`audit/requirements/REPORT.md:64`, matrix row at `:38`).

## Why

**The committed latency artifact measures a pipeline that no longer ships.**

`scripts/latency/results/single-label-verify.json:3` records `measuredAt: "2026-08-12T02:17:14.475Z"`.

Commit `c5e49f8` wired the warning comparator into the verify route. This check read its author date with git, not by inference: `2026-08-11T22:30:19-05:00`, which is `2026-08-12T03:30:19Z`. The wiring landed 1 hour 13 minutes after the measurement.

**The artifact says so itself.** `single-label-verify.json:11`, verbatim:

> "Preprocess (sharp) -> Haiku extraction (claude-haiku-4-5, real API call) -> deterministic Validation Router -> DB writes, via handleVerifyRequest in-process (not a real HTTP round-trip). **No OCR/warning-subsystem comparator (LH-020 not merged -- warningResult is always null).** LH-014's Sonnet resolver has merged to main, but route.ts never calls it inline -- every run below is the fast path only; Sonnet resolution, when it happens, runs asynchronously off the review queue, never inside this request (TH-R19)."

**The route's own history confirms the string.** `git show c5e49f8^:src/app/api/verify/route.ts` carries the line *"This route passes `warningResult: null` to"*. So on the pre-wiring route every run necessarily hit `src/server/router/field-resolution.ts:285-289`, which returns `NEEDS_REVIEW` / `LOW_MODEL_CONFIDENCE` when `warningResult` is null. That rolls up to REVIEW.

**The verdict distribution corroborates it, and does not prove it.** `verdictCounts` reads `{ "REVIEW": 20 }` (`:22-24`), and all 20 runs name `LOW_MODEL_CONFIDENCE`. The pre-wiring route produces exactly that pairing on every run. On the shipping route the same pairing is reachable a second way, so read this as corroboration only. See the correction below.

**Corroboration on the same case.** The live eval run of 2026-08-12T13:26:45Z wires the real comparator (`scripts/eval/cascade-runner.ts:221-230`). It scored `case-01-clean-match-spirits` — the exact case the latency harness measures (`single-label-verify.json:6`) — as `PASS` with a null reason. The shipping pipeline produces a clean pass on this label. The latency artifact never did.

**A new finding, not in the triage report or the audit: the harness will stamp the same false line again.**

Commit `c5e49f8` fixed the harness header comment. `scripts/latency/measure.ts:41-47` now reads *"What IS in this measurement, since TRO-514"*, and `measure.ts:331` wires the real comparator into the harness deps. The commit never touched the `pipelineScope` string literal at `measure.ts:398-405`. This check confirmed it with `git show c5e49f8 -- scripts/latency/measure.ts`: the diff adds the header comment block and the two dependency lines, and contains zero `pipelineScope` lines. So the next run writes correct timings under a false provenance claim. Fix the string before spending money.

**Why the re-run is blocked, plainly.** TRO-519 is real, Urgent, and still in Backlog — read in Linear during this check. `runOcrChannel` awaits the OCR call with no deadline (`src/server/warning/index.ts:123-138`). `compareGovernmentWarningFromImage` awaits `Promise.all` with no deadline (`index.ts:153`). Until a deadline exists, p95 on the shipping pipeline has no upper bound. A measurement taken now would measure an unbounded system, and it would need re-measuring the moment TRO-519 lands.

**The number to quote, and the number not to.** The committed artifact records p50 **3690 ms** and p95 **4339 ms** over 20 successful runs (`single-label-verify.json:25-32`). Both clear the 5000 ms target (`:34`). The measurement is real. It measures the wrong pipeline. That is the whole finding.

## Citation corrections

1. **The draft claimed `LOW_MODEL_CONFIDENCE` has one source. It has two.** `src/server/router/field-resolution.ts:253` also returns it, for any comparator-driven field that escalates on low confidence while its comparator says MATCH and no structural check hits. So 20 REVIEW / `LOW_MODEL_CONFIDENCE` runs do not prove the older route on their own. The pre-wiring route source is `git show c5e49f8^:src/app/api/verify/route.ts`, and that is decisive. The verdict distribution is corroboration.
2. **`audit/requirements/REPORT.md:15` says "The p50 of 4232 ms is real."** That figure is not in the committed artifact. The artifact records p50 3690 ms (`:30`) and p95 4339 ms (`:31`). The 4232 / 4763 pair belongs to the artifact that commit `5a16263` replaced. This check read that superseded version with `git show 5a16263^:scripts/latency/results/single-label-verify.json`: `measuredAt` 2026-08-11T17:45:48.353Z, p50 4232, p95 4763, mean 4252, min 3459, max 5277 — the exact figures still standing at `CHANGES.md:3364-3368` and `factory/scorecard.jsonl:29`. `5a16263` (author date 2026-08-11T21:17:48-05:00, *"re-measure TH-R2 after Wave 1/2 changes"*) committed the newer artifact about 34 seconds after its `measuredAt`. `CHANGES.md` was never updated: a grep for `3690` returns 0 matches. The audit's own per-row note at `audit/requirements/gaps.md:11` already caught this; the headline paragraph did not.
3. **The draft said 4232 ms "measures a pipeline two commits behind the one that ships."** Wrong count. `git rev-list --count 5a16263^..c5e49f8` returns 46. Both older runs predate the warning comparator, which is the point; the commit count was invented. The ticket no longer states one.
4. **TRO-519's description cites `src/server/warning/index.ts:146` for the un-deadlined `Promise.all`.** Line 146 is the `compareGovernmentWarningFromImage` signature. The `Promise.all` is line **153**. TRO-519's other citation, `index.ts:123` for `runOcrChannel`, is correct.

## Do

1. Fix the `pipelineScope` string literal at `scripts/latency/measure.ts:398-405`. Describe the pipeline the harness runs today, including the warning comparator. This step is not blocked. Land it now.
2. Wait for TRO-519 to land an OCR deadline. Do not run before that.
3. Ask Troy for the go-ahead. The run makes 20 real billed Haiku calls.
4. Run `pnpm latency:check`. The defaults are 20 runs against `case-01-clean-match-spirits` (`scripts/latency/args.ts:17-18`).
5. Commit the new artifact. Record p50, p95, and the verdict distribution.
6. Update `CHANGES.md:3357-3373`. Give the new figures. Name which run each older figure came from.
7. Correct the 4232 ms figure at `audit/requirements/REPORT.md:15`.
8. Re-run the TH-R2 row of the requirements audit. Record whether it returns to VERIFIED.

## Acceptance evidence

- The committed artifact's `pipelineScope` names the warning comparator, and no longer says "LH-020 not merged".
- The artifact's `measuredAt` is later than commit `c5e49f8`'s author date, `2026-08-12T03:30:19Z`.
- The artifact's `verdictCounts` no longer reads 20 REVIEW rows on a clean-match case. A different result is still a real result and stays in the artifact.
- `CHANGES.md` carries the new p50 and p95. No figure in `CHANGES.md` contradicts the committed artifact.
- `audit/requirements/REPORT.md` quotes the committed artifact's own numbers.
- TRO-519 is Done before the run. A reviewer can check its Linear status.

## Do NOT

- **Do not run the harness before TRO-519 lands.** The OCR path has no deadline, so p95 is unbounded. A p95 measured on an unbounded system means nothing, and the money spent measuring it buys a number that must be re-measured anyway.
- **Do not run without Troy's go-ahead.** The run spends real money. `MAX_RUNS` caps the damage; it does not authorize the spend.
- **Do not quote 4232 ms anywhere.** It comes from a superseded artifact, it predates the warning comparator, and it is not the committed artifact's own number.
- **Do not raise TH-R2 to VERIFIED on the current artifact.** The artifact's own `pipelineScope` field disproves the claim. PRD §6 grades this project on honest evidence.
- **Do not delete or overwrite the old artifact's record.** It is the evidence that the pipeline changed under the measurement.
- **Do not re-run the harness first and fix the string afterwards.** That order writes a false provenance line into a committed evidence file.


---

# S8 · Measure verdict variance — case-17 returns 3 REVIEW and 2 PASS across 5 committed runs

**Priority:** 2 · **Graded:** TH-R10, TH-R17, TH-R19

**Size:** Small-to-medium, and part of it is free. Step 1 spends nothing: it reads case verdicts back out of the four committed versions of eval-report.json plus benchmark-report.json. I already ran that comparison, so the number exists today. Steps 3-5 add one new script (`scripts/eval/variance.ts`) that loops the existing `runOneCase`, one new artifact shape, and one `--repeats` flag with its own cap. Steps 6-7 add prose to `docs/approach.md` and `CHANGES.md`. No production code changes. The engineering is small. The slow parts are choosing N and K and getting the spend approved. Derived cost, from the 2026-08-12T13:26:45.488Z run's own measured per-call figures (Haiku mean $0.004668 across 32 calls; resolver mean $0.010969 across 13 calls; 13 of 32 cases escalated): 8 cases x 5 repeats costs about $0.19 if nothing escalates and about $0.63 if everything does; 32 cases x 3 repeats costs about $0.45 to $1.50, and about $0.88 at that run's own escalation rate. I computed all three per-call figures from eval-report.json. Every cost figure here is derived from measured per-call costs, not from a price list.

TH-R10 (a stretch requirement, `audit/requirements/inventory.md:94`), TH-R17, TH-R19. Blocked by S5 for the paid run only. Step 1 spends nothing and needs no blocker cleared. The paid run also needs Troy's go-ahead, because it makes real billed API calls.

Source: `docs/diagnostics/2026-08-12-verdict-miss-triage.md` §3A (case-17) and §7 item 2. The report gives this no key. S8 is a new key, taken after the report's S1-S7.

**Priority note.** An earlier draft set this to Medium. I raised it to High. Two reasons. Step 1 below is free, and it already produces a real number. That number bounds every single-run accuracy figure the submission quotes.

## Why

### One committed image returned two different verdicts, on code that never changed.

I read every committed version of the two eval artifacts. `git log --oneline -- scripts/eval/results/eval-report.json` returns four commits. I read case-17 out of each with `git show <sha>:scripts/eval/results/eval-report.json`. I read the fifth run out of `benchmark-report.json` at HEAD.

| measuredAt | Artifact | case-17 label verdict | Correct |
|---|---|---|---|
| 2026-08-12T04:39:34.853Z | `eval-report.json` at `1ccf44b` | REVIEW / AMBIGUOUS_BRAND | true |
| 2026-08-12T05:16:55.005Z | `eval-report.json` at `62cdf1b` | PASS / null | false |
| 2026-08-12T05:23:34.689Z | `benchmark-report.json` at HEAD, cascade arm | REVIEW / AMBIGUOUS_BRAND | true |
| 2026-08-12T12:59:28.746Z | `eval-report.json` at `a6140ff` | REVIEW / AMBIGUOUS_BRAND | true |
| 2026-08-12T13:26:45.488Z | `eval-report.json` at HEAD (`6e41471`) | PASS / null | false |

Five runs. Three REVIEW. Two PASS. Every run expects REVIEW / LOW_IMAGE_QUALITY. Every run records `haikuModel: claude-haiku-4-5`.

The image never changed. `golden-set/manifest.json` gives case-17's `imagePath` as `golden-set/images/case-17-glare-front-label.jpg`. `git log -1 -- golden-set/images/case-17-glare-front-label.jpg` returns commit `662e8ce`, dated `2026-08-11 12:48:14 -0500` — the day before every run. I ran `git log --since="2026-08-12T04:39:34Z" --oneline --all -- 'golden-set/images/case-17*'` and got nothing.

The code that decides the verdict never changed either. Across the whole window, `2026-08-12T04:39:34Z` to `2026-08-12T13:26:46Z`, five directories show zero commits: `src/server/extractor`, `src/server/router`, `src/server/comparators`, `src/server/warning`, `src/server/preprocessing`. Command per directory: `git log --since=... --until=... --oneline -- <dir> | wc -l`.

The extractor already runs at `temperature: 0` (`src/server/extractor/request.ts:51`, documented at `:13`, held by a test at `src/server/extractor/request.test.ts:236-238`). CP-1 records that setting's limit in its own words: "Note that `temperature: 0` has never guaranteed identical output" (`docs/checkpoints/cp1-cascade-router-prompts.md:302`).

### The rest of the corpus is stable. That is the other half of the finding.

29 cases appear in all five runs. I compared each case's label verdict and each case's headline reason across all five. Exactly one case changed: case-17. The other 28 returned the identical verdict and the identical headline reason every time.

So the measured, zero-cost figure today reads 28 of 29 cases stable across five runs, with one case at 3 REVIEW / 2 PASS. State that number before spending anything.

### What I could and could not confirm about the code in between

The brief says no commit touched `src/server` between two of the runs. **That is false as written, and I must say so.** I ran:

```
git log --since="2026-08-12T05:23:34Z" --until="2026-08-12T13:26:46Z" --oneline -- src/server | wc -l
```

It returns **13**. The substance survives in the narrower form above: the five verdict-deciding directories show zero commits. The 13 commits touch batch-queue, batch-progress, batch-start, resolver, review-queue, single-label-resolve and verification-detail. One more commit, `7db16e2`, touched `src/app/api/verify/route.ts`. It adds 23 lines. It snapshots `resolverInput` on the REVIEW `review_queue` insert (TRO-511). It computes no verdict. Case-17 returned PASS in the later run, so the resolver never ran on it.

The corpus also grew inside the window. Commit `16a65fd` (TRO-515, 07:44) added one case. Commit `9b11baf` (TRO-469, 08:06) added two. The merge `6e41471` (08:27) brought the manifest to 32 cases. Both commits added new images only. No existing image changed. So the runs' **aggregate** rates are not comparable across the window. The 29 cases common to all five runs are.

### The repo already records the phenomenon, twice

- `CHANGES.md:696-702` reports the eleven verdict misses. The case-17 sentence runs `:699-702`: "One case (case-17) flips between runs — the pre-merge run scored it correct, this run does not, with no code change to explain it. This is real call-to-call model variance, not a harness bug".
- `CHANGES.md:1518-1521` records an aggregate spread. Two live runs on the same code and the identical 29 cases produced 18/29 = 62.1% and 19/29 = 65.5%. That is one case, or 3.4 percentage points.

**An earlier draft of this ticket said the 62.1% figure has no committed artifact behind it. That is wrong, and I correct it here.** I found the artifact. Commit `62cdf1b` carries `scripts/eval/results/eval-report.json` with `measuredAt: 2026-08-12T05:16:55.005Z`, label-verdict accuracy 18/29, extraction 139/145, and `totalCostUsd: 0.269077`. Those match `CHANGES.md:1509-1512` line for line. The artifact is not the file at HEAD. It lives in git history.

### Why this deserves a ticket

A compliance tool that returns different verdicts for one label on different days is a finding an evaluator will press on. Measure it. State the number. Do not discover it live.

The number also bounds every single-run accuracy figure this project quotes. The triage report's own range, 71.9% to 81.3% (report §8), rests on single runs. A spread measurement says how wide that range's own error bar is.

This touches a graded requirement. Case-17 is a TH-R10 case, and TH-R10 is a stretch requirement (`audit/requirements/inventory.md:94`). The measurement serves TH-R17 (the core works, shown with evidence) and TH-R19 (the technology choice, defended).

## Do

1. **Measure the free number first. Spend nothing.**
   - Read case-level verdicts out of all four committed versions of `eval-report.json`.
   - Read the fifth run out of `benchmark-report.json`.
   - Restrict the comparison to the 29 cases present in every run.
   - Record how many cases returned one verdict every time. Record how each unstable case split.
   - Today that reads 28 of 29 stable, with case-17 at 3 REVIEW / 2 PASS.
   - State this in `CHANGES.md` before any paid run. It costs nothing, and it may be enough.
2. **Ask Troy before the paid run. Get the go-ahead in writing.**
   - State N, K, and the derived cost estimate first.
   - Derive the estimate from the `2026-08-12T13:26:45.488Z` run's own measured per-call costs. Haiku mean $0.004668 across 32 calls. Resolver mean $0.010969 across 13 calls. 13 of 32 cases escalated. I computed all three from `eval-report.json`.
     - 8 cases x 5 repeats: about $0.19 with no escalation, about $0.63 if every run escalates.
     - 32 cases x 3 repeats: about $0.45 with no escalation, about $1.50 if every run escalates, about $0.88 at that run's own escalation rate.
   - Mark every one of those figures derived, not measured.
3. **Add a variance runner: `scripts/eval/variance.ts`, wired to `pnpm eval:variance`.**
   - Reuse `runOneCase` (`scripts/eval/cascade-runner.ts:190`). Write no second cascade path.
   - Reuse `parseEvalArgs` (`scripts/eval/args.ts:114-152`) and `resolveCaseIds` (`:178-195`).
   - Add a `--repeats=<k>` flag. Give it its own hard ceiling, the way `MAX_CASES = 40` already caps cases (`args.ts:75`).
   - Default N to `DEFAULT_SAMPLE_CASE_IDS`, which holds 8 cases (`args.ts:55-64`). Default K to 5.
   - The manifest holds 32 cases today. Two comments in `args.ts` still say 31 (`:25`, `:69`). Do not read the count from them.
4. **Record per-case stability.**
   - For each case, record all K label verdicts and all K headline reasons.
   - Record the modal verdict per case. Record a stability rate per case: modal count divided by K.
   - Record the corpus figure: how many of the N cases returned one verdict on all K runs.
   - Record the accuracy spread: the lowest and the highest label-verdict accuracy across the K runs.
5. **Write the numbers into a committed artifact: `scripts/eval/results/variance-report.json`.**
   - Follow `EvalReport`'s own discipline (`scripts/eval/types.ts:225-245`). Real measured costs. An explicit `measuredAt`. The exact model IDs. The case IDs.
   - Record the commit SHA the run used. Record the manifest content hash S5 adds.
6. **State the figure in prose, in `docs/approach.md` (LH-064) and in `CHANGES.md`.**
   - Name the variance a property of the model.
   - Give N and K beside the number, every time.
   - Put the spread next to every single-run accuracy figure the submission quotes.
7. **Record the run's real measured cost, in the artifact and in `CHANGES.md`.** Never estimate it afterward.

## Acceptance evidence

- `CHANGES.md` states step 1's retrospective figure, with the run count and the case count beside it.
- `scripts/eval/results/variance-report.json` exists. It records K verdicts per case for N cases, with real measured per-call costs.
- The artifact names the model IDs, the commit SHA, the case IDs, and the manifest content hash.
- A reader can state, from that file alone, how many of the N cases returned one verdict on all K runs.
- The artifact records the lowest and the highest label-verdict accuracy across the K runs.
- `docs/approach.md` states the spread as a range, with N and K beside it, and names it a model property.
- The prose proposes no fix for the variance.
- Troy's go-ahead, and the cost estimate shown to him, appear in this ticket or in `CHANGES.md` before the paid run.
- The measured total cost appears in the artifact and in `CHANGES.md`.
- The factory gate passes. CI is green.

## Do NOT

- **Do not propose a fix for the variance.** It is a property of the model. The deliverable is a measured number and a written statement.
- **Do not add retries, a lower temperature, or a self-consistency vote to improve the number.** The extractor already runs at `temperature: 0` (`src/server/extractor/request.ts:51`). CP-1 already records that this guarantees nothing (`cp1:302`). A vote across K calls changes the architecture and multiplies the per-label cost. Neither the PRD nor CP-1 asks for one.
- **Do not run the paid sweep without Troy's go-ahead.** It makes real billed API calls against a live paid endpoint.
- **Do not use the number to relax a golden expectation.** TRO-516's C8 already rules on case-17: the pixels support the manifest note, so do not relax it to PASS. A variance figure explains the flip. It does not license a corpus edit.
- **Do not raise `MAX_CASES` (`args.ts:75`) to fit more repeats.** Cases and repeats are different axes. Cap them separately. One careless flag would otherwise multiply the spend.
- **Do not compare aggregate rates across the window.** The corpus grew from 29 cases to 32 between the runs. Compare the 29 cases common to every run. Or compare the two same-corpus runs at `CHANGES.md:1518-1521`.
- **Do not run the paid sweep before S5 lands, unless Troy chooses to pay twice.** Today the harness scores the router's interim verdict (`cascade-runner.ts:299-304`, before the resolver gate at `:311`). A stability figure measured now describes the router alone.


---

# S4 · Deskew a baked-in tilt before extraction — EXIF-only rotation leaves it in the pixels

**Priority:** 3 · **Graded:** TH-R10

**Size:** Small to medium. One new module of roughly 120 lines (downscale, ink projection, angle sweep), a two-pass edit inside preprocessImage, one dimension re-derivation, one new field on the PreprocessedImage interface and its return, three unit tests. The risk is not code volume. The deskew changes the pixels of every uploaded image, and its benefit on case-19 is probabilistic — budget the live re-run and its interpretation, not the implementation. Observed and reassuring: the two OCR integration tests read committed JPEGs directly and never call preprocessImage, so they cannot regress from this change.

TH-R10 (stretch). Blocked by nothing.

## Why

One live run measures this. It ran at `2026-08-12T13:26:45.488Z` (`scripts/eval/results/eval-report.json`, mode `live`, model `claude-haiku-4-5`, manifest `1.0.0`). In that run case-19 expected PASS. It returned REVIEW / WARNING_MISMATCH.

Haiku invented a word. The label prints:

> ... during pregnancy because **of** the risk of birth defects ...

Haiku returned:

> ... during pregnancy because **use of** the risk of birth defects ...

The label's own text sits at `golden-set/manifest.json:1072`. Four of the five scored extraction fields came back correct. The government warning did not.

**I re-measured the distance with the repo's own comparator.** I ran `evaluateCandidate` (`src/server/warning/wording-compare.ts:61`) on both strings:

| Input | distance | wording | caps |
|---|---|---|---|
| Haiku's transcription | 4 | MISMATCH | all four positions OK |
| the label's true text | 0 | EXACT_MATCH | all four positions OK |

`NEAR_MISS_MAX_DISTANCE` is 2 (`src/server/warning/wording-compare.ts:30`). `classifyDistance` returns MISMATCH above it (`:54-58`). The comparator returned REVIEW / WARNING_MISMATCH (`src/server/warning/reconcile.ts:128-129`). The router passed that verdict through unchanged (`src/server/router/field-resolution.ts:294-300`). `rollupLabelVerdict` returned REVIEW on the one NEEDS_REVIEW row (`src/server/router/rollup.ts:16`). **Every deterministic stage behaved correctly.** The defect sits in what Haiku read.

### The design gap

`preprocessImage` corrects orientation from the EXIF tag only (`src/server/preprocessing/pipeline.ts:96-100`). `docs/PRD.md:58` scopes the stage that way. case-19's degradation is a pixel rotation of 15 degrees (`golden-set/manifest.json:1102`).

**Observed.** I read the committed JPEG with sharp. `golden-set/images/case-19-rotation-mild-correctable.jpg` carries no EXIF block and no orientation tag. It measures 1173x1032, against 1000x800 on the clean cases — the rotation already expanded the canvas at render time. So `.rotate()` does nothing on this file. Haiku reads a tilted warning block.

The same tilt breaks the OCR channel. **I re-ran `detectWarningRegionClassical` against seven committed golden images:**

| Image | classical region |
|---|---|
| case-01 | `{"x":52,"y":524,"width":894,"height":140}` |
| case-14 | `{"x":52,"y":524,"width":894,"height":140}` |
| case-15 | `{"x":52,"y":524,"width":894,"height":140}` |
| case-18 | `{"x":52,"y":524,"width":894,"height":138}` |
| case-23 | `{"x":52,"y":520,"width":886,"height":30}` |
| **case-19** | **null** |
| **case-20** | **null** |

The detector returns null on both rotated images. It returns a clean box on all five upright ones. Its own header states the assumption: it is tuned for "dense small print in a roughly axis-aligned block" (`src/server/warning/region-detect.ts:25`). A block needs three separate line runs (`:61`, `:158`). A 15-degree tilt smears the rows together.

### The honest limit — deskew helps ONCE, not twice

**I measured all three paths with the production reconciler** (`reconcileWarningChannels`, `src/server/warning/reconcile.ts:184`):

| Input | Result |
|---|---|
| A. Haiku's transcription, OCR unavailable (today) | NEEDS_REVIEW / WARNING_MISMATCH |
| B. the label's true text, OCR unavailable | MATCH |
| C. Haiku's transcription, perfect OCR restored | NEEDS_REVIEW / WARNING_MISMATCH |

Run C is the line that matters. Restoring region detection restores the OCR channel. A perfect OCR read against this invented VLM read still takes the disagree branch (`src/server/warning/reconcile.ts:135-137`). It still returns REVIEW / WARNING_MISMATCH.

So deskew helps through the extraction half only. It gives Haiku an axis-aligned warning block. **It is a probabilistic mitigation for a nondeterministic model error, not a deterministic fix.** Nobody may write that this ticket fixed case-19.

### Graded exposure, stated honestly

TH-R10 is a stretch requirement (`audit/requirements/inventory.md:94`). Its acceptance line reads "either correct extraction or an explicit unreadable/low-confidence outcome; never a confident wrong verdict" (`:95`). case-19 returned an explicit REVIEW. **TH-R10's acceptance line is not breached.** The miss is against the golden expectation of PASS (`golden-set/manifest.json:1076`). That is a stricter bar than the requirement itself. So this ranks below the report's S1, S2 and S3. Those three all sit on non-stretch requirements.

### The existing test is not evidence

`src/server/router/golden-image-quality.test.ts:202-237` covers case-19. It hands the router the manifest's true transcription (`:219`) and a clean warning comparator result (`:231`). Its one assertion (`:235`) compares the router output against the manifest expectation, which is PASS (`golden-set/manifest.json:1076`). The fixture cannot reproduce an invented transcription. The test stays green while the live run fails. Do not cite it.

### Three corrections to the triage report

1. The report states the detection ladder falls through, so the OCR channel reported unavailable (`src/server/warning/region-detect.ts:242-253`, `src/server/warning/index.ts:129`). I confirmed the classical half returns null. I did not run the band-search fallback (`region-detect.ts:249`). That path needs a live OCR callback. So "the ladder fell through on this run" stays **derived**, not observed. The conclusion does not depend on it. Runs A and C above measure both paths. Both return REVIEW / WARNING_MISMATCH.
2. The report cites `golden-set/manifest.json:1101-1103` for the rotation degradation. The `degradations` array spans `:1101-1103`. The rotate entry itself sits on `:1102`.
3. The report classifies S4 as "GRADED: TH-R10 (stretch)" without qualifying it. TH-R10's acceptance line accepts an explicit low-confidence outcome, and case-19 returned one. The graded line is not breached. The golden expectation is.

## Do

1. Add `src/server/preprocessing/deskew.ts`. Export `estimateSkewAngleDeg(image: Buffer): Promise<number>`.
2. Measure the angle from a row-ink projection. Copy the method in `src/server/warning/region-detect.ts`. Downscale to 500px wide, as `ANALYSIS_WIDTH_PX` does (`:41`). Count a pixel as ink below 180, as `DARK_PIXEL_THRESHOLD` does (`:44`). Both constants are module-private, so copy the values and name the source in a comment. Do not export them.
3. Sweep candidate angles. Keep the angle whose row-projection variance is highest. Text rows align at the correct angle, so the projection peaks there.
4. Add `MAX_DESKEW_ANGLE_DEG` to `src/server/preprocessing/constants.ts`. Propose 20. Mark it proposed, not measured, in its comment.
5. Return 0 when the sweep finds no clear peak. `src/server/preprocessing/pipeline.test.ts:18-20` builds flat single-colour JPEGs. They carry no ink runs. A no-op keeps `:36-41` and `:51-55` green.
6. Call the deskew inside `preprocessImage`. It needs two sharp passes, not one chained call: the angle estimate reads the EXIF-rotated pixels, so it cannot run inside the existing chain at `src/server/preprocessing/pipeline.ts:96-107`. Produce the EXIF-rotated buffer first. Estimate the angle from it. Rotate by that angle. Then flatten and encode. Both variants derive from `original` (`:123-138`), so one call covers the extractor and the OCR channel. `src/app/api/verify/route.ts:208` reads `haikuVariant`. `:227` reads `original`.
7. Re-derive `width` and `height` from the deskewed buffer. `src/server/preprocessing/pipeline.ts:112-116` derives them from EXIF metadata today. A rotation by an arbitrary angle expands the canvas, so those numbers stop matching `original`. `src/app/api/verify/route.ts:254-257` feeds them to `computeResizeDimensions`, and `:261` feeds the result to `longEdgePx`.
8. Add `deskewAngleDeg` to the `PreprocessedImage` interface (`src/server/preprocessing/pipeline.ts:36-47`) and to the return object (`:140-147`). A reviewer needs it to see how often the step ran.
9. Write the regression test first. Confirm it fails for the right reason.

## Acceptance evidence

* A unit test rotates a rendered label by 15 degrees. `estimateSkewAngleDeg` recovers the angle to within 2 degrees.
* A unit test proves `estimateSkewAngleDeg` returns 0 on a flat single-colour JPEG.
* `src/server/preprocessing/pipeline.test.ts:36-41` and `:51-55` pass unchanged. No skip. No weakened assertion.
* `detectWarningRegionClassical` returns a non-null region on the deskewed case-19 buffer. It returns null today. Measure both and record the two results side by side.
* **Observed:** two OCR integration tests read committed JPEGs directly and never call `preprocessImage` (`src/server/warning/region-detect.test.ts:236`, `src/server/warning/index.test.ts:168`). A deskew inside the pipeline cannot move them. Re-run both anyway and record the result.
* Run `pnpm eval:check --live --case=case-19-rotation-mild-correctable` three times. Record all three label verdicts, the model, the date, and the cost.
* **Report the three verdicts as measured. Do not write "case-19 fixed."** The failure is a model invention, so three PASSes are evidence, not proof.

## Do NOT

1. **Do not widen `NEAR_MISS_MAX_DISTANCE`** (`src/server/warning/wording-compare.ts:30`) to absorb the inserted word. Three reasons, and the second one is measured:
   * Distance 4 is a real four-character invention. The band exists for a one-character slip.
   * **It would not even change the verdict.** `reconcileSingleChannel` reaches MATCH only when `isExactMatch` passes (`src/server/warning/reconcile.ts:119`) and the VLM confidence reaches 0.90 (`:120-122`). `isExactMatch` requires distance 0 (`src/server/warning/wording-compare.ts:77-79`, `:55`). A band of 4 reclassifies case-19 as NEAR_MISS, and `reconcile.ts:128-129` still returns REVIEW / WARNING_MISMATCH. Only the note string changes.
   * CP-2 §5.5 names the failure mode directly: "Failure mode if the band is too wide: a genuinely deviant label escapes FAIL and costs a review instead" (`docs/checkpoints/cp2-warning-subsystem.md:675-676`). Guard 2 on the same page states the band never turns a FAIL into a PASS (`:672-673`).
2. **Do not lower `OCR_CONFIDENCE_FLOOR`** (`src/server/warning/reconcile.ts:67`) for this case. Run C measures the outcome: a perfect OCR read still returns REVIEW / WARNING_MISMATCH. That constant carries its own ticket (report §5 S2) and its own two cases.
3. **Do not relax the golden expectation** at `golden-set/manifest.json:1076` from PASS to REVIEW. The label prints "because of the risk" (`:1072`). The corpus is right and the model was wrong.
4. **Do not deskew inside the warning subsystem only.** Extraction is the half deskew can help. A deskew applied to the OCR crop alone leaves Haiku reading the tilted image, and run C shows that changes nothing.

## What I ran

Every number above came from one of these, in the working tree at commit `8fa8999`:

1. `node` against `scripts/eval/results/eval-report.json` — the run header, case-19's five field scores, and the two transcriptions.
2. `tsx` calling `evaluateCandidate` from `src/server/warning/wording-compare.ts` — the distance table.
3. `tsx` calling `reconcileWarningChannels` from `src/server/warning/reconcile.ts` — runs A, B and C.
4. `tsx` calling `detectWarningRegionClassical` from `src/server/warning/region-detect.ts` against seven committed JPEGs in `golden-set/images/` — the region table. **Note:** I ran the detector against the committed files, not against the `preprocessed.original` buffer the route OCRs (`src/app/api/verify/route.ts:227`).
5. `node` calling `sharp().metadata()` on three committed JPEGs — the EXIF and canvas-size result.

The drafted version of this ticket cited commit `22773b8`. HEAD is now `8fa8999`. I checked that commit: it adds reference photos, a provenance record and Wave 2b tickets, and touches nothing under `src/`, `scripts/`, `golden-set/images/` or `golden-set/manifest.json`. Every measurement holds at HEAD.

No source file changed. No script was added to the repo.


---

# S6 · Record which LOW_IMAGE_QUALITY trigger fires; no confidence branch fired in 32 live cases

**Priority:** 3 · **Graded:** TH-R10, TH-R19

**Size:** Two sizes in one ticket, and they should be judged separately. Steps 1 to 4 are small and safe: a boolean becomes a four-value enum, the eval report gains one field, and one schema field gets consumed or deleted. Roughly 150 lines plus four unit tests, with no behaviour change to the rollup. Step 4 grew slightly against the draft: deleting image_quality.issues also removes it from the resolver prompt, so that option now needs a second decision. Step 5 is open-ended research. The whole-region contrast formulation is measured and dead. The tiled formulation is unsettled — two runs with different tile parameters reach opposite conclusions, so budget a full 32-case sweep before anyone claims it works. Land steps 1 to 4, then decide on step 5 against the remaining time. A live --full eval re-run is needed to read the recorded trigger back.

TH-R10 (stretch), TH-R19. Blocked by nothing. Sequence this after the eval-harness evidence ticket (triage report §5 "S5"). That ticket records the per-field confidence this diagnosis currently has to derive.

## Why

**Measured across all 32 cases in the live run of `2026-08-12T13:26:45.488Z`** (`scripts/eval/results/eval-report.json`). I re-tallied it with `node`:

| Signal | Fired |
|---|---|
| `LOW_IMAGE_QUALITY`, label level | **1 case** (case-20) |
| `LOW_MODEL_CONFIDENCE`, any field | **0 of 160 field rows** |
| `LOW_MODEL_CONFIDENCE`, label level | **0 cases** |
| cases expecting `LOW_IMAGE_QUALITY` | **7** (case-17, 18, 20, 21, 22, 23, 24) |

On case-20 all five fields returned "(not read)". So a deterministic trigger necessarily fired there — the absent-fields rule (`src/server/router/label-blockers.ts:43-47`). **No case in the run needed a confidence-driven branch to reach its verdict.**

CP-1 makes a promise the code breaks. It states the promise twice:

> So the design treats confidence as an **ordinal signal** — useful for ranking, not for arithmetic — and never lets it decide anything on its own. Every routing decision below combines confidence with at least one deterministic signal: an evidence check, a comparator outcome, or a cross-field arithmetic check.
>
> — `docs/checkpoints/cp1-cascade-router-prompts.md:316-319` (§4.1)

> Confidence **never decides anything alone**. Every rule in §5.3 combines it with a deterministic signal — an evidence check, a comparator outcome, a proof calculation, a beverage-type cross-check.
>
> — `docs/checkpoints/cp1-cascade-router-prompts.md:1174-1176`

The second quote names §5.3 directly. `isLowImageQuality` is a §5.3 rule — its own file header says so (`src/server/router/label-blockers.ts:1-8`). It has four triggers (`:20-51`). Two keep the promise. Two break it:

| Line | Trigger | Deterministic? |
|---|---|---|
| `:25` | `legible === "no"` | **No.** One self-report, paired with nothing. |
| `:27-39` | `legible === "partial"` and a required field below 0.60 | **No.** Two self-reports, paired with each other. |
| `:41` | preprocessing rejected, or long edge under 640px | Yes. |
| `:43-47` | half the required fields absent | Yes. |

CP-1 anticipated this outcome in writing:

> And we **measure the calibration rather than assume it**. ... If it turns out to be flat — the model says 0.9 for everything — then confidence-based routing contributes nothing, and I would say so and lean entirely on the deterministic signals. That is a finding, not a failure.
>
> — `docs/checkpoints/cp1-cascade-router-prompts.md:1178-1181`

This ticket is that finding.

### The green unit test rests on a fixture the live run contradicts

`src/server/router/golden-image-quality.test.ts` covers TH-R10's bar for case-17 through case-22. It builds each extraction by hand. For case-17 it supplies `legible: "partial"` with `confidence: 0.78` (`:124`) and a `brand_name` confidence of `0.45` (`:131`), commented "Below the Unusable floor (0.60)" (`:129`). Under that fixture the partial branch fires. Its assertion at `:156` compares the router output against the manifest expectation, which is REVIEW / LOW_IMAGE_QUALITY.

The live runs produced two different readings of the same file:

* the 13:26 eval run returned **PASS** with a null reason, every field MATCH, and all five extraction fields correct;
* the committed benchmark run of `2026-08-12T05:23:34.689Z` — same `haikuModel` `claude-haiku-4-5`, same `manifestVersion` `1.0.0` — returned **REVIEW / AMBIGUOUS_BRAND** with `brand_name` NEEDS_REVIEW in the cascade arm (`scripts/eval/results/benchmark-report.json`).

The unit test is green under both. **A graded requirement rests on a fixture, and no live run has reproduced that fixture.**

### A signal the schema collects and the router never reads

`image_quality.issues` carries eight values, including `low_resolution` (`src/server/extractor/schema.ts:33-48`; `low_resolution` at `:44`). I grepped every reference outside tests. **No routing decision reads it:**

* `isLowImageQuality` reads `image_quality.legible` only (`src/server/router/label-blockers.ts:25`, `:27`).
* `src/server/router/index.ts:180` reads `image_quality.confidence`, and only to test whether the number is valid. That result feeds `CONFLICTING_EXTRACTION`, not `LOW_IMAGE_QUALITY`.

**One consumer does exist, and the draft of this ticket got it wrong.** The resolver sends the whole extraction object to Sonnet: `buildExtractionBlock` calls `serializeUntrusted(input.extraction)` (`src/server/resolver/user-message.ts:39-41`), and `input.extraction` carries `image_quality` (`src/server/extractor/types.ts:93`). `src/server/resolver/input-validation.ts:162-166` says so in its own words: "`buildExtractionBlock` in `user-message.ts` serializes the whole `extraction` object, including `image_quality`." The length check at `:187` exists for that reason, and its error text names "the resolver prompt" (`:91`).

So the honest statement is narrower: the **router** never reads `issues`; the **resolver** receives it as untrusted context. Deleting it from the schema would remove content the Sonnet prompt carries today. **Consuming it does not satisfy CP-1 §4.1 either** — `issues` is one more self-report. Write that down in the change, so nobody records it as a fix.

### Graded exposure, stated honestly

TH-R10 is a stretch requirement (`audit/requirements/inventory.md:94`). Its acceptance line accepts "either correct extraction or an explicit unreadable/low-confidence outcome" (`:95`). In the 13:26 run case-17 extracted every field correctly, so that run does not breach the line either.

The real breach is **TH-R19**: "choices defended in docs" (`audit/requirements/inventory.md:165`). CP-1 is an approved document. It states a rule twice that the code does not follow. That is the question Troy cannot answer well in a live defense.

## Do

1. Make the router name the trigger that fired. Change `isLowImageQuality` (`src/server/router/label-blockers.ts:20-51`) to return the trigger instead of a boolean. Use four names: `ILLEGIBLE`, `FIELD_CONFIDENCE`, `PREPROCESSING`, `FIELDS_ABSENT`.
2. Keep the rollup behaviour identical. `src/server/router/index.ts:156` and `:188` must produce the same `labelLevelBlocker` value as today.
3. Record the trigger in the eval report. No artifact records it today — the string "confidence" does not appear in `eval-report.json` at all, and no field holds a blocker name. On case-20 every field returned "(not read)", so `FIELDS_ABSENT` necessarily fired. `ILLEGIBLE` may have fired alongside it. Nothing in the repo distinguishes them.
4. Decide `image_quality.issues`. Either the router reads it, or `src/server/extractor/schema.ts:33-48` drops it. Do not leave it collected and unread by the router. Before dropping it, price the second effect: the resolver prompt carries it today (`src/server/resolver/user-message.ts:39-41`), so a schema deletion also removes it from Sonnet's context.
5. Attempt a deterministic signal only after steps 1 to 4 land. Write the bar down first: the signal must fire on the seven cases that expect `LOW_IMAGE_QUALITY`, and must not fire on the clean cases.
6. Carry any new signal on `PreprocessingSignal` (`src/server/router/types.ts:132-137`). `src/app/api/verify/route.ts:259-262` builds that object with two fields today.

## The contrast proposal is unsettled — two runs disagree

The triage report proposes "a per-region ink-versus-ground contrast measurement in preprocessing, which would fire on case-17's image." I tested it. **One formulation provably fails. A second is unsettled, and this ticket must not claim otherwise.**

I measured greyscale percentiles inside the brand box (`scripts/golden/render.ts:80`, `{x:60,y:60,width:880,height:140}`) on the committed JPEGs. My ratio is `(ground/255 + 0.05) / (ink/255 + 0.05)`, with ink the 2nd percentile and ground the 95th.

**Formulation A — one ratio for the whole region. Reproduced twice. It fails.**

| Case | ink (p2) | ground (p95) | ratio |
|---|---|---|---|
| case-01 (clean) | 15 | 255 | 9.65 |
| case-03 (clean) | 13 | 255 | 10.40 |
| case-17 (glare) | 15 | 255 | **9.65** |

case-17 and clean case-01 score the same number to two decimals. The glare band covers part of the box only. Black glyphs outside it hold the 2nd percentile down. No threshold on this statistic separates them.

**Formulation B — 44px tiles. NOT SETTLED. The draft of this ticket reported it as a second failure. I could not reproduce that.**

The draft reported a worst inked tile of 1.24 for clean case-03 against 1.23 for glared case-17, and concluded no threshold separates them. I ran a tiled measurement with the same tile size and stated my own filter — keep a tile when its 2nd percentile falls below 200 — and got a different answer:

| Case | worst tile ratio | median tile ratio |
|---|---|---|
| case-01 (clean) | 5.73 | 11.77 |
| case-03 (clean) | 7.09 | 11.27 |
| case-17 (glare) | **1.35** | 9.65 |
| case-21 (low light) | **1.00** | 1.04 |

Under my parameters the worst-tile statistic **does** separate case-17 from both clean cases. The draft also claimed the front region inverts — case-21 at 5.70 against clean case-01 at 4.64. I measured the front region (`scripts/golden/render.ts:81`) and got the opposite ordering: case-21 median 1.04, case-01 median 9.00.

**The finding is that the tiled result depends on unstated parameters, and two runs with different parameters reach opposite conclusions.** Neither run is evidence over 32 cases. That is exactly why step 5 keeps its written bar. Do not adopt a tile threshold on either of these tables.

One constraint neither the report nor the draft states. **Production has no label region map.** I used the golden renderer's boxes (`scripts/golden/render.ts:76-84`). `src/server/preprocessing/region.ts` exports only `PixelRegion` (`:13`) and `clampRegionToBounds` (`:40`). The single detector in the repo finds the warning block (`src/server/warning/region-detect.ts:242-253`) and returns null on a rotated image. A per-region measurement in production must define its own windows first.

**If no signal clears the bar, ship the measurement and say so.** CP-1's own words at `:1178-1181` make that an acceptable outcome.

## Acceptance evidence

* One unit test per trigger proves `isLowImageQuality` returns that trigger's name. Four tests.
* `src/server/router/label-blockers.test.ts` and `src/server/router/golden-image-quality.test.ts` keep every assertion. No skip. No deleted case.
* The eval report records the trigger for every case whose reason is `LOW_IMAGE_QUALITY`. Run `pnpm eval:check --live --full` and quote the recorded trigger for case-20.
* `grep -rn "image_quality.issues\|imageQuality.issues" src/server --include="*.ts"` shows either a router read or no schema entry. One of the two, never neither.
* A new deterministic signal ships only with a table of its value for all 32 cases and its threshold. Name every clean case it fires on.
* **Do not report a higher eval score as evidence that the promise is restored.** The promise is about pairing a self-report with a deterministic signal, not about the scoreboard.

## Do NOT

1. **Do not lower `UNUSABLE_CEILING`** (`src/server/router/confidence.ts:32`) to make the partial branch fire. That branch is the one CP-1 already calls unpaired, so a lower floor makes an unpaired rule fire more often. It also moves MATCH escalation for every field: `MATCH_ESCALATION_CEILING = UNUSABLE_CEILING` (`:73`), read at `:107-110`.
2. **Do not edit case-17's expectation to PASS.** The triage report measured the glare band core and found no pixel darker than 32/255 there. I did not re-measure that window. I measured the whole brand box and found a 2nd percentile of 15/255, which is consistent — black glyphs outside the band hold it down. I did confirm the second half of the argument directly: the same server code escalated the same file to REVIEW / AMBIGUOUS_BRAND in the 05:23Z benchmark run.
3. **Do not build a font-unusualness detector**, or any detector whose only purpose is to make cases 25 and 26 return REVIEW. The report lists that under "Not a fix". Neither the PRD nor CP-1 asks for one.
4. **Do not weaken `src/server/router/golden-image-quality.test.ts`.** Its fixtures are a legitimate router unit test. They are simply not live evidence. Add live evidence beside them. Do not delete the unit test.
5. **Do not adopt a contrast threshold from the tables above.** Two runs with different tile parameters reach opposite conclusions on case-17. Measure all 32 cases first, and publish the parameters with the numbers.

## What I ran

Every number above came from one of these, in the working tree at commit `8fa8999`:

1. `node` against `scripts/eval/results/eval-report.json` — the reason tallies, the 160 field rows, the seven expecting cases, and case-20's five "(not read)" fields.
2. `node` against `scripts/eval/results/benchmark-report.json` — case-17's cascade-arm verdict, model and manifest version in the 05:23Z run.
3. `grep -rn "image_quality|imageQuality" src scripts --include="*.ts" --include="*.tsx"`, filtered to non-test files — the consumer list.
4. `tsx` with `sharp`, reading the committed JPEGs in `golden-set/images/` — formulations A and B, and the front-region table.

The drafted version of this ticket cited commit `22773b8`. HEAD is now `8fa8999`, which touches no file any measurement here depends on.

No source file changed. No script was added to the repo.


---

# S7 · Correct scripts/eval/args.ts: the default sample produces one reviewReason, not all eight

**Priority:** 3 · **Graded:** none

**Size:** Small, and larger than the draft claimed. The comment rewrite is about 25 lines in one file. Gate G6 fails on a comment-only change, because it requires an added test case, so the ticket also adds a typed constant for the sample's documented reasons and one test that reads it (about 30 lines across scripts/eval/args.ts and scripts/eval/args.test.ts), plus a CHANGES.md entry. That test is red today and green after the rewrite. No exported behavior changes: parseEvalArgs, validateCheckArgs, resolveCaseIds, DEFAULT_SAMPLE_CASE_IDS, and MAX_CASES keep their current values. No live run, no spend.

No graded requirement. This protects PRD §6 honest-evidence discipline and CLAUDE.md's "claims carry provenance" rule. Blocked by nothing.

## Why

**The measured fact.** No case in the golden set produced `LOW_MODEL_CONFIDENCE` in the 2026-08-12 live run.

I tallied every `actualReviewReason` in `scripts/eval/results/eval-report.json` — `ticket: TRO-470 / LH-030`, `measuredAt: 2026-08-12T13:26:45.488Z`, `mode: live`, 32 cases.

| Label-level `actualReviewReason` | Cases |
|---|---|
| null | 19 |
| `AMBIGUOUS_BRAND` | 4 |
| `WARNING_MISMATCH` | 3 |
| `CONFLICTING_EXTRACTION` | 2 |
| `MISSING_REQUIRED_FIELD` | 2 |
| `AMBIGUOUS_ABV` | 1 |
| `LOW_IMAGE_QUALITY` | 1 |

Two of the eight `ReviewReason` members (`src/lib/db/enums.ts:48-57`) fired zero times: `LOW_MODEL_CONFIDENCE` and `AMBIGUOUS_NET_CONTENTS`. I checked the field rows too, not only the label rows. The string `LOW_MODEL_CONFIDENCE` appears twice in the whole report. Both are an `expectedReviewReason`. Neither is an actual one.

case-25 itself: expected REVIEW / `LOW_MODEL_CONFIDENCE`, actual PASS / null, and all five actual field verdicts MATCH.

**Which claim is false, precisely. The triage report and I differ here.**

The report calls `scripts/eval/args.ts:37` false. I could confirm less than that, and more.

* Read as a statement of case-25's manifest expectation, `:37` is true. The manifest does expect that reason. Every other line in the same list states an expectation the same way — `:30` calls case-01 "PASS", which is also its expectation.
* The false claims sit lower in the same comment, and they are stronger. They say what the sample exercises:
  * `:44-47` — "Swapped to `case-25` (a comparator-driven field's own genuine LOW_MODEL_CONFIDENCE path, `field-resolution.ts`'s `resolveComparatorField`) to keep this sample covering every reviewReason family it always intended to."
  * `:50-51` — "a cheap, fast smoke set that exercises every reviewReason family and both REVIEW-escalation and no-escalation paths."

**Measured, the eight sample cases produced one reason.** I read the eight sample rows out of the committed 32-case run. I did not run a separate eight-case sweep.

| Sample case | Expected | Actual |
|---|---|---|
| case-01 | PASS / null | PASS / null |
| case-02 | PASS / null | PASS / null |
| case-05 | FAIL / null | FAIL / null |
| case-08 | FAIL / null | FAIL / null |
| case-12 | REVIEW / `MISSING_REQUIRED_FIELD` | REVIEW / `MISSING_REQUIRED_FIELD` |
| case-14 | PASS / null | PASS / null |
| case-17 | REVIEW / `LOW_IMAGE_QUALITY` | PASS / null |
| case-25 | REVIEW / `LOW_MODEL_CONFIDENCE` | PASS / null |

One reason produced, out of eight. Two of the eight cases missed their expected verdict. So `args.ts:36` carries the same defect as `:37`, for case-17.

**No case swap can repair the claim.** `LOW_MODEL_CONFIDENCE` reaches a comparator field on one path only: the comparator returns MATCH, and the field's confidence escalates it anyway (`src/server/router/field-resolution.ts:252-254`, inside `resolveComparatorField` at `:232`). A MATCH escalates only below `MATCH_ESCALATION_CEILING`, which is defined as `UNUSABLE_CEILING` = 0.60 (`src/server/router/confidence.ts:73`, `:32`, applied at `:107-110`). No case in the corpus produced a confidence that low. The one other producer is a defensive branch for a missing warning comparator result (`field-resolution.ts:289`), which no golden case reaches either. There is no case to point at.

**A second stale claim, in the neighbouring comment.** `args.ts:25` says "the 31-case golden set". That line sits in the block this ticket already edits. `args.ts:68` says "31 cases today". That line sits in the separate `MAX_CASES` doc comment. Measured: `golden-set/manifest.json` holds 32 cases. `MAX_CASES` is 40 (`args.ts:75`), so nothing breaks today. The file still states a count that measurement contradicts. LH-023 adds case-33 and case-34 (`factory/tickets.md:174-177`), which makes 34.

## Do

1. Rewrite the case-25 line at `scripts/eval/args.ts:37`. State what the case is in the sample for: odd typography, script brand font. Do not name a reason it does not produce.
2. Rewrite the case-17 line at `:36` the same way, for the same reason.
3. Delete the swap claim. It starts mid-line at `:44` and ends at `:47`. Line 44 also carries the last words of the sentence before it. Cut the sentence, not the line.
4. Keep the TRO-469 history at `:39-44`. It records a real, documented decision about case-23.
5. Replace the "exercises every reviewReason family" sentence at `:50-51`. State the measured result: the sample produced one reason in the 2026-08-12 run.
6. Record the gap where a reader will find it. No case in the golden set produces `LOW_MODEL_CONFIDENCE` or `AMBIGUOUS_NET_CONTENTS`. Name the run and the date.
7. Correct "31-case" at `:25` and "31 cases today" at `:68` to 32.
8. Leave `DEFAULT_SAMPLE_CASE_IDS` unchanged (`:55-64`). See **Do NOT**.
9. Make the sample's documented reasons machine-checkable, and add the test that reads them. This is the step that lets the ticket pass gate G6 (`scripts/factory/gate.sh:256-262`), which fails any change with no added test case.
   * Add one exported constant to `scripts/eval/args.ts`: a map from sample case ID to the `ReviewReason` the committed run actually produced, or `null`.
   * Add one test to `scripts/eval/args.test.ts`. Load the committed report with `validateEvalReport` (`scripts/eval/report-validation.ts:102`). For every sample case, assert the map's value equals that case's `actualReviewReason` in the report.
   * Add a second assertion in the same file: every ID in `DEFAULT_SAMPLE_CASE_IDS` exists in the real manifest, loaded with `loadGoldenSetManifest` (the import at `scripts/eval/warning-golden-cases.test.ts:31`). No test checks this today.
   * The first test is red before step 1 and green after it. Write it first, and record the red run.
10. Add the `CHANGES.md` entry.

## Acceptance evidence

* The new test fails on the current `main` and passes after the rewrite. Paste both runs. That is the red-first evidence gate G6 asks for.
* Every `ReviewReason` the rewritten comment claims the sample produces appears as an `actualReviewReason` on that case's row in `scripts/eval/results/eval-report.json`. There is one to check by hand: `MISSING_REQUIRED_FIELD` on case-12.
* The comment names no reason that the report does not carry as an actual value on that case.
* The string "31" no longer appears in `scripts/eval/args.ts`. It appears exactly twice today, at `:25` and `:68`, and both are the stale count. Confirm the real count with `node -e "console.log(require('./golden-set/manifest.json').cases.length)"` — it prints 32.
* `pnpm test` passes. `scripts/eval/args.test.ts` is green, and `scripts/eval/warning-golden-cases.test.ts:63` is green. Neither pins case-25 today — `args.test.ts:92` compares against the constant itself, and the warning test pins case-08 — so neither existing assertion should need an edit. If either does, stop and say why.
* `pnpm typecheck` passes. `pnpm lint` passes.
* `parseEvalArgs`, `validateCheckArgs`, `resolveCaseIds`, `DEFAULT_SAMPLE_CASE_IDS`, and `MAX_CASES` keep their current values. The new constant is documentation the test reads. No runtime behavior changes.
* The factory gate passes.
* State the coupling out loud when you report the result. The new test reads a measured artifact, so a shrunken `eval-report.json` breaks it. That is the intended behavior, not a flaw: gate G8 already requires the committed report to cover every case in the baseline.

## Do NOT

* **Do not point `DEFAULT_SAMPLE_CASE_IDS` at another case to keep the claim alive.** Measured: no case in the 32 produces `LOW_MODEL_CONFIDENCE`. A swap restates the same false claim under a different ID. That is the exact mistake TRO-469's swap already made once.
* **Do not fix this by editing case-25's expectation in `golden-set/manifest.json`.** That is a separate, larger decision — triage report §4, corrections C1 and C2. It needs Troy's sign-off, and every case in the manifest still carries `verified: false`. This ticket is true today with the corpus exactly as it stands, and it should not wait on a corpus decision.
* **Do not spend on a live run to prove this.** The committed report already carries the evidence.
* **Do not delete the TRO-469 history at `:39-44`.** It records why case-23 left the list, and that reasoning is still correct. Only the coverage claim that follows it is false.
* **Do not write a test that asserts on the source text of `args.ts`.** A grep for "31" inside a comment would pass gate G6 and guard nothing. If Troy rejects step 9's coupling to the committed report, the honest fallback is a comment-only change plus a recorded human override on G6 — never a test written to satisfy a counter.
