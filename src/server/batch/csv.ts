/**
 * A small RFC 4180 CSV tokenizer (PRD §3.5). It turns CSV text into rows
 * of raw string cells, or says exactly where the text stopped being valid
 * CSV. `manifest.ts` gives those cells meaning.
 *
 * It handles comma-delimited fields, quoted fields containing a comma or a
 * newline, a doubled quote as an escaped literal, CRLF and bare LF, a
 * leading UTF-8 BOM, and blank lines. A quoted empty field is a real
 * one-cell record, not a blank line.
 *
 * **Quote placement is strict.** A quote may only open a field as its
 * first character, and only a delimiter, a record end, or EOF may follow
 * the closing quote. `a"b"` and `"a"b` are syntax errors, not silently
 * absorbed as `ab` — a misplaced quote carries the same "the columns may
 * have shifted" risk this module treats as fatal elsewhere.
 *
 * **A bare carriage return is a syntax error**, quoted or not. Dropping it
 * would merge two lines into one cell with no separator between them. That
 * is data corruption, not a cosmetic choice. A real CRLF is unaffected.
 *
 * Every cell is normalized to Unicode NFC, so two files that look
 * identical on screen compare equal downstream.
 */

export interface CsvSyntaxError {
  /** 1-based line number, matching what a user sees in a spreadsheet or
   * text editor. */
  line: number;
  message: string;
}

export type ParseCsvResult = { ok: true; rows: string[][] } | { ok: false; error: CsvSyntaxError };

const BOM = "﻿";

/** True for a row that is really a blank line — no character at all was
 * read for it, not even an empty pair of quotes — as opposed to a
 * genuine record holding only empty values, which a line of bare commas
 * (",,") or a quoted empty field (`""`) both produce on purpose. `hadAny`
 * is `false` only when the record's raw text between two newlines was
 * itself the empty string. */
function isBlankLine(row: string[], hadAny: boolean): boolean {
  return row.length === 1 && row[0] === "" && !hadAny;
}

export function parseCsv(text: string): ParseCsvResult {
  const input = (text.startsWith(BOM) ? text.slice(BOM.length) : text).normalize("NFC");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once no character has been consumed for the CURRENT field yet —
  // the "may a quote open here" test. Reset at every field boundary.
  let fieldStart = true;
  // True immediately after a quoted field's closing quote, until the
  // delimiter/record-end that must follow it is actually consumed.
  let afterClosedQuote = false;
  // True once ANY real CSV syntax (a quote, at least) has been read for
  // the CURRENT record — distinguishes a quoted empty field from a
  // genuinely blank line. Reset at every record boundary.
  let recordHadContent = false;
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
        afterClosedQuote = true;
        i += 1;
        continue;
      }
      if (ch === "\r" && input[i + 1] !== "\n") {
        return {
          ok: false,
          error: {
            line,
            message: `Line ${line} has a carriage return that is not followed by a line feed. Use standard CRLF or LF line endings.`,
          },
        };
      }
      if (ch === "\n") line += 1;
      field += ch;
      i += 1;
      continue;
    }

    if (afterClosedQuote && ch !== "," && ch !== "\r" && ch !== "\n") {
      return {
        ok: false,
        error: {
          line,
          message: `Line ${line} has text right after a closing quote. Wrap the whole field in quotes, or remove the extra text.`,
        },
      };
    }
    afterClosedQuote = false;

    if (ch === '"') {
      if (!fieldStart) {
        return {
          ok: false,
          error: {
            line,
            message: `Line ${line} has a quote in the middle of a field that did not start with one. Wrap the whole field in quotes if it needs one.`,
          },
        };
      }
      inQuotes = true;
      recordHadContent = true;
      fieldStart = false;
      quoteStartLine = line;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      fieldStart = true;
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (input[i + 1] !== "\n") {
        // A bare "\r" with no following "\n" is not a line ending this
        // parser recognizes (classic Mac OS 9 CSVs are not a realistic
        // input in 2026) — and silently dropping it, as an earlier draft
        // did, would merge two lines' content into one cell with no
        // separator between them, an invisible data-corruption risk
        // (review finding). Reject it instead of guessing.
        return {
          ok: false,
          error: {
            line,
            message: `Line ${line} has a carriage return that is not followed by a line feed. Use standard CRLF or LF line endings.`,
          },
        };
      }
      // A genuine CRLF pair — consumed silently here; the paired "\n"
      // ends the record on its own, below.
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (!isBlankLine(row, recordHadContent)) rows.push(row);
      row = [];
      fieldStart = true;
      recordHadContent = false;
      line += 1;
      i += 1;
      continue;
    }

    field += ch;
    fieldStart = false;
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
    if (!isBlankLine(row, recordHadContent)) rows.push(row);
  }

  return { ok: true, rows };
}
