/**
 * The tesseract.js OCR wrapper (LH-020 / TRO-468, CP-2 §4.3, §8.3, TH-R7).
 *
 * Crop-only, never the full image (CP-2 §4.4) — the caller passes an
 * already-cropped warning-region buffer (`region-detect.ts` finds the
 * region; `../preprocessing/pipeline.ts`'s `cropRegion` cuts it from the
 * ORIGINAL full-resolution image, never the resized model-input variant —
 * CP-2 §8.3's DPI math is why). Language data is committed to the repo at
 * `tessdata/`, so recognition never reaches the network — the exact
 * failure TH-R7 exists to prevent. `ocr-startup.test.ts` is the dedicated
 * test that proves this with the network disabled; this module is the
 * code that test exercises.
 *
 * PSM (page segmentation mode) is set to `SINGLE_BLOCK` — the warning
 * prints as one dense paragraph in a known region, not a full page with
 * mixed columns. `oem` (OCR engine mode) is left at the library's own
 * default, `LSTM_ONLY` — the committed language file is the matching
 * `_best_int` (LSTM-only) variant, not the larger legacy+LSTM "best" file
 * (CP-2 §4.3's package facts; this ticket's own report explains the size
 * tradeoff).
 */
import path from "node:path";
import os from "node:os";
import { createWorker, PSM } from "tesseract.js";

/** Where the committed language data lives — a repo-root directory, not
 * under `src/`, mirroring `golden-set/`'s own convention for a committed
 * binary asset (CP-2 §4.3's implementation requirement: "Commit the
 * language data to the repo... Set `langPath` to that directory"). */
export const TESSDATA_DIR = path.join(process.cwd(), "tessdata");

/** The exact filename tesseract.js's own loader builds for `langPath` +
 * `gzip: true`: `` `${langPath}/${lang}.traineddata${gzip ? '.gz' : ''}` ``
 * — confirmed by reading the installed `tesseract.js` v7.0.0 source
 * (`worker-script/index.js`), not assumed from the docs. A mismatched
 * filename here is exactly the failure CP-2 §4.3 warns produces a silent
 * fall-through toward the network path. */
export const TESSDATA_LANGUAGE_FILE = "eng.traineddata.gz";

/** A writable scratch directory for tesseract.js's own on-disk cache
 * (distinct from `TESSDATA_DIR`, which is committed and read-only in
 * production). Not `var/`, because this is engine-internal cache data,
 * not an application artifact — `cacheMethod: "none"` below means nothing
 * is actually written here, but tesseract.js still requires a path. */
const TESSDATA_CACHE_DIR = path.join(os.tmpdir(), "labelhunter-tessdata-cache");

/** CP-2 §4.3: "Page segmentation should be set to a single-block mode
 * rather than the default auto mode; the exact constant is proposed and
 * LH-020 confirms the name against tesseract.js's PSM enum before quoting
 * it anywhere." Confirmed against the installed library's
 * `src/constants/PSM.js`: `SINGLE_BLOCK: '6'`. */
export const OCR_PAGE_SEGMENTATION_MODE = PSM.SINGLE_BLOCK;

export interface OcrWarningResult {
  /** Tesseract's raw recognized text — NOT normalized. `reconcile.ts`
   * runs it through the same `evaluateCandidate` pipeline as the VLM
   * channel, so normalization happens exactly once, identically, for
   * both channels. */
  text: string;
  /** Tesseract's `MeanTextConf()`, 0-100 (CP-2 §4.3). */
  confidence: number;
}

/**
 * Runs OCR on an already-cropped warning-region image and returns its
 * text and confidence. Never throws — CP-2 §4.4 rule 3: "An OCR failure
 * degrades the answer; it never fails the request... A crashed OCR worker
 * must not produce a 500 on a label the vision model read fine." Returns
 * `null` when recognition itself could not run at all (a thrown error
 * from the underlying library); a successful call that simply found no
 * text returns `{ text: "", confidence }`, not `null` — that distinction
 * lets `reconcile.ts`'s confidence floor do its own job.
 *
 * Creates and terminates one worker per call. A pooled/reused worker
 * would shave the ~100-200ms creation cost this ticket measured, but
 * pooling is a batch-throughput concern (PRD §3.5's worker pool, CP-3) —
 * out of scope here, and named as a follow-up rather than built
 * speculatively.
 */
export async function runWarningOcr(cropImage: Buffer): Promise<OcrWarningResult | null> {
  try {
    const worker = await createWorker("eng", undefined, {
      langPath: TESSDATA_DIR,
      gzip: true,
      cachePath: TESSDATA_CACHE_DIR,
      cacheMethod: "none",
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: OCR_PAGE_SEGMENTATION_MODE });
      const { data } = await worker.recognize(cropImage);
      return { text: data.text, confidence: data.confidence };
    } finally {
      await worker.terminate();
    }
  } catch {
    return null;
  }
}
