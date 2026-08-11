# Changes

Per-ticket changelog. Every factory PR adds an entry at the top naming its ticket ID(s):
what changed, how to run it, how to roll it back. The gate greps for the ticket ID with
anchored boundaries — `TRO-30` will not match inside `TRO-301`.

## TRO-505 — golden renderer fonts: embedded, not system (2026-08-11)

**What changed.** `scripts/golden/render.ts` used three system-font stacks: Helvetica/Arial,
plus generic `cursive`/`fantasy` fallbacks for the two odd-typography cases. Those generic
fallbacks named no real font file, only a category. A different OS could substitute a
different real font for each category. `render.ts`'s own KNOWN LIMITATION comment named this
OS-font-substitution risk directly. Design doc §2 says fonts must be committed to the repo.
`render.ts` now embeds every font instead, removing the substitution risk entirely. TH-R17
grades correctness. An unrepeatable render pipeline is a correctness problem, not a cosmetic
one.

Every font is now a pinned npm package. `render.ts` reads each font's real WOFF2 file and
embeds it as a base64 `data:` URI inside a `@font-face` block. Chromium never asks the host OS
for a font substitution. `pnpm-lock.yaml` pins the exact bytes, the same way it pins every
other dependency.

The maintainers checked each font's license two ways: against the package's own
`package.json` `license` field, and against the actual `LICENSE` file text each package ships.
Both checks confirmed SIL Open Font License 1.1 for every font. Neither check relied on the
metadata field alone.

- **Inter** provides the base sans-serif for brand, class/type, content, and warning text. It
  carries an OFL-1.1 license. `render.ts` gets it from `@fontsource/inter` version 5.3.0.
  `render.ts` embeds three weights: 400, 500, and 700.
- **Dancing Script** renders the script-style "odd typography" brand case, case-25. It carries
  an OFL-1.1 license. `render.ts` gets it from `@fontsource/dancing-script` version 5.3.0.
  `render.ts` embeds its weight-700 cut.
- **UnifrakturMaguntia** renders the blackletter "odd typography" class/type case, case-26. It
  carries an OFL-1.1 license. `render.ts` gets it from `@fontsource/unifrakturmaguntia` version
  5.3.0. `render.ts` embeds its weight-400 cut, the font's only static weight. `render.ts`
  already named this exact font as a system-font fallback before this ticket. It turns out to
  ship as its own installable, OFL-licensed package. The maintainers checked that fact before
  they looked for an alternative font.

Case-26's class/type now renders at font-weight 400, not the usual 500. UnifrakturMaguntia
ships only one weight. Requesting weight 500 against a single-weight font would make Chromium
synthesize a bold cut on its own. A synthesized cut changes glyph metrics. Nothing in
`render.ts` requests that change. Rendering at the font's real weight keeps the glyph metrics
exactly what the vendored file ships. All three font packages are `devDependencies`. They are
build-time tooling for `scripts/golden/` only — the same category as `@playwright/test` and
`tsx`. The running app never imports them.

`SCRIPT_FONT_STACK` and `BLACKLETTER_FONT_STACK` fall back to `"Inter"`, not to the generic
`cursive`/`fantasy` categories. `Inter` is embedded too, so even the fallback path stays
file-embedded. A future regression that broke the Dancing Script or UnifrakturMaguntia
`@font-face` rule would degrade to Inter, not silently back to an OS-dependent font.

**Re-rendered the golden set.** `pnpm golden:build` re-rendered all 29 committed images. Total
size is 1,126,682 bytes, or 1100.3 KB. Before this ticket, the total was 1,104,318 bytes, or
1078.4 KB. Real font metrics differ slightly from the OS's previously-substituted ones. That
difference explains the size change. JPEG quality stayed at 82 with mozjpeg, unchanged from
before. Every image stays well under the ~500 KB-per-image target. `git diff --stat` against
the previous commit confirms both totals directly, file by file.

The maintainers spot-checked several images by eye: case-01 (clean baseline), case-14 (the
`STONE'S THROW` apostrophe), case-17 (glare), case-20 (severe rotation plus blur), case-23 and
case-24 (tiny warning text), and case-25 and case-26 (the two odd-typography cases). Text stays
inside its `LABEL_REGIONS` box in every one. Nothing overflows or truncates. The blackletter and
script faces render real glyphs, not placeholder boxes.

