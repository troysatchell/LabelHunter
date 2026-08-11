/**
 * Boundary validation for the verify route's multipart form (TRO-465,
 * standing rule 13 — "validate at the boundary… name the invariant, check
 * explicitly"). `POST`'s `FormData` is untrusted input: a browser bug, a
 * hand-crafted request, or a stale form can send anything. This module is
 * the one place that turns it into a typed, trustworthy `ParsedVerifyInput`
 * — or a specific, human-readable rejection reason (TH-R20). It does not
 * touch the network, the filesystem, or the database, so it is trivial to
 * unit test.
 */
import { BEVERAGE_TYPES, type BeverageType } from "../../../lib/db/enums";
import { NET_CONTENTS_UNIT_OPTIONS } from "./types";

export interface ParsedVerifyInput {
  imageFile: File;
  beverageType: BeverageType;
  brandName: string;
  classType: string;
  /** `null` when the applicant left the field blank — legal for beer/wine
   * (PRD §2, `required-fields.ts`'s "verify" cell). */
  alcoholContentPercent: number | null;
  netContentsValue: number;
  netContentsUnit: string;
}

export type ParseVerifyFormDataResult =
  | { ok: true; value: ParsedVerifyInput }
  | { ok: false; message: string };

function readTrimmedString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

/** Parses a form field into a finite number, or `null` when the field is
 * blank/absent. Returns `undefined` (distinct from `null`) when the field
 * was present but not a valid number — the caller turns that into its own
 * rejection message. */
function readOptionalNumber(formData: FormData, key: string): number | null | undefined {
  const raw = formData.get(key);
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  if (typeof raw !== "string") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Validates and narrows `formData` into a `ParsedVerifyInput`. Every check
 * is explicit and named — no `!value` catch-all — so a caller can trust the
 * result shape without re-checking, and a rejection always carries a
 * message a first-time user (TH-R3) can act on without a developer console.
 */
export function parseVerifyFormData(formData: FormData): ParseVerifyFormDataResult {
  const imageEntry = formData.get("image");
  if (!(imageEntry instanceof File) || imageEntry.size === 0) {
    return { ok: false, message: "Add a label photo before you verify." };
  }

  const beverageTypeRaw = readTrimmedString(formData, "beverageType");
  if (!(BEVERAGE_TYPES as readonly string[]).includes(beverageTypeRaw)) {
    return { ok: false, message: "Choose a beverage type: beer, wine, or spirits." };
  }

  const brandName = readTrimmedString(formData, "brandName");
  if (brandName === "") {
    return { ok: false, message: "Enter the brand name." };
  }

  const classType = readTrimmedString(formData, "classType");
  if (classType === "") {
    return { ok: false, message: "Enter the class or type." };
  }

  const alcoholContentPercent = readOptionalNumber(formData, "alcoholContentPercent");
  if (alcoholContentPercent === undefined) {
    return { ok: false, message: "Enter a number for alcohol content, or leave it blank." };
  }
  if (alcoholContentPercent !== null && (alcoholContentPercent < 0 || alcoholContentPercent > 100)) {
    return { ok: false, message: "Enter an alcohol content between 0 and 100, or leave it blank." };
  }

  const netContentsValueRaw = readOptionalNumber(formData, "netContentsValue");
  if (netContentsValueRaw === undefined || netContentsValueRaw === null || netContentsValueRaw <= 0) {
    return { ok: false, message: "Enter a net contents amount greater than zero." };
  }

  const netContentsUnit = readTrimmedString(formData, "netContentsUnit");
  if (!NET_CONTENTS_UNIT_OPTIONS.includes(netContentsUnit)) {
    return { ok: false, message: "Choose a net contents unit: mL, L, or fl oz." };
  }

  return {
    ok: true,
    value: {
      imageFile: imageEntry,
      beverageType: beverageTypeRaw as BeverageType,
      brandName,
      classType,
      alcoholContentPercent,
      netContentsValue: netContentsValueRaw,
      netContentsUnit,
    },
  };
}
