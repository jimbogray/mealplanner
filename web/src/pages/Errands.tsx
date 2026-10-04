import {
  displayName,
  errandLinks,
  MAX_ERRAND_NAME,
  type Errand,
  type ErrandHistoryEntry,
  type FamilyMember,
} from "@mealplanner/shared";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, apiUrl } from "../api";
import { ErrorNote, errorMessage } from "../components/Field";
import { useSession } from "../session";

/** Errands the family takes turns at: whose turn it is, a Done button, links for other apps, and what happened when. */
export function ErrandsPage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family) return <Navigate to="/family" replace />;
  return <Errands members={me.members} />;
}

function Errands({ members }: { members: FamilyMember[] }) {
  const [errands, setErrands] = useState<Errand[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.errands().then(setErrands, (err) => setError(errorMessage(err)));
  }, []);

  const replace = (saved: Errand) => setErrands((list) => (list ?? []).map((e) => (e.id === saved.id ? saved : e)));

  return (
    <div className="stack">
      <section className="card">
        <div className="week-head">
          <h1>Errands</h1>
          {!adding && (
            <span className="week-actions">
              <button className="small" onClick={() => setAdding(true)}>
                + New errand
              </button>
            </span>
          )}
        </div>
        <p className="note">
          Take turns at jobs like walking the dog. Press Done when it's been done and it moves on to the next person. Each errand
          has its own links so another app can ask whose turn it is, or move it on.
        </p>
        {adding && (
          <ErrandForm
            members={members}
            onSaved={(saved) => {
              setErrands((list) => [...(list ?? []), saved].sort((a, b) => a.name.localeCompare(b.name)));
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </section>
      <ErrorNote error={error} />
      {errands === null && !error && <p className="note center">Loading…</p>}
      {errands?.length === 0 && !adding && <p className="note center">No errands yet. Add one to start taking turns.</p>}
      {errands?.map((e) => (
        <ErrandCard
          key={e.id}
          errand={e}
          members={members}
          onChange={replace}
          onRemoved={() => setErrands((list) => (list ?? []).filter((x) => x.id !== e.id))}
        />
      ))}
    </div>
  );
}

/** Adds an errand, or changes one's name and who takes part (in the order they're ticked). */
function ErrandForm({
  members,
  errand,
  onSaved,
  onCancel,
}: {
  members: FamilyMember[];
  errand?: Errand;
  onSaved: (errand: Errand) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(errand?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(errand?.memberIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the errand a name.");
    if (!memberIds.length) return setError("Choose who takes turns.");
    setSaving(true);
    setError(null);
    try {
      const body = { name, memberIds };
      onSaved(errand ? await api.updateErrand(errand.id, body) : await api.addErrand(body));
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const order = (id: string) => memberIds.indexOf(id) + 1;

  return (
    <form className="event-form" onSubmit={(e) => void save(e)}>
      <label className="event-title">
        <span>Errand</span>
        <input
          autoFocus
          maxLength={MAX_ERRAND_NAME}
          placeholder="e.g. Walk the dog"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="chips" role="group" aria-label="Who takes turns">
        {members.map((m) => (
          <label key={m.id} className="chip toggle">
            <input
              type="checkbox"
              checked={memberIds.includes(m.id)}
              onChange={(e) => setMemberIds((ids) => (e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id)))}
            />
            {displayName(m)}
            {order(m.id) > 0 && <span className="turn-order">{order(m.id)}</span>}
          </label>
        ))}
      </div>
      <p className="hint">Turns go in the order people are ticked.</p>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" className="small" disabled={saving}>
          {errand ? "Save errand" : "Add errand"}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ErrandCard({
  errand,
  members,
  onChange,
  onRemoved,
}: {
  errand: Errand;
  members: FamilyMember[];
  onChange: (errand: Errand) => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string | null) => {
    const m = members.find((x) => x.id === id);
    return m ? displayName(m) : null;
  };
  const turn = nameOf(errand.turnMemberId);
  const next = nameOf(errand.nextMemberId);

  async function run(action: () => Promise<Errand | void>) {
    setBusy(true);
    setError(null);
    try {
      const saved = await action();
      if (saved) onChange(saved);
    } catch (err) {
      setError(errorMessage(err));
      // Someone else may have moved it on: show where it's at now.
      api.errands().then(
        (list) => {
          const now = list.find((e) => e.id === errand.id);
          if (now) onChange(now);
        },
        () => {},
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${errand.name}" and its history? Its links stop working.`)) return;
    setBusy(true);
    try {
      await api.removeErrand(errand.id);
      onRemoved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <section className="card">
        <ErrandForm
          members={members}
          errand={errand}
          onSaved={(saved) => {
            onChange(saved);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
  }

  return (
    <section className="card errand">
      <div className="week-head">
        <h2>{errand.name}</h2>
        <span className="week-actions">
          <button className="link small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="link danger small" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        </span>
      </div>
      <div className="errand-turn">
        <div>
          <p className="turn-now">{turn ? `${turn}'s turn` : "Nobody's turn"}</p>
          {next && next !== turn && <p className="note small">Next: {next}</p>}
        </div>
        <button
          disabled={busy || !turn}
          onClick={() => void run(() => api.errandDone(errand.id, { turnMemberId: errand.turnMemberId }))}
          title="It's been done: move on to the next person"
        >
          Done, next turn
        </button>
      </div>
      {errand.memberIds.length > 1 && (
        <label className="turn-pick">
          <span className="note small">Make it someone else's turn</span>
          <select
            value={errand.turnMemberId ?? ""}
            disabled={busy}
            onChange={(e) => void run(() => api.setErrandTurn(errand.id, { memberId: e.target.value }))}
          >
            {errand.memberIds.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorNote error={error} />
      <ErrandLinks errand={errand} busy={busy} onNewLinks={() => void run(() => api.newErrandLinks(errand.id))} />
      <History entries={errand.history} />
    </section>
  );
}

/** The public links, with copy buttons and a way to replace them if they've got out. */
function ErrandLinks({ errand, busy, onNewLinks }: { errand: Errand; busy: boolean; onNewLinks: () => void }) {
  const links = errandLinks(errand.linkToken);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <details className="errand-links">
      <summary>Links for other apps</summary>
      <div className="errand-links-body">
        <p className="hint">
          No sign-in needed: anyone with a link can use it, so share them only with apps you trust. They answer with just the
          name; add <code>?format=json</code> for the errand, whose turn it is and who's next.
        </p>
        {[
          { label: "Whose turn", url: apiUrl(links.turn) },
          { label: "Next turn (moves it on, like pressing Done)", url: apiUrl(links.next) },
        ].map(({ label, url }) => (
          <div key={label} className="errand-link">
            <span className="note small">{label}</span>
            <div className="add-extra-form">
              <input readOnly value={url} aria-label={label} onFocus={(e) => e.target.select()} />
              <button type="button" className="secondary small" onClick={() => void copy(url)}>
                {copied === url ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="link small"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Make new links? The old ones stop working, so any app using them needs the new ones."))
              onNewLinks();
          }}
        >
          Make new links
        </button>
      </div>
    </details>
  );
}

const ACTIONS: Record<ErrandHistoryEntry["action"], string> = {
  created: "Set up",
  done: "Done",
  turn: "Turn changed",
  changed: "Errand changed",
  link: "New links made",
};

function when(at: string): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What happened when, newest first: the latest few, or all of it. */
function History({ entries }: { entries: ErrandHistoryEntry[] }) {
  const [all, setAll] = useState(false);
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, 5);
  return (
    <div className="errand-history">
      <h3>History</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Whose turn</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((h) => (
              <tr key={h.id}>
                <td>{when(h.at)}</td>
                <td>{ACTIONS[h.action]}</td>
                <td>
                  {h.turnName && h.nextName && h.turnName !== h.nextName
                    ? `${h.turnName} → ${h.nextName}`
                    : (h.nextName ?? h.turnName ?? "")}
                </td>
                <td>{h.viaLink ? <span className="via-link">Link</span> : h.byName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length > 5 && (
        <button className="link small" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      )}
    </div>
  );
}
