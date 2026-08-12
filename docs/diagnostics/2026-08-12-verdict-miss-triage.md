# LabelHunter eval triage — 11 label-verdict misses, classified

**Run under diagnosis:** `scripts/eval/results/eval-report.json`, measured `2026-08-12T13:26:45.488Z`, mode `live`, model `claude-haiku-4-5`, ticket `TRO-470 / LH-030`, manifest version `1.0.0`.
**Measured headline:** extraction 154/160 = 96.25%; label verdict 21/32 = 65.625%; reviewReason 5/14 = 35.7%.
**Nothing was changed.** No source file, prompt, manifest, expectation, or config was edited. No commit, no Linear write. Every fix below is a recommendation.

---

## 1. Verdict

**Six of the eleven misses are the pipeline's fault. Five are the corpus's.** But the number that should move first is different: **two graded rubric vectors have no passing case at all today.** V4 (small/buried warning print) is carried only by case-23 and case-24, and both miss. V8 (genuinely different brand → MISMATCH) is carried only by case-29, and it misses (`audit/rubric.md:106`, `:110`; vector coverage enumerated across all 32 manifest entries). A third graded line fails outright: TH-R9's own acceptance evidence says "reworded warning → fail" (`audit/requirements/inventory.md:87`), and case-11 returns REVIEW. Its sibling case-10 carries the same V3 vector and returns FAIL correctly, so the warning subsystem is not the problem — an unrelated router blocker is. Only one miss (case-26) is a pure corpus edit. Three are pure code defects. Seven need both a code change and a corpus decision, and four of those seven cannot be settled at all until the eval harness records what it currently throws away.

---

## 2. The table

| caseId | Expected | Actual | Primary cause | Confidence | Fix kind |
|---|---|---|---|---|---|
| case-11-reworded-warning-clause-two | FAIL (warning MISMATCH) | REVIEW / CONFLICTING_EXTRACTION | **ROUTING** | medium | IMPLEMENTATION |
| case-15-case-variant-brand-punctuation | PASS (brand MATCH) | REVIEW / AMBIGUOUS_BRAND | **COMPARISON** | high | IMPLEMENTATION |
| case-17-glare-front-label | REVIEW / LOW_IMAGE_QUALITY | PASS / null | **EXTRACTION** | medium | BOTH |
| case-19-rotation-mild-correctable | PASS | REVIEW / WARNING_MISMATCH | **EXTRACTION** | high | IMPLEMENTATION |
| case-21-low-light-front-label | REVIEW / LOW_IMAGE_QUALITY | PASS / null | **GROUND-TRUTH** | medium | BOTH |
| case-23-tiny-warning-text-standard-bottle | REVIEW / LOW_IMAGE_QUALITY | PASS / null | **COMPARISON** | medium | BOTH |
| case-24-tiny-warning-text-miniature-bottle | REVIEW / LOW_IMAGE_QUALITY | PASS / null | **COMPARISON** | medium | BOTH |
| case-25-odd-typography-script-brand | REVIEW / LOW_MODEL_CONFIDENCE | PASS / null | **GROUND-TRUTH** | high | BOTH |
| case-26-odd-typography-blackletter-class-type | REVIEW / LOW_MODEL_CONFIDENCE | PASS / null | **GROUND-TRUTH** | high | CORPUS |
| case-28-conflicting-class-type | FAIL (classType MISMATCH) | REVIEW / AMBIGUOUS_BRAND | **GROUND-TRUTH** | medium | BOTH |
| case-29-conflicting-brand-name | FAIL (brandName MISMATCH) | REVIEW / AMBIGUOUS_BRAND | **GROUND-TRUTH** | medium | BOTH |

**Companion columns** — secondary cause, policy flag, graded exposure:

| caseId | Secondary cause | Policy disagreement | Extraction correct | Graded requirement / rubric vector |
|---|---|---|---|---|
| case-11 | NONE | no | yes | **TH-R9** (`inventory.md:87`), vector **V3** (`rubric.md:105`) — V3's other carrier case-10 is green |
| case-15 | NONE | yes | yes | **TH-R8** (`inventory.md:79`), vector **V5** (`rubric.md:107`) — V5's other carrier case-14 is green |
| case-17 | GROUND-TRUTH | yes | yes | **TH-R10** stretch (`inventory.md:95`) — no vector |
| case-19 | NONE | no | **no** | **TH-R10** stretch (`inventory.md:95`) — no vector |
| case-21 | EXTRACTION | yes | yes | **TH-R10** stretch — no vector |
| case-23 | GROUND-TRUTH | yes | yes | **TH-R9** + vector **V4** (`rubric.md:106`) — **V4 has no green carrier** |
| case-24 | GROUND-TRUTH | yes | yes | **TH-R9** + vector **V4** — **V4 has no green carrier** |
| case-25 | NONE | no | yes | none |
| case-26 | NONE | no | yes | none |
| case-28 | RESOLVER | yes | yes | none (`vectors: []`) |
| case-29 | RESOLVER | yes | yes | vector **V8** (`rubric.md:110`) — **case-29 is V8's only carrier** |

---

## 3. Sections by primary cause

### 3A. EXTRACTION — 2 cases

Haiku read the label wrongly, or reported a confidence that misrepresents what it read.

#### case-19-rotation-mild-correctable — confidence: high

```
spec        golden-set/manifest.json:1049-1106 — clean spirits label, one degradation
            (rotate 15 deg, :1101-1103). Expects PASS (:1076) and government_warning
            MATCH (:1094-1097). verified:false (:1106). The image was opened: the label
            prints "...because of the risk of birth defects..." and the word "use" is
            not on it.
   |
extraction  eval-report.json cases[18].extraction — 4/5 fields correct. government_warning
            correct:false. Haiku returned "...during pregnancy because use of the risk...".
            The extra word is a model invention.   <<< DIVERGES HERE
   |
comparison  Region detection returns null on this skewed image; row projection needs three
            separate line runs (src/server/warning/region-detect.ts:61, :156-159) and a
            15-degree skew smears four lines into one. The ladder falls through
            (:242-253), so the OCR channel reports unavailable (src/server/warning/index.ts:129)
            and reconcileSingleChannel runs. Measured: distance 4, wording MISMATCH, caps OK.
            Distance 4 exceeds NEAR_MISS_MAX_DISTANCE 2 (wording-compare.ts:30, :54-58),
            so the branch returns REVIEW / WARNING_MISMATCH
            (src/server/warning/reconcile.ts:128-129).
   |
routing     resolveGovernmentWarningField passes the comparator verdict through unchanged
            (src/server/router/field-resolution.ts:294-300). rollupLabelVerdict returns
            REVIEW on one NEEDS_REVIEW row (src/server/router/rollup.ts:16). Correct.
   |
resolver    Ran, returned needs-human, $0.0118. Did not affect the score: the harness reads
            body.labelVerdict at scripts/eval/cascade-runner.ts:299-304, before the resolver
            gate at :311.
```

