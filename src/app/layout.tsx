import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LabelHunter",
  description:
    "AI-powered TTB alcohol label verification prototype (take-home).",
};

// NOTE: intentionally typed as `Readonly<{ children: React.ReactNode }>`
// rather than Next 16's generated `LayoutProps<'/'>` helper. That helper is
// only declared once `.next/types/**` exists, which requires a prior `next
// dev`/`next build` — using it here made `pnpm typecheck` fail on a fresh
// clone that has never been built (TH-R13: buildable from clone).
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
