import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorNote } from "../components/Field";
import { finishGoogleRedirect } from "../components/GoogleButton";

/** Where Google's redirect sign-in lands (via the API); goes back to the page the button was on. */
export function GoogleReturnPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const result = finishGoogleRedirect(window.location.hash);
    if ("error" in result) setError(result.error);
    else navigate(result.returnTo, { replace: true });
  }, [navigate]);

  if (!error) return <p className="note">Signing in…</p>;
  return (
    <div className="card narrow">
      <h1>Google sign-in problem</h1>
      <ErrorNote error={error} />
      <p className="note">
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  );
}