**Determinism, verified on this machine.** The maintainers ran `pnpm golden:build` twice. Each
run launches a fresh Chromium process (`createLabelRenderer` in `build.ts`'s `main`). All 29
output images were byte-identical across both runs. `cmp` confirmed this on every file, not
just a file count. The maintainers did not verify cross-machine determinism. This sandbox is
one machine. The honest claim is this: the renderer no longer depends on OS font substitution,
by construction. Every font is file-embedded now, not system-referenced. "Verified
cross-machine" would overstate what the maintainers actually checked.

**Tests.** `scripts/golden/render.test.ts` gained a new block: `buildLabelHtml font embedding
(TRO-505)`. It holds three tests:
- The first test confirms the rendered HTML embeds each of the five real `@fontsource` files'
  exact bytes as a base64 `data:` URI. It reads those files itself, independent of
  `render.ts`'s own `fontFileDataUri` helper. A wrong path or a stale encoding in `render.ts`
  would still fail it.
- The second test confirms the rendered HTML never references any of the five pre-TRO-505
  system-font names: Helvetica Neue, Brush Script MT, Apple Chancery, Snell Roundhand, and
  Blackletter.
- The third test confirms the rendered HTML never falls back to the generic `cursive` or
  `fantasy` families, checked across all 29 rendered cases, not just the two odd-typography
  ones.

The maintainers confirmed all three tests red-first. They checked out the pre-fix `render.ts`
from `HEAD` each time. They ran the relevant test against that old file. They restored the new
file afterward. The embedding test failed on a missing Inter data URI. The no-system-font test
failed because `"Helvetica Neue"` was present. The no-generic-fallback test failed because
`"cursive"` was present for case-25. Every one failed for the reason TRO-505 exists to fix, not
an import error or a typo.

The existing Chromium determinism suite (`describe("renderLabelImage determinism", ...)`)
gained a third case. Before this ticket, its two independent-browser-instance tests only
exercised case-01. That case only uses plain Inter, the base font path. The new test renders
case-25 and case-26. Those are the two cases that load the Dancing Script and
UnifrakturMaguntia `@font-face` rules. Each case renders across two independent browser
instances. Both produced byte-identical decoded pixels, the same result as case-01.

**How to run it.** Source `.factory-env` first, per this repo's standing convention. `pnpm
golden:build` regenerates every image from the current manifest. `pnpm test -- scripts/golden`
runs every test file under `scripts/golden/`. `render.test.ts` now holds 12 tests, up from 8
before this ticket. `degrade.test.ts` holds 21 tests, unchanged by this ticket. All pass.

**Rollback.** `git revert` this ticket's commit(s). Reverting restores the three system-font
stacks and removes the three `@fontsource/*` devDependencies from `package.json`. Run `pnpm
install` and then `pnpm golden:build` again after a revert. The 29 committed images are pixel
data, not source. They need a fresh render to match the reverted code.

**Review triage.** Four local CodeRabbit rounds against this ticket's own commits, five real
findings fixed, one dismissed:
- Round 1 (major, `CHANGES.md`): the entry's font and license bullets were sentence
  fragments — no explicit subject or verb. Fixed with a full ASD-STE100 rewrite, same facts,
  complete sentences.
- Round 2 (major, `scripts/golden/render.ts`): `SCRIPT_FONT_STACK` and `BLACKLETTER_FONT_STACK`
  still fell back to the OS-dependent generic `cursive`/`fantasy` categories. Fixed above.
- Round 2 (trivial, `CHANGES.md`): "this gap"/"that gap" read as abstract backreferences.
  Fixed: named the concrete risk directly instead.
- Round 3 (major, `CHANGES.md`): repeated "this ticket" as the subject of many sentences read
  as an abstract, repetitive actor. Fixed: named the concrete actor instead — `render.ts`,
  `pnpm golden:build`, the maintainers, or TRO-505 by ticket ID.
- Round 4 (major, `CHANGES.md`): a repeated finding asked the "How to run it" section to show
  `DATABASE_URL` discipline for `pnpm test -- scripts/golden`, this time asking explicitly for
  no documented exception. Round 3 checked this command directly — with `DATABASE_URL` and
  every other secret unset from the environment entirely, all 45 tests across
  `render.test.ts`, `degrade.test.ts`, and `images.test.ts` passed, because none of the three
  files or the global `vitest.setup.ts` touch a database. That check still stands and is not
  retracted. Round 4 fixed the documentation anyway: "How to run it" now leads with sourcing
  `.factory-env`, this repo's own standing convention (CLAUDE.md, lessons.md rule 3),
  regardless of whether this specific command strictly needs it.
- Round 4 (minor, `scripts/golden/render.test.ts`): the "never references a pre-TRO-505 system
  font" test only checked `renderableCases[0]` (case-01). Case-01 never triggers the
  script/blackletter overrides, so it could never have caught `"Brush Script MT"`
  (`SCRIPT_FONT_STACK`'s original fallback) inside case-25's own rendered HTML specifically.
  Fixed: the test now checks every rendered case. Confirmed red-first against the true
  pre-TRO-505 `render.ts` (checked out from before this ticket's first commit).
- Round 4 (major, `CHANGES.md`), dismissed: a finding asked the "What changed" opening
  paragraph to split into more granular sub-topics (font-stack history, substitution risk,
  design requirement, implementation change, TH-R17 impact) than its current eight short
  sentences already do. That paragraph already gives each sentence one claim, an explicit
  subject, and an active verb — every concrete rule in CLAUDE.md's ASD-STE100 table. Further
  fragmentation past that point is a stylistic preference beyond what this repo's own written
  standard requires, and a fourth rewrite of the same paragraph risks introducing a new defect
  for undefined benefit — round 1's fix introduced round 2's finding; round 2's fix left
  round 3's finding. This entry stops chasing paraphrase-level suggestions here.

**Not done here (explicitly out of scope).** LH-006 plans a CI smoke test: render one label
headlessly, then run `verify.ts`. TRO-505 does not build that test. TRO-505 only removes the
font-determinism blocker LH-006 was waiting on. `verify.ts` itself is still LH-006's job.

## TRO-497 — PR review round 4: local CodeRabbit pass, 4 fixed, 1 dismissed (2026-08-11)

**What changed.** A fresh local CodeRabbit pass posted 5 findings against the round-3 fix
commit. Four are real; this entry fixes all four. One restates round 2's already-deferred
`Degradation.params` discriminated-union item. Dismissed again; no code change.

Fixed:
- `scripts/golden/build.ts:11` (minor): the header's determinism claim was unqualified. Fixed:
  scoped to "one machine with one toolchain," and pointed at `render.ts`'s system-font
  substitution known limitation.
- `golden-set/README.md:31` (major): the LH-005 paragraph read as dense prose. Fixed: ASD-STE100
  rewrite into short, one-fact sentences. Every fact stays — LH-005 ownership, the Gemini API
  call, the image's current absence, the required `verified: true` sign-off, the loader's
  schema-only check, and `images.test.ts`'s existence check.
- `CHANGES.md:9` (major): the round-three summary combined several facts per sentence. Fixed:
  ASD-STE100 rewrite into short, single-fact sentences. Every count and detail stays.
- `src/lib/golden-set/loader.ts:244` (major): `checkDegradations` accepted a `glare` or
  `low-light` entry after a `rotate` or `perspective` entry. `degrade.ts`'s
  `assertMatchesOriginalCanvas` already refuses that same order at build time — a geometric
  transform changes the canvas, so `LABEL_REGIONS`'s coordinates go stale. Fixed: the same
  order check now runs at spec-validation time. New red-first tests cover a 180-degree rotate
  followed by `glare` and by `low-light`, and a `perspective` entry followed by `glare`. The
  committed manifest has no case that breaks the new rule — confirmed by
  `loadGoldenSetManifest`'s own test, which loads and validates the real file.

Dismissed:
- `src/lib/golden-set/types.ts:130` (minor): replace `Degradation.params` with a discriminated
  union keyed by `DegradationType`. Round 2 already deferred this same item as a bigger refactor
  across `types.ts`, `loader.ts`, and `degrade.ts`'s dispatcher. Still true; no code change here.

**Tests added this round.** `loader.test.ts`: three new rejection cases for the degradation
order rule (rotate-then-glare, rotate-then-low-light, perspective-then-glare), and one new
acceptance case (glare-then-rotate). Two pre-existing tests changed their fixture's
degradation order to stay valid under the new rule; their assertions did not change.

**How to run it.** `pnpm test`, `pnpm typecheck`, `pnpm lint`.

**Rollback.** `git revert` this commit.

## TRO-497 — PR review round 3: GitHub PR #9, 11 fixed, 2 dismissed (2026-08-11)

**What changed.** CodeRabbit reviewed PR #9's live GitHub diff, not the local round-1/round-2
passes. That review posted 13 comments. Eleven were real; this entry fixes all eleven. Two
are dismissed. One restates a finding this entry already fixes, under a different comment.
CodeRabbit's own severity tag calls the other one "Low value" — it is a test refactor, not a
bug.

Fixed — documentation and ground truth:
- `CHANGES.md:10` (minor): round 2's own header claimed "5 fixed, 3 deferred." Its breakdown
  listed something different: six real fixes bundled into five bullets, one stale finding, two
  deferred findings, and one dismissed prose complaint mislabeled "deferred." Round 1's own
  CodeRabbit-triage section had the same kind of mismatch — it fell three lines short of its
  claimed "3 deferred." Fixed: both headers and their "Deferred" lists now match what each
  entry enumerates.
- `CHANGES.md:220` (minor): the "How to run it" line said "same spec in, same pixels out." That
  is an unqualified determinism claim. `render.ts`'s font stacks name system fonts, not files
  committed to the repo — this same changelog entry already states that fact 30 lines earlier.
  Fixed: the claim now says "on one machine" and points at the font-substitution caveat.
- `golden-set/manifest.json:1165` (minor): case-20's `description` and `notes` named only the
  upside-down rotation. Its `degradations` list also applies an 18-sigma blur, and its `V9`
  vector maps to "blurry/unreadable" specifically because of that blur. Fixed: both fields now
  name the blur.
- `golden-set/README.md:38` (major): the LH-005 section said the loader "rejects a
  `verified: true` `ai-generated` case" — backwards. `loader.ts` line 494 rejects
  `verified !== true`; it requires `true`, not rejects it. Fixed: swapped `true` for `false`.
- `golden-set/README.md:70` (minor): the `degradations` field's parenthetical named three of
  the five `DegradationType` values (glare, rotation, low light), reading as if `blur` and
  `perspective` were unsupported. Fixed: named all five.
- `golden-set/README.md:87` (minor): the naming convention permitted `.png` for any case, but
  `build.ts` always JPEG-encodes a `rendered`/`rendered+degraded` case — a `.png` path there
  would hold JPEG bytes under a PNG name, undetected. Fixed: scoped `.png` to a future
  `ai-generated` case (LH-005), whose image comes straight from Imagen, not `build.ts`'s encode
  step.
- `scripts/golden/images.test.ts:8` (minor): the file header claimed its tests confirm a
  degraded case's `degradations` entry "matches what `degrade.ts` actually applied when
  `build.ts` produced the committed image." The tests compare the manifest against hardcoded
  literals; none reads the committed image bytes or calls `degrade.ts`. Fixed: the header now
  states what the tests check, and names the real gap — a manifest edit without a
  `pnpm golden:build` rerun goes uncaught here.

Fixed — code:
- `scripts/golden/build.ts:76` (trivial): the JPEG encode had no explicit `.flatten()` call.
  sharp's JPEG encoder composites alpha over black by default; the pipeline avoids that today
  only because `render.ts` paints an opaque white body and `applyRotate`/`applyPerspective` fill
  new corners white — an invariant spanning three files, enforced nowhere. Fixed: added
  `.flatten({ background: "#ffffff" })` before the JPEG encode, the same call `pipeline.ts` uses
  for the same reason. A no-op on today's fully opaque images — confirmed by rebuild: all 29
  committed images stayed byte-identical.
- `scripts/golden/render.ts:203` (minor): `.classType` and both `.divider` elements hardcoded
  pixel positions (`210`, `90`, `310`, `500`) that must stay in sync with `LABEL_REGIONS` by
  hand. `degrade.ts` crops by `LABEL_REGIONS`; a future edit to one side without the other would
  move painted pixels without moving the crop — the same silent-wrong-pixels risk round 2's
  `assertMatchesOriginalCanvas` fix closed for `applyGlare`/`applyLowLight`. Fixed: the four
  literals now derive from `LABEL_REGIONS` plus three named gap constants
  (`CLASS_TYPE_GAP_PX`, `CONTENT_DIVIDER_GAP_PX`, `WARNING_DIVIDER_GAP_PX`), reproducing today's
  exact values. Confirmed by rebuild: byte-identical to before.
- `scripts/golden/degrade.test.ts:235` (trivial): no test asserted `applyDegradation`'s
  documented determinism claim — that the same input and params always produce the same output
  bytes. `applyGlare` rasterizes an SVG through librsvg, the transform most likely to vary.
  Fixed: a new test calls each of the five types twice on the same input and asserts byte
  equality.
- `scripts/golden/render.test.ts:142` (trivial): the one determinism test reused a single
  `renderer.page` for both renders, proving determinism only within one Chromium process.
  `pnpm golden:build` launches a fresh browser every run (`createLabelRenderer` in `build.ts`'s
  `main`). Fixed: a second test renders the same case from an independent
  `createLabelRenderer()` call and compares decoded pixels.

Dismissed:
- `scripts/golden/render.test.ts:1` — a rollup comment restating the same two gaps
  `degrade.test.ts:235` and `render.test.ts:142` already name individually (both fixed above).
  Duplicate, not a separate finding.
- `src/lib/golden-set/loader.test.ts:267` — extract six tests' repeated throw/catch block into a
  shared helper. CodeRabbit's own severity tag on this finding is "Low value." No correctness or
  coverage gap; skipped to avoid churn against six passing tests — CLAUDE.md's simplicity rule
  governs prose Claude writes, not restructuring code "for its own sake."

**Tests added this round.** `degrade.test.ts`: one new case, byte-equality for all five
degradation types called twice. `render.test.ts`: one new case, decoded-pixel equality across
two independent `createLabelRenderer()` calls.

**How to run it.** `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Rebuilt with
`pnpm golden:build` after the `build.ts`/`render.ts` changes — all 29 committed images matched
their prior byte counts exactly (1,104,318 bytes total), confirming no rendered pixel changed.

**Rollback.** `git revert` this commit. The pipeline works without it; these are documentation
corrections and hardening, not new features.

## TRO-497 — PR review round 2: 6 fixed, 2 deferred (2026-08-11)

**What changed.** A second gate run triggered a fresh CodeRabbit pass against round 1's fix
commit. It found 10 findings. Six were real defects. The five bullets below fix all six — one
bullet fixes two findings in the same file. One finding restated work round 1 already did:
stale, no action needed. Two findings are real but deferred, not fixed here. One finding is
addressed by explanation below, not by a code change — it is neither a fix nor a deferral.

- `degrade.ts` (major): `applyGlare` and `applyLowLight` trusted `LABEL_REGIONS`'s fixed
  coordinates. Those coordinates are only correct against the original, unrotated canvas. A
  degradations list that ran a geometric transform (`rotate`, `perspective`) before a
  region-targeted one (`glare`, `low-light`) would silently glare or dim the wrong pixels. No
  committed case does this today, but a future one could. Fixed: `assertMatchesOriginalCanvas`
  checks the input image's real decoded size before either function runs, and throws a clear
  `RangeError` on a mismatch instead of silently misplacing the effect. New tests: apply each
  function to an already-rotated image, confirm it throws.
- `loader.ts` (major): `DEGRADATION_PARAM_SHAPE` checked only each type's required params. It
  never checked glare's optional `angleDegrees`/`opacity` when present, and never rejected a
  param a transform does not use at all — for example, a `rotate` entry that also carried a
  stray `sigma`. Fixed: the shape table now has a `required` and an `optional` part per type,
  every optional key is type-checked when present, and any key outside both sets fails
  validation. New tests for all three cases.
- `build.ts` (major): `imagePath` came straight from the manifest into `join(REPO_ROOT, ...)`.
  The loader already checks `imagePath` starts with the literal string
  `"golden-set/images/"`, but that is a string-prefix check — it would not catch a value like
  `"golden-set/images/../../etc/passwd"`, which starts with that same prefix as plain text.
  Fixed: `resolveImagePath` resolves the real path and confirms it stays inside
  `golden-set/images/` before any write. The manifest is a committed, reviewed file, not
  runtime input, so this is defense in depth, not a response to an active threat.
- `images.test.ts` (minor): the existence check confirmed a file was present and non-empty,
  never that it decoded as an actual JPEG. Fixed: a new test decodes every committed image
  with sharp and asserts `metadata.format === "jpeg"`.
- `golden-set/README.md` (minor + major): "May be empty." lost its subject — changed to "The
  list may be empty." The LH-005 section did not say an `ai-generated` case's image and its
  `verified: true` flag must land in the same manifest change — added that sentence, and named
  which test starts failing if they don't (`images.test.ts`).

One finding restated "commit the missing image assets" — already done in round 1's commit;
stale against the current tree, no action needed.

Two findings are deferred, not fixed here:
- Replacing `Degradation.params: Record<string, number | string>` with a discriminated union
  keyed by `DegradationType`. The shape validation added in round 1, tightened further above,
  already closes the practical gap. The type-level version is a bigger refactor across
  `types.ts`, `loader.ts`, and `degrade.ts`'s dispatcher — better as its own change.
- `render.ts`'s font stacks name system fonts, not fonts committed to the repo, which design
  doc §2 calls for. Documented as a known limitation directly in `render.ts`'s module comment,
  with the exact practical consequence (same-machine determinism holds; cross-machine font
  substitution could differ). Not fixed here — sourcing and license-checking real font files
  is a real task, and rushing a font choice risks a license problem worse than the gap it
  closes.

**Dismissed, not deferred.** A tenth finding argued this changelog entry (round 1's) was still
too dense. Round 1 already applied one real ASD-STE100 pass (see that entry's own note). This
round adds five more short, single-fact paragraphs rather than a second full rewrite of round
1's text — further compressing already-compressed technical detail risks losing precision for
its own sake, which CLAUDE.md's writing-style section warns against directly.

**Tests added this round.** `degrade.test.ts`: two new "rejects an already-transformed image"
cases (glare, low-light). `loader.test.ts`: four new cases for the closed degradation-params
schema (accepts glare's optional params when well-typed, rejects a wrong-typed optional param,
rejects an unrecognized param). `images.test.ts`: one new case for the decoded-JPEG check.

**How to run it.** Same as round 1: `pnpm golden:build`, `pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm build`. Re-ran `pnpm golden:build` after these fixes — every image's byte
count matched round 1's exactly, confirming the fixes changed no rendered pixel.

**Rollback.** `git revert` this commit. Round 1's pipeline still works without it; these are
hardening fixes, not new features.

## TRO-497 — LH-004: golden-set degradation pass, plus the renderer LH-003 deferred (2026-08-11)

**Scope note.** This ticket's stated job was the degradation pass. LH-003 (TRO-458, Done)
shipped the spec schema, the manifest, and the loader. LH-003 did not ship `render.ts`. Its
own CHANGES.md entry says so directly: "the renderer itself... `golden-set/images/` is still
empty." A degradation pass needs a clean base image to degrade. No clean base existed. The
orchestrator approved building the renderer here, as a prerequisite of this ticket, on this
branch — not as a separate ticket. Both pieces follow below.

**What changed.** `golden-set/images/` now holds a real, committed JPEG for every `rendered`
or `rendered+degraded` case. That is 29 of 29 — every case that currently exists in the
manifest. Total size: 1,104,318 bytes (1078 KB). Largest file: 46,719 bytes (case-19).
Smallest file: 9,365 bytes (case-20). Every image stays well under the ticket's ~500 KB
target. No `ai-generated` case exists in the manifest yet — that provenance is LH-005's job.
This ticket leaves that path imageless; a scoped test checks for exactly that, per plan.

- **`scripts/golden/render.ts`** — the renderer. `buildLabelHtml` is a pure function. Given a
  case's `label` ground truth, it builds an HTML/CSS document. The document draws the brand,
  class/type, ABV line, net contents, and government warning verbatim. Whatever string the
  spec carries is the string in the HTML, byte for byte — design doc §1's core rule: no image
  model is ever trusted with the warning text. `renderLabelImage` screenshots that HTML with
  Playwright's bundled Chromium. Chromium is already a repo dependency, for `pnpm test:e2e` —
  no new dependency. The HTML is fully inline, so this makes no network call. `LABEL_REGIONS`
  names four pixel rectangles (`brand`, `front`, `content`, `warning`); `degrade.ts` targets
  each region by name. Two categories bake their "imperfection" into the render itself, not a
  post-process transform: tiny warning text (case-23/24) and an unusual brand/class-type font
  (case-25/26). Both are print choices, not photo conditions. `CASE_STYLE_OVERRIDES`
  (`render.ts:105`) is keyed by exact `caseId`, never a substring match.
- **`scripts/golden/degrade.ts`** — five transforms per design doc §4: `applyRotate`,
  `applyBlur`, `applyPerspective`, `applyGlare`, `applyLowLight`. `applyDegradation` is the
  one dispatcher `build.ts` calls. It reads a manifest case's `degradations` list, so that
  list stays the single source of truth for what happened to a case's pixels. Every numeric or
  region parameter is validated before it reaches sharp — finite, in-range, a real region name
  (CLAUDE.md rule 13). `degrade.test.ts`'s "rejects ..." tests are red-first against that
  validation: each one checks a specific bad input throws, not just that something throws.
  `applyPerspective` approximates a keystone camera angle with a 2D affine shear. sharp has no
  true 4-corner projective warp; a real one needs a per-pixel remap, and this repo has no
  dependency for that — not worth adding one for a synthetic test fixture. No committed case
  uses `applyPerspective` yet. It is implemented and unit-tested as a design-doc-§4 capability,
  ready for the next case that needs it.
- **`scripts/golden/build.ts`** — orchestrates render → degrade → JPEG-encode (mozjpeg,
  quality 82) → write, for every non-`ai-generated` case. Run with `pnpm golden:build`.
- **`golden-set/manifest.json`** — six cases gained a `degradations` entry recording the exact
  parameters `build.ts` used:
  - case-17: glare on the `brand` region.
  - case-18: glare on the `warning` region.
  - case-19: a mild, correctable 15° rotation.
  - case-20: a 180° rotation plus an 18-sigma blur — direct evidence for rubric V9's
    "blurry/unreadable," not rotation alone. The case's own note says no field should read
    confidently; the added blur backs that up.
  - case-21: low light on the `front` region.
  - case-22: low light on the `warning` region.

  Cases 23–26 (tiny text, odd typography) and every clean `rendered` case carry no
  `degradations`. Their imperfection, if any, is render-time — never a `degrade.ts` transform.
- **`src/lib/golden-set/types.ts`, `loader.ts`** — added `DegradationType` and `Degradation`.
  Design doc §3 named this `degradations` field; LH-003 never implemented it. Added the
  loader's matching validation: the field is optional, each entry's `type` must be a known
  transform, and each transform's required `params` keys must be present with the right type
  (see the review-triage note below for the two checks added after CodeRabbit's first pass).
  New `loader.test.ts` cases cover both the accept and reject paths. The manifest's shape
  changed. The loader still accepts it — "loader stays green," per this ticket's brief.
- **`vitest.config.ts`** — widened `include` to also match `scripts/**/*.test.ts`. This
  ticket's tests now run inside `pnpm test`, the one unit vitest run — not a separate suite.
- **`package.json`** — added the `golden:build` script.
- **`golden-set/README.md`** — replaced the "no images yet" section. It now states what
  exists (the three-script pipeline, image sizes) and what still doesn't (LH-005's
  `ai-generated` wild labels, LH-006's `verify.ts`). Left `verified: false` on every case
  alone. `verified` records a **human** sign-off (design doc §3); CP-2 review is where that
  happens, not this ticket.

**A real tool quirk found while writing tests, not a `degrade.ts` bug.** Chaining
`sharp(image).extract(region).stats()` in one pipeline silently returns whole-image
statistics. It ignores the extract (sharp 0.35.3 / vips 8.18.3, this machine). A minimal
repro confirmed it: a 100×100 white canvas with one 10×10 black corner. `.extract().stats()`
reported the *same* mean for the black corner, a white corner, and the full image.
Materializing the extract into its own buffer first fixes it — `.extract(region).toBuffer()`,
then `sharp(thatBuffer).stats()` — and gives the correct, expected numbers. `degrade.ts`
itself never calls `.stats()`. It chains `.extract()` straight into
`.modulate()`/`.composite()` and `.toBuffer()`, which materializes correctly regardless. So
this was a test-helper bug, not a production one. `degrade.test.ts`'s `meanBrightness` helper
documents the finding and the fix.

**CodeRabbit review triage.** Round 1's local CodeRabbit pass raised 10 findings against the
initial commit. Five were real defects, fixed below. One was already correct by design. One is
deferred. Two more are STE100 prose critiques resolved by an in-place rewrite, not by a
deferral — see the note after the deferred item.

Fixed:
- `loader.ts` (major): `checkDegradations` checked that `params` was an object but never that
  it held the right keys. Fixed: a `DEGRADATION_PARAM_SHAPE` table checks each transform's
  required params are present with the right primitive type (`angleDegrees`/`sigma`/`shear`/
  `brightnessFactor` numeric, `region` a string). Range checks stay in `degrade.ts`, the
  schema of record for those.
- `loader.ts` / `checkCase` (major): a `rendered` case could carry a non-empty `degradations`
  list — self-contradictory, since "rendered" means clean. Fixed: the loader now rejects a
  non-empty `degradations` list unless `provenance` is `rendered+degraded`.
- `degrade.ts` (major): `applyPerspective` checked `shear` was finite but never bounded it.
  Fixed: rejects `|shear| > 3` (`MAX_SHEAR_MAGNITUDE`), with tests at and past the bound.
- `render.test.ts` (minor): the "omits the ABV line" test only checked that net-contents text
  appeared somewhere in the HTML — it would not have caught a stray empty ABV line. Fixed per
  CodeRabbit's own suggested diff: count `.line` divs directly, assert exactly one, holding
  net contents.
- `images.test.ts` (major): the ai-generated existence test only checked one direction
  (unverified + no image). Fixed: now checks both directions — a verified case must have a
  real image, and an imageless case must not be verified.

Already correct by design, not a real gap:
- A finding argued the loader's `imagePath` contract should let an `ai-generated` case be
  imageless. It already is: the loader never checks file existence for any case (LH-003's own
  design — see `loader.ts`'s comments); only `images.test.ts` checks existence, and it already
  scopes that check to non-`ai-generated` cases.

Deferred (filed as follow-up work, not fixed here — real but larger than this triage pass):
- Replacing the loose `Degradation.params: Record<string, number | string>` with a
  discriminated union keyed by `DegradationType`, one interface per transform. The shape
  validation added above closes the practical gap (a manifest with a missing or wrong-typed
  param now fails to load); the type-level version is a bigger refactor across `types.ts`,
  `loader.ts`, and `degrade.ts`'s dispatcher, better done as its own change.

Resolved by explanation, not deferred: two STE100 prose findings against this entry's own
first draft and against `golden-set/README.md`'s new section were addressed directly, in
place, rather than filed as follow-up work.

**Tests (all in `pnpm test`, red-first where a fix followed).**
- `scripts/golden/render.test.ts` — `buildLabelHtml`'s exact-warning-text guarantee, checked
  by a literal substring match (`.includes()`) against every rendered case's spec text; the
  same for brand/class-type text. The warning `<div>` is empty when
  `governmentWarningPresent` is false. HTML-escaping is scoped to `&`/`<`/`>` only — a first
  draft escaped `'`/`"` too, which broke the literal-substring check against case-14's
  `STONE'S THROW`; fixed by narrowing the escape to the three characters that are actually
  structural in a text-content context, never a quoted attribute here. The "omits the ABV
  line" test counts `.line` divs directly (see the review-triage note above). A
  Playwright-backed determinism test renders the same case twice and compares **decoded raw
  pixels**, not just PNG bytes, for exact equality.
- `scripts/golden/degrade.test.ts` — each transform's effect: rotation expands the canvas and
  changes pixels; blur measurably lowers stdev; glare brightens its target region only; low
  light darkens its target region only; perspective changes shape. Plus the
  boundary-rejection tests described above, including the new shear bound. The dispatcher
  routes every known type and rejects an unknown one.
- `scripts/golden/images.test.ts` — every non-`ai-generated` case's `imagePath` resolves to a
  real, non-empty, well-under-500KB file. The six degraded cases' `degradations` entries match
  exactly what's described above. Every tiny-text/odd-typography/clean case carries none. The
  ai-generated consistency check covers both directions (see the review-triage note above).
- `src/lib/golden-set/loader.test.ts` — new cases for the `degradations` schema: accepts a
  well-formed list and every transform type with its required params; rejects an unknown
  transform type, a missing `params` object, a missing required param
  (`rotate` without `angleDegrees`), a wrong-typed param (`glare` with a numeric `region`),
  and a non-empty list on a case that isn't `rendered+degraded`.

**How to run it.** `pnpm golden:build` regenerates every image from the current manifest and
code. This is deterministic on one machine: same spec in, same pixels out on that machine —
proven by the render-determinism test. Cross-machine determinism is not verified. `render.ts`'s
font stacks name system fonts (see the "Deferred" note above), so a different OS could
substitute a different font and produce different pixels. `pnpm test` runs everything above.
`pnpm typecheck` / `pnpm lint` / `pnpm build` all pass.

**Rollback.** `git revert` this ticket's commit(s). Reverting removes `scripts/golden/`, the
29 committed images, the `degradations` manifest entries and schema addition, and the
`vitest.config.ts`/`package.json` wiring. No other ticket's code depends on any of it yet.
LH-005 (Imagen) and LH-006 (verify gate) are both still open, and unblocked either way.

**Not done here (explicitly out of scope).** `scripts/golden/verify.ts` (LH-006) and
`scripts/golden/imagen.ts` (LH-005) — neither written nor called. No code in this ticket
performs a network call.
## TRO-467 — PR review round 2: 8 findings, 7 fixed, 1 dismissed (2026-08-11)

**Still does not clear CP-2.** The gate's second review pass found 8 more findings against the
corrected document. Seven were real.

Four were internal inconsistencies the round-1 edits introduced or left behind. Two passages
said capitalization is checked at "three named positions" and then listed four words. §5.4's
distance table said "the other 25 cases with a warning" when 29 total minus 2 missing-warning
cases minus 4 listed cases is **23**. Q8 still described the ladder with three outcome classes
and overlapping rate bands, while §8.4 had been corrected to four classes and disjoint bands.
And the original CP-2 entry below still credited NFKC as passing the normalization test.

Two were real gaps. §7.1 promised that a disagreement between the derived capitalization and the
model's `prefix_casing` produces REVIEW, but §6.1's mapping table had no row for it — a promise
with no branch behind it. And Appendix B's verification commands could not fail: they printed
`match: True`/`False` and exited 0 either way, and the TTB-page check carried a **second
hard-coded copy of the statutory string**, which is precisely the drift risk this document exists
to remove. Both scripts now derive the expected text from the S1 fetch, check all six of TTB's
checklist items rather than one, and exit non-zero on any mismatch. Both were extracted from the
document and executed as written before this commit.

One was prose style: §5's opening used a figurative "gets attacked in the interview". Rewritten
literally, per the repo's ASD-STE100 rule.

**One dismissed, for the second time.** *"De-hyphenation must require line-geometry evidence"*
(raised as major in round 1, escalated to critical in round 2, with no new argument). Dismissed
on two grounds, and §5.2 now states the first as a proof rather than an assertion: for the rule
to produce a false PASS, some candidate would have to de-hyphenate to the canonical string
without being a hyphenated wrap — but the rule only deletes a hyphen that a newline follows, and
the canonical string contains no hyphen, so every such candidate is canonical with a wrap hyphen
inserted. No such candidate exists. The worst case is a severity downgrade from FAIL to REVIEW,
which still puts the label in front of a person. Second: the proposed mechanism needs character
bounding boxes, which the OCR channel can supply and the vision channel cannot, so adopting it
would make the two channels disagree by construction on every hyphenated label.

**How to run it.** Nothing to build or test. Appendix B's S3–S5 and S6–S7 scripts are now
runnable checks — `bash` them; they exit non-zero if a source has changed.

**Rollback.** `git revert` this commit.

## TRO-467 — PR review triage: 15 CodeRabbit findings, 14 fixed, 1 dismissed (2026-08-11)

**This entry still does not clear CP-2.** It corrects the checkpoint document. CP-2 stays
blocking until Troy runs the walkthrough and gives explicit acknowledgment.

**What changed.** The orchestrator's gate run captured 15 findings against the CP-2 document.
Each was verified against the document before anything was edited. Fourteen were real. One was
dismissed with a reason. Three of the fixes are substantive enough to name.

**1. TTB checks the capitals in `Surgeon General`, and our draft would have passed them in
lower case.** CodeRabbit claimed TTB guidance requires it; we did not take that on faith. We
retrieved TTB's own *Checklist of Mandatory Label Information* for wine and for distilled
spirits, and both carry the checkbox verbatim: `☐ Are the “S” in Surgeon and “G” in General
capitalized?` TTB's *2022 Boot Camp for Brewers* lists lower-case `surgeon general` under "Keg
Label Common Mistakes". The document's §5.4 had recommended a fully case-insensitive body
comparison, which would have accepted a deviation the agency's own specialist is instructed to
catch. **Capitalization is now checked at four word positions** — `GOVERNMENT`, `WARNING`,
`Surgeon`, `General` — each with its own citation, and case is folded everywhere else. The
find also produced a new §2.6 mapping all six of TTB's warning checkboxes onto what LabelHunter
does and does not do, and named the two it cannot check ("one statement", "separate and apart").
This is the best material in the document, and it exists because a reviewer pushed on a claim.

**2. NFKC was wrong by the document's own standard.** §5.1 states that a normalization rule is
legitimate only when it cannot change what a human reader sees. NFKC folds compatibility forms —
fullwidth `Ａ` to `A`, the ligature `ﬁ` to `fi` — which a reader **can** see, and it fails in
the dangerous direction by making a visibly deviant label compare equal. Changed to **NFC**, with
an explicit rule for the space characters (U+00A0 and friends) that NFKC had been handling by
accident. The effect on this project is nil and the document says so: the statutory string is
pure ASCII, so every edit distance in §5.4 is unchanged. The rule was corrected because it was
wrong in principle, not because it produced a wrong number.

**3. Two claims were stated in the present tense that describe work nobody has done.** The
tesseract.js `langPath` test and "a change to the regulation breaks a test" both read as
existing protections. Neither exists. The first is now an explicit LH-020 requirement, including
the library's real filename contract (`` `${langPath}/${lang}.traineddata${gzip ? '.gz' : ''}` ``,
verified from source) and a network-disabled startup test — a test that only checks `langPath`
is set would pass while the filename is wrong. The second is now split into two mechanisms: a
deterministic CI test against the committed eCFR fixture, which catches the constant drifting;
and a separate live re-fetch, run on a schedule or by hand, which is the only thing that can
notice the regulation itself changing. Neither is built.

