/**
 * A small RFC 4180 CSV tokenizer (TRO-473 / LH-040, PRD §3.5).
 *
 * This module knows nothing about manifests, application fields, or
 * images — it turns CSV text into rows of raw string cells, or reports
 * exactly where the text stopped being valid CSV. `manifest.ts` is the
 * layer that gives those cells meaning.
 *
 * Handles: comma-delimited fields; double-quoted fields, including a
 * comma or a newline inside one; a doubled quote (`""`) as an escaped
 * literal quote inside a quoted field; both CRLF and bare LF line
 * endings; a leading UTF-8 BOM (common in a spreadsheet program's CSV
 * export); and blank lines, which are skipped rather than turned into a
 * spurious one-cell row (also common at end of file).
 *
 * Every cell is normalized to Unicode NFC (standing rule 20) — two CSV
 * files that look identical on screen must compare equal downstream,
 * whichever export tool produced the accented characters in a brand name
 * or a filename.
 */

export interface CsvSyntaxError {
  /** 1-based line number, matching what a user sees in a spreadsheet or
   * text editor. */
  line: number;
  message: string;
}

export type ParseCsvResult = { ok: true; rows: string[][] } | { ok: false; error: CsvSyntaxError };

const BOM = "﻿";

/** True for a row that is really a blank line (no comma appeared on it,
 * and its one cell is empty) — as opposed to a genuine row of empty
 * cells, which a line of bare commas (",,") produces on purpose. */
function isBlankLine(row: string[]): boolean {
  return row.length === 1 && row[0] === "";
}

export function parseCsv(text: string): ParseCsvResult {
  const input = (text.startsWith(BOM) ? text.slice(BOM.length) : text).normalize("NFC");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  // The line the CURRENTLY OPEN quote started on — distinct from `line`,
  // which keeps advancing for every newline consumed while inside it. An
  // unterminated quote is reported at the line it opened, the line a user
  // would actually go fix, not wherever the parser happened to run out of
  // input after swallowing the rest of the file as one field.
  let quoteStartLine = 1;

  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      quoteStartLine = line;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Consumed silently — the paired "\n" (CRLF) ends the line on its
      // own below. A bare "\r" with no following "\n" is not a line
      // ending this parser recognizes (classic Mac OS 9 CSVs are not a
      // realistic input in 2026); its "\r" is simply dropped.
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (!isBlankLine(row)) rows.push(row);
      row = [];
      line += 1;
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (inQuotes) {
    return {
      ok: false,
      error: { line: quoteStartLine, message: `Line ${quoteStartLine} has a quote that never closes.` },
    };
  }

  // The file did not end with a newline — flush whatever the loop was
  // still building, unless there is nothing to flush (a file that already
  // ended cleanly on its last "\n" leaves field==="" and row===[] here).
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (!isBlankLine(row)) rows.push(row);
  }

  return { ok: true, rows };
}
