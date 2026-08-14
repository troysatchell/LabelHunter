/**
 * Golden-set end-state assertions (TRO-497 / LH-004): every `rendered` /
 * `rendered+degraded` case's `imagePath` now resolves to a real committed
 * file, scoped so a future `ai-generated` case (a future ticket's job, none
 * exist yet) never fails this check, and every degraded case records the exact
 * `degradations` entry this ticket specified. These metadata assertions pin
 * the manifest values against hardcoded literals in this file; they never
 * read the committed image bytes and never call `degrade.ts`, so they do
 * not by themselves prove a committed image matches its manifest entry — a
 * manifest edit without a `pnpm golden:build` rerun is not caught here.
 *
 * `photographed` cases (TRO-529 / LH-024) are real camera photographs, not
 * this renderer's output — `render.ts`/`build.ts` never touch them
 * (`scripts/golden/build.ts`'s own module comment). The JPEG-format and
 * ~500KB checks below assume a `build.ts`-produced file (always mozjpeg,
 * always tuned to the render pipeline's own size target) and do not apply
 * to a photograph whose format and size this repo does not control — see
 * the "golden-set photographed images" describe block for that
 * provenance's own, differently-scoped checks. This is a provenance-scoped
 * exemption, stated here and in CHANGES.md, not a blanket skip: existence,
 * non-emptiness, and a real decodable raster format are still checked for
 * every `photographed` case, just under bounds that fit a photograph
 * instead of a render.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const manifest = loadGoldenSetManifest();

/** ~500KB per the ticket's "keep the repo sane" target — `build.ts`-produced images only (see module comment above). */
const MAX_IMAGE_BYTES = 500 * 1024;

/** A generous ceiling for a real, uncompressed-by-us camera photograph
 * (TRO-529 / LH-024) — not a repo-size target the way `MAX_IMAGE_BYTES` is
 * for a rendered image, just a backstop against an accidentally-committed,
 * unreasonably large file. The largest of the five adopted photographs
 * (`crown-royal-warning-label-closeup.png`) measures ~1.7MB. */
const MAX_PHOTOGRAPHED_IMAGE_BYTES = 5 * 1024 * 1024;