**The other eleven fixes.** Agreement between the VLM and OCR channels now requires matching
capitalization verdicts, not only matching words — folding case in the agreement test would have
called `GOVERNMENT WARNING` and `Government Warning` "agreeing" while they produce opposite
verdicts. The ladder's outcome classes gained a fourth ("not found") and are now stated as a
partition with a summing assertion, so a missing warning cannot inflate the resolution-suspect
rate that drives model upgrades. The ladder's rate bands no longer overlap at exactly 10%. The
capitalization check now runs on transport-normalized text rather than raw, so an invisible
zero-width character cannot cause a false capitalization failure. De-hyphenation gained its
safety argument — the statutory string contains no hyphen, so the rule cannot manufacture a PASS,
only downgrade a FAIL to a REVIEW. The golden-set count was wrong: the document said 12 while its
own table listed 13, and the correct figure under a stated selection rule is **15**; the rule and
a runnable query are now both in the document. §9.2 gained a fifth finding — the two new
capitalization positions have no covering golden case. Appendix B gained runnable commands for
every claim it had been describing in prose, so "every command is in Appendix B" is now true.

**One dismissed.** *"Single-channel PASS must be forbidden."* Dismissed: this is **open question
10**, which the document already raises with a recommendation, both costs, and a named place in
the Q&A (Q7 calls it the residual false-PASS path). Changing the rule here would pre-empt the
decision the checkpoint exists to put in front of Troy. The document surfaces the exposure rather
than hiding it, and §8.4 now also requires the single-channel rate to be reported separately so
it cannot disappear into a healthy-looking aggregate.

