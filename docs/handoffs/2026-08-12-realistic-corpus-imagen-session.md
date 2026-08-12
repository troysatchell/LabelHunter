# Handoff: realistic-corpus Imagen pipeline, live session 2026-08-12

Continues `docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md` (LH-005/TRO-498's
design). That ticket built and bug-fixed the pipeline; this session ran it for real for the
first time — 2 live Gemini calls, real spend, real output — and found one confirmed bug plus
one committed code fix along the way. Nothing here is merged. This is a status snapshot for
whoever picks it up next, not a finished ticket.

## Why this session happened

Troy's own words: the flat rendered golden-set images ("Old Tom Distillery" as plain text on
white, no bottle) are "borderline unusable... wouldn't fly in an actual environment." This
session proved the realistic-corpus pipeline can close that gap — a real photorealistic bottle
with the exact statutory government-warning text composited onto it — but it is not yet turned
into an actual golden-set case, and one real bug needs fixing first.

## What's committed: nothing. What's uncommitted, in the working tree right now

```
 M .gitignore                                          # .gstack/ line, added by the browse skill's own setup, unrelated to this work
 M scripts/golden/imagenPrompt.test.ts                  # new test for the "bottle alone" instruction
 M scripts/golden/imagenPrompt.ts                       # PROMPT_VERSION v1 -> v2, "bottle alone" instruction added
?? .codacy/                                             # unrelated, not from this session
?? assets/golden/references/spirits-bottle-01.jpg       # first reference photo tried (Wikimedia, real branded product used only as a shape reference -- see caveats below)
?? assets/golden/references/spirits-bottle-01.json      # bottle-reference metadata, currently points at Troy's Crown Royal photo (see below)
?? assets/golden/references/crown-royal-warning-label-closeup.png   # Troy's own reference photo -- a real, close-up photo of an actual Government Warning label. Renamed from the original "Screenshot 2026-08-12 at 11.43.00 AM.png" -- that filename used U+202F (narrow no-break space, macOS's default screenshot naming), which breaks plain fs.readFileSync. Rename, don't retype, if this ever needs restoring.
?? assets/golden/references/39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg  # Troy-supplied, not yet wired into any bottle-reference JSON
?? assets/golden/references/Warning-Label-2.jpg          # Troy-supplied, not yet wired into any bottle-reference JSON
?? assets/golden/references/alcohol-warning-label-1200x596-235563604.jpg  # Troy-supplied, not yet wired into any bottle-reference JSON
?? golden-set/backdrops/case-ai-backdrop-spirits-bottle-01-compliance-desk-steady.png       # the LATEST real Gemini output (Crown Royal reference, bottle-only, v2 prompt)
?? golden-set/backdrops/case-ai-backdrop-spirits-bottle-01-compliance-desk-steady.meta.json  # its sidecar -- labelPlacement in here is WRONG, see bug below
```

`golden-set/manifest.json` has **not** been touched. No `rendered+ai-backdrop` case exists yet.
Everything above is real generated/reference material sitting outside the actual golden set.

Three of Troy's own reference photos (the `39cdef...`, `Warning-Label-2.jpg`,
`alcohol-warning-label-1200x596...` files) are on disk but not yet wired into any
`bottle-reference.json` — nobody has decided which bottle they belong to or what scene/camera
condition to pair them with.

## What's actually done and verified

1. **Real fix, tested, ready to commit on its own:** `scripts/golden/imagenPrompt.ts`'s prompt
   now explicitly says "Show the bottle alone... no drinking glass, cup, tumbler, or any other
   prop." The first real generation (using a Wikimedia reference photo that had a tasting glass
   in frame) came back with a glass in the output too -- Gemini was carrying over more of the
   reference composition than just bottle geometry. Confirmed fixed on the very next real
   generation (bottle-only, correctly). `PROMPT_VERSION` bumped `v1` -> `v2` per this file's own
   documented convention. New test asserts the instruction text is present. `npx vitest run
   scripts/golden/imagenPrompt.test.ts` — 6/6 pass.
2. **Real, end-to-end proof the pipeline works:** generation -> blank-region detection -> exact
   government-warning text composited on top, using the real renderer (same one every other
   golden-set case uses) and the real `compositeLabelOntoBackdrop` warp code. Two full real runs
   (~$0.07 each, ~$0.14 total spend, Gemini 3.1 Flash Image). Screenshots of both were sent to
   Troy directly in the session transcript.

## Confirmed bug, not yet fixed: `blankRegionDetector.ts` picks the wrong region