describe("golden-set committed images", () => {
  it("has a real, non-empty file at imagePath for every rendered/rendered+degraded case", () => {
    const renderable = manifest.cases.filter((c) => c.provenance !== "ai-generated");
    expect(renderable.length).toBeGreaterThan(0);

    for (const c of renderable) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      expect(existsSync(fullPath), `${c.caseId}: expected a file at ${c.imagePath}`).toBe(true);
      expect(
        statSync(fullPath).size,
        `${c.caseId}: ${c.imagePath} exists but is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every ai-generated case's verified flag consistent with whether its image exists", () => {
    // No ai-generated case exists in the manifest yet (a future ticket's
    // job) — this loop is a no-op today. It still runs both directions of
    // the check so it starts failing loudly, not silently, the moment one is added:
    // a verified case must have a real image, and an imageless case must
    // not be verified. Per the loader (src/lib/golden-set/loader.ts), the
    // eval harness may only use a verified ai-generated case.
    const aiGenerated = manifest.cases.filter((c) => c.provenance === "ai-generated");
    for (const c of aiGenerated) {
      const hasImage = existsSync(join(REPO_ROOT, c.imagePath));
      if (c.verified) {
        expect(hasImage, `${c.caseId}: verified ai-generated case must have a real image`).toBe(true);
      }
      if (!hasImage) {
        expect(c.verified, `${c.caseId}: an ai-generated case with no image must not be verified`).toBe(false);
      }
    }
  });

  it("decodes every committed image as an actual JPEG, not just a file with a .jpg name", async () => {
    // Scoped to non-ai-generated, non-photographed: build.ts always
    // mozjpeg-encodes a rendered case's output (this test's own point), but
    // a photographed case's file is a real camera photograph in whatever
    // format the camera/export produced — see this file's module comment.
    const renderable = manifest.cases.filter(
      (c) => c.provenance !== "ai-generated" && c.provenance !== "photographed",
    );
    for (const c of renderable) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      if (!existsSync(fullPath)) continue; // covered by the existence test above
      // sharp's `.metadata()` decodes the file's real header — this catches
      // a build.ts regression that writes, say, a raw PNG buffer to a
      // ".jpg" path, which the existence/size checks above would miss.
      const metadata = await sharp(fullPath).metadata();
      expect(metadata.format, `${c.caseId}: expected JPEG, got ${metadata.format}`).toBe("jpeg");
    }
  });

  it("keeps every committed image well under the ~500KB repo-size target", () => {
    // Scoped to non-ai-generated, non-photographed — see this file's module
    // comment: the ~500KB target is a render-pipeline tuning choice, not a
    // property this repo can impose on a real camera photograph.
    const renderable = manifest.cases.filter(
      (c) => c.provenance !== "ai-generated" && c.provenance !== "photographed",
    );
    for (const c of renderable) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      if (!existsSync(fullPath)) continue; // covered by the existence test above
      const bytes = statSync(fullPath).size;
      expect(bytes, `${c.caseId}: ${bytes} bytes exceeds the ${MAX_IMAGE_BYTES} byte target`).toBeLessThan(
        MAX_IMAGE_BYTES,
      );
    }
  });
});

describe("golden-set photographed images (TRO-529 / LH-024)", () => {
  function photographedCases() {
    return manifest.cases.filter((c) => c.provenance === "photographed");
  }

  it("has exactly the five adopted real-photograph cases, each with a real, non-empty file under assets/golden/references/", () => {
    const photographed = photographedCases();
    expect(photographed.length).toBe(5);
    for (const c of photographed) {
      expect(c.imagePath.startsWith("assets/golden/references/"), c.caseId).toBe(true);
      const fullPath = join(REPO_ROOT, c.imagePath);
      expect(existsSync(fullPath), `${c.caseId}: expected a file at ${c.imagePath}`).toBe(true);
      expect(statSync(fullPath).size, `${c.caseId}: ${c.imagePath} exists but is empty`).toBeGreaterThan(0);
    }
  });

  it("decodes every photographed case as a real raster image (JPEG or PNG), not a renamed non-image file", async () => {
    for (const c of photographedCases()) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      const metadata = await sharp(fullPath).metadata();
      expect(["jpeg", "png"], `${c.caseId}: expected jpeg or png, got ${metadata.format}`).toContain(
        metadata.format,
      );
    }
  });

  it("keeps every photographed case under a generous, non-render-pipeline size ceiling", () => {
    for (const c of photographedCases()) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      const bytes = statSync(fullPath).size;
      expect(
        bytes,
        `${c.caseId}: ${bytes} bytes exceeds the ${MAX_PHOTOGRAPHED_IMAGE_BYTES} byte backstop`,
      ).toBeLessThan(MAX_PHOTOGRAPHED_IMAGE_BYTES);
    }
  });

  it("keeps every photographed case verified: false — only Troy sets that flag (ticket instruction)", () => {
    for (const c of photographedCases()) {
      expect(c.verified, c.caseId).toBe(false);
    }
  });

  it("records governmentWarningPrefixBold/BodyBold as exactly true, false, or \"unknown\" — never a bare guess or any other string", () => {
    const allowed = [true, false, "unknown"];
    for (const c of photographedCases()) {
      expect(allowed, c.caseId).toContain(c.label.governmentWarningPrefixBold);
      expect(allowed, c.caseId).toContain(c.label.governmentWarningBodyBold);
    }
  });
});

describe("golden-set degradations recorded on the manifest (design doc §3)", () => {
  function degradationsOf(caseId: string) {
    return manifest.cases.find((c) => c.caseId === caseId)?.degradations ?? [];
  }

  it("records case-17's glare on the brand region", () => {
    expect(degradationsOf("case-17-glare-front-label")).toEqual([
      { type: "glare", params: { region: "brand", angleDegrees: 25, opacity: 0.85 } },
    ]);
  });

  it("records case-18's glare on the warning region", () => {
    expect(degradationsOf("case-18-glare-warning-block")).toEqual([
      { type: "glare", params: { region: "warning", angleDegrees: -20, opacity: 0.85 } },
    ]);
  });

  it("records case-19's mild, correctable rotation", () => {
    expect(degradationsOf("case-19-rotation-mild-correctable")).toEqual([
      { type: "rotate", params: { angleDegrees: 15 } },
    ]);
  });

  it("records case-20's severe rotation plus blur (rubric V9, blur-to-unreadable)", () => {
    expect(degradationsOf("case-20-rotation-severe-upside-down")).toEqual([
      { type: "rotate", params: { angleDegrees: 180 } },
      { type: "blur", params: { sigma: 18 } },
    ]);
  });

  it("records case-21's strengthened low light (TRO-516 correction C3) plus a small blur", () => {
    expect(degradationsOf("case-21-low-light-front-label")).toEqual([
      {
        type: "low-light",
        params: { region: "front", brightnessFactor: 0.6, contrastFactor: 0.45, noiseAmplitude: 22 },
      },
      { type: "blur", params: { sigma: 1.6 } },
    ]);
  });

  it("records case-22's strengthened low light (TRO-563 correction) plus a small blur", () => {
    expect(degradationsOf("case-22-low-light-warning-block")).toEqual([
      {
        type: "low-light",
        params: { region: "warning", brightnessFactor: 0.5, contrastFactor: 0.38, noiseAmplitude: 30 },
      },
      { type: "blur", params: { sigma: 2.0 } },
    ]);
  });

  it("carries no degradations for tiny-warning-text or odd-typography cases (render-time print choices, not degrade.ts transforms)", () => {
    // case-24-tiny-warning-text-miniature-bottle is gone (TRO-516 C5:
    // merged into case-23, 2026-08-13) — not listed here on purpose.
    // degradationsOf() falls back to `[]` for a caseId the manifest does
    // not have, so a removed ID would still pass this loop silently and
    // stop proving anything for it.
    const renderTimeOnly = [
      "case-23-tiny-warning-text-standard-bottle",
      "case-25-odd-typography-script-brand",
      "case-26-odd-typography-blackletter-class-type",
    ];
    for (const caseId of renderTimeOnly) {
      expect(degradationsOf(caseId), caseId).toEqual([]);
    }
  });

  it("carries no degradations for any clean 'rendered'-provenance case", () => {
    const cleanCases = manifest.cases.filter((c) => c.provenance === "rendered");
    expect(cleanCases.length).toBeGreaterThan(0);
    for (const c of cleanCases) {
      expect(c.degradations ?? [], c.caseId).toEqual([]);
    }
  });
});
