import type { FavouriteRecipe, RecipePreview } from "@mealplanner/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "./Field";

/** The family's favourite recipes: links to recipe pages that anyone in the family can add or remove. */
export function FavouriteRecipes() {
  const [recipes, setRecipes] = useState<FavouriteRecipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.recipes().then(setRecipes, (err) => setError(errorMessage(err)));
  }, []);

  async function remove(recipe: FavouriteRecipe) {
    if (!window.confirm(`Remove "${recipe.name}" from your favourites?`)) return;
    setError(null);
    try {
      await api.removeRecipe(recipe.id);
      setRecipes((list) => (list ?? []).filter((r) => r.id !== recipe.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card">
      <h2>Favourite recipes</h2>
      <p className="note">Paste a link to a recipe page your family loves. Everyone in the family can see, add and remove them.</p>
      <AddRecipe onAdded={(recipe) => setRecipes((list) => [recipe, ...(list ?? [])])} />
      <ErrorNote error={error} />
      {recipes && recipes.length === 0 && <p className="note small">No favourites yet.</p>}
      {recipes && recipes.length > 0 && (
        <ul className="recipes">
          {recipes.map((r) => (
            <li key={r.id}>
              <a className="recipe" href={r.url} target="_blank" rel="noopener noreferrer">
                <Thumb src={r.imageUrl} />
                <span>
                  <strong>{r.name}</strong>
                  {r.description && <span className="small">{r.description}</span>}
                  <span className="note small">{recipeFacts(r)}</span>
                </span>
              </a>
              <button className="link danger" onClick={() => void remove(r)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function recipeFacts(r: FavouriteRecipe): string {
  return [
    r.cookingMinutes && formatMinutes(r.cookingMinutes),
    r.mainProtein,
    r.siteName ?? new URL(r.url).hostname.replace(/^www\./, ""),
    r.addedBy && `added by ${r.addedBy}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function Thumb({ src }: { src: string | null }) {
  return src ? (
    <img className="thumb" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="thumb placeholder" aria-hidden="true">
      🍽
    </span>
  );
}

type Step =
  | { kind: "link" }
  | { kind: "reading"; url: string }
  // The page doesn't look like a recipe: ask before going further.
  | { kind: "confirm"; preview: RecipePreview }
  | { kind: "details"; preview: RecipePreview };

/** Paste a link → the API reads the page → check (or fill in) the details → save. */
function AddRecipe({ onAdded }: { onAdded: (recipe: FavouriteRecipe) => void }) {
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
    setStep({ kind: "reading", url });
    try {
      const preview = await api.previewRecipe(url);
      if (preview.alreadySaved) {
        setError("That recipe is already one of your favourites.");
        setStep({ kind: "link" });
      } else {
        setStep(preview.isRecipe === false ? { kind: "confirm", preview } : { kind: "details", preview });
      }
    } catch (err) {
      setError(errorMessage(err));
      setStep({ kind: "link" });
    }
  }

  if (step.kind === "confirm") {
    return (
      <div className="panel">
        <p>
          <strong>This page doesn't look like a recipe.</strong> Are you sure you want to add it to your favourites?
        </p>
        <p className="note small">{step.preview.url}</p>
        <div className="row">
          <button onClick={() => setStep({ kind: "details", preview: step.preview })}>Add it anyway</button>
          <button className="secondary" onClick={reset}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === "details") {
    return (
      <RecipeDetailsForm
        preview={step.preview}
        onCancel={reset}
        onSaved={(recipe) => {
          onAdded(recipe);
          reset();
        }}
      />
    );
  }

  const reading = step.kind === "reading";
  return (
    <>
      <form className="row" onSubmit={read}>
        <input
          className="grow"
          type="text"
          inputMode="url"
          aria-label="Recipe link"
          placeholder="https://…"
          required
          maxLength={2048}
          disabled={reading}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" disabled={reading}>
          {reading ? "Reading the recipe…" : "Add"}
        </button>
      </form>
      <ErrorNote error={error} />
    </>
  );
}

function RecipeDetailsForm({
  preview,
  onCancel,
  onSaved,
}: {
  preview: RecipePreview;
  onCancel: () => void;
  onSaved: (recipe: FavouriteRecipe) => void;
}) {
  const [name, setName] = useState(preview.name ?? "");
  const [description, setDescription] = useState(preview.description ?? "");
  const [minutes, setMinutes] = useState(preview.cookingMinutes?.toString() ?? "");
  const [protein, setProtein] = useState(preview.mainProtein ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What was read automatically is shown for checking; anything missing is flagged to fill in.
  const found = preview.isRecipe === true;
  const missing = {
    name: !found || !preview.name,
    description: !preview.description,
    minutes: !preview.cookingMinutes,
    protein: !preview.mainProtein,
  };
  const anyMissing = Object.values(missing).some(Boolean);
  const intro =
    preview.isRecipe === null
      ? "We couldn't read that page automatically. Please fill in the details."
      : preview.isRecipe === false
        ? "Please fill in the details we couldn't find."
        : anyMissing
          ? "Here's what we found. Please fill in the gaps."
          : "Here's what we found. Check it looks right, then save.";

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.addRecipe({
          url: preview.url,
          name,
          description: description || null,
          cookingMinutes: minutes ? Number(minutes) : null,
          mainProtein: protein || null,
          imageUrl: preview.imageUrl,
          siteName: preview.siteName,
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const cls = (isMissing: boolean) => (isMissing ? "missing" : undefined);
  return (
    <form className="panel stack" onSubmit={save}>
      <div className="recipe">
        <Thumb src={preview.imageUrl} />
        <span>
          <span>{intro}</span>
          <a className="note small" href={preview.url} target="_blank" rel="noopener noreferrer">
            {preview.url}
          </a>
        </span>
      </div>
      <Field label="Dish name" htmlFor="recipe-name">
        <input
          id="recipe-name"
          className={cls(missing.name)}
          required
          maxLength={200}
          placeholder="e.g. Chicken tikka masala"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Short description" htmlFor="recipe-description">
        <textarea
          id="recipe-description"
          className={cls(missing.description)}
          rows={2}
          maxLength={1000}
          placeholder="A sentence or two about the dish"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="row">
        <Field label="Cooking time (minutes)" htmlFor="recipe-minutes">
          <input
            id="recipe-minutes"
            className={cls(missing.minutes)}
            type="number"
            min={1}
            max={2880}
            step={1}
            placeholder="e.g. 45"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </Field>
        <Field label="Main protein" htmlFor="recipe-protein">
          <input
            id="recipe-protein"
            className={cls(missing.protein)}
            maxLength={80}
            placeholder="e.g. Chicken, tofu, none"
            value={protein}
            onChange={(e) => setProtein(e.target.value)}
          />
        </Field>
      </div>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" disabled={busy}>
          Save to favourites
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
