import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiUrl } from "../api";

// "Sign in with Google" via Google Identity Services:
// https://developers.google.com/identity/gsi/web/guides/display-button

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
const SCRIPT_URL = "https://accounts.google.com/gsi/client";

// Every browser on iPhone and iPad is Safari underneath, where Google's sign-in popup often never
// reports back to the page. There we use Google's full-page redirect instead: Google posts the ID
// token to the API, which sends it on to /auth/google (GoogleReturnPage), which returns to the page
// the button was on. iPadOS reports itself as a Mac, so spot it by its touch screen.
const REDIRECT =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Where the redirect started, plus a nonce Google echoes in the token so a stray one is refused.
const PENDING_KEY = "family.googlePending";
// The credential waiting for the button on returnTo to pick up.
const RESULT_KEY = "family.googleResult";

function readSession<T>(key: string): T | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the redirect sign-in will report that it wasn't started here.
  }
}

function tokenNonce(credential: string): string | null {
  try {
    const payload = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(atob(payload)) as { nonce?: string }).nonce ?? null;
  } catch {
    return null;
  }
}

/**
 * Handles the fragment /auth/google is opened with after a redirect sign-in. Returns the page to go
 * back to (whose GoogleButton then signs in), or an error message.
 */
export function finishGoogleRedirect(hash: string): { returnTo: string } | { error: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const pending = readSession<{ returnTo: string; nonce: string }>(PENDING_KEY);
  writeSession(PENDING_KEY, null);
  const credential = params.get("credential");
  if (!credential) return { error: params.get("error") ?? "Google sign-in didn't finish. Please try again." };
  if (!pending || tokenNonce(credential) !== pending.nonce) {
    return { error: "That Google sign-in wasn't started from this browser. Please try again." };
  }
  writeSession(RESULT_KEY, { returnTo: pending.returnTo, credential });
  return { returnTo: pending.returnTo };
}

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(
        config: { client_id: string } & (
          | { ux_mode: "popup"; callback: (response: { credential: string }) => void }
          | { ux_mode: "redirect"; login_uri: string; nonce: string }
        ),
      ): void;
      renderButton(el: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

export const googleSignInEnabled = Boolean(CLIENT_ID);

let scriptPromise: Promise<GoogleIdentityServices> | null = null;

function loadScript(): Promise<GoogleIdentityServices> {
  scriptPromise ??= new Promise((resolve, reject) => {
    if (window.google?.accounts) return resolve(window.google);
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.google ? resolve(window.google) : reject(new Error("Google sign-in didn't load")));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't load Google sign-in"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Renders Google's button; onCredential gets the ID token to send to POST /api/auth/google. */
export function GoogleButton({
  text,
  onCredential,
}: {
  text: "signin_with" | "signup_with" | "continue_with";
  onCredential: (credential: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  // Google keeps one global callback, so route it through a ref to the latest handler.
  const handler = useRef(onCredential);
  handler.current = onCredential;
  const [error, setError] = useState<string | null>(null);
  const returnTo = useLocation().pathname;

  // Back from a redirect sign-in that started on this page.
  useEffect(() => {
    const result = readSession<{ returnTo: string; credential: string }>(RESULT_KEY);
    if (result?.returnTo !== returnTo) return;
    writeSession(RESULT_KEY, null);
    handler.current(result.credential);
  }, [returnTo]);

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;
    loadScript().then(
      (google) => {
        if (cancelled || !el.current) return;
        if (REDIRECT) {
          const nonce = crypto.randomUUID();
          writeSession(PENDING_KEY, { returnTo, nonce });
          google.accounts.id.initialize({
            client_id: CLIENT_ID,
            ux_mode: "redirect",
            login_uri: apiUrl("/api/auth/google/redirect"),
            nonce,
          });
        } else {
          google.accounts.id.initialize({
            client_id: CLIENT_ID,
            ux_mode: "popup",
            callback: (response) => handler.current(response.credential),
          });
        }
        google.accounts.id.renderButton(el.current, { theme: "outline", size: "large", text, shape: "pill", width: 280 });
      },
      (err: Error) => !cancelled && setError(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [text, returnTo]);

  if (!CLIENT_ID) return null;
  return (
    <div className="google">
      <div ref={el} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function OrDivider({ label = "or" }: { label?: string }) {
  return googleSignInEnabled ? <div className="divider">{label}</div> : null;
}
