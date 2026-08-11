# CP-2 — Warning subsystem

**Ticket:** LH-CP2 / TRO-467 · **Blocks:** LH-020, LH-021
**Requirements served:** TH-R9, TH-R10, TH-R7, TH-R12, TH-R15, TH-R21, TH-R23
**PRD sections:** §2 bounded scope, §3.4 the warning subsystem, §3.7 the upgrade ladder,
§3.8 the latency budget, §12 risks

> **This checkpoint is NOT cleared.** This document is the material for the walkthrough.
> Troy must read it, run the Q&A, and give explicit acknowledgment. Until he does, no agent
> starts LH-020 or LH-021. An agent wrote this document; an agent cannot clear the gate.

## How to use this document

Read it in order. It takes about 45 minutes.

- **Sections 1–2** are the frame. Section 2 is the verification the PRD asked for. Read both
  even if you skip everything else.
- **Section 5 is the heart.** It defines what "exact" means. It is the section an interviewer
  will push on, and it is where a wrong choice makes the tool accuse a compliant label.
- **Section 9** is CP-2's second job: review the golden set's warning cases.
- **Section 10** is the "defend it" Q&A. Read the questions first. Try to answer each one
  before you read the answer.
- **Section 11** lists what only you can decide.

### Numbers and claims in this document

This project is graded on honest evidence (PRD §6). Every claim below carries one of five
labels.

| Label | Meaning |
|---|---|
| **verified** | Retrieved live from a named authoritative source on a stated date. The URL, the method, and the result are in Appendix B. Re-run the command and check it. |
| **derived** | Arithmetic over stated inputs. The inputs are named. Check the arithmetic. |
| **target** | A budget the design must hit. It comes from the PRD, not from a run. |
| **proposed** | A starting value chosen by reasoning. The golden set (LH-030) replaces it with a measured one. |
| **not measured** | We do not know yet. It stays "not measured" until a real run says otherwise. |

CP-1 used four labels. This document adds **verified**, because its central claim is a
statutory string retrieved from a government source. That claim is stronger than "derived"
and weaker than "measured on our own system", so it needed its own word.

---

## 1. The one-sentence version

The government warning is compared by code against a statutory string we retrieved from the
Code of Federal Regulations; two independent readers transcribe it; normalization removes only
what the camera and the OCR engine added; and no model is ever asked whether the warning
looks right.

---

## 2. The canonical text — verified, not assumed

PRD §3.4 wrote the canonical text and then wrote this instruction beside it: *"Verify verbatim
against ttb.gov during implementation — a ticket, not an assumption."* This section is that
task. It is done.

### 2.1 What we retrieved, and from where

**Retrieval date: 2026-08-11.** All five retrievals succeeded. Appendix B holds the exact
commands.

| # | Source | What it gave | Result |
|---|---|---|---|
| S1 | eCFR API, 27 CFR 16.21, title-27 issue date 2026-07-06 | The statutory statement | **verified** |
| S2 | eCFR API, 27 CFR 16.22 | The capitalization, bold, legibility, and type-size rules | **verified** |
| S3 | ttb.gov — distilled spirits health warning page | The same statement, plus TTB's plain-English format rules | **verified**, identical to S1 |
| S4 | ttb.gov — malt beverage health warning page | The same statement | **verified**, identical to S1 |
| S5 | ttb.gov — wine health warning page | The same statement | **verified**, identical to S1 |

eCFR is the source of record. The three ttb.gov pages are corroboration, and they matter for a
different reason: the brief's stakeholders are TTB agents, so the string the agency publishes to
its own regulated industry is the string they will expect to see quoted back.

### 2.2 The statement, verbatim

From 27 CFR 16.21 (S1), character for character:

```text
GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.
```

Facts about that string (**verified**, Appendix B):

| Property | Value |
|---|---|
| Length | 283 characters |
| SHA-256 | `35e1f5d39ee341ac7c114f8159956cb0cc1981b94e4ffeee194ff5060bf99fbc` |
| Non-ASCII characters | none |
| Apostrophes, quotation marks, hyphens | none |

Those last two rows are not trivia. Section 5 uses them. A normalization rule that folds
curly quotes, or strips diacritics, cannot help a string that contains neither — it can only
ever hide a deviation.

### 2.3 Byte comparison against PRD §3.4

**Result: identical. No discrepancy in wording, punctuation, casing, or whitespace.**

We extracted the candidate string from `docs/PRD.md` §3.4 programmatically, unwrapped its
Markdown line breaks to single spaces, and compared it to the eCFR text as bytes. Both are 283
characters. Both hash to `35e1f5d3…f99fbc`. The equality check returned true, and the
character-level diff returned no operations. The command is in Appendix B.

The PRD's copy was right. That is worth saying plainly, because the honest outcome of a
verification ticket is sometimes "the thing we assumed was correct" — and the value of the
ticket is that we now know it rather than believe it.

### 2.4 One structural finding: the CFR prints two paragraphs, not one string

eCFR renders § 16.21 as **two separate paragraphs**:

```text
P1: GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects.
P2: (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.
```

Joining them with one space produces the 283-character string above. So the "canonical text" is
really **two statements plus a join rule**, and the join rule is a design decision this document
makes rather than inherits.

TTB's own guidance says the statement must print as one continuous run of text. Its wording
differs across its own pages: the malt beverage page says *"It must appear as a continuous
statement."*; the wine and distilled spirits pages say *"It must appear as a continuous
paragraph."* (**verified**, S3–S5). Neither phrase appears in 27 CFR 16.21 or 16.22. So
"continuous" is TTB guidance, not statutory text, and the comparator must not turn it into a
rule of its own. What it does justify is the join: a conforming label prints the two statements
as one run, so comparing against one joined string is the correct target.

**Recommendation:** store the two statements as a two-element constant and derive the joined
string from it, rather than committing one 283-character literal. The structure then matches the
source, and the join becomes a named, testable rule instead of a hidden assumption. See open
question 8.

### 2.5 The second statute section — 27 CFR 16.22

§ 16.21 gives the words. § 16.22 gives the typography. This is where the caps rule actually
lives, and CP-1 and the golden set both referred to it without a citation. It now has one.

**§ 16.22(a)(2), verbatim** (**verified**, S2):

```text
The first two words of the statement required by § 16.21, i.e., "GOVERNMENT WARNING," shall
appear in capital letters and in bold type. The remainder of the warning statement may not
appear in bold type.
```

Read that sentence twice. It carries **four separate rules**, and they are not equally
checkable from a photograph:

| Rule | From | LabelHunter checks it? |
|---|---|---|
| The first two words are `GOVERNMENT WARNING` | § 16.21 wording | **Yes** — part of the exact compare (§5) |
| Those two words print in capital letters | § 16.22(a)(2) | **Yes** — deterministic, hard-enforced (§7.1) |
| Those two words print in bold type | § 16.22(a)(2) | **No** — advisory signal only (§7.2) |
| The rest does **not** print in bold type | § 16.22(a)(2) | **No** — not checked at all (§7.2, open question 5) |

The fourth rule is a finding. PRD §2 scoped "bold detection" as one thing. The regulation has
two bold rules pointing in opposite directions, and the extractor schema carries a single
`formatting.bold` flag that cannot express both. Section 7.2 handles it; open question 5 asks
you to decide it.

The rest of § 16.22 (**verified**, S2) sets physical requirements: the statement must be
"readily legible under ordinary conditions" on "a contrasting background" (a)(1); the letters
must not be compressed (a)(3); characters per inch are capped at 40, 25, or 12 depending on
type size (a)(4); and minimum type size is 1 mm, 2 mm, or 3 mm depending on container volume
(b)(1)–(3).

**LabelHunter checks none of the physical requirements, and §7.2 says why in one line:** a
photograph carries no scale. We know the required minimum type size, because the applicant
declares net contents and (b) is a lookup on volume. We cannot measure the printed type size,
because that needs the label's physical dimensions and a photograph does not supply them. Naming
the gap precisely — we know the threshold, we cannot measure the quantity — is a better answer
than "type size is out of scope."

### 2.6 What we could not verify

- **Whether TTB accepts any variation in practice.** The regulation states one statement. Our
  comparator treats it as the only acceptable one. Whether a TTB specialist would in fact reject
  a label over a missing comma is an enforcement question, not a text question, and no public
  source settles it. **not measured.**
- **The "continuous statement" / "continuous paragraph" wording.** It appears on ttb.gov, not in
  the CFR, and TTB's own pages disagree on which noun to use. We use it only as support for the
  join rule (§2.4), never as a rule.
- **Whether the 2026-07-06 issue of title 27 is the operative text on the submission date.**
  eCFR reports title 27 as up to date through 2026-08-07. LH-020 re-runs the Appendix B command
  and asserts the constant against the retrieved fixture, so a change to the regulation breaks a
  test rather than passing silently. See §9.3.