**How to run it.** Nothing to build or test. Re-read §2.6, §5.2, §5.4, and §7.1 — those carry the
substantive changes. Appendix B's S6–S8 commands reproduce the TTB checklist finding; they need
`pdftotext`.

**Rollback.** `git revert` this commit. It edits two documents and no code.

## TRO-467 — LH-CP2: ⛔ CHECKPOINT 2 walkthrough material (2026-08-11)

**This entry does not clear a checkpoint.** It adds the material Troy reads *at* the
checkpoint. CP-2 stays blocking until Troy runs the walkthrough and gives explicit
acknowledgment. Until then, LH-020 and LH-021 do not start.

**What changed.** One new document: `docs/checkpoints/cp2-warning-subsystem.md`. No product
code, no `src/` change, no golden-set change. It covers everything PRD §10 requires CP-2 to
cover — canonical text sourcing, the OCR choice, normalization, the exact compare, caps and
bold handling, and the limitation wording — plus the golden-set review PRD §12 assigns to this
checkpoint, and a "defend it" Q&A (TH-R9, TH-R10, TH-R7, TH-R12, TH-R15, TH-R21, TH-R23).

- **The canonical text is now verified, not assumed.** PRD §3.4 carried the statutory string
  with a note beside it: "verify verbatim against ttb.gov during implementation — a ticket,
  not an assumption." This is that task, and it is done. The statement was retrieved live on
  2026-08-11 from the eCFR API for 27 CFR 16.21 (title 27, issue date 2026-07-06) and
  cross-checked against three ttb.gov pages — malt beverage, wine, and distilled spirits. All
  four sources carry a byte-identical string. **The PRD's copy is exactly right:** 283
  characters, pure ASCII, SHA-256 `35e1f5d39ee341ac7c114f8159956cb0cc1981b94e4ffeee194ff5060bf99fbc`,
  no discrepancy in wording, punctuation, casing, or whitespace. Every command is in the
  document's Appendix B.
