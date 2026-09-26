import type { FamilyMember, Invite, LifeStage, Me } from "@mealplanner/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api, inviteUrl } from "../api";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { LifeStageBadge, LifeStageSelect } from "../components/LifeStageSelect";
import { FavouriteRecipes } from "../components/FavouriteRecipes";
import { useSession } from "../session";

export function FamilyPage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family || !me.member) return <NoFamily />;
  const isAdmin = me.member.role === "admin";
  return (
    <div className="stack">
      <Members me={me} isAdmin={isAdmin} />
      <FavouriteRecipes />
      {isAdmin && <AddMember />}
      {isAdmin && <Invites />}
    </div>
  );
}

function Members({ me, isAdmin }: { me: Me; isAdmin: boolean }) {
  return (
    <section className="card">
      <h1>{me.family!.name}</h1>
      <p className="note">
        {me.members.length} {me.members.length === 1 ? "member" : "members"}
      </p>
      <ul className="members">
        {me.members.map((m) => (
          <MemberRow key={m.id} member={m} isSelf={m.id === me.member!.id} canEdit={isAdmin || m.id === me.member!.id} isAdmin={isAdmin} />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({ member, isSelf, canEdit, isAdmin }: { member: FamilyMember; isSelf: boolean; canEdit: boolean; isAdmin: boolean }) {
  const { refresh } = useSession();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [lifeStage, setLifeStage] = useState<LifeStage>(member.lifeStage);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    await run(() => api.updateMember(member.id, { name, lifeStage }));
  }

  function remove() {
    const question = isSelf ? "Leave this family?" : `Remove ${member.name} from the family?`;
    if (window.confirm(question)) void run(() => api.removeMember(member.id));
  }

  if (editing) {
    return (
      <li>
        <form className="row" onSubmit={save}>
          <input aria-label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <LifeStageSelect value={lifeStage} onChange={setLifeStage} />
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
        <ErrorNote error={error} />
      </li>
    );
  }

  return (
    <li>
      <div className="member">
        <div>
          <strong>{member.name}</strong>
          {isSelf && <span className="note"> (you)</span>}
          <div className="note small">
            {member.email ?? "No login"}
            {member.role === "admin" && " · Admin"}
          </div>
        </div>
        <LifeStageBadge stage={member.lifeStage} />
        <div className="actions">
          {canEdit && (
            <button className="link" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {isAdmin && member.hasAccount && !isSelf && (
            <button
              className="link"
              onClick={() => void run(() => api.updateMember(member.id, { role: member.role === "admin" ? "member" : "admin" }))}
            >
              {member.role === "admin" ? "Remove admin" : "Make admin"}
            </button>
          )}
          {(isAdmin || isSelf) && (
            <button className="link danger" onClick={remove}>
              {isSelf ? "Leave" : "Remove"}
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
    </li>
  );
}

function AddMember() {
  const { refresh } = useSession();
  const [name, setName] = useState("");
  const [lifeStage, setLifeStage] = useState<LifeStage>("child");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addMember({ name, lifeStage });
      await refresh();
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Add a family member</h2>
      <p className="note">For someone who won't sign in themselves, like a baby or young child.</p>
      <form className="row" onSubmit={submit}>
        <input aria-label="Name" placeholder="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <LifeStageSelect value={lifeStage} onChange={setLifeStage} />
        <button type="submit" disabled={busy}>
          Add
        </button>
      </form>
      <ErrorNote error={error} />
    </section>
  );
}

function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.invites().then(setInvites, (err) => setError(errorMessage(err)));
  }, []);

  async function create() {
    setError(null);
    try {
      const invite = await api.createInvite();
      setInvites((list) => [invite, ...list]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api.revokeInvite(id);
      setInvites((list) => list.filter((i) => i.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy(invite: Invite) {
    try {
      await navigator.clipboard.writeText(inviteUrl(invite.code));
      setCopied(invite.id);
    } catch {
      setError("Couldn't copy automatically; select the link and copy it instead.");
    }
  }

  return (
    <section className="card">
      <h2>Invite family members</h2>
      <p className="note">
        Create a link and send it to someone (by text, WhatsApp, email…). They'll set up their own login and join the family. Each link
        works once and expires after 14 days.
      </p>
      <button onClick={() => void create()}>Create invite link</button>
      <ErrorNote error={error} />
      {invites.length > 0 && (
        <ul className="invites">
          {invites.map((invite) => (
            <li key={invite.id}>
              <input readOnly aria-label="Invite link" value={inviteUrl(invite.code)} onFocus={(e) => e.target.select()} />
              <button className="secondary" onClick={() => void copy(invite)}>
                {copied === invite.id ? "Copied" : "Copy"}
              </button>
              <button className="link danger" onClick={() => void revoke(invite.id)}>
                Revoke
              </button>
              <span className="note small">Expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoFamily() {
  const { setMe } = useSession();
  const [familyName, setFamilyName] = useState("");
  const [name, setName] = useState("");
  const [lifeStage, setLifeStage] = useState<LifeStage>("adult");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setMe(await api.createFamily({ familyName, name, lifeStage }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card narrow">
      <h1>You're not in a family yet</h1>
      <p className="note">Open an invite link someone sent you, or start a new family.</p>
      <form className="stack" onSubmit={submit}>
        <Field label="Family name" htmlFor="familyName">
          <input id="familyName" required maxLength={80} value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
        </Field>
        <Field label="Your name" htmlFor="name">
          <input id="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="You are" htmlFor="lifeStage">
          <LifeStageSelect id="lifeStage" value={lifeStage} onChange={setLifeStage} />
        </Field>
        <ErrorNote error={error} />
        <button type="submit">Create family</button>
      </form>
    </div>
  );
}
