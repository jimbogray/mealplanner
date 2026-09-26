import type { Address, AddressSuggestion } from "@mealplanner/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useSession } from "../session";
import { ErrorNote, errorMessage } from "./Field";

export function HomeAddress({ address, isAdmin, search }: { address: Address | null; isAdmin: boolean; search: boolean }) {
  const { refresh } = useSession();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm("Remove the family's home address?")) return;
    setError(null);
    try {
      await api.removeAddress();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card">
      <h2>Home address</h2>
      {editing ? (
        <AddressSearch
          onDone={async (saved) => {
            if (saved) await refresh();
            setEditing(false);
          }}
        />
      ) : (
        <>
          {address ? (
            <address className="address">
              {[address.line1, address.line2, address.town, address.county, address.postcode].filter(Boolean).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </address>
          ) : (
            <p className="note">
              {!isAdmin
                ? "No home address yet. A Family Manager can add it."
                : search
                  ? "Add your home address."
                  : "Address search isn't set up yet, so the home address can't be added."}
            </p>
          )}
          {isAdmin && (
            <div className="row">
              {search && (
                <button className={address ? "secondary" : undefined} onClick={() => setEditing(true)}>
                  {address ? "Change address" : "Add address"}
                </button>
              )}
              {address && (
                <button className="link danger" onClick={() => void remove()}>
                  Remove
                </button>
              )}
            </div>
          )}
          <ErrorNote error={error} />
        </>
      )}
    </section>
  );
}

/** A random id for one search, from first keystroke to pick, so Google bills it as one session. */
function newSessionToken(): string {
  return crypto.randomUUID();
}

/** One search box: type part of the address, then pick it from the suggestions. */
function AddressSearch({ onDone }: { onDone: (saved: boolean) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<AddressSuggestion[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(newSessionToken());
  const latest = useRef(0);

  useEffect(() => {
    const query = input.trim();
    if (query.length < 3) {
      setSuggestions(null);
      return;
    }
    const id = ++latest.current;
    const timer = setTimeout(() => {
      api.searchAddress({ input: query, sessionToken: session.current }).then(
        (res) => {
          if (id !== latest.current) return; // A newer search has started.
          setError(null);
          setSuggestions(res.suggestions);
        },
        (err) => id === latest.current && setError(errorMessage(err)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);

  async function pick(s: AddressSuggestion) {
    setSaving(true);
    setError(null);
    try {
      await api.setAddress({ placeId: s.placeId, sessionToken: session.current });
      await onDone(true);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    } finally {
      session.current = newSessionToken();
    }
  }

  return (
    <div className="stack">
      <div className="address-search">
        <input
          type="search"
          aria-label="Search for your address"
          placeholder="Start typing your address or postcode"
          autoComplete="off"
          autoFocus
          maxLength={200}
          disabled={saving}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        {suggestions && (
          <ul className="suggestions" aria-label="Matching addresses">
            {suggestions.length === 0 && <li className="note small">No matching addresses</li>}
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button type="button" disabled={saving} onClick={() => void pick(s)}>
                  <strong>{s.text}</strong>
                  {s.secondaryText && <span className="note small">{s.secondaryText}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ErrorNote error={error} />
      <div>
        <button type="button" className="secondary" onClick={() => void onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