**Exact divergence:** the Haiku transcription. Measured counterfactual: feed the label's true text through `evaluateCandidate` and distance is 0, so `reconcileSingleChannel` returns MATCH at confidence ≥ 0.90 (`src/server/warning/reconcile.ts:119-122`), which rolls up to PASS.

**The OCR channel is provably not a compounding cause.** Had detection succeeded and Tesseract read the statute perfectly, `reconcileDualChannel` would see the two folded readings differ and take the disagree branch — the same REVIEW / WARNING_MISMATCH (`src/server/warning/reconcile.ts:135-137`). Restoring OCR alone changes nothing here.

**Design gap behind it:** preprocessing corrects orientation from the EXIF tag only (`src/server/preprocessing/pipeline.ts:96-100`, scoped that way at `docs/PRD.md:58`). A pixel-baked 15-degree rotation carries no EXIF tag, so that step is a no-op on this image.

---

#### case-17-glare-front-label — confidence: medium

```
spec        golden-set/manifest.json cases[16] — expects REVIEW / LOW_IMAGE_QUALITY and
            brandName NEEDS_REVIEW. One degradation: glare, region brand, 25 deg, opacity
            0.85. vectors: []. verified:false (golden-set/README.md:81-85, :117 — verified
            records a human sign-off, and every case is still false).
            The transform paints a white band at alpha 0.85 with blend "screen" over the
            880x140 brand box (scripts/golden/degrade.ts:160-206; box at
            scripts/golden/render.ts:80). Measured on the committed JPEG at the band core
            (x=465..530, brand rows y=106..164): darkest pixel 32/255, only 135 of 3835
            pixels below 100. The letters "sti" survive as pale gray, not black. The image
            really does wash part of the brand name.
   |
extraction  eval-report.json cases[16].extraction — all five fields correct in THIS run.
            But the committed benchmark run (2026-08-12T05:23:34Z, same haikuModel, same
            manifestVersion, no commit to src/server between the two) scored this exact
            file REVIEW / AMBIGUOUS_BRAND with brand_name NEEDS_REVIEW. AMBIGUOUS_BRAND on
            brand_name requires comparatorVerdict !== MATCH, because structuralHit is
            hard-coded false for that field (src/server/router/index.ts:113-118,
            src/server/router/field-resolution.ts:252-253). So in that run Haiku's brand
            read differed from the label. The glare does break the read.   <<< DIVERGES HERE
            (the self-reported confidence link — unobserved, bounded at >= 0.60)
   |
comparison  brand_name compared identical strings; similarity 1.0 clears the 0.95 threshold
            (src/server/comparators/brand.ts:23, :51-56). MATCH. Correct.
   |
routing     isLowImageQuality returned false on all four clauses
            (src/server/router/label-blockers.ts:20-51). A MATCH escalates only below 0.60
            (src/server/router/confidence.ts:32, :107-116). PASS, headline null
            (rollup.ts:14-18, precedence.ts:36-41). Correct given its inputs.
   |
resolver    Never ran (cascade-runner.ts:311 gates on REVIEW).
```

**Exact divergence:** the extractor's self-reported confidence on `brand_name`. The chain does **not** diverge at the expectation — the pixels support the manifest note, and the same server code met the expectation in another run. This is model-call variance, recorded in the repo's own words at `CHANGES.md:697-701`.

**Systemic finding this case exposes.** Across all 32 cases in this run, `LOW_IMAGE_QUALITY` fired exactly once (case-20), and only through its fourth trigger — half the required fields null (`label-blockers.ts:43-47`). `LOW_MODEL_CONFIDENCE` fired on zero fields. Seven cases expect `LOW_IMAGE_QUALITY`. Both confidence-driven branches were inert. CP-1 anticipated this: "If it turns out to be flat — the model says 0.9 for everything — then confidence-based routing contributes nothing" (`docs/checkpoints/cp1-cascade-router-prompts.md:1174-1181`).

---

### 3B. COMPARISON — 3 cases

A comparator returned the wrong field verdict given correct extraction.

#### case-15-case-variant-brand-punctuation — confidence: high

```
spec        golden-set/manifest.json:811-867 — application "Stone's Throw" (:817), label
            "STONES THROW" (:824). Expects PASS (:838), brandName MATCH (:841), reason
            "Brand matches once case and the dropped apostrophe are normalized" (:842).
            verified:false (:866). Carries rubric vector V5 (audit/rubric.md:107).
   |
extraction  eval-report.json:1625-1631 — brandName "STONES THROW", byte-identical to spec,
            correct:true. All five fields correct (:1621-1661).
   |
comparison  compareBrandOrClass normalizes both sides. Step 6 of the pipeline drops
            punctuation but KEEPS the apostrophe:
              const kept = text.replace(/\p{P}/gu, (mark) => (mark === "'" || mark === "-" ? mark : ""));
            src/server/comparators/normalize.ts:87   <<< DIVERGES HERE
            So the label folds to "stones throw" and the application to "stone's throw" —
            one character apart. similarity() returns 1 - 1/13 = 0.923077
            (src/server/comparators/similarity.ts:44-48). 0.923077 < 0.95, so
            src/server/comparators/brand.ts:53 falls through to NEEDS_REVIEW (:63-66).
   |
routing     Comparator verdict is not MATCH, so FIELD_SPECIFIC_REASON.brand_name =
            AMBIGUOUS_BRAND (src/server/router/field-resolution.ts:66, :246-254).
            rollupLabelVerdict returns REVIEW (rollup.ts:16). Matches CP-1 §5.4's own table
            (cp1:663-669). Correct.
   |
resolver    Ran, "resolved", $0.01016. Out of scope for the expectation
            (golden-set/README.md:121). The cascade paid a penny to do what a correct
            normalizer does for free.
```

**Exact divergence:** `src/server/comparators/normalize.ts:87` — the character class that keeps the apostrophe. The threshold at `brand.ts:53` only fails because normalization already left the strings one character apart. Repair step 6 and the score is 1.000000, so the threshold never gets a decision to make.

**Corpus-wide measurement** (production normalizer + similarity re-run over all 32 cases, brand_name and class_type): case-15 is the **only** case that expects MATCH and scores below 0.95. The highest similarity-driven non-MATCH expectation is case-16 at 0.423077. Adding `'` to the dropped set moves exactly two scores: case-15 brand 0.923077 → 1.000000, case-16 brand 0.423077 → 0.461538 (still far below any plausible threshold). Nothing else in the corpus moves. It also closes the separate U+2019 gap the repo already pins in its own test as "a real gap" (`src/server/comparators/normalize.test.ts:71-87`).

