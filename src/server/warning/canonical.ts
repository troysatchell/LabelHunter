/**
 * The canonical government-warning text (LH-020 / TRO-468, CP-2 §2).
 *
 * Retrieved live from the eCFR API for 27 CFR 16.21, title 27 issue date
 * 2026-07-06, on 2026-08-11 — **verified**, not assumed (CP-2 §2.1–§2.3;
 * the retrieval command is in CP-2 Appendix B and in this ticket's own
 * report). Cross-checked byte-identical against `docs/PRD.md` §3.4's
 * candidate string and against three ttb.gov pages (malt beverage, wine,
 * distilled spirits). `canonical.test.ts` re-derives this same value from
 * a committed fixture of that retrieval (`fixtures/ecfr-16-21.xml`), so a
 * future edit to this file that drifts from the source fails a test
 * instead of silently shipping (CP-2 §2.7, §9.3).
 */

/**
 * eCFR renders § 16.21 as two separate `<P>` elements inside one
 * `<EXTRACT>`, not one string (CP-2 §2.4). Stored as a two-element tuple
 * rather than one 283-character literal so the code's own shape matches
 * the statute's shape — open question 8, adopted per its recommendation.
 */
export const CANONICAL_WARNING_PARAGRAPHS: readonly [string, string] = [
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects.",
  "(2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
];

/**
 * The joined statement a compliant label prints as one continuous run of
 * text (CP-2 §2.4: TTB's own guidance, not the CFR itself, says the two
 * statutory paragraphs print as one statement — that guidance justifies
 * the join, so this is what `wording-compare.ts` compares candidates
 * against). Joined with a single space, matching CP-2 §2.3's byte
 * comparison against the PRD.
 */
export const CANONICAL_WARNING_TEXT: string = CANONICAL_WARNING_PARAGRAPHS.join(" ");

/**
 * The four word positions CP-2 §5.4 checks capitalization at, with their
 * citations. `GOVERNMENT` and `WARNING` come from 27 CFR 16.22(a)(2)
 * (verified live 2026-08-11: "The first two words of the statement
 * required by § 16.21, i.e., 'GOVERNMENT WARNING,' shall appear in capital
 * letters and in bold type."). `Surgeon` and `General` come from TTB's own
 * *Checklist of Mandatory Label Information* and its 2022 Boot Camp for
 * Brewers deck, which names lower-case `surgeon general` a named common
 * mistake (CP-2 §2.6) — not from the CFR itself. Case is folded everywhere
 * else in the body (CP-2 §5.4: "we enforce rules we can cite, and only
 * those").
 */
export const CHECKED_CAPITALIZATION_WORDS = ["GOVERNMENT", "WARNING", "Surgeon", "General"] as const;
