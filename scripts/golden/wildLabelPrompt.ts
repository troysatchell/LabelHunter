/**
 * Prompt compiler for the wild-label track (LH-027 / TRO-530, image-gen
 * design doc §5, job 2, `docs/superpowers/specs/2026-08-10-golden-label-
 * image-gen-design.md`). Job 1 (backdrops, `imagenPrompt.ts`) composites a
 * renderer's exact-text label onto a photo. Job 2 has no renderer step at
 * all: Gemini draws the WHOLE label — brand, class/type, ABV, net
 * contents, and the government warning — as one flat piece of artwork. No
 * bottle, no backdrop, no compositing, no warp (the ticket's own words).
 *
 * The one place that turns a `WildLabelRequest`'s data into the narrative
 * prose Gemini actually reads — the same "keep the compiler boring"
 * guardrail `imagenPrompt.ts` documents for job 1: no LLM-generated prompt
 * layer, no per-request rewriting. `buildWildLabelPrompt` is a pure string
 * template.
 *
 * GROUND TRUTH FLOWS FROM THE IMAGE, NOT ONTO IT. `WildLabelRequest` below
 * records what was ASKED for — the design brief this file sends to Gemini.
 * It is never trusted as ground truth. A human transcribes what actually
 * rendered into each case's `label` fields by looking at the committed
 * image (see `golden-set/wild-labels/README.md`) — a garbled or reworded
 * warning is a valid, useful case, not a failed generation.
 */
import type { BeverageType } from "../../src/lib/golden-set/types";

/**
 * Bumped whenever this file's prompt text changes. Stamped into a
 * generated case's sidecar `generationMetadata.promptVersion` — forensic
 * record-keeping, not a reproducibility claim (image generation is not
 * deterministic regardless of prompt version).
 */
export const WILD_LABEL_PROMPT_VERSION = "v1";

/**
 * One wild label's design brief: what was ASKED for. `brandName`,
 * `classType`, `abvText`, `netContentsText`, and `warningText` are the
 * REQUESTED field content — the same content a real applicant would type
 * into the application form for this fictional product. `designBrief`
 * varies layout, typeface, color, and warning placement across the set
 * (the ticket's explicit requirement) — free narrative prose, not a
 * structured sub-schema, because layout/typeface/color language does not
 * reduce to a handful of enum fields the way `imagenPrompt.ts`'s scene/
 * camera-condition combinations do.
 */
export interface WildLabelRequest {
  readonly caseId: string;
  readonly beverageType: BeverageType;
  readonly brandName: string;
  readonly classType: string;
  /** Empty string requests a label with no alcohol-content statement at all (TTB allows this for some beers, PRD §2). */
  readonly abvText: string;
  readonly netContentsText: string;
  /** The literal statutory warning text requested. What actually renders may differ — see this file's module comment. */
  readonly warningText: string;
  /** Layout, typeface, color scheme, and warning-placement instructions, unique per request. */
  readonly designBrief: string;
}

/**
 * The ~5 wild-label requests (design doc §5, ticket "aim for about 5").
 * Deliberately varied across every axis the ticket names: beverage type,
 * layout, typeface, color, and where the government warning sits on the
 * label. Fictional brands only — every `brandName` below is invented for
 * this repo; the shared guardrail clause in `buildWildLabelPrompt` also
 * tells the model not to depict a real, existing brand or trademark.
 */