---

#### case-23 and case-24 (tiny warning text) — confidence: medium each

```
spec        golden-set/manifest.json, case-23 and case-24 expected blocks — both expect
            REVIEW / LOW_IMAGE_QUALITY with governmentWarning NEEDS_REVIEW, stated
            mechanism "extraction confidence is low". verified:false. Both notes cite
            CP-2 §9.2 finding 1 and record TRO-469's swap of the reason from
            LOW_MODEL_CONFIDENCE to LOW_IMAGE_QUALITY — a documented human decision.
            The renderer gives BOTH cases the same TINY_WARNING_FONT_SIZE_PX = 9 on the
            same 1000x800 canvas (scripts/golden/render.ts:227, :248-250, :251-253). The
            pair samples one print size twice. CP-2 §8.3's DPI arithmetic — the stated
            reason these two cases exist — assumes a 3000px-wide photograph
            (docs/checkpoints/cp2-warning-subsystem.md:899-911).
   |
extraction  eval-report.json cases[22] and cases[23] — all five fields correct:true in both.
            Haiku returned the statutory text character for character.
   |
comparison  Replayed on the buffer the route actually OCRs — preprocessed.original, a
            mozjpeg re-encode (src/server/preprocessing/pipeline.ts:94-107,
            src/app/api/verify/route.ts:227), not the committed file.
            case-23: region {x:52,y:520,w:886,h:30}, method classical, confidence 58.00,
                     wording MISMATCH, distance 47.
            case-24: same region, confidence 56.00, wording MISMATCH, distance 42.
            Both fall under OCR_CONFIDENCE_FLOOR = 60, so ocrUsable is false and the
            reconciler discards the OCR candidate entirely:
              const ocrUsable = ocr.available && ocr.confidence >= OCR_CONFIDENCE_FLOOR;
            src/server/warning/reconcile.ts:186   <<< DIVERGES HERE
            The single-channel table then returns MATCH, because the VLM text equals
            canonical and its confidence is >= 0.90 (reconcile.ts:118-123).
   |
routing     resolveGovernmentWarningField passes MATCH through
            (src/server/router/field-resolution.ts:294-297). No blocker, five MATCH rows,
            so PASS with a null headline (rollup.ts:14-19, precedence.ts:36-41). Correct.
   |
resolver    Never ran. The harness scores the router's own verdict at
            cascade-runner.ts:299-304 anyway, so no resolver call could have changed either
            score.
```

**Exact divergence:** `src/server/warning/reconcile.ts:186`. An unmeasured floor of 60 discards two readings at 58 and 56.

**Derived from measured inputs:** any floor at or below 56 sends **both** cases to `reconcileDualChannel`. The folded VLM text and the folded OCR text differ, so `agree` is false, and the function returns NEEDS_REVIEW / WARNING_MISMATCH (`reconcile.ts:134-138`). The label verdict then becomes REVIEW — the expected verdict on both cases.

**The floor is the work this very ticket owed.** The code marks it "proposed" and names the sweep that should replace it: "LH-030's golden-set sweep is what would replace it with a measured one" (`src/server/warning/reconcile.ts:62-67`; assigned at `docs/checkpoints/cp2-warning-subsystem.md:1523-1524`). This eval report's own `ticket` field reads `TRO-470 / LH-030`. The sweep never ran, and these two cases are the exact evidence it would have used. CP-2 open question 7 predicted the cost: a floor set too high "pushes everything down the single-channel path" (`cp2:1484-1490`).

**Control measurement:** the OCR channel is healthy on this corpus at normal print size. Replayed on case-25 and case-26, Tesseract returns region `{x:52,y:524,w:894,h:140}`, confidence 95.00, wording EXACT_MATCH, distance 0. Both ran dual-channel. So the tiny-print failure is a print-size result, not a broken detector.

---

### 3C. ROUTING — 1 case

The router produced the wrong label verdict given correct field verdicts.

#### case-11-reworded-warning-clause-two — confidence: medium

```
spec        golden-set/manifest.json:581-588, :603, :606-607, :625-628, :631-633 —
            beverageType "wine", classType "Mead", a Stagecoach Meadery label. Clause (2)
            is reworded. Expects FAIL with governmentWarning MISMATCH. Carries vector V3.
            audit/rubric.md:105 — "V3 | Reworded/paraphrased warning body | FAIL".
            TH-R9's acceptance evidence: "reworded warning -> fail"
            (audit/requirements/inventory.md:87).
   |
extraction  eval-report.json cases[10].extraction — all five scored fields correct. Haiku
            transcribed the reworded clause character for character. Note the blind spot:
            the harness scores five fields only (scripts/eval/extraction-scoring.ts:254-266),
            so beverage_type is never scored and the 96.25% carries no information about it.
   |
comparison  government_warning returned MISMATCH — exactly the golden expectation. MISMATCH
            is reachable from one branch only: reconcileSingleChannel never returns it
            (src/server/warning/reconcile.ts:115-130). So the dual-channel path ran, the
            two channels AGREED on folded words and caps, and the OCR channel cleared the
            floor (reconcile.ts:134-145). CHANGES.md:2496 records the measured edit distance
            as 24. TH-R9 worked.
   |
routing     The router passed the MISMATCH through unchanged (field-resolution.ts:294-297).
            Then a label-level blocker fired:
              const beverageTypeDisagreesWithApplication =
                extraction.beverage_type.value !== null &&
                normalizeForBoundaryMatch(extraction.beverage_type.value) !== normalizeForBoundaryMatch(application.beverageType) &&
                extraction.beverage_type.confidence >= TRUSTED_THRESHOLD_DEFAULT;
            src/server/router/index.ts:166-169   <<< DIVERGES HERE
            That feeds isConflictingExtraction (:171-186) and sets labelLevelBlocker (:188).
            rollup.ts:15 returns REVIEW before line 17 ever reads the MISMATCH.
   |
resolver    Ran, needs-human. Could not have changed the score (cascade-runner.ts:299-304
            precedes :311).
```

**Exact divergence:** `src/server/router/index.ts:166-169`, the beverage_type cross-check. `rollup.ts:15` is only where the defect becomes the label verdict; `rollup.ts` obeys CP-1 §5.4 exactly and is not itself wrong.

**Why the cross-check is wrong here.** CP-1 states the premise: "A confident spirits reading against a declared wine application means one of the two records is wrong" (`docs/checkpoints/cp1-cascade-router-prompts.md:504-509`). Neither record is wrong. TTB classes mead as a wine, the application says wine, and the label says Mead. The check normalizes casing and whitespace only (`index.ts:158-169`) and has no vocabulary guard. The router's own tests cover an in-vocabulary swap and a casing slip (`src/server/router/index.test.ts:136-157`); an off-menu answer is untested.

