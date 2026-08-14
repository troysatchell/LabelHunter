# Design: Realistic Golden-Set Corpus via Gemini 3.1 Flash Image

**Date:** 2026-08-11
**Status:** approved (brainstorm session with Troy)
**Serves:** TH-R12 (test-label set), TH-R10 (imperfect images), rubric V9/X1 and general realism
evidence, PRD §6 golden set
**Supersedes:** §5 ("Imagen usage") of
`docs/design/2026-08-10-golden-label-image-gen-design.md`. That design capped Imagen
at ~6 backdrops and ~5 wild labels, under a $5 budget, because Google API billing was not yet
enabled. Troy enabled billing on 2026-08-11. This design replaces that cap.
**Decision:** Gemini 3.1 Flash Image generates realistic bottle photographs — steady, motion-blur,
and camera-shake conditions — from Troy's real bottle reference photos. The renderer still
produces the label with exact warning text (unchanged from the original design). The label is
composited onto the Gemini photo, so ground truth stays guaranteed by construction. No
hand-transcription of warning text.

## 1. Goal

Ship a realistic-corpus track inside the golden set: roughly 40–60 committed images showing real
bottle shapes in real-world conditions (blur, camera shake, varied lighting), each carrying the
same trusted ground truth the render-first pipeline already guarantees.

Success criteria:

1. Every generated image composites the renderer's exact-text label — no image in this track
   relies on Gemini to draw correct warning text.
2. A pilot batch (one bottle, 6 images) proves the compositing approach works before the full
   corpus generates.
3. Cost stays visible: the generation script logs running spend as it runs.

## 2. Relationship to the existing pipeline

LH-003 (render.ts) and LH-004 (degrade.ts) are unchanged. They remain the deterministic backbone:
exact-text labels, free, reproducible, CI-smoke-tested. This design only replaces LH-005's
original scope (§5 of the 2026-08-10 doc) — the part of the golden set that uses the Gemini API.

Two AI-assisted provenances now exist side by side:

- `ai-generated` (unchanged): a handful of fully AI-generated labels, text included. Requires
  full human transcription and verification per image. Kept small — this is where the
  text-mangling risk the original design warned about still lives.
- `rendered+ai-backdrop` (new, this design): the renderer's exact-text label composited onto a
  Gemini-generated realistic photo. No transcription risk. This is the track that scales to
  40–60 images.

## 3. Reference-photo and prompt-authoring layer

One hand-authored JSON file per real bottle photo Troy supplies, committed alongside the photo:

```json
// assets/golden/references/amber-whiskey-01.json
{
  "bottleId": "amber-whiskey-01",
  "referencePhoto": "assets/golden/references/amber-whiskey-01.jpg",
  "beverageType": "spirits",
  "bottleDescription": "tall amber glass whiskey bottle, cork stopper, tapered shoulders",
  "scenes": [
    { "sceneId": "bar-counter", "setting": "rustic dark-wood bar counter, blurred bottles in background", "lighting": "warm tungsten backlight, golden-hour glow" },
    { "sceneId": "kitchen-counter", "setting": "brushed steel counter near a window", "lighting": "soft overcast daylight" }
  ],
  "cameraConditions": ["steady", "motion-blur", "camera-shake"]
}
```

The JSON is the source of truth for what to generate. It carries data only — setting, lighting,
camera condition — never its own prompt phrasing. `scripts/golden/imagenPrompt.ts` is the single
place that turns data into prose, so every bottle's prompts share one structure.

`imagenPrompt.ts` expands each `scene × cameraCondition` pair into Gemini's prompt. The prompt's
sentence order states the hierarchy explicitly — reference image gives bottle identity, scene JSON
gives environment, camera condition gives the photographic artifact, and the blank label is a
compositing requirement, not a style choice:

