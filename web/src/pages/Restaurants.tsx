import type { Restaurant, RestaurantInput, RestaurantPreview } from "@mealplanner/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "../components/Field";
import { PlaceInput, type PickedPlace } from "../components/PlaceInput";
import { AverageRating, StarRating } from "../components/Stars";
import { ChosenCount } from "../components/ChosenCount";
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
  const [groupBy, setGroupBy] = useState<GroupBy | null>(null);
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

  const renderRestaurant = (r: Restaurant) =>
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
        <ChosenCount dates={r.chosenOn} />
        <div className="actions">
          <button className="link" onClick={() => setEditing(r.id)}>
            Edit
          </button>
          <button className="link danger" onClick={() => void remove(r)}>
            Remove
          </button>
        </div>
      </li>
    );

  return (
    <div className="stack">
      <section className="card">
        <h1>Restaurants</h1>
        <p className="note">Your family's favourite places to eat out. Anyone in the family can add, edit or remove them.</p>
        <AddRestaurant onAdded={saved} />
      </section>
      <ErrorNote error={error} />
      {restaurants && restaurants.length === 0 && <p className="note center">No restaurants yet. Add your first one above.</p>}
      {restaurants && restaurants.length > 0 && (
        <div className="group-by" role="group" aria-label="Group restaurants by">
          <span className="note small">Group by</span>
          {GROUPINGS.map((g) => (
            <button
              key={g.key}
              className={groupBy === g.key ? "" : "secondary"}
              aria-pressed={groupBy === g.key}
              onClick={() => setGroupBy((current) => (current === g.key ? null : g.key))}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
      {restaurants && restaurants.length > 0 && !groupBy && (
        <section className="card">
          <ul className="restaurants">{restaurants.map(renderRestaurant)}</ul>
        </section>
      )}
      {restaurants &&
        groupBy &&
        groupRestaurants(restaurants, groupBy).map((group) => (
          <section key={group.label} className="card">
            <h2 className="group-heading">
              {group.label} <span className="note small">({group.restaurants.length})</span>
            </h2>
            <ul className="restaurants">{group.restaurants.map(renderRestaurant)}</ul>
          </section>
        ))}
    </div>
  );
}

type GroupBy = "cuisine" | "drive" | "rating";

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: "cuisine", label: "Cuisine" },
  { key: "drive", label: "Driving Time" },
  { key: "rating", label: "Rating" },
];

const DRIVE_BANDS = [
  { label: "0–15 mins", max: 15 },
  { label: "15–30 mins", max: 30 },
  { label: "30 mins–1 hr", max: 60 },
  { label: "1 hr+", max: Infinity },
];

const STAR_BANDS = [5, 4, 3, 2, 1].map((stars) => ({ stars, label: stars === 1 ? "1 star" : `${stars} stars` }));

/** Splits restaurants into labelled groups, in display order. Restaurants missing the detail go last. */
function groupRestaurants(restaurants: Restaurant[], by: GroupBy): { label: string; restaurants: Restaurant[] }[] {
  const groups = new Map<string, Restaurant[]>();
  let labels: string[];
  let unknown: string;
  let labelOf: (r: Restaurant) => string | null;
  if (by === "drive") {
    labels = DRIVE_BANDS.map((b) => b.label);
    unknown = "Driving time not known";
    labelOf = (r) => (r.driveMinutes == null ? null : DRIVE_BANDS.find((b) => r.driveMinutes! <= b.max)!.label);
  } else if (by === "rating") {
    // By the family's average, rounded down: 4.5 stars sits with the 4s.
    labels = STAR_BANDS.map((b) => b.label);
    unknown = "Not rated yet";
    labelOf = (r) => (r.averageRating == null ? null : (STAR_BANDS.find((b) => r.averageRating! >= b.stars)?.label ?? null));
  } else {
    // Cuisines are free text, so "italian" and "Italian " share a group.
    const names = new Map<string, string>();
    for (const r of restaurants) {
      const c = r.cuisine?.trim();
      if (c && !names.has(c.toLowerCase())) names.set(c.toLowerCase(), c.charAt(0).toUpperCase() + c.slice(1));
    }
    labels = [...names.values()].sort((a, b) => a.localeCompare(b));
    unknown = "Cuisine not known";
    labelOf = (r) => names.get(r.cuisine?.trim().toLowerCase() ?? "") ?? null;
  }
  for (const r of restaurants) {
    const label = labelOf(r) ?? unknown;
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  return [...labels, unknown].filter((l) => groups.has(l)).map((label) => ({ label, restaurants: groups.get(label)! }));
}

function formatDrive(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

type Step =
  | { kind: "link" }
  | { kind: "reading" }
  // What the link says (or nothing, to add one by hand), to check and fill in before saving.
  | { kind: "details"; preview: RestaurantPreview | null };

/** Paste a link → Claude reads the name and details → check, correct or fill them in → save. */
function AddRestaurant({ onAdded }: { onAdded: (restaurant: Restaurant) => void }) {
  const [step, setStep] = useState<Step>({ kind: "link" });
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep({ kind: "link" });
    setUrl("");
  }

  async function read(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStep({ kind: "reading" });
    try {
      const preview = await api.previewRestaurant(url.trim());
      if (preview.alreadySaved) {
        setError(`${preview.alreadySaved} is already one of your restaurants.`);
        setStep({ kind: "link" });
      } else {
        setStep({ kind: "details", preview });
      }
    } catch (err) {
      setError(errorMessage(err));
      setStep({ kind: "link" });
    }
  }

  if (step.kind === "details") {
    return (
      <RestaurantForm
        preview={step.preview}
        submitLabel="Add restaurant"
        onSave={(input) => api.addRestaurant(input)}
        onSaved={(restaurant) => {
          onAdded(restaurant);
          reset();
        }}
        onCancel={reset}
      />
    );
  }

  const reading = step.kind === "reading";
  return (
    <div className="stack">
      <form className="row" onSubmit={(e) => void read(e)}>
        <input
          className="grow"
          type="text"
          inputMode="url"
          aria-label="Restaurant link"
          placeholder="Paste the restaurant's website"
          required
          maxLength={2048}
          disabled={reading}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" disabled={reading}>
          {reading ? "Reading the link…" : "Add"}
        </button>
      </form>
      <p className="hint">
        We'll read its name, cuisine, address and booking link for you to check.{" "}
        <button type="button" className="link" disabled={reading} onClick={() => setStep({ kind: "details", preview: null })}>
          No website? Add it by name
        </button>
      </p>
      <ErrorNote error={error} />
    </div>
  );
}

function RestaurantForm({
  initial,
  preview,
  submitLabel,
  onSave,
  onSaved,
  onCancel,
}: {
  /** The restaurant being edited. */
  initial?: Restaurant;
  /** When adding: what its link said, or null to add one by hand. */
  preview?: RestaurantPreview | null;
  submitLabel: string;
  onSave: (input: RestaurantInput) => Promise<Restaurant>;
  onSaved: (restaurant: Restaurant) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const start = initial ?? preview;
  const [name, setName] = useState(start?.name ?? "");
  const [url, setUrl] = useState(start?.url ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [address, setAddress] = useState(start?.address ?? "");
  const [picked, setPicked] = useState<PickedPlace | null>(null);
  const addressSearch = useSession().me?.addressSearch ?? false;
  const [cuisine, setCuisine] = useState(start?.cuisine ?? "");
  const [bookingUrl, setBookingUrl] = useState(start?.bookingUrl ?? "");
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
        ...picked,
        // What was read from the link has been checked, so save it as is (unless the link was changed).
        readLink: !preview || url.trim() !== preview.url,
      });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // What was read from the link is shown for checking; anything it didn't find is flagged to fill in.
  const read = preview?.found ?? false;
  const cls = (value: string | null | undefined) => (preview && !value ? "missing" : undefined);
  const intro =
    preview === undefined
      ? null
      : preview === null
        ? "Add the restaurant's details."
        : !read
          ? "We couldn't read the restaurant's details from that link. Please fill them in."
          : [preview.name, preview.cuisine, preview.address, preview.bookingUrl].every(Boolean)
            ? "Here's what we found. Check it looks right, then add it."
            : "Here's what we found. Correct anything that's wrong and fill in the gaps.";

  return (
    <form className="panel stack" onSubmit={(e) => void submit(e)}>
      {intro && <p>{intro}</p>}
      <div className="row">
        <div className="field grow">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            id={`${id}-name`}
            className={cls(preview?.name)}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
          />
        </div>
        <div className="field grow">
          <label htmlFor={`${id}-url`}>Link (optional)</label>
          <input id={`${id}-url`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Restaurant's website" inputMode="url" />
        </div>
      </div>
      <Field
        label="Address or ZIP code (optional)"
        htmlFor={`${id}-address`}
        hint={
          preview
            ? "Leave blank to find it by name near home. Used to work out the driving time."
            : "Leave blank to read it from the link, or find it by name near home. Used to work out the driving time."
        }
      >
        <PlaceInput
          id={`${id}-address`}
          className={cls(preview?.address)}
          value={address}
          search={addressSearch}
          onChange={(value, place) => {
            setAddress(value);
            setPicked(place);
          }}
        />
      </Field>
      <div className="row">
        <div className="field grow">
          <label htmlFor={`${id}-cuisine`}>Cuisine</label>
          <input
            id={`${id}-cuisine`}
            className={cls(preview?.cuisine)}
            value={cuisine}
            onChange={(e) => setCuisine(e.target.value)}
            maxLength={60}
            placeholder="e.g. Italian"
          />
        </div>
        <div className="field grow">
          <label htmlFor={`${id}-booking`}>Booking link</label>
          <input
            id={`${id}-booking`}
            className={cls(preview?.bookingUrl)}
            value={bookingUrl}
            onChange={(e) => setBookingUrl(e.target.value)}
            inputMode="url"
            placeholder="OpenTable, Resy or their own page"
          />
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
          {busy ? (url.trim() && url.trim() !== (start?.url ?? "") ? "Reading the link…" : "Saving…") : submitLabel}
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
