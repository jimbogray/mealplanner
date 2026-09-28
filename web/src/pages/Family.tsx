import { canSignIn, displayName, type Allergen, type Diet, type FamilyMember, type Invite, type LifeStage, type Me } from "@mealplanner/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, inviteUrl } from "../api";
import { HomeAddress } from "../components/HomeAddress";
import { PreferencesCard } from "../components/Preferences";
import { DietFields, dietSummary } from "../components/DietFields";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { LifeStageBadge, LifeStageSelect } from "../components/LifeStageSelect";
import { useSession } from "../session";

export function FamilyPage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family || !me.member) return <NoFamily />;
  return <FamilyView me={me} isAdmin={me.member.role === "admin"} />;
}

function FamilyView({ me, isAdmin }: { me: Me; isAdmin: boolean }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin) api.invites().then(setInvites, (err) => setInviteError(errorMessage(err)));
  }, [isAdmin, me.members.length]);

  /** Creates an invite (for an existing member, if given) and returns it. */
  const createInvite = useCallback(async (memberId?: string) => {
    const invite = await api.createInvite(memberId);
    setInvites((list) => [invite, ...list]);
    return invite;
  }, []);

  return (
    <div className="stack">
      <Members me={me} isAdmin={isAdmin} invites={invites} onInvite={createInvite} />
      <HomeAddress address={me.family!.address} isAdmin={isAdmin} search={me.addressSearch} />
      <PreferencesCard prefs={me.family!} isAdmin={isAdmin} />
      {isAdmin && <AddMember />}
      {isAdmin && (
        <Invites invites={invites} setInvites={setInvites} onCreate={() => createInvite()} error={inviteError} setError={setInviteError} />
      )}
    </div>
  );
}

