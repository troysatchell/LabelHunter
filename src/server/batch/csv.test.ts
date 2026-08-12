import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("parses a simple comma-separated file into rows of cells", () => {
    const result = parseCsv("a,b,c\n1,2,3\n");
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b", "c"],
        ["1", "2", "3"],
      ],
    });
  });

  it("treats a quoted field containing a comma as one cell", () => {
    const result = parseCsv('brand,note\n"Smith, Jones & Co",fine\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[1]).toEqual(["Smith, Jones & Co", "fine"]);
  });

  it('unescapes a doubled quote ("") inside a quoted field', () => {
    const result = parseCsv('brand\n"Stone\'s ""Throw"" Distillery"\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[1]).toEqual(['Stone\'s "Throw" Distillery']);
  });

  it("keeps an embedded newline inside a quoted field as one cell, and still counts lines correctly afterward", () => {
    const result = parseCsv('brand,note\n"multi\nline",ok\nnext,row\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      ["brand", "note"],
      ["multi\nline", "ok"],
      ["next", "row"],
    ]);
  });

  it("treats CRLF line endings the same as LF", () => {
    const result = parseCsv("a,b\r\n1,2\r\n");
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
    });
  });

  it("strips a leading UTF-8 BOM so it never becomes part of the first header cell", () => {
    const bom = "﻿";
    const result = parseCsv(`${bom}a,b\n1,2\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0][0]).toBe("a");
  });

  it("ignores a trailing blank line at end of file", () => {
    const result = parseCsv("a,b\n1,2\n\n");
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
    });
  });

  it("ignores a blank line in the middle of the file", () => {
    const result = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b"],
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  it("parses a file with no trailing newline", () => {
    const result = parseCsv("a,b\n1,2");
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
    });
  });

  it("returns ok:true with zero rows for an empty string", () => {
    expect(parseCsv("")).toEqual({ ok: true, rows: [] });
  });

  it("reports an unterminated quoted field as a syntax error naming a line number", () => {
    const result = parseCsv('a,b\n"unterminated,oops\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.line).toBe(2);
    expect(result.error.message).toMatch(/quote/i);
  });

  it("normalizes cell content to NFC (standing rule 20)", () => {
    // Built from explicit Unicode code points (not literal accented
    // characters in this source file) so the two forms below are
    // unambiguous: U+0065 ("e") followed by a combining acute accent
    // (U+0301) is the DECOMPOSED form (NFD) of the same glyph the single
    // precomposed code point U+00E9 renders (NFC). A CSV exported by a
    // different tool can use either form for text that looks identical
    // on screen.
    const nfd = "Caf" + String.fromCharCode(0x65, 0x0301);
    const nfc = "Caf" + String.fromCharCode(0x00e9);
    expect(nfd).not.toBe(nfc); // sanity: the two source forms really differ
    expect(nfd.normalize("NFC")).toBe(nfc);

    const result = parseCsv(`brand\n${nfd}\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[1][0]).toBe(nfc);
  });

  it("keeps a row consisting only of commas (real blank cells, not a blank line)", () => {
    const result = parseCsv("a,b,c\n,,\n");
    expect(result).toEqual({
      ok: true,
      rows: [
        ["a", "b", "c"],
        ["", "", ""],
      ],
    });
  });
});