`detectBlankRegionQuad` scans the whole generated photo and keeps the **largest** connected
region within color tolerance of the blank-label cream color
(`BLANK_LABEL_COLOR_RGB = {r:240,g:233,b:220}`). **This is not robust against a bright window or
wall in the generated scene** — a light, evenly-lit background is often larger and more
uniformly-colored than the actual label, so it wins.

Hit 3 times in a row, independently, across both real generations this session:
- Run 1 (Wikimedia reference, glass in frame): detector correctly found the label. Worked.
- Run 2 (same reference, after the bottle-only prompt fix): detector matched the bright window,
  top-right corner of frame (`topLeft: {x:693,y:0}` — touching the very top edge, a label never
  would). Composite landed floating over the window.
- Run 3 (cropping the search to the left 70% of the same image, hoping to dodge the window):
  detector matched a *different* false positive — a shadowed background area — not the actual
  label either.
- Run 4 (Crown Royal reference, current committed-to-disk state): same failure mode again,
  `topLeft: {x:869,y:282}` extending to `x:1348` — 1354px-wide image, so this is the right-edge
  window again.

**Every one of the 4 real generations this session needed a hand-corrected label placement** to
get a good composite — found each time by grid-scanning the actual generated image for
color-matching pixel clusters and picking the right one, or seeding a flood-fill from a manually
verified point. That workaround is documented in the session transcript but not saved as
reusable code anywhere.

**This directly contradicts the pipeline's own "0 need manual placement" log message** —
`generateOne`/`main` in `imagen.ts` only flags a case for manual placement when detection finds
*no* match at all (`detectedQuad === null`), never when it finds a *wrong* one. The 3 failed
attempts above all logged "OK," not "DETECTION FAILED." Whoever fixes this should treat that log
message's current meaning as unreliable until it's fixed, not just the underlying detector.

**Recommended fix directions, not yet evaluated for feasibility:**
- Bias against regions touching the image border (a real label crop essentially never touches
  the frame edge, a background region often does — this alone would have caught all 3 failures
  above; every false-positive quad in this session had at least one coordinate at 0 or at the
  image's max width/height).
- Reject or down-rank regions whose aspect ratio is very unlike a label (all 3 false positives
  were much more extreme aspect ratios than the true label region, though this alone isn't fully
  reliable — see the `blankRegionDetector.ts` diagnostic data in the session transcript for the
  real numbers).
- Prefer a region whose bounding box is more centrally located, since a bottle (and its label)
  is usually the framed subject, not the edges/background.
- Least effort, most honest: keep "largest region" but sanity-check it against
  `MIN_REGION_FRACTION`/`MAX_REGION_FRACTION` bounds tighter than 0.02-0.85 of the *whole frame*
  — a label that's 85% of the image is implausible on its face.

## Open decisions for whoever picks this up (not resolved here)

1. **Which reference photo(s) actually become the golden set's realistic-corpus bottle(s)?**
   Candidates on disk now: the Wikimedia one (real branded product, used cautiously, see below),
   Troy's Crown Royal warning-label close-up (real product, Troy's own photo, explicitly chosen
   by him), and 3 more of Troy's reference photos not yet wired into a JSON at all.
2. **Brand-content posture.** The existing golden set uses a fictional brand
   ("Old Tom Distillery") throughout. Every reference photo used as an `imagen.ts` bottle
   reference so far (Wikimedia and Troy's own) shows a real product. Gemini's prompt explicitly
   blanks the label region and forbids generating logos/text, so real branding never appears in
   the *output* -- but the reference *input* itself is real branded material either way. Troy
   made this call explicitly and directly for his own Crown Royal photo; the Wikimedia one was
   this agent's own more cautious, independent choice from earlier in the session and hasn't
   been explicitly endorsed the same way.
3. **Fix the detector first, or work around it per-case forever?** Given it's failed 4/4 real
   generations, fixing it is very likely worth doing before generating any more scenes.
4. **How many scenes / degraded variants** (motion-blur, camera-shake, low-light, etc. -- the
   full taxonomy the rendered golden-set cases already use) should the realistic-corpus track
   cover, and does it replace or supplement the existing flat-rendered cases?
5. **Folding a result into `golden-set/manifest.json` as a real `rendered+ai-backdrop` case** —
   the mechanics are proven (this session did it as a scratch script, not against the real
   manifest) but nobody has decided to commit one yet.

## Real cost incurred this session

~$0.14 (2 real Gemini 3.1 Flash Image calls, Standard tier, 1K resolution, ~$0.067/image per
`imagen.ts`'s own estimate). No spend cap applies (removed 2026-08-11, Troy's explicit call).