**Correlation isolates it.** case-11 and case-22 are the only two cases in the 32 whose `classType` is "Mead", both declare `beverageType` "wine", and they are the only two cases that produced CONFLICTING_EXTRACTION. Two separate live runs reproduce it (the 13:26 eval run and the 05:23 benchmark run). An invalid `image_quality` confidence does not select the same two Mead cases four times.

**Corpus evidence that raises the odds further.** No golden label prints its category word at all — the renderer emits only brand, class type, ABV, net contents and the warning block (`scripts/golden/render.ts:286-292`, `:373-383`). All 32 cases sit in the identical position for beverage_type evidence, yet only two blocked. Had Haiku answered the category from empty evidence, all 32 would have blocked.

**Vocabulary asymmetry, the root of it.** The application form rejects `mead` by name with "Choose a beverage type: beer, wine, or spirits" (`src/app/api/verify/parse-request.test.ts:67-76`). The extractor schema leaves `beverage_type` a free-form `$ref` field with no enum (`src/server/extractor/schema.ts:56`, `:88-100`) and states the vocabulary in prose only (`src/server/extractor/prompt.ts:65-66`). The router then compares a closed enum against an open string by equality.

**The decisive corroboration.** case-10 carries the same V3 vector, the same reworded-warning defect class, and returns FAIL correctly (eval-report.json, case-10). The difference between the two is the Mead class, not the warning.

---

### 3D. GROUND-TRUTH — 5 cases

The golden case's `expected` block is wrong, and the pipeline is right.

#### case-25 and case-26 (odd typography) — confidence: high each

```
spec        manifest.json case-25/case-26 expected blocks — both expect REVIEW /
            LOW_MODEL_CONFIDENCE, brandName (25) and classType (26) NEEDS_REVIEW, reason
            "extraction confidence is low". verified:false. NEITHER entry carries a notes
            field, and neither cites a design document.
            The only change from a clean case is the font: SCRIPT_FONT_STACK / Dancing
            Script 700 (scripts/golden/render.ts:224, :254-256) and BLACKLETTER_FONT_STACK /
            UnifrakturMaguntia 400 (:225, :229, :257-260).
   |
extraction  eval-report.json cases[24].extraction.fields[0] and cases[25].extraction.fields[1]
            — "Willowbrook Winery" and "Straight Rye Whiskey", byte-identical to expected,
            correct:true. All five fields correct in both.
   |
comparison  Identical strings, similarity 1.0, above the 0.95 threshold, MATCH
            (src/server/comparators/brand.ts:12-14, :23, :51-56).
   |
routing     brand_name and class_type carry no router-side structural check, so
            structuralHit is always false (src/server/router/index.ts:113-119). A MATCH
            escalates only below MATCH_ESCALATION_CEILING = UNUSABLE_CEILING = 0.60
            (src/server/router/confidence.ts:32, :107-116). The report records MATCH with
            actualReviewReason null, so confidence reached 0.60 or higher.
            PASS (rollup.ts:14-19).   <<< DIVERGES AT THE SPEC, not here
   |
resolver    Never ran.
```

**Exact divergence:** the spec link. The expectation needs confidence below 0.60. The recorded MATCH with a null reason proves it reached 0.60 or higher. Nothing earlier in the chain discarded evidence, so there is no defect to push the cause back to. Both images were opened: sharp black text on white, unusual and fully legible.

**Corroboration:** `benchmark-report.json` records brand_name and class_type MATCH in **both** arms for these two cases, and its expected reason matches the current manifest (unlike cases 23 and 24, where the benchmark scored a stale `LOW_MODEL_CONFIDENCE`). A brand name and a class designation are not memorised statutory text, so the two models are genuinely independent readers here.

**What the pair actually measured:** two models, two different unusual fonts, zero confidence drop. That is a real result about the extractor. It scores as a miss only because the manifest recorded a prediction as ground truth.

---

#### case-21-low-light-front-label — confidence: medium

```
spec        manifest.json cases[20] — expects REVIEW / LOW_IMAGE_QUALITY with brandName AND
            classType NEEDS_REVIEW. One degradation: low-light, region front,
            brightnessFactor 0.32. vectors: []. verified:false. Note claims "front label
            underexposed".
            The transform crops the 880x240 front box, applies sharp modulate({brightness:
            0.32}), and composites it back (scripts/golden/degrade.ts:213-240; box at
            scripts/golden/render.ts:81). modulate scales lightness only — no blur, no
            noise, no soft edge.   <<< DIVERGES HERE
            Measured read-only on the committed JPEG: front-region ground drops to a median
            of 75/255 while text stays at 6/255 — a WCAG ratio of 2.32:1. Column x=500 shows
            a ONE-PIXEL seam: 255 -> 76 at y=60 and 75 -> 255 at y=300. Inside the box the
            maximum horizontal gradient is 73 against 248 on clean case-03, so glyph edges
            stay perfectly abrupt and only their amplitude scales. The artifact is a
            hard-edged gray rectangle with crisp black type, not underexposure.
   |
extraction  eval-report.json cases[20].extraction — all five correct. "Northgate Cellars",
            "Merlot", "13.8%", "750 ml", warning verbatim.
   |
comparison  Identical strings both fields, similarity 1.0, MATCH (brand.ts:23, :51-56).
   |
routing     isLowImageQuality false on all four clauses (label-blockers.ts:20-51). No field
            escalated (confidence.ts:107-116). PASS. Preprocessing cannot have masked the
            dimming: the pipeline rotates, flattens, resizes and re-encodes, and never
            normalizes brightness or contrast (preprocessing/pipeline.ts:96-138).
   |
resolver    Never ran.
```

**Exact divergence:** the committed image. It does not realize the photo condition its own manifest note describes.

**Consistent, not flaky** — unlike case-17. The 05:23Z benchmark run also returned PASS with `cascadeEscalated: false`. An earlier pre-merge run listed case-21 among the wrong verdicts too (`CHANGES.md:697-699`). Three runs agree with each other and disagree with the expectation.

---

#### case-28-conflicting-class-type and case-29-conflicting-brand-name — confidence: medium each