export const WILD_LABEL_REQUESTS: readonly WildLabelRequest[] = [
  {
    // Renamed after generation (2026-08-13): the requested design was
    // ornate/Victorian typography, but what actually rendered is a
    // duplicated word fragment in the warning text ("alcoholic\nholic
    // beverages") -- a reworded-warning case, not merely an odd-typography
    // one. Ground truth flows FROM the image (this file's module comment)
    // — the caseId (and this repo's own naming convention, e.g.
    // case-10-reworded-warning-clause-one) follows what was found, not
    // what was asked for.
    caseId: "case-40-reworded-warning-wild-duplicated-word",
    beverageType: "spirits",
    brandName: "Hollow Creek Distillers",
    classType: "Straight Rye Whiskey",
    abvText: "47% Alc./Vol. (94 Proof)",
    netContentsText: "750 mL",
    warningText:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    designBrief:
      "Design direction: an ornate Victorian-style label, deep amber and gold color scheme, an engraved-look decorative border, a wax-seal graphic near the brand name, a bold serif display typeface for the brand name. Place the government warning in a bordered box in the lower third of the label, in a small plain serif font.",
  },
  {
    caseId: "case-41-tiny-warning-text-wild-craft-ipa",
    beverageType: "beer",
    brandName: "Foghorn Brewing Co.",
    classType: "India Pale Ale",
    abvText: "6.8% Alc./Vol.",
    netContentsText: "12 fl oz",
    warningText:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    designBrief:
      "Design direction: a modern minimalist can-front design, bold geometric sans-serif typeface for the brand name, a bright teal-and-orange color-block palette, a simple line-art foghorn icon. Place the government warning as very small print running vertically along the right edge of the label, rotated 90 degrees.",
  },
  {
    caseId: "case-42-odd-typography-wild-script-wine",
    beverageType: "wine",
    brandName: "Amberfield Cellars",
    classType: "Pinot Noir",
    abvText: "13.5% Alc./Vol.",
    netContentsText: "750 mL",
    warningText:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    designBrief:
      "Design direction: an elegant, minimal wine label, muted cream-and-burgundy palette, a delicate flowing script typeface for the brand name, a thin single-line rule under the class/type line. Place the government warning as a single dense paragraph in very small print along the very bottom edge of the label, not boxed.",
  },
  {
    caseId: "case-43-odd-typography-wild-highcontrast-gin",
    beverageType: "spirits",
    brandName: "Vaultline Gin Co.",
    classType: "London Dry Gin",
    abvText: "42% Alc./Vol. (84 Proof)",
    netContentsText: "750 mL",
    warningText:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    designBrief:
      "Design direction: an ultra-modern, high-contrast design, matte black background with neon-green ink, a bold condensed geometric sans-serif typeface, an asymmetric off-center layout. Place the government warning in a small rectangular box tucked into the bottom-left corner, slightly rotated.",
  },
  {
    caseId: "case-44-odd-typography-wild-woodcut-stout",
    beverageType: "beer",
    brandName: "Millrace Stout Works",
    classType: "Oatmeal Stout",
    abvText: "5.4% Alc./Vol.",
    netContentsText: "16 fl oz",
    warningText:
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    designBrief:
      "Design direction: a rustic hand-drawn woodcut illustration style, a warm earthy palette of deep brown and cream, a distressed hand-lettered display font for the brand name, a small woodcut-style illustration of a millwheel. Place the government warning directly beneath the class/type line, in regular (not boxed) small print, the same general style as the rest of the label's body text.",
  },
] as const;

/**
 * Compiles one `WildLabelRequest` into the full prompt Gemini reads.
 * Requests the label ALONE — no bottle, no backdrop, no scene (design doc
 * §5, ticket item 3) — as a flat, front-facing graphic. The fictional-
 * brand guardrail lives here, once, rather than repeated in every
 * request's own text (the same "one place that changes what gets sent"
 * reasoning `imagenPrompt.ts` documents).
 */
export function buildWildLabelPrompt(request: WildLabelRequest): string {
  const fieldLines = [
    `Brand name printed prominently: "${request.brandName}"`,
    `Class/type line: "${request.classType}"`,
    request.abvText ? `Alcohol content line: "${request.abvText}"` : null,
    `Net contents line: "${request.netContentsText}"`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return `Create a flat, front-facing product label graphic for a fictional bottled or canned ${request.beverageType} beverage, as if scanned straight-on with no bottle, no can, no shadow, and no background scene -- just the printed label artwork on a plain neutral background, like a print proof.

${fieldLines}

Government warning statement, printed somewhere on the label:
"${request.warningText}"

${request.designBrief}

This is a fictional brand created for software testing only. Do not depict, reference, or imitate any real, existing brand, distillery, brewery, winery, or trademark.`;
}