- **Two findings the verification turned up.** The CFR renders the statement as two
  paragraphs, not one string, so the joined form is a documented design decision rather than
  something inherited. And the caps rule lives in 27 CFR 16.22(a)(2), not 16.21 — a sentence
  that carries **two** bold rules, not one: the first two words must print in bold, and the
  remainder may not. The extractor schema has a single `formatting.bold` flag and checks
  neither. The document names both and drafts the limitation wording.
- **Normalization is the load-bearing section**, and it turns on one sentence: a normalization
  rule is legitimate only when it cannot change what a human reader sees on the label.
  Whitespace runs, line breaks, line-end hyphenation, invisible characters, Unicode NFC
  canonical forms, and an explicit list of space characters all pass that test and are
  normalized. (This bullet said NFKC when the document first shipped; NFKC folds *visibly*
  different compatibility forms and therefore fails the test — corrected in the review round
  above.) Quote folding, diacritic
  stripping, and punctuation dropping all fail it and are deliberately absent — even though
  all three appear in the brand-name normalizer, where equivalence rather than exactness is
  the requirement. The statutory string contains no apostrophe, no quotation mark, and no
  non-ASCII character, so those rules could only ever make a deviant label look compliant.
- **Capitalization is checked at four word positions and folded everywhere else.** Words 1 and
  2 must be `GOVERNMENT WARNING` in full capitals (16.22(a)(2)); `Surgeon` and `General` must
  each carry an initial capital (TTB's own label checklist — see the review-round entry above,
  which corrected this section from a fully case-insensitive body). Computed over the golden
  set's own ground-truth strings, the title-case cases (case-08, case-09) sit at edit distance
  **0** once case is folded — the separate capitalization check is the only thing that catches
  them, and rubric gate G4 depends on it. Genuine rewordings sit at distance 24 and 38, which
  is what sizes the proposed near-miss band at 1–2.
- **Every verdict maps onto a real `WarningComparatorResult` branch**, and the document names
  the two `ReviewReason` values the union cannot return: `CONFLICTING_EXTRACTION` (PRD §3.7
  uses it for channel disagreement) and `LOW_MODEL_CONFIDENCE` (golden cases 23 and 24 expect
  it). Recommendation: leave the type alone and fix the two golden entries.
- **The tesseract.js choice is verified, and it carries a hazard.** Version 7.0.0, Apache-2.0,
  pure JS plus a WASM core with no native dependencies — that is the Render argument. But
  unless `langPath` is set, it downloads language data from a public CDN **at runtime**, which
  would break TH-R7's constrained-network requirement and PRD §3.8's latency budget together.
  Found by reading the package source, not by hitting it. LH-020 must commit
  `eng.traineddata`, set `langPath`, and test that it stays set.
- **A real conflict between PRD §3.8 and one crop-detection option.** A model-reported bounding
  box cannot arrive before the model call finishes, so it cannot satisfy §3.8's "OCR runs
  concurrently with the Haiku call". The document recommends classical detection instead, with
  a band-search fallback and a single-channel final fallback.
- **The golden-set review CP-2 owns.** 29 cases, 15 warning-relevant (the count and its
  selection rule were corrected in the review round above), **zero images** —
  `golden-set/images/` holds only `.gitkeep`. CP-2 can sign off on the specifications and
  cannot sign off on the pixels. Five findings are raised for the walkthrough to settle.
- **Eleven open questions**, each with a recommendation and the cost of choosing wrong. Every
  threshold is marked **proposed** and every unmeasured figure says "not measured", CP-1 style.
  A fifth claim label, **verified**, was added for retrieved statutory text — it is a stronger
  claim than "derived" and weaker than "measured on our own system".

**How to run it.** Nothing to build, nothing to test — this branch adds no code, so `pnpm build`
and `pnpm test` have nothing new to exercise. Read `docs/checkpoints/cp2-warning-subsystem.md`
— about 45 minutes — and work the Appendix A checklist during the walkthrough. Appendix B holds
a runnable command for every **verified** claim in the document, including the canonical-text
byte comparison against PRD §3.4 and the golden-set case count.

**Rollback.** `git revert` this commit. The document adds no code and nothing imports it.
## TRO-465 — LH-013 comparator swap (2026-08-11)

**What changed.** LH-013 (TRO-463) merged real field comparators to `main`
(`src/server/comparators/`). This ticket's one swap point,
`src/app/api/verify/route.ts`, now imports `productionComparators` from there instead of
the provisional stand-in. `provisional-comparators.ts` and its test are deleted — nothing
else in the repo imported them.