```
spec        case-28: manifest.json:1586-1632 — application "Bourbon Whiskey", label
            "Straight Rye Whiskey". Expects FAIL with classType MISMATCH. vectors: [] (:1632).
            case-29: manifest.json:1642-1691 — application "Old Tom Distillery", label
            "Copper Kettle Spirits". Expects FAIL with brandName MISMATCH. vectors: ["V8"]
            (:1689-1691) — and case-29 is V8's ONLY carrier in the manifest.
            The golden set declares its own scope: GoldenExpectedResult is "The full
            expected Validation Router output for one case"
            (src/lib/golden-set/types.ts:108-120), and golden-set/README.md:109 names that
            type "the schema of record".   <<< DIVERGES HERE
   |
extraction  eval-report.json cases[27] and cases[28] — all five fields correct:true in both.
   |
comparison  compareBrandOrClass normalizes and scores. case-28 class_type: 0.4000.
            case-29 brand_name: 0.1429. Both below 0.95, so NEEDS_REVIEW
            (src/server/comparators/brand.ts:51-66). brand.ts has three NEEDS_REVIEW
            returns and no MISMATCH return — by design: "PRD §3.3 / CP-1 §5.3: distance
            beyond the threshold goes to REVIEW, never a silent FAIL — even a wholly
            different brand" (brand.ts:60-62). Confirmed at docs/PRD.md:87.
   |
routing     NEEDS_REVIEW always escalates (confidence.ts:113-114). FIELD_SPECIFIC_REASON
            maps both fields to AMBIGUOUS_BRAND (field-resolution.ts:64-70, :246-254).
            rollupLabelVerdict tests NEEDS_REVIEW before MISMATCH and returns REVIEW
            (rollup.ts:14-18) — CP-1 §5.4's written ladder, line for line (cp1:663-674).
            Routing is correct in every respect.
   |
resolver    BOTH ran and returned "resolved" (case-28 $0.008932 / 4717 ms; case-29
            $0.00869 / 7105 ms). "resolved" means only that no field returned NEEDS_HUMAN
            (src/server/resolver/response.ts:185-189), so the field came back
            RESOLVED_MATCH or RESOLVED_MISMATCH — and the report stores NEITHER.
            src/server/resolver/field-result.ts:51-56 maps RESOLVED_MISMATCH to a field row
            with verdict MISMATCH and resolvedBy "sonnet" — exactly what the expectation
            asks for, one stage later than the golden set looks.
```

**Exact divergence:** the golden set's **scope declaration**, not its verdict values. `src/lib/golden-set/types.ts:108-120` scopes the `expected` block to the router. CP-1 §6.5 hands the final call on brand and class to the resolver, because it is "an equivalence judgment code cannot make" (`cp1:929-933`), and CP-1 §9 open question 1 keeps the REVIEW rule precisely because escalating "produces a judged mismatch rather than a string-distance verdict" (`cp1:1346-1352`). A MISMATCH on these fields is unreachable at the stage the golden set scores, and fully reachable one stage later.

