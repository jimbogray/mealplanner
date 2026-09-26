import type { FavouriteRecipe } from "@mealplanner/shared";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { AddRecipe, recipeFacts, Thumb } from "../components/AddRecipe";
import { ErrorNote, errorMessage } from "../components/Field";
import { AverageRating, StarRating } from "../components/Stars";
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

  async function togglePrepared(recipe: FavouriteRecipe) {
    setError(null);
    try {
      const updated = await api.setRecipePrepared(recipe.id, !recipe.prepared);
      setRecipes((list) => (list ?? []).map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function rate(recipe: FavouriteRecipe, stars: number) {
    setError(null);
    try {
      const updated = await api.rateRecipe(recipe.id, stars);
      setRecipes((list) => (list ?? []).map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function renderTile(r: FavouriteRecipe) {
    return (
      <li key={r.id} className={r.prepared ? "tile prepared" : "tile"}>
        <a href={r.url} target="_blank" rel="noopener noreferrer">
          <Thumb src={r.imageUrl} />
          <span className="tile-body">
            <strong>{r.name}</strong>
            {r.description && <span className="small tile-description">{r.description}</span>}
            <span className="note small">{recipeFacts(r)}</span>
          </span>
        </a>
        <div className="tile-corner">
          <AverageRating average={r.averageRating} count={r.ratingCount} />
          <button
            className="tile-prepared"
            aria-pressed={r.prepared}
            disabled={!isManager}
            title={isManager ? (r.prepared ? "Mark as not prepared yet" : "Mark as prepared") : "Only a Family Manager can change this"}
            onClick={() => void togglePrepared(r)}
          >
            {r.prepared ? "✓ Prepared" : "Prepared"}
          </button>
        </div>
        <button className="tile-remove" aria-label={`Remove ${r.name}`} title="Remove from your recipes" onClick={() => void remove(r)}>
          ×
        </button>
        <div className="tile-foot">
          <StarRating mine={r.myRating} onRate={(stars) => void rate(r, stars)} />
        </div>
      </li>
    );
  }

  return (
    <div className="stack">
      <section className="card">
        <h1>Recipe</h1>
        <p className="note">Your family's favourite recipes. Paste a link to a recipe page to add one; anyone in the family can add, rate or remove them.</p>
        <AddRecipe onAdded={(recipe) => setRecipes((list) => [recipe, ...(list ?? [])])} />
      </section>
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

type GroupBy = "time" | "protein" | "prepared";

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: "time", label: "Cook Time" },
  { key: "protein", label: "Protein" },
  { key: "prepared", label: "Prepared" },
];

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
  for (const r of recipes) {
    const label = labelOf(r) ?? unknown;
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  return [...labels, unknown].filter((l) => groups.has(l)).map((label) => ({ label, recipes: groups.get(label)! }));
}
