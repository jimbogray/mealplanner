// Adding a favourite recipe (paste a link, check or fill in what was read, save; or type one in by hand) and small
// pieces shared with the Library page.
import type { FavouriteRecipe, RecipePreview } from "@mealplanner/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNote, errorMessage, Field } from "./Field";

/** "25 min · Eggs · BBC Good Food · added by Sam" */
export function recipeFacts(r: FavouriteRecipe): string {
  return [
    r.cookingMinutes && formatMinutes(r.cookingMinutes),
    r.mainProtein,
    r.url ? (r.siteName ?? new URL(r.url).hostname.replace(/^www\./, "")) : "Own recipe",
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

export function Thumb({ src }: { src: string | null }) {
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
  | { kind: "details"; preview: RecipePreview }
  // Typed in by hand, with no link.
  | { kind: "typed" };

/** Paste a link → the API reads the page → check (or fill in) the details → save. Or type a recipe in by hand. */
export function AddRecipe({ onAdded }: { onAdded: (recipe: FavouriteRecipe) => void }) {
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

  if (step.kind === "details" || step.kind === "typed") {
    return (
      <RecipeDetailsForm
        preview={step.kind === "details" ? step.preview : null}
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
      <p className="note small">
        No link?{" "}
        <button
          type="button"
          className="link"
          disabled={reading}
          onClick={() => {
            setError(null);
            setStep({ kind: "typed" });
          }}
        >
          Type in your own recipe
        </button>
      </p>
      <ErrorNote error={error} />
    </>
  );
}

/** The details of a recipe read from its link (`preview`), to check and fill in; or, with no preview, typed in by hand. */
function RecipeDetailsForm({
  preview,
  onCancel,
  onSaved,
}: {
  preview: RecipePreview | null;
  onCancel: () => void;
  onSaved: (recipe: FavouriteRecipe) => void;
}) {
  const [name, setName] = useState(preview?.name ?? "");
  const [description, setDescription] = useState(preview?.description ?? "");
  const [minutes, setMinutes] = useState(preview?.cookingMinutes?.toString() ?? "");
  const [protein, setProtein] = useState(preview?.mainProtein ?? "");
  const [imageUrl, setImageUrl] = useState(preview?.imageUrl ?? "");
  const [ingredients, setIngredients] = useState("");
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What was read automatically is shown for checking; anything missing is flagged to fill in.
  const found = preview?.isRecipe === true;
  const missing = preview
    ? {
        name: !found || !preview.name,
        description: !preview.description,
        minutes: !preview.cookingMinutes,
        protein: !preview.mainProtein,
        image: !preview.imageUrl,
      }
    : { name: false, description: false, minutes: false, protein: false, image: false };
  const anyMissing = Object.values(missing).some(Boolean);
  const intro = !preview
    ? "Type in your own recipe. Only the name is needed; add the rest if you like."
    : preview.isRecipe === null
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
          url: preview?.url ?? null,
          name,
          description: description || null,
          cookingMinutes: minutes ? Number(minutes) : null,
          mainProtein: protein || null,
          imageUrl: imageUrl.trim() || null,
          siteName: preview?.siteName ?? null,
          ...(preview ? {} : { ingredients: ingredients || null, method: method || null }),
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
        <Thumb src={/^https?:\/\//i.test(imageUrl.trim()) ? imageUrl.trim() : null} />
        <span>
          <span>{intro}</span>
          {preview && (
            <a className="note small" href={preview.url} target="_blank" rel="noopener noreferrer">
              {preview.url}
            </a>
          )}
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
      {!preview && (
        <>
          <Field label="Ingredients" htmlFor="recipe-ingredients" hint="One a line. They go on the shopping list when the recipe's on the schedule.">
            <textarea
              id="recipe-ingredients"
              rows={6}
              maxLength={10000}
              placeholder={"500 g chicken thighs\n2 onions\n1 tin coconut milk"}
              value={ingredients}
              onChange={(e) => setIngredients(e.target.value)}
            />
          </Field>
          <Field label="Method" htmlFor="recipe-method">
            <textarea
              id="recipe-method"
              rows={6}
              maxLength={10000}
              placeholder={"1. Fry the onions until soft.\n2. …"}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            />
          </Field>
        </>
      )}
      <Field
        label="Photo link"
        htmlFor="recipe-image"
        hint={missing.image ? "We couldn't find a photo. To add one, right-click a photo on the recipe page and copy its image address." : undefined}
      >
        <input
          id="recipe-image"
          className={cls(missing.image)}
          type="text"
          inputMode="url"
          maxLength={2048}
          placeholder="https://… (optional)"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
        />
      </Field>
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
