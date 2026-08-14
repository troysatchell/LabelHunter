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
 *
 * TRO-519: every await below is now bounded by `OCR_TIMEOUT_MS`
 * (`Promise.race` against a timer). Before this ticket, a hung Node
 * `worker_threads` worker — the same failure mode as a `MODULE_NOT_FOUND`
 * inside the spawned worker script — hung `runWarningOcr` forever, and
 * `/api/verify` with it. See `runWarningOcr`'s own comment for the
 * deadline's reasoning and the cancellation investigation.
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
 * How long `runWarningOcr` waits for the ENTIRE worker lifecycle —
 * creation, parameter set, and recognition — before it gives up (TRO-519).
 * Before this ticket, none of those awaits carried a deadline. A Node
 * `worker_threads` worker that spawns but never sends its expected
 * message back — exactly what a module-resolution failure INSIDE the
 * worker script looks like from here, since it neither completes nor
 * rejects — hung `runWarningOcr` forever, and hung `/api/verify` with it
 * (TRO-480's finding).
 *
 * The value is reasoned from PRD §3.8's latency budget, not measured:
 *
 * 1. The OCR channel's own p50 TARGET is ~0.5s. 2000ms is 4x that: room
 *    for a real, slow-but-working recognition on a larger or noisier
 *    crop, so this deadline does not fire on a genuine success.
 * 2. Haiku extraction's own p50 TARGET is ~2.5s, and `index.ts` runs the
 *    two channels concurrently (`Promise.all`). A single OCR hang bounded
 *    at 2000ms stays under Haiku's own typical latency — the hang hides
 *    behind the Haiku call already on the critical path, instead of
 *    becoming the new bottleneck, and still leaves headroom under the
 *    ~5s p95 fast-path total once preprocessing's own ~0.3s is spent.
 *
 * One named risk this value does not close: `region-detect.ts`'s
 * band-search fallback (out of this ticket's scope — TRO-519 touches only
 * `ocr.ts`/`index.ts`) can call this function up to four times
 * sequentially before it gives up on detection. A systemic hang cause (a
 * corrupted committed `tessdata` file, say, not a one-off) hangs every
 * one of those calls alike, so the channel's worst case in that
 * combination is roughly 4x this constant, not 1x. That combination — an
 * unusual label layout AND a systemic OCR hang, at once — is narrower
 * than the single-hang case this ticket targets, and it was INFINITE
 * before this ticket regardless. Bounded-but-large still beats unbounded.
 * Tightening the shared band-search budget itself changes
 * `region-detect.ts`, and belongs to a follow-up ticket, not this one.
 */
export const OCR_TIMEOUT_MS = 2_000;

/** The race's timed-out arm resolves to this, never a real result — a
 * `Symbol` so it can never collide with a genuine `OcrWarningResult`. */
const OCR_TIMED_OUT = Symbol("runWarningOcr timed out");

/**
 * `runWarningOcr`'s one real external call, injectable so a test can
 * supply a `createWorker` that never resolves — the exact shape of a hung
 * worker — without a real multi-second sleep (lessons.md rule 8). Mirrors
 * `index.ts`'s own `CompareGovernmentWarningFromImageDeps` DI shape.
 */
export interface RunWarningOcrDeps {
  createWorker: typeof createWorker;
}

const defaultDeps: RunWarningOcrDeps = { createWorker };

/** The real worker type `createWorker` resolves to, named once so it does
 * not have to be spelled out at every use below. */
type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

/**
 * Terminates `worker` without making the caller wait for it. Fire-and-
 * forget on purpose (local CodeRabbit review round 1, TRO-519 — a major
 * finding): an EARLIER draft `await`ed `worker.terminate()` inside the
 * timeout branch's own cleanup, so a hanging `.terminate()` could extend
 * the very deadline this ticket exists to enforce. A failure is still
 * visible, just asynchronously — logged with the phase named, not a bare
 * `console.warn` (lessons.md rule 24). Guarded against a SYNCHRONOUS
 * throw too, not only a rejected promise, so this function itself can
 * never throw into its caller.
 */
function terminateInBackground(worker: TesseractWorker): void {
  try {
    worker.terminate().catch((terminateError: unknown) => {
      console.error("[warning-ocr] worker.terminate() failed during cleanup", {
        timeoutMs: OCR_TIMEOUT_MS,
        error: terminateError,
      });
    });
  } catch (terminateError) {
    console.error("[warning-ocr] worker.terminate() threw synchronously during cleanup", {
      timeoutMs: OCR_TIMEOUT_MS,
      error: terminateError,
    });
  }
}

/**
 * Runs OCR on an already-cropped warning region and returns its text and
 * confidence. It never throws and never hangs past `OCR_TIMEOUT_MS`. Both
 * follow CP-2 §4.4 rule 3: an OCR failure degrades the answer, it never
 * fails the request.
 *
 * A throw and a timeout both return `null`, the same degraded shape. A
 * successful call that found no text returns `{ text: "", confidence }`,
 * so the confidence floor can still do its own job.
 *
 * **No cancellation exists to use.** Neither `createWorker` nor
 * `Worker.recognize` takes a signal anywhere in `tesseract.js@7.0.0`'s
 * public API, checked against its own declarations and source. So one
 * `Promise.race` is shared across every await in the chain, never a fresh
 * timer per step.
 *
 * **Termination covers a worker that arrives late.** A deadline that fires
 * mid-recognition terminates the handle in the background. A deadline that
 * fires during `createWorker` terminates the worker as soon as it exists,
 * and recognition never runs against it. Nothing can terminate a
 * `createWorker` that never settles at all — but this function still
 * returns within `OCR_TIMEOUT_MS`, which is the point.
 *
 * It creates and terminates one worker per call. Pooling would save the
 * measured ~100–200 ms creation cost, but pooling is a batch-throughput
 * concern (PRD §3.5) and open work here.
 */
export async function runWarningOcr(
  cropImage: Buffer,
  deps: RunWarningOcrDeps = defaultDeps,
): Promise<OcrWarningResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: TesseractWorker | undefined;
  let timedOut = false;

  const deadline = new Promise<typeof OCR_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(OCR_TIMED_OUT);
    }, OCR_TIMEOUT_MS);
  });

  // One chain, one shared deadline (lessons.md rule 23) — creation,
  // parameter set, and recognition all race the SAME timer, never a
  // fresh one per step. `worker` is a normal side-effecting assignment
  // partway through this chain: if creation finishes before the deadline
  // does, the assignment has already run by the time anything below
  // reads it — JS's single-threaded, run-to-completion semantics make
  // this reliable, not a data race.
  const work = (async (): Promise<OcrWarningResult | null> => {
    worker = await deps.createWorker("eng", undefined, {
      langPath: TESSDATA_DIR,
      gzip: true,
      cachePath: TESSDATA_CACHE_DIR,
      cacheMethod: "none",
    });
    if (timedOut) {
      // This worker arrived after the deadline already gave up on it —
      // nobody is still awaiting `work`. Terminate it now instead of
      // leaving it running unattended, and stop here: no
      // setParameters/recognize for a result this function will never
      // return (local CodeRabbit review round 1).
      terminateInBackground(worker);
      return null;
    }
    try {
      await worker.setParameters({ tessedit_pageseg_mode: OCR_PAGE_SEGMENTATION_MODE });
      const { data } = await worker.recognize(cropImage);
      return { text: data.text, confidence: data.confidence };
    } finally {
      // Reached only on a genuinely fast settle (success, or a real
      // throw that is not a hang) — a truly hung recognize() never
      // reaches this line, so it can never race the timeout branch's
      // own termination call below over the same worker.
      terminateInBackground(worker);
    }
  })();

  try {
    const outcome = await Promise.race([work, deadline]);
    if (outcome === OCR_TIMED_OUT) {
      // A worker handle already exists exactly when the deadline landed
      // during setParameters/recognize, after createWorker had already
      // resolved — terminate it now. When no handle exists yet, `work`'s
      // own branch above terminates it once createWorker finally does
      // resolve, late.
      if (worker) terminateInBackground(worker);
      return null;
    }
    return outcome;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
