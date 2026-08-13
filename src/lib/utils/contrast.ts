/**
 * WCAG 2.x contrast-ratio math (TRO-573). The same relative-luminance
 * formula TRO-480 and TRO-570 applied by hand to verify color pairs —
 * made into a real, tested function so the next CSS edit is checked by
 * the test suite instead of by a human re-deriving it from a screenshot.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#([0-9a-fA-F]{6})$/;

export function hexToRgb(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex);
  if (!match) {
    throw new Error(`Not a 6-digit hex color: ${JSON.stringify(hex)}`);
  }
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function linearize(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/** WCAG contrast ratio between two colors, 1:1 (identical) to 21:1 (black/white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexToRgb(hexA));
  const luminanceB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA floor for normal-size text (below 18pt / 14pt bold). */
export const WCAG_AA_TEXT = 4.5;

/** WCAG AA floor for large text (at or above 18pt, or 14pt bold) and for a
 * UI component's own visual boundary (WCAG 1.4.11, non-text contrast). */
export const WCAG_AA_UI = 3.0;
