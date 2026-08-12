import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MANIFEST_PATH } from "../../src/lib/golden-set/loader";
import { hashManifestContent, hashManifestFile } from "./manifest-hash";

describe("hashManifestContent", () => {
  it("is stable for identical content", () => {
    const text = readFileSync(DEFAULT_MANIFEST_PATH, "utf8");
    expect(hashManifestContent(text)).toBe(hashManifestContent(text));
  });

  it("changes when one case in the manifest is edited (TRO-538 acceptance evidence)", () => {
    const original = readFileSync(DEFAULT_MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(original) as { cases: Array<{ expected: { labelVerdict: string } }> };
    parsed.cases[0].expected.labelVerdict = parsed.cases[0].expected.labelVerdict === "PASS" ? "REVIEW" : "PASS";
    const edited = JSON.stringify(parsed);

    expect(hashManifestContent(edited)).not.toBe(hashManifestContent(original));
  });

  it("does not change when content is byte-identical but the caller re-reads it", () => {
    const first = hashManifestContent("same text");
    const second = hashManifestContent("same text");
    expect(first).toBe(second);
  });

  it("changes on a single trailing whitespace difference — a raw content hash, not a semantic one", () => {
    expect(hashManifestContent('{"a":1}')).not.toBe(hashManifestContent('{"a":1}\n'));
  });
});

describe("hashManifestFile", () => {
  it("reads the real committed manifest and returns a 64-char hex SHA-256 digest", () => {
    const hash = hashManifestFile(DEFAULT_MANIFEST_PATH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches hashManifestContent applied to the same file's own text", () => {
    const text = readFileSync(DEFAULT_MANIFEST_PATH, "utf8");
    expect(hashManifestFile(DEFAULT_MANIFEST_PATH)).toBe(hashManifestContent(text));
  });
});

describe("hashManifestContent — raw bytes, not a decode/re-encode round trip (CodeRabbit finding, TRO-538 triage)", () => {
  it("hashes a Buffer's exact bytes, distinct from decoding it to a string first when a byte sequence is not valid UTF-8", () => {
    // An invalid UTF-8 byte (0xFF, never a valid lead or continuation byte)
    // decodes to the U+FFFD replacement character, then re-encodes to
    // different bytes than the original -- exactly the round-trip gap the
    // fix closes.
    const invalidUtf8Bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x31, 0x7d]); // {"a":<0xFF>1}
    const decodedThenReencoded = Buffer.from(invalidUtf8Bytes.toString("utf8"), "utf8");
    expect(invalidUtf8Bytes.equals(decodedThenReencoded)).toBe(false); // proves the two inputs really do differ

    expect(hashManifestContent(invalidUtf8Bytes)).not.toBe(hashManifestContent(decodedThenReencoded));
  });

  it("hashing the same Buffer twice is stable", () => {
    const bytes = Buffer.from('{"a":1}', "utf8");
    expect(hashManifestContent(bytes)).toBe(hashManifestContent(Buffer.from(bytes)));
  });
});
