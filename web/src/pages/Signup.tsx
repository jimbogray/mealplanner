import type { LifeStage } from "@mealplanner/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { GoogleButton, OrDivider } from "../components/GoogleButton";
import { LifeStageSelect } from "../components/LifeStageSelect";
import { useSession } from "../session";

interface Draft {
  familyName?: string;
  name?: string;
  lifeStage?: LifeStage;
}

function readDraft(key: string): Draft {
  try {
    return (JSON.parse(sessionStorage.getItem(key) ?? "{}") as Draft) ?? {};
  } catch {
    return {};
  }
}

/**
 * Sign-up form. With an inviteCode it joins that family; otherwise it creates a new one.
 * forMember: the invite is for an existing member, whose name and life stage are already set.
 */
export function AccountForm({ inviteCode, forMember, submitLabel }: { inviteCode?: string; forMember?: string | null; submitLabel: string }) {
  const { signIn } = useSession();
  const navigate = useNavigate();
  // Kept for the tab's session, so the form survives Google's full-page redirect sign-in on iPhone.
  const draftKey = `family.signupDraft:${inviteCode ?? ""}`;
  const [draft] = useState(() => readDraft(draftKey));
  const [familyName, setFamilyName] = useState(draft.familyName ?? "");
  const [name, setName] = useState(draft.name ?? "");
  const [lifeStage, setLifeStage] = useState<LifeStage>(draft.lifeStage ?? "adult");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ familyName, name, lifeStage }));
    } catch {
      // Storage blocked: nothing to restore after a redirect.
    }
  }, [draftKey, familyName, name, lifeStage]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const profile = forMember ? {} : { name, lifeStage };
      const res = await api.signup({ email, password, ...profile, ...(inviteCode ? { inviteCode } : { familyName }) });
      signIn(res.token, res.me);
      navigate("/family");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  // Google supplies the email (and a name if "Your name" is blank); the family and life stage come from this form.
  async function withGoogle(credential: string) {
    setError(null);
    if (!inviteCode && !familyName.trim()) {
      setError("Enter your family name first, then continue with Google.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.google({
        credential,
        lifeStage,
        ...(name.trim() ? { name } : {}),
        ...(inviteCode ? { inviteCode } : { familyName }),
      });
      signIn(res.token, res.me);
      navigate("/family");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {!inviteCode && (
        <Field label="Family name" htmlFor="familyName" hint="What your family will see, e.g. “The Grays”.">
          <input id="familyName" required maxLength={80} value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
        </Field>
      )}
      {!forMember && (
        <>
          <Field label="Your name" htmlFor="name">
            <input id="name" required maxLength={80} autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="You are" htmlFor="lifeStage">
            <LifeStageSelect id="lifeStage" value={lifeStage} onChange={setLifeStage} />
          </Field>
        </>
      )}
      <GoogleButton text={inviteCode ? "continue_with" : "signup_with"} onCredential={(c) => void withGoogle(c)} />
      <OrDivider label="or use an email and password" />
      <Field label="Email" htmlFor="email">
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 8 characters.">
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <button type="submit" disabled={busy}>
        {busy ? "Just a moment…" : submitLabel}
      </button>
    </form>
  );
}

export function SignupPage() {
  return (
    <div className="card narrow">
      <h1>Create your family</h1>
      <p className="note">Set up your family, then invite everyone else with a link.</p>
      <AccountForm submitLabel="Create family" />
      <p className="note center">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