**Behavioral change, honest.** `alcohol_content` and `net_contents` can now report a
`MISMATCH` on a genuine numeric disagreement — the provisional stand-in never asserted
`MISMATCH` for any field. `brand_name`/`class_type` still never do (CP-1 §5.3: a judgment
call routes to REVIEW, never a silent FAIL — LH-013's own design, unchanged by this ticket).
The label-level verdict a real disagreement now produces is still `REVIEW`, not `FAIL`: the
government warning has no comparator yet (LH-020) and always needs review today, and REVIEW
outranks FAIL in the rollup. `route.test.ts` updated: the STONE'S THROW case now asserts a
real `MATCH` with a normalization note (TH-R8, previously untestable under the provisional
stand-in's plain casefold); a new test asserts the ABV field-level `MISMATCH` this ticket
could not previously produce. No test was weakened — every changed assertion states the real
comparator's real behavior, verified by reading `src/server/comparators/*.ts` directly, not
by trusting either side's prose.

**How to run it.** `pnpm typecheck`, `pnpm lint`, `pnpm test` (400 tests), `pnpm build` — all
green.

**Rollback.** `git revert` this commit. The provisional comparator files it deletes are
restored by the revert; no other ticket depends on them.

## TRO-465 — PR review round 1: orchestrator triage, 9 fixed, 0 dismissed (2026-08-11)

**What changed.** The worktree's captured CodeRabbit review (`.factory/coderabbit.json`, 9
findings) was triaged against current code, not against the review text's own instructions.
Every finding checked out as real and current — none was stale or a misread. All 9 fixed.

Fixed, real:

- `verify-client.ts` (critical): the default `fetchImpl` was a bare `fetch` reference. Some
  engines throw "Illegal invocation" when `fetch` runs detached from its receiver. Fixed:
  `globalThis.fetch.bind(globalThis)`. Added a test that stubs `globalThis.fetch` and confirms
  the default path works with no injected `fetchImpl`.
- `verify-client.ts` (major): `isVerifyErrorResponse` accepted any object with an `error` key,
  with no check that `kind` was a real `VerifyErrorKind` or that `message` was a string. A
  successful response was cast to `VerifySuccessResponse` with zero shape check. Fixed: `kind`
  now checks against a new `VERIFY_ERROR_KINDS` array (`types.ts`), and a new
  `isVerifySuccessResponse` guard checks `applicationId`, `verificationId`, `labelVerdict`
  (against `LABEL_VERDICTS`), and `fields` before trusting the body. Either check failing now
  throws the same designed `VerifyClientError("SERVICE", …)` instead of letting a malformed
  body reach `ResultsChecklist` and crash it. Four new tests cover the paths this closes.
- `ResultsChecklist.tsx` (major): its own `aria-live="polite"` wrapper mounts fresh, with its
  content already inside, only once a result exists — a live region that appears with content
  already in it is not guaranteed to be announced (WAI-ARIA). Fixed: `ResultsChecklist` no
  longer sets `aria-live` itself; `VerifyForm.tsx` now renders it inside the one persistent
  `aria-live="polite"` region that already existed for the loading message, present from the
  form's first render.
- `parse-request.test.ts` (trivial, ×2): added a test for the inclusive alcohol-content
  boundaries (0 and 100 both parse) and a test for a missing `netContentsUnit` (same rejection
  message as an unrecognized one).
- `ResultsChecklist.test.tsx` (trivial): added a test for a `MISMATCH` row — the suite
  previously only exercised `MATCH` and `NEEDS_REVIEW`.
- `VerifyForm.tsx` (trivial): added a comment on the `FormData` build explaining why it must
  run before `setPhase({ status: "loading" })` — every control disables on loading, and a
  disabled control is excluded from `FormData` by the HTML forms spec itself.
- `CHANGES.md` (minor, ×2): reworded the provisional-comparators bullet for precision
  (`provisional-comparators.ts` defines the default bundle; `route.ts` is the call site that
  passes it into `routeLabel`) and rewrote the styling/jsdom/how-to-run prose to ASD-STE100 —
  shorter sentences, one instruction each, no hedging, no embedded test/file counts that go
  stale on the next edit.

Not raised by this review, confirmed unchanged: no finding asked for the real field
comparators or the warning subsystem. The provisional stand-in and the `warningResult: null`
wiring stay exactly as this ticket's original entry describes — settled design, not something
this round touched. `main` still does not have LH-013 merged (re-checked before this round).

**How to run it.** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — all green.

**Rollback.** `git revert` this commit. Independent of the original TRO-465 commit below;
reverting this one alone restores the pre-triage behavior without touching the rest of the
ticket.

## TRO-465 — LH-015: Verify screen + results checklist (2026-08-11)

**What changed.** The single-label verify flow now runs end to end. It serves PRD §3.8, §5,
and TH-R1, TH-R3, TH-R20.

- `src/app/api/verify/route.ts` — a new `POST /api/verify` route. One request does the whole
  fast path: preprocess the photo, run the Haiku extractor, route the result, persist
  `applications`, `label_images`, `verifications`, `field_results`, and — on a REVIEW verdict —
  `review_queue`. It returns per-field verdicts and the label verdict in the same response. It
  never calls Sonnet. A REVIEW verdict returns immediately with an explicit "needs review —
  {reason}" flag, matching PRD §3.8's latency contract; LH-014's resolver (a sibling ticket,
  not yet merged) consumes the `review_queue` row later, on its own schedule.
- `src/app/api/verify/parse-request.ts` — boundary validation for the multipart form: image
  present, beverage type in the closed set, brand name and class/type non-blank, alcohol
  content a number in 0–100 or blank, net contents a positive number with a recognized unit.
  Every rejection carries a specific, plain-language message.
- `src/app/api/verify/types.ts` — shapes shared between the route and the UI.
- `src/server/router/provisional-comparators.ts` — **LH-013 (TRO-463) has not merged.** This
  file defines the default `FieldComparators` bundle: exact text match after a trim and a
  casefold, and the router's own provisional numeric parser for ABV and net contents. It never
  returns `MISMATCH` on its own (PRD §3.3: a real disagreement routes to REVIEW, never a
  silent FAIL). `route.ts` is the only production call site that passes a `FieldComparators`
  value into `routeLabel` — it does so through `VerifyRouteDeps.comparators`, defaulted to
  this bundle. Swap the one import in `route.ts` for LH-013's real bundle when it lands;
  nothing else changes.
- **The government warning has no comparator yet either** (LH-020, gated by CP-2, not yet
  merged). `route.ts` passes `warningResult: null` to `routeLabel` — honestly, not a
  fabricated match. `resolveGovernmentWarningField` (LH-012) already handles a `null` result
  by routing to `NEEDS_REVIEW`. Until LH-020 lands, every label with a warning on it needs
  review for that one field. Expected, not a bug in this ticket.
- `src/server/storage/local-file-storage.ts` — writes the uploaded photo to `var/uploads/`
  (gitignored) and returns the path `label_images.storage_path` stores. Prototype-appropriate,
  not a durable store: Render's filesystem is ephemeral, so a redeploy can lose these files
  while the database row survives. Documented in the file as a one-file swap point for a real
  object store later.
- `src/app/page.tsx` — replaces the scaffold placeholder with the Verify screen: upload
  control, the five application fields plus the beverage-type selector, one Verify button.
- `src/app/_components/VerifyForm.tsx`, `ResultsChecklist.tsx`, `ErrorPanel.tsx` —
  the form, the results checklist (✓ / ✗ / ⚠ rows with evidence and the one-line reason from
  `reason-text.ts`, never a bare confidence number), and the designed error panel (`role="alert"`,
  not a toast) for every failure mode TH-R20 names.
- `src/app/_lib/verify-client.ts` — the fetch wrapper. Classifies every failure into
  `VerifyClientError` with a `kind`: a structured error body from the server, a non-2xx
  response with none, a response this client cannot parse, a network failure, or a 45-second
  client-side timeout (`AbortController`) for the case the server never answers.
- `src/app/globals.css` — USWDS-influenced styling: navy and white, 18px base type, and
  high-contrast focus rings. No purple-gradient AI slop. No emoji-driven design. Dark mode
  follows `prefers-color-scheme`.

**A jsdom finding, not a product bug.** `VerifyForm` reads the selected photo from the file
input's own `.files` ref, not `new FormData(form).get("image")`. In this repo's jsdom test
environment, a `FormData` built from a form element reconstructs its file entries with the
right filename but `size: 0`. The reconstruction loses the underlying bytes. Reading the input
directly avoids the problem.

**How to run it.** Run `pnpm dev` and open `/`. Run
`pnpm test -- src/app src/server/router/provisional-comparators.test.ts src/server/storage`
for this ticket's own suites. Run `pnpm test` for the full suite; every test passes. Run
`pnpm build`; it succeeds. A manual smoke test against `pnpm start` confirmed the page
renders. The same test confirmed that `/api/verify` returns the correct JSON for a missing
image and for an unreadable image, over a real HTTP request. The smoke test made no live
Anthropic call.

