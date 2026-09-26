import { normalisePostcode, type Address } from "@mealplanner/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useSession } from "../session";
import { ErrorNote, errorMessage, Field } from "./Field";

const EMPTY: Address = { line1: "", line2: null, town: "", county: null, postcode: "", latitude: null, longitude: null };

export function HomeAddress({ address, isAdmin, lookup }: { address: Address | null; isAdmin: boolean; lookup: boolean }) {
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
        <AddressForm
          initial={address}
          lookup={lookup}
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
            <p className="note">{isAdmin ? "Add your home address." : "No home address yet. A Family Manager can add it."}</p>
          )}
          {isAdmin && (
            <div className="row">
              <button className={address ? "secondary" : undefined} onClick={() => setEditing(true)}>
                {address ? "Change address" : "Add address"}
              </button>
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

function AddressForm({
  initial,
  lookup,
  onDone,
}: {
  initial: Address | null;
  lookup: boolean;
  onDone: (saved: boolean) => Promise<void>;
}) {
  // With lookup, start at the postcode search; the full form shows once an address is picked
  // or the person chooses to type it in.
  const [manual, setManual] = useState(!lookup || initial !== null);
  const [search, setSearch] = useState(initial?.postcode ?? "");
  const [found, setFound] = useState<Address[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [form, setForm] = useState<Address>(initial ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFound(null);
    setSearching(true);
    try {
      const { addresses } = await api.lookupAddress(search);
      setFound(addresses);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  function pick(index: string) {
    if (!found || index === "") return;
    setForm(found[Number(index)]);
    setManual(true);
  }

  function set<K extends keyof Address>(key: K, value: Address[K]) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Coordinates come from the lookup and only fit the postcode they came with.
      if (key === "postcode" && normalisePostcode(String(value)) !== normalisePostcode(f.postcode)) {
        next.latitude = null;
        next.longitude = null;
      }
      return next;
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setAddress({ ...form, line2: form.line2?.trim() || null, county: form.county?.trim() || null });
      await onDone(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {lookup && (
        <form className="stack" onSubmit={find}>
          <Field label="Find your address by postcode" htmlFor="address-search">
            <div className="row">
              <input
                id="address-search"
                className="postcode"
                required
                maxLength={10}
                autoComplete="postal-code"
                placeholder="e.g. SW1A 2AA"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit" className="secondary" disabled={searching}>
                {searching ? "Finding…" : "Find address"}
              </button>
            </div>
          </Field>
          {found && (
            <Field label={`${found.length} ${found.length === 1 ? "address" : "addresses"} found`} htmlFor="address-pick">
              <select id="address-pick" defaultValue="" onChange={(e) => pick(e.target.value)}>
                <option value="" disabled>
                  Choose your address
                </option>
                {found.map((a, i) => (
                  <option key={i} value={i}>
                    {[a.line1, a.line2, a.town].filter(Boolean).join(", ")}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!manual && (
            <div>
              <button type="button" className="link" onClick={() => setManual(true)}>
                Enter the address yourself
              </button>
            </div>
          )}
        </form>
      )}
      {!manual && <ErrorNote error={error} />}
      {manual ? (
        <form className="stack" onSubmit={save}>
          <Field label="Address line 1" htmlFor="address-line1">
            <input
              id="address-line1"
              required
              maxLength={120}
              autoComplete="address-line1"
              value={form.line1}
              onChange={(e) => set("line1", e.target.value)}
            />
          </Field>
          <Field label="Address line 2 (optional)" htmlFor="address-line2">
            <input
              id="address-line2"
              maxLength={120}
              autoComplete="address-line2"
              value={form.line2 ?? ""}
              onChange={(e) => set("line2", e.target.value)}
            />
          </Field>
          <div className="row">
            <Field label="Town or city" htmlFor="address-town">
              <input
                id="address-town"
                required
                maxLength={80}
                autoComplete="address-level2"
                value={form.town}
                onChange={(e) => set("town", e.target.value)}
              />
            </Field>
            <Field label="County (optional)" htmlFor="address-county">
              <input id="address-county" maxLength={80} value={form.county ?? ""} onChange={(e) => set("county", e.target.value)} />
            </Field>
            <Field label="Postcode" htmlFor="address-postcode">
              <input
                id="address-postcode"
                className="postcode"
                required
                maxLength={10}
                autoComplete="postal-code"
                value={form.postcode}
                onChange={(e) => set("postcode", e.target.value)}
              />
            </Field>
          </div>
          <ErrorNote error={error} />
          <div className="row">
            <button type="submit" disabled={busy}>
              Save address
            </button>
            <button type="button" className="secondary" onClick={() => void onDone(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button type="button" className="secondary" onClick={() => void onDone(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