function Members({
  me,
  isAdmin,
  invites,
  onInvite,
}: {
  me: Me;
  isAdmin: boolean;
  invites: Invite[];
  onInvite: (memberId: string) => Promise<Invite>;
}) {
  return (
    <section className="card">
      <h1>{me.family!.name}</h1>
      <p className="note">
        {me.members.length} {me.members.length === 1 ? "member" : "members"}
      </p>
      <ul className="members">
        {me.members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            isSelf={m.id === me.member!.id}
            canEdit={isAdmin || m.id === me.member!.id}
            isAdmin={isAdmin}
            invite={invites.find((i) => i.memberId === m.id)}
            onInvite={() => onInvite(m.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({
  member,
  isSelf,
  canEdit,
  isAdmin,
  invite,
  onInvite,
}: {
  member: FamilyMember;
  isSelf: boolean;
  canEdit: boolean;
  isAdmin: boolean;
  invite: Invite | undefined;
  onInvite: () => Promise<Invite>;
}) {
  const { refresh } = useSession();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [familiarName, setFamiliarName] = useState(member.familiarName ?? "");
  const [lifeStage, setLifeStage] = useState<LifeStage>(member.lifeStage);
  const [diet, setDiet] = useState<Diet>(member.diet);
  const [allergies, setAllergies] = useState<Allergen[]>(member.allergies);
  const [wfhDays, setWfhDays] = useState<number[]>(member.workFromHomeDays);
  const [error, setError] = useState<string | null>(null);
  const summary = dietSummary(member.diet, member.allergies);

  function startEditing() {
    setName(member.name);
    setFamiliarName(member.familiarName ?? "");
    setLifeStage(member.lifeStage);
    setDiet(member.diet);
    setAllergies(member.allergies);
    setWfhDays(member.workFromHomeDays);
    setEditing(true);
  }

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
    await run(() =>
      api.updateMember(member.id, {
        name,
        familiarName: familiarName.trim() || null,
        lifeStage,
        diet,
        allergies,
        ...(lifeStage === "adult" ? { workFromHomeDays: wfhDays } : {}),
      }),
    );
  }

  function remove() {
    const question = isSelf ? "Leave this family?" : `Remove ${displayName(member)} from the family?`;
    if (window.confirm(question)) void run(() => api.removeMember(member.id));
  }

  if (editing) {
    return (
      <li>
        <form className="stack" onSubmit={save}>
          <div className="row">
            <input aria-label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <LifeStageSelect value={lifeStage} onChange={setLifeStage} />
          </div>
          <Field
            label="Familiar name"
            htmlFor={`familiar-${member.id}`}
            hint={`Shown on the schedule and around the app instead of ${isSelf ? "your" : "their"} name. Leave blank to use the name.`}
          >
            <input
              id={`familiar-${member.id}`}
              placeholder={`What the family calls ${isSelf ? "you" : "them"}, e.g. Mum`}
              maxLength={40}
              value={familiarName}
              onChange={(e) => setFamiliarName(e.target.value)}
            />
          </Field>
          <DietFields idPrefix={`edit-${member.id}`} diet={diet} allergies={allergies} onDiet={setDiet} onAllergies={setAllergies} />
          {lifeStage === "adult" && <WfhDaysField days={wfhDays} onChange={setWfhDays} />}
          <div className="row">
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
        <ErrorNote error={error} />
      </li>
    );
  }

  return (
    <li>
      <div className="member">
        <div>
          <strong>{displayName(member)}</strong>
          {isSelf && <span className="note"> (you)</span>}
          <div className="note small">
            {member.familiarName && `${member.name} · `}
            {member.email ?? "No login"}
            {member.role === "admin" && " · Family Manager"}
          </div>
          {summary && <div className="diet small">{summary}</div>}
          {member.lifeStage === "adult" && member.workFromHomeDays.length > 0 && (
            <div className="wfh-note small">Works from home: {member.workFromHomeDays.map((d) => WEEKDAYS[d - 1]).join(", ")}</div>
          )}
        </div>
        <LifeStageBadge stage={member.lifeStage} />
        <div className="actions">
          {canEdit && (
            <button className="link" onClick={startEditing}>
              Edit
            </button>
          )}
          {isAdmin && !member.hasAccount && canSignIn(member.lifeStage) && !invite && (
            <button className="link" onClick={() => void run(onInvite)}>
              Invite to sign in
            </button>
          )}
          {isAdmin && !isSelf && (member.hasAccount || member.role === "admin" || canSignIn(member.lifeStage)) && (
            <button
              className="link"
              onClick={() => void run(() => api.updateMember(member.id, { role: member.role === "admin" ? "member" : "admin" }))}
            >
              {member.role === "admin" ? "Remove as Family Manager" : "Make Family Manager"}
            </button>
          )}
          {(isAdmin || isSelf) && (
            <button className="link danger" onClick={remove}>
              {isSelf ? "Leave" : "Remove"}
            </button>
          )}
        </div>
      </div>
      {invite && (
        <p className="note small">
          Sign-in link for {displayName(member)}: <InviteLink invite={invite} />
        </p>
      )}
      <ErrorNote error={error} />
    </li>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** Monday to Friday pills for the days an adult usually works from home; new schedule weeks start from these. */
function WfhDaysField({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <fieldset>
      <legend>Usually works from home</legend>
      <div className="chips">
        {WEEKDAYS.map((label, i) => (
          <label key={label} className="chip toggle wfh">
            <input
              type="checkbox"
              checked={days.includes(i + 1)}
              onChange={(e) => onChange([1, 2, 3, 4, 5].filter((d) => (d === i + 1 ? e.target.checked : days.includes(d))))}
            />
            {label}
          </label>
        ))}
      </div>
      <p className="hint">Filled in on each new week of the schedule; change any day there.</p>
    </fieldset>
  );
}

function InviteLink({ invite }: { invite: Invite }) {
  const [copied, setCopied] = useState(false);
  const url = inviteUrl(invite.code);
  return (
    <span className="invite-link">
      <code>{url}</code>
      <button
        className="link"
        onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true), () => setCopied(false))}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function AddMember() {
  const { refresh } = useSession();
  const [name, setName] = useState("");
  const [lifeStage, setLifeStage] = useState<LifeStage>("child");
  const [diet, setDiet] = useState<Diet>("none");
  const [allergies, setAllergies] = useState<Allergen[]>([]);
  const [coManager, setCoManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.addMember({ name, lifeStage, diet, allergies, role: coManager && canSignIn(lifeStage) ? "admin" : "member" });
      await refresh();
      setName("");
      setDiet("none");
      setAllergies([]);
      setCoManager(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Add a family member</h2>
      <p className="note">
        Anyone in the family, whether or not they'll ever sign in. You can send them a link to sign in as themselves later.
      </p>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <input aria-label="Name" placeholder="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <LifeStageSelect value={lifeStage} onChange={setLifeStage} />
        </div>
        <DietFields idPrefix="add" diet={diet} allergies={allergies} onDiet={setDiet} onAllergies={setAllergies} />
        {canSignIn(lifeStage) && (
          <div>
            <label className="check">
              <input type="checkbox" checked={coManager} onChange={(e) => setCoManager(e.target.checked)} />
              <span>
                <strong>Co-Manager</strong>
                <span className="note small">
                  {" "}
                  Makes them a Family Manager too, able to add, edit and invite family members once they sign in.
                </span>
              </span>
            </label>
          </div>
        )}
        <div>
          <button type="submit" disabled={busy}>
            Add
          </button>
        </div>
      </form>
      <ErrorNote error={error} />
    </section>
  );
}

function Invites({
  invites,
  setInvites,
  onCreate,
  error,
  setError,
}: {
  invites: Invite[];
  setInvites: (update: (list: Invite[]) => Invite[]) => void;
  onCreate: () => Promise<Invite>;
  error: string | null;
  setError: (error: string | null) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      await onCreate();
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
        Create a link and send it to someone (by text, WhatsApp, email…). They'll set up their own login and join the family. To
        give someone you've already added their own login, use “Invite to sign in” next to their name. Each link works once and
        expires after 14 days.
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
              <span className="note small">
                {invite.memberName ? `For ${invite.memberName} · ` : ""}Expires {new Date(invite.expiresAt).toLocaleDateString()}
              </span>
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
