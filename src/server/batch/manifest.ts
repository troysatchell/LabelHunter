/**
 * Turns raw CSV text into validated manifest rows (TRO-473 / LH-040, PRD
 * §3.5, TH-R4, TH-R20). Mirrors `src/app/api/verify/parse-request.ts`'s
 * validation rules field-for-field — the same beverage types, the same
 * alcohol-content range, the same net-contents units — applied once per
 * CSV row instead of once per form submission.
 *
 * Two different kinds of "wrong" are told apart on purpose (this ticket's
 * brief: "a malformed-CSV designed error state ... not a raw parse-error
 * dump"):
 *
 * - A STRUCTURAL problem — unreadable CSV syntax, a missing required
 *   column, a duplicated column, or a row with the wrong number of cells —
 *   makes the whole file unusable. A ragged column count is a strong
 *   signal that columns have shifted somewhere in the file, so guessing
 *   which cell means what from that point on would risk silently
 *   mis-reading a field rather than just failing loudly. The whole parse
 *   fails: `ok: false`, one plain-English message.
 * - A VALUE problem in an otherwise well-formed row — a beverage type
 *   that is not beer/wine/spirits, a non-numeric ABV — affects only that
 *   row. It is reported in `rowErrors`, never silently dropped, while
 *   every other structurally sound row still parses normally.
 */
import { BEVERAGE_TYPES } from "../../lib/db/enums";
import { parseCsv } from "./csv";
import { MANIFEST_COLUMNS, type ManifestColumn, type ManifestRow, type ManifestRowError, type ParseManifestResult } from "./types";

/**
 * Duplicated from `src/app/api/verify/types.ts` on purpose, not imported:
 * that file is the API/UI layer for the single-label route, and `server/*`
 * code does not depend on `app/*` — the dependency runs the other way
 * through this codebase. Three strings, unlikely to drift; if they ever
 * do, every batch row using the new unit fails validation immediately and
 * visibly, rather than silently accepting a value the rest of the app
 * does not recognize.
 */
const NET_CONTENTS_UNIT_OPTIONS: readonly string[] = ["mL", "L", "fl oz"];

function normalizeHeaderName(cell: string): string {
  return cell.trim().toLowerCase();
}

function friendlyCsvSyntaxMessage(rawMessage: string): string {
  return `LabelHunter could not read this CSV file. ${rawMessage}`;
}

export function parseManifest(csvText: string): ParseManifestResult {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) {
    return { ok: false, message: friendlyCsvSyntaxMessage(parsed.error.message) };
  }

  const [headerRow, ...dataRows] = parsed.rows;
  if (!headerRow) {
    return {
      ok: false,
      message: "This CSV file is empty. Add a header row and at least one label, then upload it again.",
    };
  }

  const normalizedHeaders = headerRow.map(normalizeHeaderName);
  const columnIndex = new Map<string, number>();
  const duplicateColumns = new Set<string>();
  normalizedHeaders.forEach((name, idx) => {
    if (columnIndex.has(name)) {
      duplicateColumns.add(name);
    } else {
      columnIndex.set(name, idx);
    }
  });
  if (duplicateColumns.size > 0) {
    const names = [...duplicateColumns].map((c) => `"${c}"`).join(", ");
    return {
      ok: false,
      message: `This CSV has more than one column named ${names}. Remove the duplicate and try again.`,
    };
  }

  const missingColumns = MANIFEST_COLUMNS.filter((col) => !columnIndex.has(col));
  if (missingColumns.length > 0) {
    return {
      ok: false,
      message: `This CSV is missing required columns: ${missingColumns.join(", ")}. Add them and try again.`,
    };
  }

  if (dataRows.length === 0) {
    return {
      ok: false,
      message: "This CSV has a header row but no label rows. Add at least one label, then upload it again.",
    };
  }

  const expectedCellCount = headerRow.length;
  for (let i = 0; i < dataRows.length; i++) {
    const cellCount = dataRows[i].length;
    if (cellCount !== expectedCellCount) {
      const rowNumber = i + 2; // +1: 0-indexed -> 1-indexed; +1: header is row 1
      return {
        ok: false,
        message: `Row ${rowNumber} has ${cellCount} column(s), but the header row has ${expectedCellCount}. Check for a missing or extra comma, then try again.`,
      };
    }
  }

  const cell = (cells: string[], name: ManifestColumn): string => {
    const idx = columnIndex.get(name);
    // Every name in MANIFEST_COLUMNS was already confirmed present above
    // (the missingColumns check returned early otherwise) — this is a
    // defensive assertion, not a real runtime possibility.
    if (idx === undefined) {
      throw new Error(`parseManifest: column "${name}" missing after header validation — this is a bug`);
    }
    return (cells[idx] ?? "").trim().normalize("NFC");
  };

  const rows: ManifestRow[] = [];
  const rowErrors: ManifestRowError[] = [];

  dataRows.forEach((cells, i) => {
    const rowNumber = i + 2;
    const beverageTypeRaw = cell(cells, "beverage_type");
    const brandName = cell(cells, "brand_name");
    const classType = cell(cells, "class_type");
    const alcoholContentRaw = cell(cells, "alcohol_content_percent");
    const netContentsValueRaw = cell(cells, "net_contents_value");
    const netContentsUnit = cell(cells, "net_contents_unit");
    const imageFilename = cell(cells, "image_filename");

    if (!(BEVERAGE_TYPES as readonly string[]).includes(beverageTypeRaw)) {
      rowErrors.push({ rowNumber, message: `Row ${rowNumber}: choose a beverage type: beer, wine, or spirits.` });
      return;
    }
    if (brandName === "") {
      rowErrors.push({ rowNumber, message: `Row ${rowNumber}: enter the brand name.` });
      return;
    }
    if (classType === "") {
      rowErrors.push({ rowNumber, message: `Row ${rowNumber}: enter the class or type.` });
      return;
    }

    let alcoholContentPercent: number | null = null;
    if (alcoholContentRaw !== "") {
      const parsedAbv = Number(alcoholContentRaw);
      if (!Number.isFinite(parsedAbv)) {
        rowErrors.push({
          rowNumber,
          message: `Row ${rowNumber}: enter a number for alcohol content, or leave it blank.`,
        });
        return;
      }
      if (parsedAbv < 0 || parsedAbv > 100) {
        rowErrors.push({
          rowNumber,
          message: `Row ${rowNumber}: enter an alcohol content between 0 and 100, or leave it blank.`,
        });
        return;
      }
      alcoholContentPercent = parsedAbv;
    }

    const netContentsValue = Number(netContentsValueRaw);
    if (!Number.isFinite(netContentsValue) || netContentsValue <= 0) {
      rowErrors.push({ rowNumber, message: `Row ${rowNumber}: enter a net contents amount greater than zero.` });
      return;
    }

    if (!NET_CONTENTS_UNIT_OPTIONS.includes(netContentsUnit)) {
      rowErrors.push({ rowNumber, message: `Row ${rowNumber}: choose a net contents unit: mL, L, or fl oz.` });
      return;
    }

    if (imageFilename === "") {
      rowErrors.push({ rowNumber, message: `Row ${rowNumber}: enter an image filename.` });
      return;
    }

    rows.push({
      rowNumber,
      beverageType: beverageTypeRaw as ManifestRow["beverageType"],
      brandName,
      classType,
      alcoholContentPercent,
      netContentsValue,
      netContentsUnit,
      imageFilename,
    });
  });

  return { ok: true, rows, rowErrors };
}
