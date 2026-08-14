"use client";

/**
 * The one site header (Troy's direct request, 2026-08-13).
 *
 * Every screen put its way out at the very BOTTOM of the page. A verified
 * label pushes that link below the whole per-field checklist, so returning
 * to the Verify screen meant scrolling past every row first. This header
 * is the constant way out: the wordmark returns home from anywhere, and
 * the three main screens stay one click apart (TH-R3 — no hunting).
 *
 * Two pieces, the same split `AccessCodeForm` uses and for the same
 * reason. `SiteHeaderView` takes the current path as a plain prop, so it
 * renders under `@testing-library/react` with no Next router context.
 * `SiteHeader` is the thin wrapper `layout.tsx` renders; it reads the real
 * path from `usePathname` and carries no logic of its own.
 *
 * The per-page "Back to ..." links stay where they are. They say
 * something this header cannot: which screen you came from.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Verify" },
  { href: "/batch", label: "Batch" },
  { href: "/review-queue", label: "Review queue" },
];

/**
 * True when `href` names the screen the visitor is on now.
 *
 * A detail page keeps its own section marked: `/review-queue/12` marks
 * "Review queue", and `/verify/12` marks "Verify", because a verification
 * detail page belongs to the Verify flow. "/" needs that explicit rule —
 * every path starts with "/", so a prefix test alone would mark "Verify"
 * on every screen in the app.
 */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname === "/verify" || pathname.startsWith("/verify/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface SiteHeaderViewProps {
  /** The path the visitor is on, e.g. `/review-queue/12`. */
  readonly pathname: string;
}

export function SiteHeaderView({ pathname }: SiteHeaderViewProps) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand">
          LabelHunter
        </Link>
        <nav aria-label="Main">
          <ul className="site-nav">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="site-nav__link"
                  // `undefined`, not `"false"`: the attribute must be
                  // absent on every other item, and React renders the
                  // string "false" as a real value assistive tech reads.
                  aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}

/** The real, router-connected header `src/app/layout.tsx` renders. */
export function SiteHeader() {
  // `usePathname` returns null during a static prerender of a route that
  // has no path context yet; "/" is the honest default there, and the
  // client render corrects it before anyone interacts.
  const pathname = usePathname() ?? "/";
  return <SiteHeaderView pathname={pathname} />;
}
