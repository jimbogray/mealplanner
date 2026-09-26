import type { InvitePreview, LifeStage } from "@mealplanner/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { LifeStageSelect } from "../components/LifeStageSelect";
import { useSession } from "../session";
import { AccountForm } from "./Signup";

export function JoinPage() {
  const { code = "" } = useParams();
  const { me } = useSession();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.previewInvite(code).then(setInvite, (err) => setError(errorMessage(err)));
  }, [code]);

  if (error) {
    return (
      <div className="card narrow">
        <h1>Invite link problem</h1>
        <ErrorNote error={error} />
        <p className="note">
          Ask whoever sent it for a new link, or <Link to="/signup">create your own family</Link>.
        </p>
      </div>
    );
  }
  if (!invite) return <p className="note">Checking your invite…</p>;

  const heading = (
    <>
      <h1>Join {invite.familyName}</h1>
      <p className="note">{invite.invitedBy} invited you to join the family.</p>
    </>
  );

  if (me?.family) {
    return (
      <div className="card narrow">
        {heading}
        <p>
          You're signed in as {me.user.email}, who is already part of <strong>{me.family.name}</strong>. Sign out to join with a
          different account.
        </p>
        <Link to="/family">Back to {me.family.name}</Link>
      </div>
    );
  }

  return (
    <div className="card narrow">
      {heading}
      {me ? (
        <AcceptForm code={code} />
      ) : (
        <>
          <AccountForm inviteCode={code} submitLabel={`Join ${invite.familyName}`} />
          <p className="note center">
            Already have an account?{" "}
            <Link to="/login" state={{ from: `/join/${code}` }}>
              Sign in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

/** For someone already signed in who isn't in a family. */
function AcceptForm({ code }: { code: string }) {
  const { setMe } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [lifeStage, setLifeStage] = useState<LifeStage>("adult");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMe(await api.acceptInvite(code, { name, lifeStage }));
      navigate("/family");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Your name" htmlFor="name">
        <input id="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="You are" htmlFor="lifeStage">
        <LifeStageSelect id="lifeStage" value={lifeStage} onChange={setLifeStage} />
      </Field>
      <ErrorNote error={error} />
      <button type="submit" disabled={busy}>
        Join family
      </button>
    </form>
  );
}
