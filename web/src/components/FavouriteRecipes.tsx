import type { FavouriteRecipe } from "@mealplanner/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNote, errorMessage } from "./Field";

/** The family's favourite recipes: links to recipe pages that anyone in the family can add or remove. */
export function FavouriteRecipes() {
  const [recipes, setRecipes] = useState<FavouriteRecipe[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.recipes().then(setRecipes, (err) => setError(errorMessage(err)));
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const recipe = await api.addRecipe({ url });
      setRecipes((list) => [recipe, ...(list ?? [])]);
      setUrl("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(recipe: FavouriteRecipe) {
    if (!window.confirm(`Remove "${recipe.title}" from your favourites?`)) return;
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
      <form className="row" onSubmit={add}>
        <input
          className="grow"
          type="text"
          inputMode="url"
          aria-label="Recipe link"
          placeholder="https://…"
          required
          maxLength={2048}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      <ErrorNote error={error} />
      {recipes && recipes.length === 0 && <p className="note small">No favourites yet.</p>}
      {recipes && recipes.length > 0 && (
        <ul className="recipes">
          {recipes.map((r) => (
            <li key={r.id}>
              <a className="recipe" href={r.url} target="_blank" rel="noopener noreferrer">
                {r.imageUrl ? (
                  <img src={r.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="placeholder" aria-hidden="true">
                    🍽
                  </span>
                )}
                <span>
                  <strong>{r.title}</strong>
                  <span className="note small">
                    {r.siteName ?? new URL(r.url).hostname.replace(/^www\./, "")}
                    {r.addedBy && ` · added by ${r.addedBy}`}
                  </span>
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
