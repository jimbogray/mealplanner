import { useEffect, useRef, useState } from "react";

// "Sign in with Google" via Google Identity Services:
// https://developers.google.com/identity/gsi/web/guides/display-button

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
const SCRIPT_URL = "https://accounts.google.com/gsi/client";

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(config: { client_id: string; callback: (response: { credential: string }) => void; ux_mode?: "popup" }): void;
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

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;
    loadScript().then(
      (google) => {
        if (cancelled || !el.current) return;
        google.accounts.id.initialize({
          client_id: CLIENT_ID,
          ux_mode: "popup",
          callback: (response) => handler.current(response.credential),
        });
        google.accounts.id.renderButton(el.current, { theme: "outline", size: "large", text, shape: "pill", width: 280 });
      },
      (err: Error) => !cancelled && setError(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [text]);

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
