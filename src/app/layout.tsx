import type { Metadata } from "next";
import { SiteHeader } from "./_components/SiteHeader";
import "./globals.css";

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
      <body>
        {/* First stop for a keyboard, before the header's own links
            (Troy's direct request, 2026-08-13). `tabIndex={-1}` on the
            target below is what makes the jump actually move focus, not
            just scroll — a plain <div> is not focusable on its own. */}
        <a className="skip-link" href="#main-content">
          Skip to the main content
        </a>
        <SiteHeader />
        <div id="main-content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}