---

## 3. The two statements, and what "exact comparison" means

### 3.1 The object being compared

The comparator compares one thing against one thing:

- **Left side:** a candidate transcription of the label's warning block, after the §5
  normalization.
- **Right side:** the canonical string from §2.2, after the same normalization.

Nothing else. No similarity score. No threshold. No model opinion. The comparison operator is
`===`.

### 3.2 Three things "exact" does not mean

Say these out loud in the interview, because "exact" invites three wrong readings.

**It does not mean byte equality of the raw transcription.** A label prints the warning across
four to six physical lines. A camera, a vision model, and an OCR engine each add their own line
breaks, padding, and hyphenation. None of that was printed by the label's designer. Comparing
raw bytes would fail every real label, including perfectly compliant ones.

**It does not mean case-insensitive everywhere.** The capitalization of the first two words is a
regulated property (§2.5). Code checks it separately, and hard. Section 5.4 explains why the
body is treated differently, and open question 1 asks you to confirm that choice.

**It does not mean a model judges similarity.** The model transcribes. Code compares. That
split is the whole argument (§10, Q1).

### 3.3 The comparison, stated precisely

```text
compareWarning(candidate):

  1. raw        = candidate transcription, exactly as the reader returned it
  2. prefixOK   = checkPrefixCaps(raw)                  # §7.1, reads RAW text
  3. normalized = normalizeTransport(raw)               # §5.2, rules 1-5
  4. compared   = foldCase(normalized)                  # §5.4, body only
  5. canonical  = foldCase(normalizeTransport(CANONICAL))
  6. distance   = 0 if compared === canonical else levenshtein(compared, canonical)
  7. verdict from §6's table, using prefixOK and distance
```

Two ordering constraints are load-bearing, and a reviewer should check them:

1. **The caps check runs on the raw text, before any case folding.** Fold case first and Jenny's
   catch disappears. Section 5.4 shows the arithmetic that proves it.
2. **De-hyphenation runs before line breaks collapse to spaces.** Once the newline is a space,
   `bever- ages` is indistinguishable from a label that really printed a hyphen there.

---

## 4. The dual path — two readers, on purpose

### 4.1 Why two channels at all

One reader gives you an answer. Two readers give you an answer **and a measure of how much to
trust it**.

The two channels fail in different ways, which is the entire point:

| | Vision model (Haiku) | OCR (tesseract.js) |
|---|---|---|
| Reads by | learned language modelling over pixels | character shape matching |
| Typical failure | a plausible, fluent invention | a character confusion (`rn`→`m`, `,`→`.`) |
| Behaviour on a statutory paragraph it half-sees | tends to complete it from memory | tends to garble it visibly |
| Case handling | reports what it read | preserves it literally |

The vision model's failure mode is the dangerous one here. A model that has seen the government
warning thousands of times in training can reproduce it perfectly **from memory** while looking
at a label that says something slightly different. That is not a hypothetical risk for this
particular field; it is the single most likely way this tool produces a false PASS (§10, Q7).

OCR does not know what the warning is supposed to say. That ignorance is exactly why it is
useful.

**An honest limit, stated up front:** two channels do not make a wrong answer right. They make a
wrong answer **visible**. When the channels disagree, the subsystem does not pick a winner — it
returns REVIEW.

### 4.2 The vision channel

Haiku transcribes the warning block as part of the single extraction call CP-1 §3.2 designed.
The extractor prompt already carries the rule that matters:

```text
Copy the whole warning block exactly as printed. Copy the capitalization exactly. Do not
correct spelling. Do not expand abbreviations. Do not add or remove punctuation. Another
system compares your copy to the statutory text, so an "improved" copy destroys the check.
```

No second model call happens on the happy path. The warning gets no special model treatment
until the ladder (§8.4) says the evidence justifies it. That is TH-R19: the cascade is the
architecture, not an optimization.

The ladder's field-level rung sends **the warning crop only** to Sonnet, and leaves the other
four fields on Haiku. That rung buys two things at once: a stronger reader and more pixels
(Haiku's vision cap is 1568 px on the long edge, Sonnet's is 2576 px — both **verified** live
against the API at TRO-460 and recorded in `src/server/preprocessing/constants.ts`).

### 4.3 The OCR channel — tesseract.js

**Why tesseract.js, in one line:** it is the only mature OCR engine that runs inside our Node
process with no native binary, so Render can build and run it exactly as it builds everything
else.

Verified package facts, retrieved 2026-08-11 from the npm registry and the project's source
(Appendix B):

| Fact | Value | Why it matters |
|---|---|---|
| Latest version | `tesseract.js@7.0.0`, published 2025-12-15 | Actively maintained |
| Licence | Apache-2.0 (engine core also Apache-2.0) | No licence problem in a government-adjacent prototype |
| Native dependencies | none — pure JS plus `tesseract.js-core` WASM | **The Render argument.** No build toolchain, no `node-gyp`, no system package |
| Engine core size | ~30 MB unpacked | A real cost in the deploy image. Named, not hidden |
| Default language data location | `https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0` | **A hazard — see below** |
| Confidence returned | `data.confidence`, from Tesseract's `MeanTextConf()`, an integer 0–100 | The signal §6 routes on |
| Per-word confidence | only when `blocks: true` is requested; the default is `blocks: false` | LH-020 must opt in, or it gets no word-level detail |

**The langPath hazard, and the requirement it creates.** If `langPath` is not set, tesseract.js
downloads `eng.traineddata` from a public CDN **at first use, at runtime**. That breaks two
requirements at once. TH-R7 is the constrained-network lesson from the failed vendor pilot: a
firewalled evaluator would see the OCR channel silently die. And PRD §3.8's latency budget has no
room for a CDN round trip on the first label of a batch.

> **Implementation requirement for LH-020, not optional.** Commit `eng.traineddata` to the repo.
> Set `langPath` to that local directory and `cachePath` to a writable path. Add a test that
> fails when `langPath` is unset. The dependency then appears in the README's outbound-dependency
> list (TH-R7, rubric D2) as "none at runtime", which is a true statement only because we made
> it true.

**What OCR is given.** The warning crop, at near-native resolution (§8.3), greyscaled, as raw
pixels. Not the full label (§10, Q3). Page segmentation should be set to a single-block mode
rather than the default auto mode; the exact constant is **proposed** and LH-020 confirms the
name against tesseract.js's `PSM` enum before quoting it anywhere.

**What OCR is not asked to do.** OCR never reads the brand, the class/type, the alcohol content,
or the net contents. CP-1 §8 Q15 gives the reason: OCR returns a bag of strings, and turning
that into labelled fields means layout heuristics for every label design on the market. The
warning is the one field where OCR's weakness does not apply, because it is plain print in a
known block with known content.

### 4.4 The latency budget — concurrent, crop-only

PRD §3.8 (**target**, not measured):

| Stage | Budget (p50) |
|---|---|
| Preprocess — variants, warning crop, EXIF | ~0.3 s |
| tesseract.js OCR on the warning crop, **in parallel with the Haiku call** | ~0.5 s |
| Haiku extraction | ~2.5 s |
| Validation Router | < 10 ms |
| **Fast path total** | **~3 s p50 · ≤ 5 s p95** |

Three rules follow, and each is a line of code someone could get wrong:

1. **Concurrent, never serial.** `await Promise.all([extract(image), ocrCrop(crop)])`. Written
   serially, OCR adds its whole cost to the critical path and the 5-second promise (TH-R2) gets
   harder for no reason.
2. **The crop, never the full image.** Full-image tesseract.js costs 1–3 seconds. PRD §3.8 calls
   that "a tax we don't pay".
3. **An OCR failure degrades the answer; it never fails the request.** If OCR throws, times out,
   or returns nothing, the subsystem continues with one channel and §4.5's single-channel rules
   apply. A crashed OCR worker must not produce a 500 on a label the vision model read fine.

Section 8.2 raises a real conflict between rule 1 and one of the crop-detection options. Read it
before you accept the budget.

### 4.5 Reconciliation — when do two candidates agree?

**Agreement is defined by the same normalizer used for the statutory compare.** Two candidates
agree when `foldCase(normalizeTransport(vlm)) === foldCase(normalizeTransport(ocr))`. Using a
looser rule here — a similarity score, say — would quietly reintroduce fuzziness into the one
place the design promised there would be none.

Reusing the comparator's own normalizer has a second benefit. Any pair of candidates that agree
under it produce identical verdicts, so the subsystem never has to decide which channel "won".

The decision table:

