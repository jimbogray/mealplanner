import type { FavouriteRecipe } from "@mealplanner/shared";
import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { AddRecipe, recipeFacts, Thumb } from "../components/AddRecipe";
import { ErrorNote, errorMessage } from "../components/Field";
import { AverageRating, StarRating } from "../components/Stars";
import { ChosenCount } from "../components/ChosenCount";
import { useSession } from "../session";

/** The family's recipe library: add a recipe by its link, and browse them all as tiles. */
export function LibraryPage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family) return <Navigate to="/family" replace />;
  return <Library isManager={me.member?.role === "admin"} />;
}

function Library({ isManager }: { isManager: boolean }) {
  const [recipes, setRecipes] = useState<FavouriteRecipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy | null>(null);
  // A recipe typed in by hand has no page to open, so it opens here.
  const [viewing, setViewing] = useState<FavouriteRecipe | null>(null);
  // The press of Prepared just made, which can be taken back for a little while (in case it was a slip).
  const [justPressed, setJustPressed] = useState<{ recipeId: string; prepId: string } | null>(null);

  useEffect(() => {
    if (!justPressed) return;
    const timer = setTimeout(() => setJustPressed(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [justPressed]);

  useEffect(() => {
    api.recipes().then(setRecipes, (err) => setError(errorMessage(err)));
  }, []);

  async function remove(recipe: FavouriteRecipe) {
    if (!window.confirm(`Remove "${recipe.name}" from your recipes?`)) return;
    setError(null);
    try {
      await api.removeRecipe(recipe.id);
      setRecipes((list) => (list ?? []).filter((r) => r.id !== recipe.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function replace(updated: FavouriteRecipe) {
    setRecipes((list) => (list ?? []).map((r) => (r.id === updated.id ? updated : r)));
  }

  // Each press records that the family cooked it today.
  async function addPreparation(recipe: FavouriteRecipe) {
    setError(null);
    try {
      const before = new Set(recipe.preparations.map((p) => p.id));
      const updated = await api.addPreparation(recipe.id);
      replace(updated);
      const added = updated.preparations.find((p) => p.id && !before.has(p.id));
      setJustPressed(added?.id ? { recipeId: recipe.id, prepId: added.id } : null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function undoPreparation(recipeId: string, prepId: string) {
    setError(null);
    setJustPressed(null);
    try {
      replace(await api.removePreparation(recipeId, prepId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Opened as soon as it's clicked (a window opened later counts as a pop-up), then pointed at the PDF once it's here.
  async function openSavedPage(recipe: FavouriteRecipe) {
    setError(null);
    const tab = window.open("", "_blank");
    try {
      const pdf = await api.recipePagePdf(recipe.id);
      const url = URL.createObjectURL(pdf);
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      setError(errorMessage(err));
    }
  }

  async function rate(recipe: FavouriteRecipe, stars: number) {
    setError(null);
    try {
      replace(await api.rateRecipe(recipe.id, stars));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function renderTile(r: FavouriteRecipe) {
    return (
      <li key={r.id} className={r.prepared ? "tile prepared" : "tile"}>
        {r.url ? (
          <a href={r.url} target="_blank" rel="noopener noreferrer">
            <TileFace recipe={r} />
          </a>
        ) : (
          <button type="button" className="tile-open" onClick={() => setViewing(r)}>
            <TileFace recipe={r} />
          </button>
        )}
        <div className="tile-corner">
          <AverageRating average={r.averageRating} count={r.ratingCount} />
          <button
            className={r.prepared ? "tile-prepared done" : "tile-prepared"}
            disabled={!isManager}
            title={`${preparedSummary(r)}. ${isManager ? "Press each time you cook it." : "Only a Family Manager can add to this."}`}
            onClick={() => void addPreparation(r)}
          >
            {r.prepared ? "✓ Prepared" : "Prepared"}
          </button>
          {justPressed?.recipeId === r.id && (
            <button className="tile-undo" title="Take back this press of Prepared" onClick={() => void undoPreparation(r.id, justPressed.prepId)}>
              Undo
            </button>
          )}
        </div>
        <button className="tile-remove" aria-label={`Remove ${r.name}`} title="Remove from your recipes" onClick={() => void remove(r)}>
          ×
        </button>
        <div className="tile-foot">
          <StarRating mine={r.myRating} onRate={(stars) => void rate(r, stars)} />
          {r.pageSavedAt && (
            <button
              className="tile-pdf"
              title={`A copy of the recipe page saved ${new Date(r.pageSavedAt).toLocaleDateString()}, in case the site goes offline`}
              onClick={() => void openSavedPage(r)}
            >
              PDF
            </button>
          )}
          <ChosenCount dates={r.chosenOn} />
        </div>
      </li>
    );
  }

  return (
    <div className="stack">
      <section className="card">
        <h1>Recipes</h1>
        <p className="note">Your family's favourite recipes. Paste a link to a recipe page to add one, or type in your own; anyone in the family can add, rate or remove them.</p>
        <AddRecipe onAdded={(recipe) => setRecipes((list) => [recipe, ...(list ?? [])])} />
      </section>
      {viewing && <TypedRecipe recipe={viewing} onClose={() => setViewing(null)} />}
      <ErrorNote error={error} />
      {recipes && recipes.length === 0 && <p className="note center">No recipes yet. Add your first one above.</p>}
      {recipes && recipes.length > 0 && (
        <div className="group-by" role="group" aria-label="Group recipes by">
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
      {recipes && recipes.length > 0 && !groupBy && <ul className="tiles">{recipes.map(renderTile)}</ul>}
      {recipes &&
        groupBy &&
        groupRecipes(recipes, groupBy).map((group) => (
          <section key={group.label} className="recipe-group">
            <h2>
              {group.label} <span className="note small">({group.recipes.length})</span>
            </h2>
            <ul className="tiles">{group.recipes.map(renderTile)}</ul>
          </section>
        ))}
    </div>
  );
}

function TileFace({ recipe: r }: { recipe: FavouriteRecipe }) {
  return (
    <>
      <Thumb src={r.imageUrl} />
      <span className="tile-body">
        <strong>{r.name}</strong>
        {r.description && <span className="small tile-description">{r.description}</span>}
        <span className="note small">{recipeFacts(r)}</span>
        {r.prepared && <span className="note small tile-made">{madeLine(r)}</span>}
      </span>
    </>
  );
}

/** A recipe typed in by hand, with its ingredients and method, in a dialog. */
function TypedRecipe({ recipe: r, onClose }: { recipe: FavouriteRecipe; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const lines = (text: string | null) => (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <dialog ref={dialog} className="recipe-dialog" aria-labelledby="typed-recipe-name" onClose={onClose}>
      <div className="row recipe-dialog-head">
        <h2 id="typed-recipe-name">{r.name}</h2>
        <button type="button" className="link" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </div>
      {r.imageUrl && <img className="recipe-dialog-photo" src={r.imageUrl} alt="" referrerPolicy="no-referrer" />}
      {r.description && <p>{r.description}</p>}
      <p className="note small">{recipeFacts(r)}</p>
      <h3>Ingredients</h3>
      {lines(r.ingredients).length ? (
        <ul>
          {lines(r.ingredients).map((l, i) => (
            <li key={i}>{l.replace(/^[-*•]\s*/, "")}</li>
          ))}
        </ul>
      ) : (
        <p className="note">None typed in.</p>
      )}
      <h3>Method</h3>
      {r.method ? <p className="recipe-method">{r.method}</p> : <p className="note">None typed in.</p>}
    </dialog>
  );
}

/** How long an accidental press of Prepared can be taken back. */
const UNDO_MS = 10_000;

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

/** e.g. "Made 3 times, last on 12 Oct 2026", under the recipe's facts. */
function madeLine(r: FavouriteRecipe): string {
  return `Made ${times(r.timesPrepared)}${r.lastPrepared ? `, last on ${shortDate(r.lastPrepared)}` : ""}`;
}

/** The Prepared pill's tooltip: how often and when. */
function preparedSummary(r: FavouriteRecipe): string {
  if (!r.prepared) return "Not prepared yet";
  const dates = r.preparations.map((p) => (p.date ? shortDate(p.date) + (p.fromSchedule ? " (schedule)" : "") : "date not known"));
  return `Prepared ${times(r.timesPrepared)}: ${dates.join(", ")}`;
}

type GroupBy = "time" | "protein" | "prepared" | "last" | "popular";

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: "time", label: "Cook Time" },
  { key: "protein", label: "Protein" },
  { key: "prepared", label: "Prepared" },
  { key: "last", label: "Last Prepared" },
  { key: "popular", label: "Most Popular" },
];

/** How long ago a recipe was last cooked, for the Last Prepared groups. */
const SINCE_BANDS = [
  { label: "In the last week", days: 7 },
  { label: "In the last month", days: 31 },
  { label: "In the last 3 months", days: 92 },
  { label: "Longer ago", days: Infinity },
];

function daysSince(date: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - new Date(`${date}T00:00:00`).getTime()) / 86_400_000);
}

/** Most recently cooked first; never cooked (or no date) last. */
function byLastPrepared(a: FavouriteRecipe, b: FavouriteRecipe): number {
  return (b.lastPrepared ?? "").localeCompare(a.lastPrepared ?? "");
}

const TIME_BANDS = [
  { label: "0–15 mins", max: 15 },
  { label: "15–30 mins", max: 30 },
  { label: "30 mins+", max: Infinity },
];

/** Splits recipes into labelled groups, in display order. Recipes missing the detail go last. */
function groupRecipes(recipes: FavouriteRecipe[], by: GroupBy): { label: string; recipes: FavouriteRecipe[] }[] {
  const groups = new Map<string, FavouriteRecipe[]>();
  let labels: string[];
  let unknown: string;
  let labelOf: (r: FavouriteRecipe) => string | null;
  if (by === "time") {
    labels = TIME_BANDS.map((b) => b.label);
    unknown = "Cook time not known";
    labelOf = (r) => (r.cookingMinutes == null ? null : TIME_BANDS.find((b) => r.cookingMinutes! <= b.max)!.label);
  } else if (by === "last") {
    labels = [...SINCE_BANDS.map((b) => b.label), "Date not known"];
    unknown = "Not prepared yet";
    labelOf = (r) =>
      !r.prepared ? null : r.lastPrepared ? SINCE_BANDS.find((b) => daysSince(r.lastPrepared!) <= b.days)!.label : "Date not known";
  } else if (by === "popular") {
    const counts = [...new Set(recipes.map((r) => r.timesPrepared).filter((n) => n > 0))].sort((a, b) => b - a);
    labels = counts.map((n) => `Made ${times(n)}`);
    unknown = "Not prepared yet";
    labelOf = (r) => (r.timesPrepared ? `Made ${times(r.timesPrepared)}` : null);
  } else if (by === "prepared") {
    labels = ["Prepared"];
    unknown = "Not prepared yet";
    labelOf = (r) => (r.prepared ? "Prepared" : null);
  } else {
    // Proteins are free text, so "chicken" and "Chicken " share a group.
    const names = new Map<string, string>();
    for (const r of recipes) {
      const p = r.mainProtein?.trim();
      if (p && !names.has(p.toLowerCase())) names.set(p.toLowerCase(), p.charAt(0).toUpperCase() + p.slice(1));
    }
    labels = [...names.values()].sort((a, b) => a.localeCompare(b));
    unknown = "No main protein";
    labelOf = (r) => names.get(r.mainProtein?.trim().toLowerCase() ?? "") ?? null;
  }
  // Within a group, the most recently cooked come first when grouping by when or how often.
  const ordered = by === "last" || by === "popular" ? [...recipes].sort(byLastPrepared) : recipes;
  for (const r of ordered) {
    const label = labelOf(r) ?? unknown;
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  return [...labels, unknown].filter((l) => groups.has(l)).map((label) => ({ label, recipes: groups.get(label)! }));
}