**Measurement artifact, not just a scope debate.** `scripts/eval/resolver-rollup.ts:177-221` already re-rolls a resolution into a label verdict, and `scripts/eval/benchmark.ts:182` calls it for the **Sonnet-only** arm. The cascade arm is deliberately not scored that way (`scripts/eval/types.ts:144-149`: the resolver's outcome is "never scored against a golden answer"). So the two benchmark arms are measured at different stages of the same pipeline.

**Do not fit a second threshold band.** Measured: case-16 scores 0.4615 and expects REVIEW, case-28 scores 0.4000 and expects FAIL, and rubric V8's own example (`OLD TOM` vs `OLD TOM'S RESERVE`) scores 0.4118. A MISMATCH threshold would have to sit inside a 0.012-wide window fitted to three points, and it would still contradict `docs/PRD.md:87`. String distance cannot separate "same brand, extra words" from "different product".

---

## 4. Corpus corrections — the exact field, and to what

**Do not apply. These are recommendations.** Ordered by how safe each is.

| # | Case | Field to change | From | To | Safe to apply now? |
|---|---|---|---|---|---|
| C1 | case-26 | `expected.labelVerdict` | `REVIEW` | `PASS` | **Yes** |
| C1 | case-26 | `expected.reviewReason` | `LOW_MODEL_CONFIDENCE` | `null` | **Yes** |
| C1 | case-26 | `expected.fields.classType.verdict` | `NEEDS_REVIEW` | `MATCH` | **Yes** |
| C1 | case-26 | `expected.fields.classType.reason` | "decorative blackletter font; extraction confidence is low" | a statement of the measured result: a clean blackletter render does not lower extraction confidence, on Haiku or Sonnet | **Yes** |
| C2 | case-25 | same four fields, `brandName` in place of `classType` | as above | as above | **Yes** — make the pair in one change |
| C3 | case-21 | either the **image** or the **note** | `modulate({brightness: 0.32})` on a white ground | a transform that compresses dynamic range toward mid-gray, adds sensor noise, and adds a small blur, so glyph edges actually degrade | **Only after Troy rules on golden-set fidelity** |
| C4 | case-23 / case-24 | `expected.reviewReason` | `LOW_IMAGE_QUALITY` | `WARNING_MISMATCH` | **No — after the OCR floor sweep.** Under a corrected floor the honest reason is that the second channel could not confirm the statute |
| C5 | case-24 | the rendered print size, or the case itself | same 9px as case-23 | genuinely smaller print, **or** merge into case-23 and spend the slot | **No — owner decision** |
| C6 | case-28 | `expected.labelVerdict` / `reviewReason` / `classType.verdict` | `FAIL` / absent / `MISMATCH` | `REVIEW` / `AMBIGUOUS_BRAND` / `NEEDS_REVIEW` | **No — only if the golden set stays router-scoped** |
| C7 | case-29 | same three fields, `brandName` | `FAIL` / absent / `MISMATCH` | `REVIEW` / `AMBIGUOUS_BRAND` / `NEEDS_REVIEW` | **No — and it costs rubric V8's only carrier** |
| C8 | case-17 | **not** relaxed to PASS | — | if the case must become deterministic: raise opacity toward 1.0 and widen `bandHeight` past `h*0.4` so the band covers the whole brand line | **No — the pixels support the note** |

**Order matters on C6 and C7.** A corpus edit there would delete a legitimate expectation to match a measurement artifact, before anyone measured what the cascade actually decided. Record the resolver's per-field disposition first, re-run, and read it. If Sonnet returned RESOLVED_MISMATCH, both expectations are right as written and no corpus edit arises at all.

**C7 has a hidden cost the owner must accept explicitly.** Rewriting case-29 to REVIEW drops the manifest's only V8 case. `scripts/golden/verify.ts:20-21`, `:76-90` gates on vector coverage with `KNOWN_VECTOR_GAPS` empty today. The same change must therefore also amend `audit/rubric.md:110` or add V8 to `KNOWN_VECTOR_GAPS`, on the record, as an uncovered graded vector.

**Two cases every corpus edit shares:** `verified: false` on all 32 entries (`golden-set/README.md:81-85`, `:117` — `verified` records a human sign-off). No corpus edit should ship without a human setting it.

**Precedent for strengthening pixels rather than relaxing a note:** case-20's added 18-sigma blur, `CHANGES.md:4289-4292`.

---

## 5. Implementation changes — ranked by severity

Graded requirements outrank everything. Three of the top four are graded.

### S1 — case-11: the beverage_type cross-check fires on a valid subtype. **GRADED: TH-R9.**

`src/server/router/index.ts:166-169`. Fire the cross-check only when the extractor names a **different member of the declared vocabulary** — beer, wine, or spirits. Treat an off-menu answer such as "mead" as "no opinion", not as a conflict.

This is S1 because it is the only miss that breaks a graded acceptance-evidence line outright. TH-R9's evidence reads "reworded warning → fail" (`audit/requirements/inventory.md:87`); rubric V3 reads FAIL (`audit/rubric.md:105`). The warning subsystem produced the correct MISMATCH from two agreeing channels. A router blocker on an unrelated field suppressed it one line before the rollup would have said FAIL (`src/server/router/rollup.ts:15`). Two supporting changes:

- Close the vocabulary asymmetry at its source: `src/server/extractor/schema.ts:56` has no enum while `src/app/api/verify/parse-request.test.ts:67-76` shows the application side rejecting "mead" by name. This is a CP-1 §3.4 change and needs the owner's sign-off. It is an alternative to the router fix, not a substitute — a schema enum forces the model to guess a category it may not be able to judge.
- Finish TRO-502's exemption: `src/server/router/overrides.ts:130-155` gates only rule 2 on `supportKind !== "exempt"`. Rule 1 at `:134` still demands non-empty evidence from `beverage_type`, a field the label can never print, by the same argument TRO-502 used to exempt rule 2.

### S2 — cases 23 and 24: sweep `OCR_CONFIDENCE_FLOOR`. **GRADED: TH-R9, rubric V4.**

`src/server/warning/reconcile.ts:67`, `:186`. The floor is marked "proposed" in its own comment and CP-2 §12 assigned the replacing sweep to LH-030 (`docs/checkpoints/cp2-warning-subsystem.md:1523-1524`). This eval report **is** LH-030. Measured, the two cases sit two and four points under it. Any floor at or below 56 flips both to REVIEW.

The compliance risk is the real severity driver, not the scoreboard: today a statutory field passes on one channel while the only reader without the statute memorised produces 47 and 42 edits of garbage. Rubric V4 has no green carrier as a result.

Two supporting changes:
- Split CP-2 §4.5's merged row (`cp2:488-499`). "OCR produced no candidate" and "OCR produced a candidate far from canonical, below the floor" are different states. The second carries real evidence that the print is unreadable. Treating them alike is what produced this PASS.
- Add channel provenance to `WarningComparatorResult` and a single-channel-pass rate to `WarningSegmentationSummary`. CP-2 §8.4 already requires that rate and `scripts/eval/types.ts:188-206` has no field for it.

### S3 — case-15: normalization keeps the apostrophe. **GRADED: TH-R8, rubric V5.**

`src/server/comparators/normalize.ts:87`. Add `'` to the characters step 6 drops.

**Recommended over lowering the threshold.** Simulated across all 32 cases against the real extracted values, this moves exactly two scores, closes case-15, leaves case-16 in REVIEW, and closes the U+2019 gap the repo's own test already labels "a real gap" (`normalize.test.ts:71-87`). Lowering `BRAND_CLASS_MATCH_THRESHOLD` (`brand.ts:23`) closes case-15 too, but it loosens brand **and** class matching globally on a corpus that contains no case in the 0.42–0.92 band to test the loosened region with. Targeted change with measured zero collateral beats broad change with untested blast radius.

Note the honest limit: TH-R8's named test is `STONE'S THROW` vs `Stone's Throw` (`inventory.md:79`, `docs/PRD.md:86`, rubric V5 at `audit/rubric.md:107`). case-14 already passes that exact pair. case-15 sits just beyond every document's own named test. The governing document still supports it: `docs/PRD.md:85` lists the router's normalizers as "case, punctuation, whitespace, unicode", with no apostrophe carve-out, and CLAUDE.md makes the PRD settled architecture.

### S4 — case-19: no deskew before the Haiku call. **GRADED: TH-R10 (stretch).**

`src/server/preprocessing/pipeline.ts:96-100` corrects orientation from the EXIF tag only, scoped that way at `docs/PRD.md:58`. A pixel-baked rotation carries no EXIF tag.

**State the honest limit:** for this case deskew helps **once**, not twice. Restoring classical region detection restores the OCR channel, but a perfect OCR read against this hallucinated VLM read still lands on the disagree branch and still returns REVIEW / WARNING_MISMATCH (`reconcile.ts:135-137`). Deskew helps only through the extraction half, by giving Haiku an axis-aligned warning block. That is a probabilistic mitigation for a nondeterministic model error, not a deterministic fix.

**Do not** weaken `NEAR_MISS_MAX_DISTANCE` (`wording-compare.ts:30`) to absorb the inserted word. Distance 4 is a real four-character invention, and widening the band would forgive genuine wording deviations that CP-2 §5.5 exists to catch.

Worth fixing on its own merits, separately: classical region detection returns null on every rotated image tested (case-19 and case-20), and returns a clean box on case-01, case-14, case-15, case-18 and case-23.

### S5 — the eval harness records almost nothing it needs to. Not graded, but it blocks four diagnoses.

This is the enabling fix. Four of the eleven diagnoses stay at medium confidence purely because the harness stores scores instead of evidence.

1. **Per-field confidence.** `eval-report.json` contains the string "confidence" zero times. `ExtractionFieldScore` (`scripts/eval/types.ts:45-52`) and `VerdictFieldScore` (`:64-80`) both omit it. CP-1 §4.5 steps 1 and 2 specify exactly this — record confidence and correctness for every field, then build a reliability diagram — and neither is built (`cp1:411-425`). Every confidence claim in this triage is a derived bound because of that.
2. **The whole `image_quality` object.** The database has no `image_quality` column at all (`src/lib/db/schema.ts:310-314`), and `field_results` rows die with the application row the harness deletes (`schema.ts:266-268`, `cascade-runner.ts:181-183`, `:388`).
3. **`beverage_type`.** `scripts/eval/extraction-scoring.ts:254-266` scores five fields. The field that caused case-11's miss is invisible in every extraction metric in the report.
4. **Resolver per-field dispositions and a post-resolution label verdict.** `scripts/eval/types.ts:149` stores only `resolverOutcome`. `scripts/eval/resolver-rollup.ts:177-221` already implements the roll-up and `benchmark.ts:182` uses it for the Sonnet-only arm. Required on its own under PRD §6 honest evidence: the current 65.6% is a router number reported as a cascade number.
5. **Manifest provenance.** `benchmark-report.json` records `expectedReviewReason: LOW_MODEL_CONFIDENCE` for case-23 and case-24 while the manifest says `LOW_IMAGE_QUALITY`. Both artifacts stamp `manifestVersion: "1.0.0"`, and six manifest commits carry that same string, including TRO-469's change to those very fields. Make `manifestVersion` move with content, or record a content hash.

### S6 — cases 17 and 21: `LOW_IMAGE_QUALITY` has no deterministic signal. **GRADED: TH-R10 (stretch).**

CP-1 §4.1 promises confidence "never decides anything alone" and that every rule pairs it with a deterministic signal (`cp1:315-318`). The `partial` branch at `src/server/router/label-blockers.ts:27-39` breaks that promise: it rests on `legible` and `confidence`, both self-reported. Measured across 32 live cases, the two confidence-driven branches fired **zero** times.

A per-region ink-versus-ground contrast measurement in preprocessing would restore the promise and would fire on case-17's image. A related, cheaper observation: the extraction schema already collects `image_quality.issues` with a `low_resolution` value (`src/server/extractor/schema.ts:37-46`), and the router reads only `legible` and `confidence` (`src/server/router/index.ts:156`, `:180`). Either consume that signal or delete it from the schema, so the design does not appear to check something it ignores.

### S7 — case-25: `scripts/eval/args.ts:37` makes a false coverage claim. Not graded.

The comment states that case-25 covers "REVIEW / LOW_MODEL_CONFIDENCE (brand_name)" in the default live sample, and `:39-47` records that it replaced case-23 in that role after TRO-469. Measured, case-25 produces PASS with a null reason, and **no case in the 32 produced LOW_MODEL_CONFIDENCE at all.** The claim is false today, before any corpus correction. Either point `DEFAULT_SAMPLE_CASE_IDS` at a case that genuinely produces it, or delete the claim.

### Not a fix — leave alone

- **The warning subsystem's comparator.** It produced the correct MISMATCH on case-11 from two agreeing channels, exactly as CP-2 §4.5 specifies.
- **A font-unusualness signal** to force cases 25 and 26 to REVIEW. Nothing in the PRD or CP-1 asks for one. Building a detector to satisfy an unverified expectation is backwards.
- **A second, lower MISMATCH band in `compareBrandOrClass`.** The required window is 0.012 wide and fitted to the test set, and it contradicts `docs/PRD.md:87`.

---

## 6. Policy disagreements — the owner decides, no fix applies

These are cases where the pipeline follows written design and the expectation encodes a different written policy. Each names two documents that both exist and were both approved.

### P1 — CP-1 §4.2's confidence band table against CP-1 §4.3's asymmetry rule
**Affects case-17, case-21. Both policies live in the same approved checkpoint, which never reconciles them.**

- **Policy A (implemented).** `docs/checkpoints/cp1-cascade-router-prompts.md:354` — "MATCH | `confidence < 0.60` | Agreement corroborates. Escalate only when the read is unusable." The code follows this: `src/server/router/confidence.ts:107-116`.
- **Policy B (also written).** `cp1:326` — "Uncertain | `0.60 <= confidence < 0.85` | Use the value, but never as a final answer. **Escalate the field.**" Under Policy B, case-17 and case-21 return REVIEW at any confidence under 0.85. CP-2 already applies Policy B's shape to the warning channel: a matching single-channel read below 0.90 still returns REVIEW (`docs/checkpoints/cp2-warning-subsystem.md:494`).

Every image-quality expectation in the golden set assumes something closer to §4.2. Note that the expectations are **not** policy-less: the CP-1-approved extractor prompt names glare and low light explicitly — "Report low confidence when the image blocks you. Glare, blur, an angle, low light, a crop, and an obstruction all lower confidence" (`src/server/extractor/prompt.ts:33-34`, approved at `cp1:152`), and `src/server/router/golden-image-quality.test.ts` quotes that rule as the basis for its fixtures.

### P2 — CP-2 §4.5's single-channel table against CP-2 §9.2 finding 1
**Affects case-23, case-24. Both live in the approved CP-2 document, which never reconciles them.**

- **Policy A (implemented).** `cp2:488-499` — "equals canonical, **and** VLM confidence ≥ 0.90 | **PASS**", plus §8.4's clean-pass rule at `cp2:933-952`. The code follows this: `src/server/warning/reconcile.ts:118-123`.
- **Policy B (also written).** `cp2:1014-1019` — finding 1 recommends this exact expectation and states "Tiny print is an image-resolution problem, and that is the honest name for it."

§4.5 wrote its single-channel row for a **crop-detection failure**, where no second opinion exists. Here the crop detector worked and the second opinion is 47 and 42 edits out. That is the decision: should a warning PASS on one channel when the second channel **ran** and disagreed badly?

### P3 — the golden set's scope: router verdict or cascade end state
**Affects case-28, case-29.**

- **Policy A.** `src/lib/golden-set/types.ts:108-120` — `GoldenExpectedResult` is "The full expected Validation Router output for one case", and `golden-set/README.md:109` calls that type "the schema of record". `scripts/eval/types.ts:144-149` states the resolver's outcome is "never scored against a golden answer".
- **Policy B.** `audit/rubric.md:110` — V8, "Brand genuinely different — **MISMATCH**", with no flagged-equivalent escape hatch (contrast V5 on line 107, which explicitly permits one). CP-1 §6.5 places that MISMATCH at the resolver, "an equivalence judgment code cannot make" (`cp1:929-933`), and CP-1 §9 open question 1 keeps the REVIEW rule precisely because it "produces a judged mismatch" (`cp1:1346-1352`).

**These two do not actually conflict at the system level.** Router REVIEW → resolver MISMATCH → label FAIL satisfies V8 and the PRD together, and `src/server/resolver/field-result.ts:51-56` is the code that produces it. The clash is only about **which stage the golden set scores.**

### P4 — CP-2 §6.1's third column (raised, not classified)
`cp2:700-705` heads a column "Router's label verdict" and writes a bare FAIL for a wording MISMATCH, while its PASS row writes "contributes PASS". I read the column as the warning's **contribution**, not a rollup rule, because CP-1 §5.4 owns the rollup (`cp1:663-674`) and §6.1's own preamble says "Every row below names the exact branch it returns". So I recorded **no** policy disagreement on case-11. If the owner intended §6.1 to bind the rollup, that is a genuine CP-1/CP-2 conflict and CP-1 §9 open question 3 should be reopened.

---

## 7. What I could not determine

Stated plainly. Each of these is why four diagnoses sit at medium rather than high.

1. **No per-field extractor confidence exists anywhere.** The report never stored it, the database has no column for it, and the harness deletes the rows it does write. Every confidence statement in this triage is a **derived bound** from an observed outcome, not a number. Affects case-17, case-21, case-23, case-24, case-25, case-26 — every image-quality and typography diagnosis.

2. **case-17's true cause is bounded, not resolved.** The image genuinely washes the brand name (measured: no pixel darker than 32/255 at the glare core), and the same server code escalated the same file correctly in the 05:23Z benchmark run. That makes it model-call variance at the extraction step. But I cannot read the confidence that decided it. If the owner wants certainty here, re-run case-17 alone, five times, with confidence recorded. It costs almost nothing.

3. **case-11's exact blocker input is unobserved.** Six of the eight `isConflictingExtraction` inputs are dead by observation. Two survive: an off-menu `beverage_type` value at high confidence (the likely one, and a router gap by CP-1's own stated premise), and an invalid `image_quality` confidence (`index.ts:180`). I put roughly one chance in ten on an empty-evidence variant, where EXTRACTION becomes at least co-primary, and about one in thirty on the invalid-confidence branch, where the primary moves to EXTRACTION outright. **The cheap experiment:** re-run case-11 and case-22 live with the raw extraction dumped, and read `beverage_type.value`, `.evidence` and `.confidence`. One Haiku call each settles it.