> "Create a photorealistic photograph of the bottle shown in the provided reference image.
> Preserve the bottle's silhouette, proportions, glass color, closure, and overall geometry. Place
> the bottle on {setting}. {lighting}. {cameraCondition}.
>
> Keep the bottle's label area in its existing position and perspective, but make the label
> surface completely blank and uniform matte cream (#F0E9DC). Do not generate any text, logos,
> illustrations, typography, seals, or other graphics. The blank label must remain suitable for
> later digital compositing.
>
> Realistic materials, reflections, shadows, depth of field, and physically plausible lighting."

`cameraCondition` is one of three fixed clauses:

| Condition | Clause |
|---|---|
| `steady` | "Tripod-steady, 1/125s shutter speed, tack-sharp image with minimal motion blur." |
| `motion-blur` | "Handheld at approximately 1/15s, with gentle directional motion blur while the bottle silhouette and label area remain clearly recognizable." |
| `camera-shake` | "Handheld low-light phone photograph with visible multi-directional camera shake and imperfect sharpness, while the bottle remains recognizable." |

**Guardrail — keep the compiler boring.** The bottle JSON stays limited to the fields shown
above: no per-bottle prompt overrides, no free-text prompt fragments. `imagenPrompt.ts` stays the
single deterministic template — no LLM-generated prompt layer, no dynamic prompt rewriting, no
per-bottle prompt customization. Add that complexity only if the pilot (§5) discovers a concrete
failure mode a template change cannot fix; do not add it speculatively.

## 4. Generation

`scripts/golden/imagen.ts` calls Gemini 3.1 Flash Image once per `(bottle, scene, cameraCondition)`
combination, passing the built prompt and the real bottle photo as a reference image. Model choice
matters: Gemini 2.5 Flash Image (the model implied by the original design) retires 2026-10-02.
Gemini 3.1 Flash Image is current and is not on a deprecation schedule as of this writing.

Target scale: roughly 5 bottles × 2 scenes × 3 conditions, plus a second lighting variant on
about half — landing at 40–60 images, per Troy's sizing choice.

## 5. Compositing: finding the blank label region

This is the highest-risk part of the design. The blank area moves with each bottle's natural
label placement — there is no fixed screen-space rectangle to composite into.

**Primary path — automated detection.** The prompt fixes the blank area to one distinct, known
color (`#F0E9DC`). A detection step scans the generated image for the largest connected region
near that color, fits a quadrilateral to its corners, and `sharp` perspective-warps the renderer's
label PNG into that quad.

**Fallback — manual click.** A small helper script opens a generated photo, a human clicks the 4
corners, and the script saves them to a sidecar JSON next to that image. Used only for images
where automated detection fails.

**Rollout — pilot before scale.** Generate one bottle × 2 scenes × 3 conditions (6 images) first.
Build and test the detector against those 6. This is a hard gate — do not generate the remaining
corpus until the pilot demonstrates all five of:

1. The blank region is actually produced in every pilot image.
2. It stays geometrically aligned with the bottle (not floating free of the label area).
3. The `#F0E9DC` color is separable enough from the rest of the scene to detect reliably.
4. The connected-component detector does not pick up unrelated cream-colored regions elsewhere
   in the frame (background, bottle cap, table surface).
5. The recovered perspective quad is good enough for `render.ts`'s label to warp into without
   visible distortion.

If all five hold, generate the rest of the corpus and run the same detector unattended. If
detection is flaky on some images, fall back to manual clicking for those only — not the whole
corpus.

## 6. Schema changes

`src/lib/golden-set/types.ts`:

- `GoldenSetProvenance` gains `"rendered+ai-backdrop"`.
- A case with that provenance carries three new fields: `referenceBottle` (bottle JSON id),
  `scene` (scene id), `cameraCondition` (`"steady" | "motion-blur" | "camera-shake"`). Recorded
  for traceability, not exact reproducibility — Gemini generation is not deterministic, so (like
  `ai-generated`) these images are committed to git rather than regenerated on demand.
- `verified: true` is still required before eval may use a `rendered+ai-backdrop` case. The check
  is lighter than for `ai-generated`: a human confirms the composited label is legible and
  correctly placed. No warning-text transcription — that text is trusted by construction from the
  renderer.
- `generationMetadata` (new, `rendered+ai-backdrop` only): `{ model, resolution, promptVersion,
  generatedAt }`. `promptVersion` is a string constant in `imagenPrompt.ts`, bumped whenever the
  template text changes. This is forensic record-keeping, not a reproducibility claim — it lets
  anyone looking at a committed image later understand why it looks the way it does (which model,
  which template version, which bottle and scene produced it) without implying a re-run would
  produce the same bytes. §10 already establishes that generation is not reproducible.

`scripts/golden/verify.ts` (LH-006, not yet built) must additionally check: every
`rendered+ai-backdrop` case has `referenceBottle`/`scene`/`cameraCondition`/`generationMetadata`
set, its referenced bottle JSON and reference photo exist, and it is `verified: true`.

## 7. QA gates

CP-2 (existing unskippable checkpoint) reviews this corpus alongside the rest of the golden set.
Never weaken a spec to make an eval pass (CLAUDE.md non-negotiable applies here too).

## 8. Testing

Consistent with the original design's rule that CI never calls an image API:

- `imagenPrompt.ts`'s prompt expansion is a pure function. Unit-tested with fixture bottle JSON,
  asserting exact prompt strings. No network.
- The blank-region detector is a pure function over pixels. Unit-tested against synthetic fixture
  images drawn with `sharp` itself (a known cream rectangle at a known position on a colored
  background), asserting it finds the right quad. No dependency on real Gemini output.
- Generation and real compositing run as a manual, dev-time `pnpm golden:imagen` command — network,
  costs money, same posture the original design already established for LH-005.

## 9. Cost

Confirmed against `ai.google.dev/gemini-api/docs/pricing` on 2026-08-11 (standard tier, subject to
change — verify against the live console before a large run): Gemini 3.1 Flash Image is
$0.067/image at 1K resolution, $0.101/image at 2K. A 45-image corpus costs about $3 at 1K, about
$4.50 at 2K. `imagen.ts` logs running spend as it generates. No hard budget ceiling — Troy is
watching billing directly.

## 10. Risks and open questions

- **Detection reliability is unproven.** Gemini may not always honor "leave this area blank and
  this color" precisely. The pilot batch (§5) exists specifically to surface this before the full
  corpus generates.
- **Non-reproducibility.** Unlike `rendered`/`rendered+degraded` cases, re-running generation will
  not byte-for-byte reproduce the same photos. This is why the images are committed, matching the
  existing `ai-generated` precedent.
- **Ticket/Linear impact, deferred to the implementation plan:** LH-005 / TRO-498's description
  in `factory/tickets.md` and Linear still states the original 6-backdrop/5-wild-label scope. The
  implementation plan should update both to match this design.

## 11. Out of scope

- Wrapping the label onto the bottle's curved glass surface in 3D — the compositing step is a flat
  perspective warp into a detected quad, not a true cylindrical projection.
- Any runtime image generation in the deployed app (unchanged from the original design — this is
  a dev-time, golden-set-only dependency).