| VLM vs OCR | Candidate vs canonical | Outcome | Why |
|---|---|---|---|
| agree | both equal | **PASS** | Two independent readers, one statutory string. The strongest evidence available |
| agree | both differ | **FAIL** | Two independent readers found the same deviation. A transcription slip does not happen twice, identically, in two unrelated engines |
| disagree | exactly one equals | **REVIEW** `WARNING_MISMATCH` | One channel contradicts the other. Passing on the agreeing one is the false-PASS path (§10, Q7) |
| disagree | neither equals | **REVIEW** `WARNING_MISMATCH` | We do not know what the label says |
| OCR unavailable or below the confidence floor | — | single-channel rules below | |

**Single-channel rules** (the OCR candidate is discarded when `data.confidence < 60`, **proposed**,
on Tesseract's 0–100 scale):

| Single channel says | Outcome | Why |
|---|---|---|
| equals canonical, **and** VLM confidence ≥ 0.90 | **PASS** | CP-1 §4.2 already set 0.90 as the warning transcription's trusted threshold |
| equals canonical, VLM confidence < 0.90 | **REVIEW** `LOW_IMAGE_QUALITY` | One weak reader is not enough to certify a statutory field |
| differs from canonical | **REVIEW** `WARNING_MISMATCH` | **We never accuse on one channel.** A FAIL is a claim the agency acts on |

That last row is the asymmetry worth defending. A single-channel PASS is allowed at high
confidence; a single-channel FAIL never is. The reason is TH-R10 and the cost of the two errors:
a wrong PASS delays a catch, a wrong FAIL accuses a compliant producer of a federal violation.

---

## 5. Normalization — the load-bearing decision

This is the section that gets attacked in the interview, so it is the section with the most
reasoning per line.

### 5.1 The principle, in one sentence

> **Normalize the transport, never the text.**

A photograph and an OCR engine both add artifacts the printer never printed. Those artifacts get
removed. Anything a human reader can see on the label survives untouched.

That gives a test any proposed rule must pass:

> **A normalization rule is legitimate only when it cannot change what a human reader sees.**

Collapsing a run of spaces passes the test — nobody reading the label sees the difference between
one space and three. Folding a curly apostrophe to a straight one fails it — a reader can see
which one is printed. Dropping punctuation fails it badly. Every rule below is sorted by that
test, and the sort is the defence.

### 5.2 The rules that apply, in this fixed order

| # | Rule | What it does | Why it passes the §5.1 test | Failure mode if chosen wrong |
|---|---|---|---|---|
| 1 | **Unicode NFKC** | Maps compatibility forms to canonical ones: fullwidth letters, ligatures, non-breaking space → space | These are encoding representations of the same visible glyph. A reader cannot see the difference | Skip it and a non-breaking space from the model's tokenizer causes a false FAIL |
| 2 | **Strip zero-width and soft characters** | Removes U+200B, U+FEFF, U+00AD | They are invisible by definition. Removing an invisible character cannot change what a reader sees | Skip it and an invisible character from a tokenizer causes a false FAIL that is impossible to debug by eye |
| 3 | **De-hyphenate at line ends** | `bever-\nages` → `beverages`. Fires only on a hyphen immediately followed by a line break | Justified text hyphenates at the line break. The hyphen is the typesetter's, not the statute's | Skip it and every justified label FAILs. Apply it too broadly — to any hyphen — and a label that really printed a hyphen escapes detection |
| 4 | **Line breaks → space** | Every newline becomes one space | The label wraps because it is narrow. The wrap point is a layout accident | Skip it and every real label FAILs. This is the single biggest source of false FAILs if omitted |
| 5 | **Collapse whitespace runs, trim ends** | Multiple spaces → one; strip leading and trailing | A reader does not count spaces. OCR and the model both pad inconsistently | Skip it and inter-word padding from OCR causes a false FAIL |

Rule 3 must run before rule 4. Once the newline is a space, the de-hyphenation rule can no longer
tell a wrap hyphen from a printed one.

### 5.3 The rules that are deliberately absent

Each of these appears in CP-1 §5.3's **brand** normalizer. None of them belongs here. That
contrast is the point: CP-1 Q11 committed to two matching regimes with no shared helpers, and
this table is what that commitment looks like in practice.

| Rule | Used for brands? | Used here? | Why not |
|---|---|---|---|
| Fold apostrophe and quote variants | yes | **no** | The statutory string contains no apostrophe and no quotation mark (§2.2, verified). A folding rule can therefore never fix a conforming label — it can only make a deviant one look conforming |
| Strip diacritics | yes | **no** | Same argument. The statutory string is pure ASCII. Stripping can only mask a deviation |
| Drop punctuation | yes | **no** | The colon, the parentheses around `(1)` and `(2)`, the commas, the periods are all part of the statement. Drop them and `GOVERNMENT WARNING (1) According to…` passes without its colon |
| Fuzzy or similarity matching | yes | **no** | TH-R9 asks for word for word. A threshold is the opposite of word for word |
| Reorder or normalize word order | no | **no** | Word order is the statement |
| Casefold the whole string | yes | **partly** | See §5.4 — the one deliberate exception, and the one that needs a decision |

### 5.4 Case — the one asymmetry, and the arithmetic behind it

Case gets split in two:

- **The prefix (`GOVERNMENT WARNING`): compared case-sensitively.** § 16.22(a)(2) regulates the
  capitalization of exactly these two words. This is Jenny's catch and rubric gate G4's second
  vector.
- **The body: compared case-insensitively (recommended, open question 1).** No regulation states
  the case of the remainder. Encoding a rule the regulation does not state would make LabelHunter
  stricter than the law, and a false FAIL is the most damaging error this tool can make.

**Why the split is necessary rather than merely tidy** — this is derived arithmetic over the
golden set's own ground-truth strings, not a model run (Appendix B):

| Golden case | What is wrong with it | Edit distance from canonical, case-sensitive | Edit distance, case-insensitive |
|---|---|---|---|
| case-08 — title-case prefix only | prefix printed `Government Warning:` | 15 | **0** |
| case-09 — whole statement title case | prefix and body both title case | 50 | **0** |
| case-10 — clause (1) reworded | genuine wording deviation | 38 | 38 |
| case-11 — clause (2) reworded | genuine wording deviation | 24 | 24 |
| the other 25 cases with a warning | nothing | 0 | 0 |

Two conclusions come straight off that table.

**The caps check is not optional and cannot be folded into the string compare.** Under a
case-insensitive body compare, case-08 and case-09 are at distance 0 — the words are right. The
*only* thing that catches them is the separate prefix check in §7.1. Remove that check and rubric
gate G4 fails, which is an automatic "not submit-ready" verdict.

**Real rewordings are nowhere near a near-miss.** The closest genuine deviation in the golden set
sits 24 characters away. That number sizes the band in §5.5.

### 5.5 The near-miss band (proposed)

CP-1 open question 2 raised this and deferred it here. This document decides it.

> **Proposed rule:** after normalization, an edit distance of 1 or 2 from the canonical string
> returns **REVIEW** with `WARNING_MISMATCH`, not FAIL. A distance of 3 or more returns FAIL.

The argument is asymmetric cost. A one-character difference is far more likely a transcription
slip than a printed deviation. Sending it to REVIEW costs one resolver call — about $0.05
(**derived**, CP-1 §7.1). Sending it to FAIL costs a false accusation of a federal labelling
violation. That trade is not close.

The band is safe because of the margin measured in §5.4: the nearest real deviation is 24
characters out, twelve times the band. **The margin is derived from four golden cases, which is a
small sample, and I would say so rather than claim the band is proven.**

Two guards on the band:

1. **The band never applies to the prefix.** A caps failure is a caps failure at any distance. It
   is a separate check on a separate rule (§7.1).
2. **The band never turns a FAIL into a PASS.** Its only effect is FAIL → REVIEW. A human or the
   resolver still looks.

Failure mode if the band is too wide: a genuinely deviant label escapes FAIL and costs a review
instead. Failure mode if there is no band at all: an OCR slip becomes a public accusation.

### 5.6 Worked examples

| Raw candidate (abbreviated) | After normalization | Verdict | Why |
|---|---|---|---|
| `GOVERNMENT WARNING: (1)\nAccording to the\nSurgeon General, …` | equals canonical | **PASS** | Rules 4 and 5 removed the label's line wrapping |
| `GOVERNMENT WARNING: (1) … alcoholic bever-\nages during …` | equals canonical | **PASS** | Rule 3 rejoined the hyphenated wrap |
| `Government Warning: (1) According to …` | body equals canonical | **FAIL** | Body matches; the prefix caps check fails (§7.1) |
| `GOVERNMENT WARNING: (1) According to the Surgeon General, pregnant women should not consume …` | distance 38 | **FAIL** | Genuine rewording. Far outside the band |
| `GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defect.` | distance 1 | **REVIEW** | Near-miss band. One character. More likely a slip than a deviation |
| VLM returns canonical; OCR returns garbled text | — | **REVIEW** | Channels disagree (§4.5) |

---

## 6. Verdict semantics, mapped onto `WarningComparatorResult`

### 6.1 The table

`src/server/router/types.ts` already defines the contract LH-020 implements. Every row below
names the exact branch it returns.

| Situation | `WarningComparatorResult` returned | Router's label verdict | UI reason line |
|---|---|---|---|
| Both channels agree, equals canonical, prefix all-caps | `{ verdict: "MATCH" }` | contributes PASS | "Government Warning matches the required text." |
| Wording deviates, distance ≥ 3 | `{ verdict: "MISMATCH", note }` | **FAIL** | "Government Warning wording differs from the required text." |
| Prefix printed in title case | `{ verdict: "MISMATCH", note }` | **FAIL** | "Government Warning must print in capital letters." |
| Near miss, distance 1–2 | `{ verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" }` | REVIEW | "Government Warning differs by a single character — needs a closer look." |
| Channels disagree | `{ verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" }` | REVIEW | "Government Warning could not be read consistently." |
| OCR confidence low, or the crop is clipped, or single channel below 0.90 | `{ verdict: "NEEDS_REVIEW", reviewReason: "LOW_IMAGE_QUALITY" }` | REVIEW | "Government Warning is not clear enough in this image." |
| Warning absent entirely | `{ verdict: "NEEDS_REVIEW", reviewReason: "MISSING_REQUIRED_FIELD" }` | REVIEW | "No Government Warning found on this label." |

**The last row settles CP-1 open question 10**, which asked whether an absent warning should FAIL
or REVIEW and left it open. It is REVIEW. From a JSON payload alone, "the label has no warning"
and "the reader did not find the warning" are the same event. The warning subsystem is the only
component positioned to tell them apart, and it can only do so partially: it knows whether the
crop was clipped and whether image quality was poor. It does not know whether the warning is on a
part of the bottle the photograph does not show. Under TH-R10, an unresolvable question produces
REVIEW.

The golden set already expects exactly this (case-12 and case-13, both `MISSING_REQUIRED_FIELD`
with a REVIEW label verdict), so no change is needed there.

### 6.2 Why the union shape matters

```ts
export type WarningComparatorResult =
  | { verdict: "MATCH" | "MISMATCH"; note?: string }
  | {
      verdict: "NEEDS_REVIEW";
      reviewReason: Extract<ReviewReason,
        "WARNING_MISMATCH" | "LOW_IMAGE_QUALITY" | "MISSING_REQUIRED_FIELD">;
      note?: string;
    };
```

The discriminated union is deliberate, and its author wrote the reason into the type's own
comment: a `NEEDS_REVIEW` with no stated reason is a **compile error**, not a silent default the
router has to guess at. LH-020 cannot ship a review outcome nobody named.

It also constrains this document. Two names that appear elsewhere in the project **cannot** come
out of this comparator:

- **`CONFLICTING_EXTRACTION`.** PRD §3.7's ladder describes "VLM and OCR candidates disagree" as
  `CONFLICTING_EXTRACTION`. The union does not permit it. §6.1 routes that event as
  `WARNING_MISMATCH` instead. The ladder's telemetry still counts the event under its own name
  (§8.4) — the routed reason and the metric label are two different things. Open question 4.
- **`LOW_MODEL_CONFIDENCE`.** Golden cases 23 and 24 expect it as the label-level headline for
  tiny warning text. This comparator cannot produce it, and CP-1 §5.2's precedence would rank
  `LOW_IMAGE_QUALITY` (rank 1) above it anyway. Open question 4 and §9.2.

### 6.3 The reason strings

Every string in §6.1's last column is written for a compliance agent, not an engineer. None
mentions a confidence number, a model name, or an edit distance. That follows PRD §3.3 and
TH-R20: the UI shows "Government Warning differs from expected text", never "AI confidence: 71%".

The detail view shows more: the expected text and the detected text, side by side, with the
differing region marked. That is PRD §5's "warning expected-vs-detected diff". It is what turns a
verdict into something Jenny can act on without trusting us.

---

## 7. Caps enforcement and bold detection

These two live in the same sentence of the regulation (§2.5) and get opposite treatment. Being
able to say why, crisply, is one of the better answers available in this interview.

### 7.1 Caps — deterministic and hard

**The rule.** Take the raw transcription, before any case folding. Take the first two
whitespace-separated words. Strip a trailing colon from the second. Compare to `GOVERNMENT` and
`WARNING` with `===`.

| Comparison | Meaning | Verdict |
|---|---|---|
| Equal | Prefix conforms | continue to the body compare |
| Not equal, but equal when case-folded | The words are right, the capitalization is not | **MISMATCH**, caps reason |
| Not equal even when case-folded | The prefix is absent or reworded | **MISMATCH**, wording reason |

**Code derives the casing; it does not trust the model's report.** The extractor schema carries a
`prefix_casing` enum (`ALL_CAPS` / `TITLE_CASE` / `OTHER` / `NOT_VISIBLE`). That field is a
cross-check, not the source of truth. Two reasons. It is a model's opinion about its own output,
and this design does not let a model decide a statutory question. And code reading the first two
characters of a string is testable in a way a model's self-report never is.

When the derived casing and the model's `prefix_casing` disagree, that is itself a signal: the
transcription is unreliable, so the result is REVIEW rather than a verdict either way.

**OCR checks caps too.** Tesseract preserves case literally. So the caps check has the same two
independent channels the wording check has, and the same reconciliation applies. This is worth
saying in the interview, because it is not obvious and it strengthens the strongest requirement.

**Why this is hard-enforced and bold is not:** capitalization survives a photograph. It is a
choice of glyph, and a glyph is what a camera records. Stroke weight is a measurement, and the
photograph does not carry the scale that measurement needs.

### 7.2 Bold — an advisory signal, not a check

PRD §2 scoped bold detection as "attempted via Sonnet vision judgment, reported as low-confidence
signal, and documented as a prototype limitation." This document keeps that scope and adds the
regulatory detail §2.5 uncovered: **§ 16.22(a)(2) has two bold rules, and the schema carries one
flag.**

| Regulation | Extractor field | Status |
|---|---|---|
| `GOVERNMENT WARNING` **shall** print in bold | `formatting.bold: true / false / uncertain` | Advisory only. Never changes a verdict |
| The remainder **may not** print in bold | *no field* | Not checked. Not attempted. Named in the limitation |

Four reasons bold resists a prototype check, in the order they bite:

1. **Bold is relative, not absolute.** A typeface's regular weight can be heavier than another
   typeface's bold. The judgment only means anything as a comparison between the prefix and the
   body at the same size — which is a measurement, not a glance.
2. **Small print destroys the evidence.** The warning prints at 1–3 mm (§2.5). At that size the
   stroke-weight difference between regular and bold is a fraction of a pixel in a normal photo.
3. **JPEG compression removes what is left.** Every image reaching us has already been through at
   least one lossy encode. Compression artifacts at small type sizes are the same magnitude as the
   signal we would be measuring.
4. **There is no ground truth in the image.** We see rendered pixels. We do not see the font the
   designer chose.

**What would make it checkable, in a v2 that is not this prototype:** binarize the crop, measure
mean stroke width by morphological erosion, and compare the prefix's stroke width to the body's
at matched x-height. That is a real technique with a real literature. It needs a clean, flat,
high-resolution crop, and it needs the prefix and body to be the same typeface. Naming it costs
nothing and shows the limitation is a scope decision rather than a shrug.

### 7.3 The limitation wording — drafted for reuse

`docs/approach.md` (TH-R15, TH-R23) and the README both need this paragraph. It is written to be
copied verbatim, so the tool and the docs never drift apart on what was promised.

> **Limitation — bold type on the government warning.** 27 CFR 16.22(a)(2) requires the words
> "GOVERNMENT WARNING" to print in bold type, and it forbids bold type on the rest of the
> statement. LabelHunter checks neither rule. It reports a three-valued advisory signal from the
> vision model — bold, not bold, or uncertain — and that signal never changes a verdict. Stroke
> weight is a relative measurement. It depends on the typeface, the printed size, the photograph's
> resolution, and the compression the photograph has already been through. A prototype that turned
> that signal into a failure would accuse a compliant label of a violation it cannot prove.
> LabelHunter does hard-enforce the capitalization rule from the same sentence of the regulation,
> because capitalization survives a photograph and stroke weight does not.

---

## 8. Warning-region detection and the crop

### 8.1 What LH-020 builds against

Two pieces already exist and are merged. LH-020 does not rebuild them.

| Existing | File | What it does |
|---|---|---|
| `clampRegionToBounds(region, w, h)` | `src/server/preprocessing/region.ts` | Guarantees a caller's pixel box fits inside the image. Rounds fractional coordinates. Throws `RangeError` on a non-finite field |
| `cropRegion(...)` | `src/server/preprocessing/pipeline.ts` | Performs the extraction through sharp |

That file's own header states the split precisely: *"This ticket does not detect the warning block
on a label — that is LH-020's job."* So LH-020 owns exactly one new thing here: **producing the
region.**

### 8.2 Detection — three options, one conflict

| Option | How it works | Cost | Risk |
|---|---|---|---|
| **A. Model-reported box** | Ask Haiku to return the warning block's bounding box in normalized coordinates | one extra schema field | Vision models are unreliable at precise coordinates. **not measured.** And see the conflict below |
| **B. Band search** | Run OCR at near-native resolution on a small set of candidate bands (top, bottom, left, right thirds). Keep the band whose text contains `GOVERNMENT`, case-insensitively | k small OCR passes instead of one | k× the OCR cost. Fails on a label with an unusual layout |
| **C. Classical detection** | Morphological gradient plus connected components on a downscaled greyscale image, to find dense small-text blocks | milliseconds, no OCR | Heuristic. Needs tuning. **not measured** |

**The conflict, and it is real.** Option A's box comes from the same Haiku call that produces the
transcription. So OCR cannot start until Haiku returns — which breaks PRD §3.8's requirement that
OCR runs *concurrently with* the Haiku call, not after it. Choosing A means either giving up the
concurrency or accepting a serial ~0.5 s on the critical path.

**Recommendation: C as the primary detector, B as the fallback, single-channel as the final
fallback.** C runs in milliseconds on the preprocessed image, so OCR starts immediately and the
budget holds. If C finds no candidate region, B tries a small fixed set of bands. If both fail,
the subsystem runs single-channel (§4.5) — a REVIEW-biased outcome, never a wrong one.

This is open question 3, and it is the one with the most engineering risk attached.

### 8.3 Near-native DPI, and why it is not a detail

PRD §3.1 says the pipeline keeps the original full-resolution image specifically for OCR, and
crops the warning region at near-native DPI. Here is the arithmetic behind that (**derived**, from
stated assumptions — no measurement):

Assume a 750 mL bottle's front label is about 100 mm wide, photographed at 3000 px wide.

| Source of the crop | Scale | 2 mm cap height becomes | Usable for OCR? |
|---|---|---|---|
| The original image | 30 px/mm | ~60 px | Comfortable |
| The Haiku variant, resized to 1568 px long edge | ~15.7 px/mm | ~31 px | Marginal |
| A thumbnail at 800 px | ~8 px/mm | ~16 px | No |

Tesseract wants roughly 20 px of x-height as a floor and does noticeably better above 30 px. The
warning is legally allowed to print at 1 mm on small containers (§2.5). At 1 mm, the Haiku variant
gives about 16 px — below the floor. **That is why the crop must come from the original image and
not from the resized variant**, and it is why golden cases 23 and 24 (tiny warning text, and a
50 mL miniature) exist at all.

The assumed label width and photo resolution are assumptions. LH-030 replaces the table with
measured OCR accuracy per source. Until then this is arithmetic, and it is labelled as such.

> **Implementation note for LH-020.** `src/server/preprocessing/constants.ts` sets
> `OUTPUT_MEDIA_TYPE = "image/jpeg"` for every pipeline output, and its comment includes "any
> later warning-region crop". That constant exists because the Claude vision API accepts JPEG and
> not HEIC. **Tesseract is not an API and needs no re-encode.** Sending the OCR crop through a
> lossy JPEG round trip adds compression artifacts to exactly the small print we are trying to
> read. LH-020 should hand tesseract raw pixels or PNG. See open question 6.

### 8.4 The upgrade ladder — restated so the walkthrough rehearses it

PRD §3.7 makes the model-upgrade decision a number, not a judgment call. Restated here because
the comparator is what produces that number.

**The segmentation.** Every warning check writes exactly one outcome class:

| Class | What it means | Upgrade signal? |
|---|---|---|
| **Clean pass** | Both channels agree with the statute | no |
| **True mismatch (FAIL)** | The label's text genuinely differs | **No — no matter how frequent.** This is the tool working |
| **Resolution-suspect (REVIEW)** | `LOW_IMAGE_QUALITY`, or the two channels disagree | **Yes. This rate drives the ladder** |

Naming the denominator, which PRD §3.7 leaves implicit:

```text
suspect rate = resolution-suspect / (clean pass + true mismatch + resolution-suspect)
```

**The ladder** (apply in order; re-measure on the golden set after each step):

| Suspect rate | Action |
|---|---|
| ≤ 10% | Healthy. Keep Haiku plus the warning crop |
| 10–25% | **Fix the crop pipeline first** — detection, DPI, framing. Re-measure before any model change |
| > 25%, persistent after the crop fix | Field-level upgrade: the warning crop goes to Sonnet; Haiku keeps the other four fields |
| Still failing, or other fields degrade too | Full extractor upgrade to Sonnet; re-run the latency and cost benchmarks before accepting |

The rung ordering encodes the design's own belief about what usually goes wrong: **a bad crop
looks exactly like a bad model, and it is far cheaper to fix.** Spending a model upgrade on a
cropping bug is the mistake this ladder exists to prevent.

The eval harness reports the segmentation on every run (PRD §6), so the upgrade decision appears
in CI output rather than in someone's judgment mid-week. No number here is measured yet.

---

## 9. Golden-set review — CP-2's second job

PRD §12 lists "generated test labels unrealistic" as a risk, with the mitigation "golden set
reviewed at CP-2." This is that review.

### 9.1 Current state, checked in this worktree

- `golden-set/manifest.json`: **29 cases**, schema version 1.0.0. **12 are warning-relevant.**
- `golden-set/images/`: **empty except `.gitkeep`.** Zero images exist.
- Every case has `verified: false`, because verification requires an image and none exist.
- `golden-set/README.md` names the gap in its own words and explains why placeholder files would
  be worse than an empty directory. That judgment was right.

The 12 warning-relevant cases, and which comparator branch each exercises:

| Case | Category | Exercises | Expected label verdict |
|---|---|---|---|
| case-01, 03, 04 | clean-match | PASS path, rubric vector V1 | PASS |
| case-08 | title-case prefix only | **§7.1 caps check** — rubric gate G4, Jenny's catch | FAIL |
| case-09 | whole statement title case | §7.1 caps check with a title-case body | FAIL |
| case-10 | clause (1) reworded | §5 wording compare, distance 38 | FAIL |
| case-11 | clause (2) reworded | §5 wording compare, distance 24 | FAIL |
| case-12, 13 | missing warning | `MISSING_REQUIRED_FIELD` branch | REVIEW |
| case-18 | glare on the warning block | `LOW_IMAGE_QUALITY` branch | REVIEW |
| case-22 | low light on the warning block | `LOW_IMAGE_QUALITY` branch | REVIEW |
| case-23 | tiny text, standard bottle | crop DPI, §8.3 | REVIEW |
| case-24 | tiny text, 50 mL miniature | crop DPI at the legal 1 mm floor | REVIEW |

Rubric gate G4 needs three vectors: exact → PASS, title-case → FAIL, reworded → FAIL. All three
are covered. G4 is a submission gate, so this coverage is not optional.

### 9.2 Four findings the checkpoint should settle

**Finding 1 — two cases expect a reason this comparator cannot return.** Cases 23 and 24 expect a
label-level `reviewReason` of `LOW_MODEL_CONFIDENCE`. `WarningComparatorResult` permits only
`WARNING_MISMATCH`, `LOW_IMAGE_QUALITY`, and `MISSING_REQUIRED_FIELD`. Separately, CP-1 §5.2 ranks
`LOW_IMAGE_QUALITY` first and `LOW_MODEL_CONFIDENCE` last, so even if both fired, the headline
would be `LOW_IMAGE_QUALITY`. **Recommendation:** change the two manifest entries to
`LOW_IMAGE_QUALITY`. Tiny print is an image-resolution problem, and that is the honest name for it.

**Finding 2 — case-09's expected reason assumes a case-sensitive body.** Its reason string reads
"the wording must match the statute exactly", which implies the title-case body itself is a wording
failure. Under §5.4's recommendation the body compares case-insensitively, so the verdict is still
MISMATCH but the reason is the caps rule alone. **Recommendation:** the verdict stays; the reason
string changes to name the prefix. Settle open question 1 first — it decides this.

**Finding 3 — no case exercises channel disagreement, and no image can.** "VLM and OCR disagree" is
a property of two readers, not of a label. No photograph produces it reliably. **Recommendation:**
LH-020 covers it with unit tests over synthetic candidate pairs, and CP-2 records that a golden
image is the wrong tool for this branch. Name it in the approach doc so it does not read as a gap.

**Finding 4 — no case exercises the near-miss band.** §5.5 proposes a distance-1–2 REVIEW band, and
the golden set's deviations are 24 and 38 characters out. The band has no covering case.
**Recommendation:** add one case — the canonical text with a single character changed, expecting
REVIEW. It is one renderer parameter and it is the band's only evidence.

### 9.3 What CP-2 should sign off on, and what it cannot

**Can sign off:** the 12 cases' *specifications* — what each label says, what the router should
decide, and why. The specifications are complete and they cover the rubric's gate vectors.

**Cannot sign off:** the images. None exist. PRD §12's mitigation reads "golden set reviewed at
CP-2", and half of that review — do the pixels look like real labels? — is not possible today. Say
this plainly at the walkthrough rather than let the checkpoint imply coverage it does not have.

> **Requirement for the image-generation ticket (LH-004 … LH-006), decided here.** The renderer
> must draw the warning text from the same canonical constant the comparator uses. And a separate
> test must assert that constant against a **committed fixture of the retrieved eCFR XML**, not
> against itself. Without the second half, a wrong constant would render a wrong label, match it,
> and pass — the golden set would be testing our copy of the statute against our copy of the
> statute. The fixture makes the statute check its own source.

---

## 10. Defend it — Q&A

Read each question. Answer it yourself. Then read the answer.

---

**Q1. Why exact comparison instead of asking the model whether the warning is correct?**

Because of what each answer sounds like when a producer appeals a rejection.

"The system compared the transcribed text against the statutory string from 27 CFR 16.21, and it
differs at these characters" is a statement someone can check. They can read our normalizer, read
the statute, and either agree or find our bug.

"Sonnet thought it looked right" is not a statement anyone can check. It is not reproducible
either — the same label could get a different answer next week, and nobody could tell whether the
label changed, the model changed, or the temperature was different.

There is a second reason, and it is the one an engineer will care about more. TH-R8 and TH-R9 ask
for opposite things. Dave needs `STONE'S THROW` to match `Stone's Throw`. Jenny needs
`Government Warning` to fail. A single model asked to do both will drift: some days it forgives a
comma in the statute, some days it rejects a case difference in a brand name. Neither drift shows
up in the output. Splitting the two regimes into separate code paths with no shared helpers is the
only way to hold both requirements at once.

And on this particular field, code is simply better than any model. On "does this string equal that
string", code is 100% accurate and 100% reproducible. There is no accuracy argument for the model
here — only an accuracy argument against it.

---

**Q2. Why tesseract.js? Why not a cloud OCR service, or a native Tesseract binding?**

The deciding constraint is deployment. tesseract.js is pure JavaScript plus a WASM core with no
native dependencies (**verified** from its published package metadata). Render builds and runs it
the same way it builds everything else in the repo — no build toolchain, no `node-gyp`, no system
package, no Docker escape hatch. A native binding would mean a custom build image for a prototype
that has a week to exist.

A cloud OCR service is the more interesting alternative, and I rejected it for a specific reason
rather than a general one. TH-R7 exists because the last vendor pilot failed on a constrained
network. Adding a second outbound API dependency — with its own key, its own quota, and its own
failure mode — to the one component whose job is to be an *independent* check would undercut both
requirements at once.

Two costs I would flag rather than let someone find. The engine core is about 30 MB unpacked, which
is real weight in a deploy image. And tesseract.js downloads its language data from a public CDN at
runtime unless you set `langPath` — which would have quietly reintroduced the exact
network-dependency problem TH-R7 warns about. We found that reading the source, not by hitting it,
and the fix is to commit `eng.traineddata` and point `langPath` at it. There is a test that fails
if someone unsets it.

---

**Q3. Why run OCR only on the warning crop? Why not the whole label?**

Three reasons, and they stack.

**Latency.** Full-image tesseract.js costs 1–3 seconds. Our whole single-label budget is 5 seconds
p95, and the Haiku call already spends about 2.5 of it. The crop costs about 0.5 s and runs
concurrently with the model call, so it costs nothing on the critical path. Those are budget
targets from PRD §3.8, not measurements.

**Accuracy.** OCR is good at plain print in a known block and bad at stylized label art. A
brand name in a script face produces confident garbage. Running OCR only where it is strong is the
whole design principle here, not a shortcut.

**It would not help anyway.** OCR returns a bag of strings and their positions. It does not know
which string is the brand name. Turning that into labelled fields means layout heuristics for every
label design in the market — which is the fragile part of exactly the vendor pilot that failed.

The honest cost of the choice: if our crop detector misses the warning block, we lose the OCR
channel for that label. That does not produce a wrong answer. It produces a single-channel result,
which §4.5 biases toward REVIEW.

---

**Q4. What happens when OCR and the vision model disagree?**

Nothing gets decided. The result is REVIEW with `WARNING_MISMATCH`.

That is the answer even when one of the two candidates exactly equals the statutory string —
and that case is worth dwelling on, because the tempting behaviour is to pass it. If the vision
model returns the statute perfectly and OCR returns something different, one of two things is true:
OCR misread a compliant label, or the model reproduced the statute from memory instead of from the
label. Both are common. We cannot tell them apart from the payload. So we do not guess.

Passing on the agreeing channel is precisely how a false PASS gets manufactured, which is the worst
failure this subsystem has (see Q7).

The disagreement rate is not just a routing outcome — it is the metric that drives the model
upgrade ladder (§8.4). If we see a lot of it, that is evidence about our crop or our reader, and
the ladder says what to do about it in what order.

---

**Q5. How do you catch `Government Warning` in title case deterministically?**

Code takes the raw transcription before any case folding, takes the first two words, strips the
trailing colon, and compares them to `GOVERNMENT` and `WARNING` with a case-sensitive equality
check. If they differ only by case, that is the caps failure and it produces FAIL with the caps
reason. The rule is 27 CFR 16.22(a)(2), which requires the first two words to print in capital
letters.

Two details make this stronger than it first sounds.

**Code derives the casing rather than trusting the model's report.** The extractor does return a
`prefix_casing` enum, but that is a model's opinion about its own output. We use it as a
cross-check: if the derived casing and the reported casing disagree, that is a signal the
transcription is unreliable, and the result becomes REVIEW.

**The check has two channels, like the wording check.** Tesseract preserves case literally, so OCR
gives an independent read of the capitalization too.

And here is the number that shows why this check cannot be folded into the string comparison. In
the golden set, the title-case cases sit at edit distance **0** from the statutory string once case
is folded — the words are all correct. The separate caps check is the only thing that catches them.
Remove it and rubric gate G4 fails, which is an automatic not-submit-ready verdict.

---

**Q6. Why is bold a documented limitation rather than a check?**

Because I can measure capitalization from a photograph and I cannot measure stroke weight from one.

Capitalization is a choice of glyph. A camera records glyphs. `G` and `g` are different shapes and
survive compression, angle, and small type.

Bold is a relative measurement. It only means something as a comparison between the prefix and the
body at matched size — and the warning prints at 1 to 3 millimetres. At that size the stroke-width
difference between a regular and a bold face is a fraction of a pixel in a normal phone photo, and
every photo we get has already been through at least one lossy encode. The compression artifacts
are the same magnitude as the signal.

So the design reports a three-valued signal from the vision model — bold, not bold, uncertain —
shows it as advisory in the detail view, and never lets it change a verdict. Turning it into a FAIL
would accuse a compliant label of a violation we cannot prove.

One thing I would add, because verifying the regulation turned it up: 16.22(a)(2) actually contains
*two* bold rules. The first two words must be bold, and the rest must not be. Our schema has one
flag and checks neither. The limitation paragraph in the approach doc names both, so nobody reads
"bold detection attempted" as a claim we cover the second one.

If I were building the real version, the technique is stroke-width measurement by morphological
erosion on a binarized crop, comparing prefix to body at matched x-height. That needs a clean
high-resolution crop and a shared typeface, and it is a v2 feature, not a week-one one.

---

**Q7. What would it actually take to produce a false PASS on the warning?**

This is the failure I would most want to be asked about, so let me answer it as a threat model
rather than a reassurance.

A false PASS needs one of two things to happen.

**Path one: both channels agree on the wrong text.** The vision model would have to transcribe the
statutory string from memory rather than from the label, *and* OCR would have to independently
produce the same wrong string. OCR does not know what the warning is supposed to say, so it has no
mechanism for that particular error. This path is close to closed, and closing it is the reason the
second channel exists.

**Path two: the OCR channel is absent, and the model transcribes from memory.** This is the real
one. If our crop detector fails, §4.5 falls back to single-channel, and a single channel at
confidence ≥ 0.90 that matches the statute produces PASS. A vision model that has seen this exact
paragraph thousands of times in training is exactly the kind of reader that completes it from
memory when the pixels are marginal.

Three things narrow it, and none closes it. The confidence floor of 0.90 is higher for this field
than for any other (CP-1 §4.2). A clipped or low-quality crop routes to REVIEW before the compare
runs. And the extractor must supply an evidence string, so the transcription is not free-floating.

The residual risk, stated plainly: a marginal image, a failed crop detection, and a confident
model reciting the statute produce a PASS on a label that says something slightly different. The
mitigation that would actually close it is refusing to PASS on one channel at all — and I did not
choose that, because it converts every crop-detection failure into a human review. That is a
throughput cost I would rather measure on the golden set before paying. It is on the open-questions
list precisely because it is a judgment call, not a solved problem.

---

**Q8. How does the ladder decide to upgrade the model, with evidence?**

By segmenting the warning outcomes into three classes and watching exactly one of them.

A **true mismatch** is the tool working. It never triggers an upgrade, no matter how frequent —
that distinction matters, because a naive "warning failure rate" metric would trigger an upgrade
every time we tested against a batch of genuinely bad labels.

A **resolution-suspect** outcome is `LOW_IMAGE_QUALITY`, or the two channels disagreeing. That rate
is the signal.

Then the rungs, in order. Below 10% we change nothing. Between 10 and 25% we fix the crop pipeline
— detection, DPI, framing — and re-measure before touching the model. Above 25% and persistent
after that fix, the warning crop alone goes to Sonnet while Haiku keeps the other four fields. Only
if that fails too do we move the whole extractor, and that rung requires re-running the latency and
cost benchmarks before we accept it.

The ordering encodes a belief worth stating out loud: a bad crop looks exactly like a bad model,
and it is an order of magnitude cheaper to fix. Spending a model upgrade on a cropping bug is the
specific mistake the ladder exists to prevent.

The eval harness reports the segmentation on every run, so this shows up as a number in CI rather
than a judgment call mid-week. No number is measured yet, and I would not quote one.

---

**Q9. How do you know your canonical text is the right text?**

Because I retrieved it rather than trusted it, and the retrieval is reproducible.

The statement comes from eCFR's API for 27 CFR 16.21, from the 2026-07-06 issue of title 27,
retrieved on 2026-08-11. I cross-checked it against three separate ttb.gov pages — malt beverage,
wine, and distilled spirits — and all three carry a byte-identical string. It is 283 characters,
pure ASCII, and it hashes to `35e1f5d3…`. The exact command is in the document's appendix.

Our PRD had a candidate string written down with a note beside it saying "verify verbatim during
implementation — a ticket, not an assumption." I ran the byte comparison. They are identical. That
is a boring result and it is the right kind of boring: we now know it instead of believing it.

Two things I would rather volunteer than have found. The CFR actually renders the statement as two
paragraphs, not one string, so the joined form we compare against is a design decision we made and
documented, not something we inherited. And TTB's own pages disagree with each other on a detail —
one says the statement must appear as a "continuous statement", the others say "continuous
paragraph", and neither phrase appears in the CFR at all. So we treat "continuous" as guidance
supporting the join rule, never as a rule of its own.

And it does not stay verified by assertion: a committed fixture of the retrieved XML is what the
constant is tested against, so a change to the regulation breaks a test rather than passing
silently.

---

**Q10. You normalize before an "exact" comparison. Is that not a contradiction?**

It would be, if normalization touched the text. It touches the transport.

The test every rule has to pass is one sentence: **a normalization rule is legitimate only when it
cannot change what a human reader sees on the label.** Collapsing a run of spaces passes — nobody
sees the difference between one space and three. Rejoining a word hyphenated across a line break
passes — the hyphen belongs to the typesetter, not the statute. Removing a zero-width character
passes trivially, since it is invisible.

Folding curly quotes to straight ones fails that test. Stripping diacritics fails it. Dropping
punctuation fails it badly. So none of those are in this normalizer — even though all three *are*
in the brand-name normalizer, where equivalence rather than exactness is the requirement.

There is a nice detail that makes the point concrete. The statutory string contains no apostrophe,
no quotation mark, and no non-ASCII character at all. So a quote-folding rule here could never fix
a compliant label. It could only ever make a deviant one look compliant. Leaving it out is not
caution — it is the only correct choice.

The one deliberate exception is case, and it is scoped by the regulation itself. 16.22(a)(2)
regulates the capitalization of exactly two words, and we check exactly those two words, hard and
case-sensitively.

---

**Q11. If you compare the body case-insensitively, is that not a hole?**

It is a deliberate choice with a cost, and I would rather defend the choice than pretend there is
no cost.

The regulation states the capitalization rule for the first two words and says nothing about the
rest. If we compared the body case-sensitively, a label that printed the whole warning in capitals
would fail our check while violating no rule I can cite. That is the error I care most about
avoiding — a false accusation of a federal labelling violation is worse than a missed catch,
because a producer acts on it.

What we lose: if TTB does in fact expect the body in a particular case, we would not flag it. I
could not find that requirement in 27 CFR part 16 or on ttb.gov, and I am not willing to enforce a
rule I cannot cite.

It is also the reason the caps check must be structurally separate rather than folded into the
string compare — under case-insensitive comparison, the title-case cases sit at distance 0 and only
the prefix check catches them.

This is on the open-questions list, and it is the one I would most want a TTB specialist to settle,
because it is a regulatory question rather than an engineering one.

---

**Q12. What if the warning is printed somewhere your photo does not show?**

Then we return REVIEW with "No Government Warning found on this label", and we do not call it a
failure.

27 CFR 16.21 permits the statement on the brand label, a separate front label, a back label, or a
side label. A single photograph of a bottle cannot see all four. So "absent from this image" and
"absent from this product" are different claims, and only the first is one we are entitled to make.

That is why an absent warning routes to REVIEW rather than FAIL, and it settles a question CP-1
left open. The reason string is written so an agent reads it correctly: it says the warning was not
found on *this label*, not that the product is non-compliant.

The related case — the warning is visible but partly outside the crop — routes to REVIEW with
`LOW_IMAGE_QUALITY`, because a clipped block is exactly the input that produces a plausible false
FAIL.

---

**Q13. What does an agent actually see when the warning fails?**

Three things, and none of them is a number.

The results checklist shows one row for the Government Warning with a failure mark and one line of
plain English: "Government Warning wording differs from the required text", or "Government Warning
must print in capital letters." Never a confidence percentage, never a model name, never an edit
distance.

The detail view shows the required text and the detected text side by side, with the differing
region marked. That is the part Jenny can act on. She does not have to trust our verdict — she can
see the two strings and agree or disagree in a second.

And the row records what it was compared against and what evidence supported it, so a reviewer can
reconstruct the verdict later without re-running a model. That is TH-R22's audit trail, and it is
the reason the whole comparison is deterministic in the first place: a verdict you cannot
reconstruct is not one an agency can defend.

---

## 11. Open questions for Troy

These are real forks. Each has a recommendation and the cost of choosing wrong.

**1. Should the warning body compare case-insensitively outside the prefix?**
§5.4 recommends yes: case-sensitive on the two-word prefix (27 CFR 16.22(a)(2) regulates it),
case-insensitive on the body (no regulation states it). *Recommendation:* adopt. Enforcing a rule
we cannot cite is how a compliance tool makes a false accusation. *Cost of choosing wrong:* if TTB
does expect a particular case in the body, we miss that deviation. If we go the other way and a
compliant all-caps label fails, we accuse a producer of a violation with no citation behind it.
This also decides finding 2 in §9.2.

**2. Adopt the near-miss band at distance 1–2?**
§5.5 proposes that an edit distance of 1 or 2 returns REVIEW rather than FAIL. CP-1 open question 2
deferred this here. *Recommendation:* adopt, with N = 2. The nearest genuine deviation in the golden
set is 24 characters away (**derived**, §5.4), so the margin is twelve times the band. *Cost of
choosing wrong:* too narrow and an OCR slip becomes a false accusation; too wide and a real
deviation costs a review instead of a failure. The second error is much cheaper than the first.

**3. Which crop detector, given the concurrency conflict?**
§8.2 finds a real conflict: a model-reported bounding box cannot arrive before the model call
finishes, which breaks PRD §3.8's "OCR runs concurrently". *Recommendation:* classical detection
(option C) as primary, band search (option B) as fallback, single-channel as the final fallback.
*Cost of choosing wrong:* choosing the model-reported box costs about 0.5 s on the critical path of
every label and puts TH-R2's 5-second promise at risk for no accuracy gain we have measured.

**4. Leave `WarningComparatorResult`'s union as merged?**
§6.2 finds two names the union cannot return: `CONFLICTING_EXTRACTION` (PRD §3.7 uses it for
channel disagreement) and `LOW_MODEL_CONFIDENCE` (golden cases 23 and 24 expect it).
*Recommendation:* leave the type alone. Route channel disagreement as `WARNING_MISMATCH`, keep the
ladder's telemetry label separate from the routed reason, and change the two golden cases to
`LOW_IMAGE_QUALITY`. *Cost of choosing wrong:* widening the union weakens the property that makes it
useful — that a review outcome must name a reason the router already knows how to display.

**5. One bold flag or two?**
§2.5 found that 16.22(a)(2) carries two bold rules — the prefix must be bold, the remainder must
not be — and the schema has one flag. *Recommendation:* keep one flag for the prototype and name
the second rule explicitly as unchecked in §7.3's limitation paragraph. *Cost of choosing wrong:*
adding a second flag implies we check something we do not; omitting the sentence from the docs lets
"bold detection attempted" read as a claim we cover both.

**6. Should the OCR crop skip the JPEG re-encode?**
§8.3 notes `OUTPUT_MEDIA_TYPE = "image/jpeg"` applies to every pipeline output, including the
warning crop. Tesseract is not an API and needs no re-encode. *Recommendation:* hand tesseract raw
pixels or PNG; leave the JPEG constant alone for the API-bound variants. *Cost of choosing wrong:*
lossy compression artifacts land on exactly the 1–3 mm print the OCR channel exists to read, which
would show up as a raised suspect rate and could trigger a model upgrade the ladder should not have
recommended.

**7. Is 60/100 the right OCR confidence floor?**
§4.5 discards an OCR candidate below Tesseract's mean text confidence of 60. **proposed**, not
measured. *Recommendation:* keep 60 as a starting value and let LH-030 sweep it against the golden
set, exactly as CP-1 §4.5 sweeps the model confidence thresholds. *Cost of choosing wrong:* set too
high and we lose the second channel on ordinary labels, which pushes everything down the
single-channel path; set too low and garbage OCR manufactures disagreements and inflates the
suspect rate.

**8. Store the canonical text as two statements or one string?**
§2.4 found the CFR renders two paragraphs. *Recommendation:* store a two-element constant and derive
the joined string, so the structure matches the source and the join is a named, testable rule.
*Cost of choosing wrong:* a single 283-character literal hides the join as an assumption, and it
makes the eCFR fixture harder to assert against.

**9. Add a near-miss golden case?**
§9.2 finding 4: the proposed band has no covering case. *Recommendation:* add one — the canonical
text with a single character changed, expecting REVIEW. It is one renderer parameter.
*Cost of choosing wrong:* the band ships with reasoning and no evidence, which is exactly the thing
this project promised not to do.

**10. Should a single channel ever be allowed to PASS?**
§4.5 allows it at model confidence ≥ 0.90. Q7 names this as the residual false-PASS path.
*Recommendation:* keep it for the prototype, and report the single-channel rate on the stats page so
the exposure is visible rather than assumed. *Cost of choosing wrong:* forbidding it turns every
crop-detection failure into a human review, which could be a large throughput cost we have not
measured; allowing it leaves the one path by which a model reciting the statute from memory can
produce a PASS.

---

## 12. What this document does not decide

Named here so nobody assumes coverage that is not there.

- **The warning region detector's implementation.** §8.2 recommends an approach and names the
  conflict. LH-020 builds it and measures it.
- **Any threshold as a final value.** The 0.90 model confidence floor, the 60/100 OCR floor, and
  the distance-2 band are all **proposed**. LH-030's sweep replaces them with measured values.
- **The verify screen and the expected-versus-detected diff view.** LH-015 and LH-021 own the UI.
  This document supplies the reason strings, not the screen.
- **Bold detection.** Explicitly out of scope, with the limitation wording drafted in §7.3.
- **Any physical measurement from § 16.22** — type size, characters per inch, compression,
  contrasting background. §2.5 explains why a photograph cannot supply the scale.
- **Whether the golden-set images look realistic.** No images exist. §9.3 says so plainly.
- **Batch behaviour of the warning subsystem.** CP-3 owns the queue.

---

## Appendix A — walkthrough checklist

Tick these during the session. The checkpoint is not covered until all of them are.

- [ ] **The canonical text.** Read §2.2 and §2.3. Confirm the source, the retrieval date, and the
      byte-identical result against PRD §3.4. Confirm the two-paragraph finding in §2.4.
- [ ] **The regulation's four rules.** Read §2.5's table. Confirm which two LabelHunter enforces
      and which two it does not.
- [ ] **The dual path.** Read §4.1 and §4.5. Confirm the reconciliation table, and confirm that a
      single channel never produces a FAIL.
- [ ] **The normalization rules.** Read §5.1's one-sentence test, then §5.2 and §5.3. For each
      absent rule, say out loud why it is absent.
- [ ] **The case asymmetry.** Read §5.4's edit-distance table. Confirm that the caps check is what
      catches Jenny's case, and that it must run before case folding.
- [ ] **The verdict mapping.** Read §6.1. Confirm every row maps onto a real
      `WarningComparatorResult` branch, and confirm the two names the union cannot return.
- [ ] **The bold limitation.** Read §7.3's paragraph as written. Confirm it is the wording
      `docs/approach.md` and the README will reuse verbatim.
- [ ] **The ladder.** Read §8.4. Say the suspect-rate definition and its denominator out loud.
- [ ] **The golden set.** Read §9.1 and §9.2. Decide the four findings. Confirm that CP-2 signs off
      on specifications, not images, and that no image exists yet.
- [ ] Run the Q&A in §10. Note any question that did not have a good answer.
- [ ] Decide the ten open questions in §11.
- [ ] Say the words. Acknowledgment unblocks LH-020 and LH-021. Silence does not.

---

## Appendix B — retrieval log

Every claim marked **verified** in this document comes from one of these commands, run on
**2026-08-11**. Re-run them to check the claims.

**S1 — the statutory statement, 27 CFR 16.21.** Title 27's latest issue date was `2026-07-06`; the
eCFR API rejects a future date, so the issue date is explicit rather than "today".

```bash
curl -sS "https://www.ecfr.gov/api/versioner/v1/titles.json" \
  | python3 -c "import sys,json;print([t for t in json.load(sys.stdin)['titles'] if t['number']==27])"

curl -sS "https://www.ecfr.gov/api/versioner/v1/full/2026-07-06/title-27.xml?part=16&section=16.21"
```

The `<EXTRACT>` element holds two `<P>` elements — statement (1) and statement (2).

**S2 — the typography rules, 27 CFR 16.22.**

```bash
curl -sS "https://www.ecfr.gov/api/versioner/v1/full/2026-07-06/title-27.xml?part=16"
```

**S3–S5 — ttb.gov corroboration.** All three carry a byte-identical statement.

```text
https://www.ttb.gov/regulated-commodities/beverage-alcohol/distilled-spirits/ds-labeling-home/ds-health-warning
https://www.ttb.gov/regulated-commodities/beverage-alcohol/beer/labeling/malt-beverage-health-warning
https://www.ttb.gov/regulated-commodities/beverage-alcohol/wine/labeling-wine/wine-labeling-health-warning-statement
```

**The byte comparison against PRD §3.4.** Extract the candidate from the PRD, unwrap its Markdown
line breaks, and compare bytes and SHA-256 against the eCFR text. Both are 283 characters and both
hash to `35e1f5d39ee341ac7c114f8159956cb0cc1981b94e4ffeee194ff5060bf99fbc`. The equality check
returned true and the character-level diff returned no operations.

**tesseract.js package facts.**

```bash
curl -sS "https://registry.npmjs.org/tesseract.js"        # version 7.0.0, Apache-2.0, published 2025-12-15
curl -sS "https://registry.npmjs.org/tesseract.js-core"   # Apache-2.0, ~30 MB unpacked
curl -sS "https://raw.githubusercontent.com/naptha/tesseract.js/master/src/worker-script/index.js"
curl -sS "https://raw.githubusercontent.com/naptha/tesseract.js/master/src/worker-script/utils/dump.js"
curl -sS "https://raw.githubusercontent.com/naptha/tesseract.js/master/src/worker-script/constants/defaultOutput.js"
```

`worker-script/index.js` carries the default CDN path for language data. `dump.js` shows
`confidence` comes from `MeanTextConf()`. `defaultOutput.js` shows `blocks: false` is the default.

**The edit distances in §5.4.** Computed over `golden-set/manifest.json`'s own
`label.governmentWarningText` strings, with the §5.2 normalization applied and standard Levenshtein
distance. This is arithmetic over committed ground truth, not a model run — it is **derived**, not
measured. LH-020 should carry it as a test so the margin cannot drift silently.