4. **case-28 and case-29's post-resolution verdict is genuinely unknown.** Both resolvers returned "resolved", which means only that no field returned NEEDS_HUMAN (`src/server/resolver/response.ts:185-189`). Whether Sonnet said RESOLVED_MATCH or RESOLVED_MISMATCH is not recorded anywhere. Until it is, nobody can say whether these two cases are corpus errors or measurement artifacts. **Do not edit the manifest before that measurement exists.**

5. **Whether Haiku *read* the 9px warning or *completed it from memory*.** CP-2 open question 7 path two names this as the residual false-PASS path. The corpus cannot answer it: no golden case pairs tiny print with a wording deviation, so no evidence in this repo separates the two. That is why case-23's EXTRACTION hypothesis is recorded as an open question, not a classification.

6. **Whether cases 23 and 24 can test their own hypothesis at all.** Both images are 1000x800. CP-2 §8.3's DPI arithmetic — the stated reason the pair exists — assumes a 3000px-wide photograph (`cp2:899-911`). At 1000px the "original" is already below the resolution §8.3 calls comfortable. The pair may be untestable as built, whatever the font size.

7. **Whether a golden expectation may depend on a model self-report at all.** case-17 scored correct in one live run and wrong in another with no code change. That is a corpus-design question, not a router question.

