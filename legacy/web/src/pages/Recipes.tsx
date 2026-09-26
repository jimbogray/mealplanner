import { useState } from "react";
import type { RecipeSuggestion } from "@mealplanner/shared";
import { api } from "../api/client";

export function Recipes() {
  const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [discoverNew, setDiscoverNew] = useState(false);
  const [msg, setMsg] = useState<string>();

  async function suggest() {
    setLoading(true);
    setMsg(undefined);
    try {
      const res = await api.suggest(undefined, discoverNew);
      setSuggestions(res.suggestions);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function choose(recipeId: string, title: string) {
    await api.choose(recipeId, true);
    setMsg(`Chosen: ${title}. Family notified.`);
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>Suggest tonight's dinner</h2>
        <label>
          <input type="checkbox" checked={discoverNew} onChange={(e) => setDiscoverNew(e.target.checked)} />
          Discover new ideas from the web
        </label>
        <button onClick={suggest} disabled={loading}>
          {loading ? "Thinking…" : "Suggest recipes"}
        </button>
        {msg && <p className="note">{msg}</p>}
      </section>

      {suggestions.map((s) => (
        <section key={s.recipe.id} className="card">
          <h3>{s.recipe.title}</h3>
          <p className="match">Fridge match: {Math.round(s.fridgeMatch * 100)}% — {s.rationale}</p>
          {s.missingIngredients.length > 0 && (
            <p className="note">Still need: {s.missingIngredients.join(", ")}</p>
          )}
          <details>
            <summary>Ingredients & method</summary>
            <ul>
              {s.recipe.ingredients.map((i, n) => (
                <li key={n}>{[i.quantity, i.unit, i.name].filter(Boolean).join(" ")}</li>
              ))}
            </ul>
            <ol>
              {s.recipe.steps.map((step, n) => (
                <li key={n}>{step}</li>
              ))}
            </ol>
          </details>
          <button onClick={() => choose(s.recipe.id, s.recipe.title)}>Choose this</button>
        </section>
      ))}
    </div>
  );
}
