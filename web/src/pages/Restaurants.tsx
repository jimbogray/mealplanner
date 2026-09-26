import type { Restaurant, RestaurantInput } from "@mealplanner/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { AverageRating, StarRating } from "../components/Stars";
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

  async function rate(restaurant: Restaurant, stars: number) {
    setError(null);
    try {
      saved(await api.rateRestaurant(restaurant.id, stars));
    } catch (err) {
      setError(errorMessage(err));
    }
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
                    <strong className="restaurant-name">
                      <AverageRating average={r.averageRating} count={r.ratingCount} className="average" />
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer">
                          {r.name}
                        </a>
                      ) : (
                        r.name
                      )}
                    </strong>
                    {(r.cuisine || r.driveMinutes !== null || r.bookingUrl) && (
                      <div className="restaurant-tags">
                        {r.cuisine && <span className="cuisine">{r.cuisine}</span>}
                        {r.driveMinutes !== null && (
                          <span className="drive" title="Driving time from home">
                            🚗 {formatDrive(r.driveMinutes)} from home
                          </span>
                        )}
                        {r.bookingUrl && (
                          <a className="book" href={r.bookingUrl} target="_blank" rel="noopener noreferrer">
                            Book a table
                          </a>
                        )}
                      </div>
                    )}
                    {r.notes && <p className="restaurant-notes">{r.notes}</p>}
                    <p className="note small">
                      {[r.address, r.url && new URL(r.url).hostname.replace(/^www\./, ""), r.addedBy && `added by ${r.addedBy}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <StarRating mine={r.myRating} onRate={(stars) => void rate(r, stars)} />
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

function formatDrive(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
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
  const [address, setAddress] = useState(initial?.address ?? "");
  const [cuisine, setCuisine] = useState(initial?.cuisine ?? "");
  const [bookingUrl, setBookingUrl] = useState(initial?.bookingUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const saved = await onSave({
        name,
        url: url.trim() || null,
        notes: notes.trim() || null,
        address: address.trim() || null,
        cuisine: cuisine.trim() || null,
        bookingUrl: bookingUrl.trim() || null,
      });
      onSaved(saved);
      if (!initial) {
        setName("");
        setUrl("");
        setNotes("");
        setAddress("");
        setCuisine("");
        setBookingUrl("");
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
          <input id={`${id}-url`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Restaurant's website" inputMode="url" />
        </div>
      </div>
      {!initial && <p className="hint">With a link, the cuisine, address and booking link are read from the restaurant's website.</p>}
      <Field
        label="Address or postcode (optional)"
        htmlFor={`${id}-address`}
        hint="Leave blank to read it from the link, or find it by name near home. Used to work out the driving time."
      >
        <input id={`${id}-address`} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} autoComplete="off" />
      </Field>
      {initial && (
        <div className="row">
          <div className="field grow">
            <label htmlFor={`${id}-cuisine`}>Cuisine</label>
            <input id={`${id}-cuisine`} value={cuisine} onChange={(e) => setCuisine(e.target.value)} maxLength={60} placeholder="e.g. Italian" />
          </div>
          <div className="field grow">
            <label htmlFor={`${id}-booking`}>Booking link</label>
            <input id={`${id}-booking`} value={bookingUrl} onChange={(e) => setBookingUrl(e.target.value)} inputMode="url" />
          </div>
        </div>
      )}
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
          {busy ? (url.trim() && url.trim() !== (initial?.url ?? "") ? "Reading the link…" : "Saving…") : submitLabel}
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
