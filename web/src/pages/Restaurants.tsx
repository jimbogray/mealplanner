import type { Restaurant, RestaurantInput } from "@mealplanner/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { useSession } from "../session";

/** The family's favourite restaurants: a name, an optional link and notes. */
export function RestaurantsPage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family) return <Navigate to="/family" replace />;
  return <Restaurants />;
}

function byName(a: Restaurant, b: Restaurant): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function Restaurants() {
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.restaurants().then(setRestaurants, (err) => setError(errorMessage(err)));
  }, []);

  function saved(restaurant: Restaurant) {
    setRestaurants((list) => [...(list ?? []).filter((r) => r.id !== restaurant.id), restaurant].sort(byName));
  }

  async function remove(restaurant: Restaurant) {
    if (!window.confirm(`Remove ${restaurant.name} from your restaurants?`)) return;
    setError(null);
    try {
      await api.removeRestaurant(restaurant.id);
      setRestaurants((list) => (list ?? []).filter((r) => r.id !== restaurant.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h1>Restaurants</h1>
        <p className="note">Your family's favourite places to eat out. Anyone in the family can add, edit or remove them.</p>
        <RestaurantForm submitLabel="Add restaurant" onSave={(input) => api.addRestaurant(input)} onSaved={saved} />
      </section>
      <ErrorNote error={error} />
      {restaurants && restaurants.length === 0 && <p className="note center">No restaurants yet. Add your first one above.</p>}
      {restaurants && restaurants.length > 0 && (
        <section className="card">
          <ul className="restaurants">
            {restaurants.map((r) =>
              editing === r.id ? (
                <li key={r.id}>
                  <RestaurantForm
                    initial={r}
                    submitLabel="Save"
                    onSave={(input) => api.updateRestaurant(r.id, input)}
                    onSaved={(updated) => {
                      saved(updated);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <li key={r.id} className="restaurant">
                  <div className="restaurant-body">
                    <strong>
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer">
                          {r.name}
                        </a>
                      ) : (
                        r.name
                      )}
                    </strong>
                    {r.notes && <p className="restaurant-notes">{r.notes}</p>}
                    <p className="note small">{[r.url && new URL(r.url).hostname.replace(/^www\./, ""), r.addedBy && `added by ${r.addedBy}`].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="actions">
                    <button className="link" onClick={() => setEditing(r.id)}>
                      Edit
                    </button>
                    <button className="link danger" onClick={() => void remove(r)}>
                      Remove
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

function RestaurantForm({
  initial,
  submitLabel,
  onSave,
  onSaved,
  onCancel,
}: {
  initial?: Restaurant;
  submitLabel: string;
  onSave: (input: RestaurantInput) => Promise<Restaurant>;
  onSaved: (restaurant: Restaurant) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onSaved(await onSave({ name, url: url.trim() || null, notes: notes.trim() || null }));
      if (!initial) {
        setName("");
        setUrl("");
        setNotes("");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={initial ? "panel stack" : "stack"} onSubmit={(e) => void submit(e)}>
      <div className="row">
        <div className="field grow">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </div>
        <div className="field grow">
          <label htmlFor={`${id}-url`}>Link (optional)</label>
          <input id={`${id}-url`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Website, menu or map" inputMode="url" />
        </div>
      </div>
      <Field label="Notes (optional)" htmlFor={`${id}-notes`}>
        <textarea
          id={`${id}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="What to order, when to book, who loves it…"
        />
      </Field>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
