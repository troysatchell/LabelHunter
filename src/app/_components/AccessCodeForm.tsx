"use client";

/**
 * The access-code entry form (TRO-482 / LH-061, PRD §8).
 *
 * Two pieces, on purpose. `AccessCodeFormView` holds all the interactive
 * logic and takes "where to go on success" as a plain prop — no
 * `next/navigation` import, so it renders under plain
 * `@testing-library/react`, no Next router context required.
 * `useRouter()` THROWS ("invariant expected app router to be mounted")
 * outside one — confirmed by reading `next/dist/client/components/
 * navigation.js` directly, not assumed — which would make a component
 * that calls it unconditionally impossible to render in a unit test
 * without mocking Next internals. `AccessCodeForm` is the thin,
 * real-world wrapper `src/app/access-code/page.tsx` renders, supplying
 * the real router; it carries no logic of its own worth testing
 * separately from `AccessCodeFormView`.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { sanitizeRedirectPath } from "../../lib/utils/safe-redirect-path";

const DEFAULT_NEXT = "/";

export interface AccessCodeSubmitResult {
  readonly ok: boolean;
  /** `null` on success. A friendly, specific message on failure — never a
   * bare status code (TH-R20). */
  readonly message: string | null;
}

async function submitAccessCode(code: string): Promise<AccessCodeSubmitResult> {
  try {
    const response = await fetch("/api/access-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (response.ok) return { ok: true, message: null };
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, message: body?.error?.message ?? "That code did not work. Check it and try again." };
  } catch {
    return { ok: false, message: "LabelHunter could not check that code. Check your connection and try again." };
  }
}

export interface AccessCodeFormViewProps {
  /** Injected in tests; defaults to the real `POST /api/access-code` call. */
  submit?: (code: string) => Promise<AccessCodeSubmitResult>;
  /** Called once, with the page to return to, after the server accepts the
   * code. Real callers (`AccessCodeForm` below) navigate there and refresh
   * so the cookie the server just set is picked up by the very next
   * request; tests just record the call. */
  onSuccess: (next: string) => void;
}

/** Client-only read of `?next=`, deliberately NOT `useSearchParams()`:
 * that hook requires a `<Suspense>` boundary around any page that might
 * be statically rendered, which this one small page does not otherwise
 * need. A lazy `useState` initializer, not a `useEffect` + `setState`
 * (that combination cascades a second render for no benefit, and
 * `eslint-plugin-react-hooks` flags it — real finding, fixed here, not
 * suppressed): `window` is undefined during any server render, so this
 * returns the safe default there; on the client it runs once, during the
 * component's first (hydration) render. `next`'s value never appears in
 * rendered DOM output — only inside `handleSubmit`'s closure — so a
 * client value that differs from the server's default causes no
 * hydration mismatch warning; there is nothing visible to mismatch.
 *
 * `?next=` is attacker-controlled input (standing rule 18) — anyone can
 * send a victim a link like `/access-code?next=https://evil.com`.
 * `sanitizeRedirectPath` (TRO-565 finding 1) rejects anything that is not
 * a same-origin, path-relative destination before this value ever reaches
 * `router.push()`. */
function readNextFromLocation(): string {
  if (typeof window === "undefined") return DEFAULT_NEXT;
  const raw = new URLSearchParams(window.location.search).get("next");
  return sanitizeRedirectPath(raw) || DEFAULT_NEXT;
}

export function AccessCodeFormView({ submit = submitAccessCode, onSuccess }: AccessCodeFormViewProps) {
  const [next] = useState(readNextFromLocation);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setErrorMessage("");
    const result = await submit(code);
    if (result.ok) {
      onSuccess(next);
      return;
    }
    setStatus("error");
    setErrorMessage(result.message ?? "That code did not work. Check it and try again.");
  }

  const isLoading = status === "loading";

  return (
    <>
      <form className="access-code-form" onSubmit={handleSubmit} aria-busy={isLoading}>
        <div className="field">
          <label className="field__label" htmlFor="access-code-input">
            Access code
          </label>
          <input
            id="access-code-input"
            name="code"
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="field__input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={isLoading}
            required
          />
        </div>
        <button type="submit" className="primary-button" disabled={isLoading || code.length === 0}>
          {isLoading ? (
            <>
              <span className="busy-spinner" aria-hidden="true" />
              Checking the code…
            </>
          ) : (
            "Continue"
          )}
        </button>
      </form>
      {/* One persistent polite line, present from first render, so the
          in-flight state reaches assistive tech too — before this, the
          only signal was the button's own label swap, which a screen
          reader has no reason to re-read (same WAI-ARIA reasoning as
          VerifyForm's results region). Visually hidden: sighted users
          already see the button. */}
      <p className="visually-hidden" role="status">
        {isLoading ? "Checking the code…" : ""}
      </p>
      {status === "error" && (
        <div className="error-panel" role="alert">
          <p className="error-panel__title">That code did not work</p>
          <p className="error-panel__message">{errorMessage}</p>
        </div>
      )}
    </>
  );
}

/** The real, router-connected form `src/app/access-code/page.tsx` renders. */
export function AccessCodeForm() {
  const router = useRouter();
  return (
    <AccessCodeFormView
      onSuccess={(next) => {
        router.push(next);
        // The cookie was just set by the server; a client-side push alone
        // would reuse the Router Cache's already-fetched (unauthenticated)
        // version of the target page. refresh() re-requests server data
        // for the current route tree, so the very next render reflects the
        // new cookie.
        router.refresh();
      }}
    />
  );
}
