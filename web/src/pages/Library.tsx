import type { FavouriteRecipe } from "@mealplanner/shared";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { AddRecipe, recipeFacts, Thumb } from "../components/AddRecipe";
import { ErrorNote, errorMessage } from "../components/Field";
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

  useEffect(() => {
    api.recipes().then(setRecipes, (err) => setError(errorMessage(err)));
  }, []);

  async function remove(recipe: FavouriteRecipe) {
    if (!window.confirm(`Remove "${recipe.name}" from your library?`)) return;
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

  return (
    <div className="stack">
      <section className="card">
        <h1>Library</h1>
        <p className="note">Your family's favourite recipes. Paste a link to a recipe page to add one; anyone in the family can add or remove them.</p>
        <AddRecipe onAdded={(recipe) => setRecipes((list) => [recipe, ...(list ?? [])])} />
      </section>
      <ErrorNote error={error} />
      {recipes && recipes.length === 0 && <p className="note center">No recipes yet. Add your first one above.</p>}
      {recipes && recipes.length > 0 && (
        <ul className="tiles">
          {recipes.map((r) => (
            <li key={r.id} className={r.prepared ? "tile prepared" : "tile"}>
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                <Thumb src={r.imageUrl} />
                <span className="tile-body">
                  <strong>{r.name}</strong>
                  {r.description && <span className="small tile-description">{r.description}</span>}
                  <span className="note small">{recipeFacts(r)}</span>
                </span>
              </a>
              <button
                className="tile-prepared"
                aria-pressed={r.prepared}
                disabled={!isManager}
                title={isManager ? (r.prepared ? "Mark as not prepared yet" : "Mark as prepared") : "Only a Family Manager can change this"}
                onClick={() => void togglePrepared(r)}
              >
                {r.prepared ? "✓ Prepared" : "Prepared"}
              </button>
              <button className="tile-remove" aria-label={`Remove ${r.name}`} title="Remove from library" onClick={() => void remove(r)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