**Integrity note.** The working tree changed under this session, by another process, not by this diagnosis. Commit `8fa8999` ("chore(golden-set): commit reference photos, provenance record, and Wave 2b tickets") landed, and `audit/requirements/REPORT.md` and `gaps.md` are modified with two new untracked files beside them. None of that touches routing, prompts, comparators, the warning subsystem, golden expectations, or the eval outputs read here. `git diff HEAD` is empty across `golden-set/`, `src/server/`, `scripts/eval/`, `scripts/golden/`, `docs/` and `factory/`.

---

## 8. What the 65.6% actually means

**First, it is not a cascade number.** The harness builds `actualVerdict` from the `/api/verify` response body at `scripts/eval/cascade-runner.ts:299-304`, and only then calls the resolver at `:311`. So 21/32 measures the **Validation Router alone**. The Sonnet-only benchmark arm, by contrast, **is** scored post-resolution (`scripts/eval/resolver-rollup.ts:177-221`, called at `scripts/eval/benchmark.ts:182`). The two arms of the headline benchmark are measured at different stages of the same pipeline. Under PRD §6 honest evidence, that has to be said out loud before the number is quoted anywhere.

**Second, separating corpus error from pipeline error moves it — within a stated range.**

| Reading | What it assumes | Corrected score | Rate |
|---|---|---|---|
| **Measured today** | nothing corrected | 21/32 | **65.6%** |
| **Floor — worst reading for the pipeline** | only the two unarguable corpus errors, case-25 and case-26 (both high confidence, no policy dispute, no competing signal) | 23/32 | **71.9%** |
| **Ceiling — best defensible reading** | all five GROUND-TRUTH-primary cases corrected: 21, 25, 26, 28, 29 | 26/32 | **81.3%** |
| **Overclaim boundary — do not use** | also editing 17, 23, 24, where GROUND-TRUTH is only a *secondary* cause | 29/32 | 90.6% |

**Say it as a range: true label-verdict accuracy is between 71.9% and 81.3%, and 65.6% is the floor of the floor.** Do not go past 81.3%. Cases 17, 23 and 24 carry GROUND-TRUTH only as a secondary cause; editing their expectations would move the scoreboard while the pipeline defect stands. On case-23 and case-24 that defect is a statutory field passing on a single channel — the last thing to paper over with a manifest edit.

**Two honest caveats that push the other way.**

- The 81.3% ceiling can be reached **two different ways**, and only one is a corpus edit. If the harness scored the cascade's end state instead of the router's interim verdict, case-28 and case-29 would plausibly turn correct with **no manifest change at all** — and so might case-15, which also expects a verdict the router alone cannot reach and whose resolver also returned "resolved". Measure before editing.
- **A stricter number exists and is worse.** Label verdict alone ignores the ReviewReason. Measured `reviewReasonAccuracy` is 5/14 = 35.7%, and three further cases (case-07, case-18, case-22) score correct on label verdict while naming the wrong reason. Counting both, the run is **18/32 = 56.25%** strict. `scripts/eval/verdict-scoring.ts:115-122` makes `reviewReasonCorrect` vacuously true on any non-REVIEW expectation, which is why five of the eleven misses above report `reviewReasonCorrect: true` while carrying the wrong reason.

**Third, the extraction figure is narrower than it looks.** 96.25% covers five fields (`scripts/eval/extraction-scoring.ts:254-266`). `beverage_type` — the field that most likely caused case-11's miss — is never scored. All six extraction errors in the run fall on the two rotation cases, case-19 and case-20. Glare, low light, tiny print and odd typography produced **zero** extraction errors. That is a real, defensible result about the extractor, and it is better evidence than the scoreboard point.

**The one-line version for a live defence:** the router is right far more often than 65.6% suggests, the corpus encodes several predictions that the run falsified, and the two things the pipeline genuinely gets wrong — a suppressed FAIL on a reworded warning, and a statutory field passing on one channel — both sit on graded requirements and both have small, measured fixes waiting.