**What this ticket could not verify.** No live Haiku call, and no real photograph of a real
label — every test mocks the Anthropic client (`makeMockMessage`, matching
`src/server/extractor/index.test.ts`'s own pattern) or uses a synthetic sharp-generated JPEG.
A true end-to-end run needs a real `ANTHROPIC_API_KEY` and a real label photo; say so rather
than claim it.

**Comparator set shipped.** Provisional (`provisional-comparators.ts`), not LH-013's real
bundle — LH-013 had not merged into `main` as of this ticket's work. `main` was re-checked
immediately before finishing; still not merged.

**Rollback.** `git revert` this commit. `var/uploads/` is gitignored and holds no data worth
preserving.

## TRO-463 / TRO-504 — LH-013: real field comparators (2026-08-11)

**What changed.** This ticket builds the real field comparators under `src/server/comparators/`.
They replace the router's placeholder judgment logic. They serve TH-R8 and TH-R11.

- `normalize.ts` — the fuzzy-match normalizer. Six steps: Unicode NFKC, casefold, apostrophe
  folding, diacritic stripping, whitespace collapse, punctuation drop. Apostrophe folding runs
  before NFKC, not after. NFKC decomposes the acute accent (´) into a space and a combining
  mark. Folding first keeps that character from disappearing before the fold rule can see it.
  A code comment explains the exception.
- `similarity.ts` — normalized Levenshtein distance. It backs the brand/class fuzzy match.
- `brand.ts` — the real `brand_name` / `class_type` comparator. TH-R8's named case: label
  "STONE'S THROW" against application "Stone's Throw" now MATCHes, with a note. Similarity at
  or above 0.95 MATCHes. Below 0.95, the field goes to NEEDS_REVIEW. It never returns MISMATCH.
  A brand comparator is a judgment tool, not an exact one.
- `abv.ts` — the real ABV grammar. It reads a percent, a proof statement, or both, in either
  order. It checks proof against percent: 27 CFR 5.1 defines proof as twice the percent by
  volume. It compares the label's percent against the application's declared percent.
- `net-contents.ts` — the real net-contents grammar. It reads a value and a unit (mL, L, fl
  oz), converts units, and compares the label's quantity against the application's.
- `index.ts` — `productionComparators`, the one import site LH-015 (TRO-465) wires into
  `routeLabel` in place of the router's placeholder set.

**TRO-504's three deferred edge cases close here, not as patches to the code they name.**

1. Combining marks did not stop `text-boundary.ts`'s evidence check from reading a combining
   mark's position as a word boundary. An unaccented value could pass as evidence for a
   different, accented word. `\p{M}` now joins `\p{L}\p{N}` in that check's lookaround.
2. `text-boundary.ts`'s casefold used bare `toLowerCase()`. German ß did not fold to "ss", so
   an all-caps label spelling and a mixed-case ß spelling of the same word did not match. Both
   `text-boundary.ts` and the new fuzzy normalizer now fold ß (and ẞ) to "ss".
3. The net-contents parser stopped at the first number in the text and gave up if that
   number's unit did not match. `"90 Proof 750 mL"` returned no match instead of finding
   `750 mL`. The real parser scans every number in the text and returns the first one a known
   unit follows.

**A regulatory VERIFY cell closes.** `required-fields.ts` marked beer's `alcohol_content` cell
VERIFY. 27 CFR 7.65(a) states an alcohol content statement is optional on a malt beverage
label, unless a state law prohibits or requires it. This system models the federal rule, not
state law. The cell is now `not_required`, cited. Wine's cell stays VERIFY: 27 CFR 4.36(a)'s
real rule is conditional on the wine's own ABV and its class/type wording. The required-field
table has no way to express that condition without a larger schema change. The comment states
what was verified and what still needs a larger fix.

**Two numbers move from "fails safe, unverified" to "verified, and zero is correct."** TTB's
ABV tolerance regulations govern the bottled product against its own label (27 CFR 5.65(b) for
spirits, 27 CFR 4.36(b) for wine). This comparator checks a different thing: does the label's
printed number match the application form's declared number. Zero tolerance is the right
answer for that second question. It is not a stand-in for the first.

**Wiring.** `field-resolution.ts` and `overrides.ts` import their numeric parsing from
`../comparators/abv.ts` and `../comparators/net-contents.ts` now, not from
`provisional-numeric.ts`. That file's docstring says LH-013 replaces its callers, not
necessarily the file itself. Its only remaining caller is `test-support.ts`'s own placeholder
fixtures, which belong to the already-merged LH-012 router-core ticket. The docstring is
narrowed to say so.

**A known gap, left open rather than silently fixed.** CP-1 §5.3 names three literal
apostrophe variants to fold: the straight apostrophe, the backtick, and the acute accent. A
label extracted by a real vision model may use a Unicode right single quotation mark (’,
U+2019) as a stylized apostrophe instead. That character is not one of the three named
variants, so it is not folded. Measured effect: "Stone’s Throw" against "Stone’s Throw" scores
about 0.923 similarity. That is just under the 0.95 match threshold. The pair routes to
NEEDS_REVIEW, not a clean MATCH. `docs/checkpoints/cp1-cascade-router-prompts.md` should decide
whether to widen the rule. This ticket implements the rule as written, not a guess at its
intent.

**Six more fixes from this ticket's own CodeRabbit review round, applied before this commit.**
Each one is a real gap, each has a named regression test, and each keeps the comparators pure
functions with no new dependency.

- `brand.ts`: two values that both normalize to an empty string (e.g. "..." against "---",
  once punctuation is stripped) no longer score a false MATCH. Empty normalized text has
  nothing left to judge, so it now routes to NEEDS_REVIEW like any other undecidable pair.
- `abv.ts`: `compareAbv` now catches a self-contradictory label (CP-1's own named example, "45%
  Alc./Vol. (100 Proof)") on its own, as a pure function — not only through the router's
  separate structural check. It reports NEEDS_REVIEW even when the stated percent happens to
  equal the application's.
- `net-contents.ts`: `parseNetContents` now reads a comma-grouped thousands number
  ("1,000 mL") as one value, and does not misread a comma-decimal (European-style "1,5") as a
  US decimal.
- `net-contents.ts`: `compareNetContents` now MATCHes two equal zero quantities. The tolerance
  check divides by the application's quantity, defined as an infinite fraction when that
  quantity is zero — correct when the label states something else, wrong when the label also
  states zero and the two numbers actually agree.
- `field-resolution.ts`: `checkAbvStructural`'s tolerance-vs-application check now reads a
  proof-only label's canonical percent (27 CFR 5.1), not only a label that states a percent
  directly. A proof-only reading used to skip this check entirely.
- `overrides.ts`: the ABV evidence-support check now compares the value and the evidence on
  the canonical percent scale, not axis-by-axis (percent-vs-percent, proof-vs-proof only). A
  value stated as "45%" whose evidence states only "90 Proof" is the same reading and is now
  recognized as such — this is the same bug class TRO-462's own `abvAlternatesConflict` fix
  already closed for the alternates check, now closed here too.

**Two required-fields.ts findings from that same review round, not adopted.** CodeRabbit
suggested reverting beer's `alcohol_content` cell from `not_required` back to `verify`. This
ticket verified the regulation directly (27 CFR 7.65(a), fetched and quoted in the code
comment): a malt beverage label's alcohol content statement is optional under federal law.
`not_required` is the cited, correct value, not a guess CodeRabbit's heuristic should override.

**Three more fixes from PR #8's GitHub review, applied before this commit.** Each one has a
named regression test.

- `net-contents.ts`: `parseNetContents("1,5 L")` used to return `{ value: 5, unit: "l" }`
  instead of failing. The comma-grouping fix above stopped it from misreading "1,5" as "1.5",
  but it left the orphaned "5" behind as a fresh candidate. `NUMBER_PATTERN` now refuses to
  read a bare number that sits directly after a comma, so a malformed comma-decimal rejects the
  whole read instead of handing back a different, wrong quantity.
- `field-resolution.ts`: `checkNetContentsStructural`'s alternates check now MATCHes two equal
  zero quantities, the same zero-division bug already fixed in `compareNetContents`, present
  here too.
- `text-boundary.ts`: `normalizeForBoundaryMatch` now calls `.normalize("NFC")` first. A
  precomposed accented letter and its canonically equivalent decomposed form (a base letter
  plus a combining mark) used to normalize to different strings. They are the same text under
  Unicode's own definition, and now they normalize the same way.

**A note on running tests.** `pnpm test` and `pnpm test -- <path>` both read `DATABASE_URL`.
Every worktree gets its own database (`scripts/factory/worktree.sh`); running tests with
`DATABASE_URL` unset, or pointing at any database other than the current worktree's own, is
this repo's own non-negotiable rule (`CLAUDE.md`) — test provisioning resets the target
schema. `source .factory-env` before running either command below.

**How to run it.** `pnpm test -- src/server/comparators src/server/router` runs the new and
changed suites. `pnpm test` runs everything; 344 tests pass repo-wide. `pnpm typecheck` and
`pnpm lint` are both clean.

**Rollback.** `git revert` this commit. That one command is the whole procedure. The same
commit changed `field-resolution.ts` and `overrides.ts`'s imports. It also added the module
they import from. A revert restores the old imports and the old behavior together. Nothing is
left to fix by hand.

## TRO-462 — PR review round 2: orchestrator triage, 2 fixed, 3 deferred (2026-08-10)

**What changed.** The orchestrator's independent gate run found 5 more CodeRabbit findings
against the round-1 fix commit. Two were real and fixed here.

- `field-resolution.ts` (major): `abvAlternatesConflict` compared a percent reading to a
  percent alternate, and a proof reading to a proof alternate, as two separate checks. It
  never converted across the two scales. `"45%"` against an alternate of `"100 Proof"`
  passed as agreeing, because neither separate check ever ran — 100 Proof has no percent
  reading to compare, and 45% has no proof reading to compare. Fixed: both readings convert
  to a canonical percent scale first (proof is twice the percent, 27 CFR's own definition),
  then compare. `"45%"` against `"90 Proof"` now correctly agrees. `"45%"` against
  `"100 Proof"` (50%) now correctly conflicts.
- `types.ts` (major): `FieldResultRow` allowed `resolvedBy: "sonnet"` with
  `reviewReason: null` — a state that should not exist, since a field is only resolved
  because something escalated it. Fixed: a discriminated union. The resolved branch
  requires the reason; the unresolved branch keeps it nullable. No behavior change — every
  construction site in this ticket already passes `resolvedBy: null`, since LH-014's
  resolver does not exist yet.

Three findings were real but deferred, filed as **TRO-504** rather than fixed here:
combining-mark and German-ß handling in the word-boundary text match (deep Unicode edge
cases with no golden-set coverage yet), and a provisional net-contents parser that stops
at the first unsupported unit instead of scanning past it (the parser's own docstring
already marks it a stand-in for LH-013's real implementation — more polish on a stand-in
is not the right place to spend the fix).

**How to run it.** `pnpm test -- src/server/router` — 11 files, 135 cases (up from 133).

**Rollback.** `git revert` this commit. The two fixes are independent of round 1; nothing
else depends on either change.

## TRO-462 — LH-012: Validation Router core (2026-08-10)

**What changed.** This ticket adds the Validation Router's decision logic under
`src/server/router/`. It serves PRD §3.3, TH-R2, TH-R8, and TH-R19. The router answers one
question. Given what the Haiku extractor read, and what the applicant filed, what does each
field's verdict say? What does the whole label say? The router is deterministic TypeScript.
It never calls a model.

This ticket builds the router shell. That shell covers confidence bands, the
anti-hallucination overrides, the eight `ReviewReason` rules, their precedence, and the
label-level rollup. The design comes from `docs/checkpoints/cp1-cascade-router-prompts.md`
§4-§5. Troy approved that design at CP-1. This ticket implements it as written.

This ticket does not build the real field comparators. Those cover normalization, fuzzy
brand and class matching, ABV parsing, and net-contents parsing. LH-013 (TRO-463) owns that
work, and this ticket blocks it. This ticket also does not build the warning comparator.
LH-020 owns that work, in its own CP-2-gated subsystem.

**Files.**
- `types.ts` — the router's public shapes. `ApplicationRecord` is the applicant's filed
  record. `FieldComparator` is the interface LH-013 implements against. `WarningComparatorResult`
  is the contract LH-020 implements against. It is a discriminated union: a `NEEDS_REVIEW`
  verdict requires a `reviewReason`; every other verdict forbids one. `PreprocessingSignal`
  carries what LH-010 found before the image reached the extractor. `FieldResultRow` is one
  output row, with CP-1 §5.5's exact columns.
- `confidence.ts` — the three confidence bands from CP-1 §4.2, and the asymmetry rule from
  §4.3. A low-confidence MATCH escalates only below 0.60. A low-confidence MISMATCH escalates
  below 0.90. A NEEDS_REVIEW comparator result always escalates. The two escalation cutoffs
  look like the per-field trusted threshold (0.85, or 0.90 for the warning transcription),
  but they answer a different question. This file names them as separate constants
  (`MATCH_ESCALATION_CEILING`, `MISMATCH_ESCALATION_CEILING`) so a future re-tune of one does
  not silently move the other.
- `overrides.ts` — the three CP-1 §4.4 anti-hallucination checks. Evidence must be present.
  Evidence must support the value at a boundary, not a substring. Confidence must be a real
  number in range. A failed check rejects the field. It never clamps a bad number into range.
  `beverage_type` is exempt from the evidence-support check only. Its value is an inferred
  category. It is never verbatim in the label's evidence. This is a known, ticketed exemption,
  TRO-502. The exemption is commented at its call site in `index.ts`.
- `text-boundary.ts` — the word-boundary text check the evidence-support override uses for
  text fields. This is not LH-013's real normalization pipeline. LH-013's pipeline covers
  Unicode NFKC, apostrophe folding, and diacritic stripping. This file answers one narrower
  question only: does the evidence contain this exact word.
- `provisional-numeric.ts` — a minimal, clearly-labeled stand-in ABV and net-contents parser.
  The overrides' numeric check uses it. The `AMBIGUOUS_ABV` and `AMBIGUOUS_NET_CONTENTS`
  structural checks use it too. LH-013 replaces every caller with the real, ttb.gov-cited
  grammar.
- `required-fields.ts` — the required-field-by-beverage-type table. It implements CP-1 §5.3's
  table exactly as given, including the `alcohol_content` cells CP-1 marks **VERIFY** for
  beer and wine. A `"verify"` cell stays its own distinct value. The code does not fold it
  into `"required"` silently. It does route as required today. That is the fail-safe reading.
- `field-state.ts` — the field-shape-aware absence check. `government_warning` has no
  `value`. It has `present` instead. A uniform `value === null` check would never fire for
  the warning field. It would silently pass a warning the router never actually examined.
- `label-blockers.ts` — the two label-level blockers, `LOW_IMAGE_QUALITY` and
  `CONFLICTING_EXTRACTION`.
- `field-resolution.ts` — the field-specific `AMBIGUOUS_ABV` and `AMBIGUOUS_NET_CONTENTS`
  structural checks. This includes the proof-arithmetic self-contradiction check. CP-1 names
  `"45% Alc./Vol. (100 Proof)"` as the worked example. This file also resolves each field's
  final verdict and reason, for the four comparator-driven fields and for the government
  warning's contract.
- `precedence.ts` — the exact CP-1 §5.2 rank order, and the headline-reason picker.
- `rollup.ts` — the CP-1 §5.4 label rollup. A label-level blocker outranks every field
  verdict. The rollup checks the blocker first, so it cannot miss one.
- `reason-text.ts` — one line of UI English per row. PRD §3.3 and TH-R20 require this. The
  text is never a bare confidence number.
- `index.ts` — `routeLabel`, the module's one public entry point. It wires every file above
  together.
- `test-support.ts` — placeholder comparators for this ticket's own tests. They check exact
  match after a trim and a casefold. They are honestly named. Nobody should read them as real
  judgment logic. `STONE'S THROW` and `Stone's Throw` would NOT match here. That judgment is
  LH-013's job.

**Load-bearing decisions.**
- The word-boundary evidence check first used `\b`. `\b`'s boundary depends on the character
  at the edge of the pattern itself. The government warning transcription ends in a period.
  That put a non-word character on both sides of the trailing `\b`. The check never matched,
  even for the correct reading. TDD caught this. The first `index.test.ts` run failed a
  clean-fixture case with `CONFLICTING_EXTRACTION`, for the right reason. The fix uses
  lookaround instead: `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])`, with the `u` flag. Lookaround
  checks the character outside the match. It also now recognizes Unicode letters, not only
  ASCII ones, so an accented brand name does not break the boundary check.
- The asymmetry rule's two escalation cutoffs are fixed values. They apply the same way
  across every field. They do not scale off the per-field trusted threshold. CP-1 §4.3 gives
  them as flat numbers, not a formula.
- `MISSING_REQUIRED_FIELD` does not fire when `LOW_IMAGE_QUALITY` already fired for the
  label. CP-1 §5.3 states this carve-out for this one pair of reasons. This ticket implements
  that carve-out literally. It does not generalize it into a broader rule the document does
  not state elsewhere.
- `REVIEW_REASON_PRECEDENCE` derives from a `Record<ReviewReason, number>`, not a hand-written
  array. TypeScript requires every `ReviewReason` member to have a rank. A ninth reason added
  to the enum without a rank is a compile error here, not a silent gap.

**Review round.** Two independent CodeRabbit passes ran against the first commit: one from
this worktree's own gate, one from the orchestrator's. Together they found real, fix-now
issues, folded into this same entry rather than a separate one, since no PR had opened yet.
- **Major.** `buildFieldReasonText`'s verdict fallback treated every non-MISMATCH verdict as
  a match. CP-1 §5.3's own carve-out (above) leaves a field at `NEEDS_REVIEW` with
  `reviewReason: null`. That field printed "Matches the application." Fixed: a `NEEDS_REVIEW`
  verdict now falls back to its own line, "This field needs a closer look."
- **Major.** The `AMBIGUOUS_ABV` and `AMBIGUOUS_NET_CONTENTS` alternates check flagged any
  non-empty `alternates` array, even one that only restated the same number. CP-1 §5.3 says
  "conflicting ways," not "stated twice." Fixed: each alternate is now parsed and compared to
  the primary value; only a genuine numeric disagreement counts as a conflict.
- **Major.** `provisionalParseNetContents`'s regex could capture trailing label text past the
  real unit, e.g. `"750 mL Alcohol 45%"`, and then fail to match any known unit at all. Fixed:
  the unit is now matched against the start of the captured text only, so trailing text after
  the unit does not break the parse.
- **Major.** `numericEvidenceSupportsNetContents` (the §4.4 override's numeric check) compared
  unit strings, so `"750 mL"` as the value and `"0.75 L"` as the evidence — the same quantity —
  failed the check. Fixed: both sides now convert to mL before comparing, matching CP-1 §5.3's
  own wording, "the converted values."
- **Major.** `WarningComparatorResult` allowed a `NEEDS_REVIEW` verdict with no `reviewReason`,
  and the router silently defaulted one. Fixed: the type is now a discriminated union.
  `reviewReason` is required on the `NEEDS_REVIEW` branch and does not exist on any other
  branch. An unnamed REVIEW result is a compile error for LH-020 to hit, not a silent default.
- **Major.** `isLowImageQuality`'s partial-legibility check counted an override-rejected
  field's confidence, even though `overrides.ts` zeroes that confidence only so it never
  displays a garbage number. That zero is evidence the extraction was broken, not evidence the
  image was hard to read. Fixed: an override-rejected field is now excluded from this check.
- **Major.** The `beverage_type` cross-check compared the extractor's raw string against the
  application's beverage type with no normalization, so `"Spirits"` (a valid, schema-legal
  extractor output) against `"spirits"` (the application's value) would have falsely triggered
  `CONFLICTING_EXTRACTION`. Fixed: both sides are normalized the same way the evidence
  word-boundary check normalizes text, before comparing. The 0.85 confidence gate on this
  check now reuses `TRUSTED_THRESHOLD_DEFAULT` instead of a second, separate 0.85 literal.
- **Minor.** The three `AMBIGUOUS_*` reason texts all read "needs a closer look," with no
  detail. Fixed: each now names what a reviewer must check, e.g. "A reviewer must check the
  alcohol content against the label."
- **Minor.** This entry's own opening sentence, and several entries below, buried more than
  one idea inside a single long sentence with nested em-dash parentheticals. The same catch
  TRO-461's review made. Fixed: rewritten throughout as short, standalone sentences.

**Regression tests.** `src/server/router/*.test.ts` — 11 files, 133 cases. One file covers
one concern: confidence bands, overrides, provisional numeric parsing, the required-field
table, field-shape-aware absence, the two label blockers, field resolution, reason text,
precedence, rollup, and an `index.test.ts` integration suite. Named cases include the
proof-arithmetic self-contradiction example, the `beverage_type` TRO-502 exemption, and a
case for every review-round fix above.

**How to run it.** `pnpm test -- src/server/router` runs 11 files and 133 cases. `pnpm
typecheck` and `pnpm lint` both run clean. The full repo suite, `pnpm test`, runs 23 files
and 247 cases.

**Known limits.** The real field comparators, LH-013, and the warning comparator, LH-020, do
not exist yet. This ticket routes on their contracts, not their real output. The
`alcohol_content` VERIFY cells for beer and wine, and the ABV and net-contents tolerances,
stay unverified regulatory placeholders. Each one is flagged in code, pending LH-013's
ttb.gov citations.

**Rollback.** Run `git revert` on this commit and the router-core commit before it.
`src/server/router/*.ts` and `*.test.ts` are removed, and `.gitkeep` returns.

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
