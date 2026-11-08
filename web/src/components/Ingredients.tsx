import { COMMON_GROCERIES, ingredientKey, MAX_EXTRA_NAME, shoppingItems, type ShoppingList, type ShoppingMeal } from "@mealplanner/shared";
import { useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNote, errorMessage } from "./Field";

/** "red onion" as "Red onion" (ingredients are read in lower case). */
export function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The list with an ingredient of a day's recipe in the house (or not), and the shopping list worked out again. */
export function withHave(list: ShoppingList, date: string, name: string, have: boolean): ShoppingList {
  const meals = list.meals.map((m) =>
    m.date === date && m.ingredients ? { ...m, ingredients: m.ingredients.map((i) => (i.name === name ? { ...i, have } : i)) } : m,
  );
  const bought = list.items.filter((i) => i.bought).map((i) => i.key);
  return { ...list, meals, items: shoppingItems(meals, bought, list.extras, list.adjusted) };
}

/**
 * A day's recipe ingredients as pills: all ticked (to buy) to start with; untick what's already in the house
 * so it stays off the shopping list.
 */
export function DayIngredients({ meal, onHave }: { meal: ShoppingMeal | undefined; onHave: (name: string, have: boolean) => void }) {
  if (!meal) return null;
  if (!meal.ingredients) return <span className="note small">Couldn't read this recipe's ingredients</span>;
  if (!meal.ingredients.length) return null;
  const inHouse = meal.ingredients.filter((i) => i.have).length;
  return (
    <details className="ingredients">
      <summary>
        Ingredients: {meal.ingredients.length - inHouse} to buy
        {inHouse > 0 && `, ${inHouse} in the house`}
      </summary>
      <p className="hint">Untick anything you already have.</p>
      <div className="chips">
        {meal.ingredients.map((i) => (
          <label key={i.name} className="chip toggle ingredient" title={i.have ? "In the house" : "To buy"}>
            <input type="checkbox" checked={!i.have} onChange={(e) => onHave(i.name, !e.target.checked)} />
            {capitalise(i.name)}
            {i.quantity && <span className="qty">{i.quantity}</span>}
          </label>
        ))}
      </div>
    </details>
  );
}

/**
 * A box to add anything else to the shopping list (milk, bread…), suggesting everyday groceries as you type, with
 * what's been added so far (each can be taken off again). `today` is the person's own date.
 */
export function AddToList({ list, today, onChange }: { list: ShoppingList; today: string; onChange: (list: ShoppingList) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const onList = new Set(list.items.map((i) => i.key));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      onChange(await api.addExtra(today, name.trim()));
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(extraId: string) {
    setError(null);
    try {
      onChange(await api.removeExtra(today, extraId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="add-extra">
      <form className="add-extra-form" onSubmit={add}>
        <input
          list={`${id}-groceries`}
          aria-label="Add to the shopping list"
          placeholder="Add milk, bread, eggs…"
          maxLength={MAX_EXTRA_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <datalist id={`${id}-groceries`}>
          {COMMON_GROCERIES.filter((g) => !onList.has(ingredientKey(g.name))).map((g) => (
            <option key={g.name} value={g.name} />
          ))}
        </datalist>
        <button type="submit" disabled={saving || !name.trim()}>
          Add
        </button>
      </form>
      {list.extras.length > 0 && (
        <div className="chips">
          {list.extras.map((x) => (
            <span key={x.id} className="chip extra">
              {capitalise(x.name)}
              <button type="button" className="link" aria-label={`Take ${x.name} off the list`} onClick={() => void remove(x.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

/**
 * A box to paste a link to a recipe (one not in the family's recipes): Claude reads its ingredients and they're
 * added to the shopping list, sorted into aisles. `today` is the person's own date.
 */
export function AddRecipeLink({ today, onChange }: { today: string; onChange: (list: ShoppingList) => void }) {
  const [url, setUrl] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setReading(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.addRecipeLink(today, url.trim());
      onChange(res.list);
      setUrl("");
      const count = `${res.added.length} ingredient${res.added.length === 1 ? "" : "s"}`;
      setDone(res.name ? `Added ${count} from ${res.name}.` : `Added ${count}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="add-extra">
      <form className="add-extra-form" onSubmit={add}>
        <input
          type="url"
          aria-label="Recipe link"
          placeholder="Paste a recipe link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={reading}
        />
        <button type="submit" disabled={reading || !url.trim()}>
          {reading ? "Reading…" : "Add ingredients"}
        </button>
      </form>
      {reading && <p className="note small">Reading the recipe's ingredients…</p>}
      {done && <p className="note small">{done} Spices, salt and pepper are left off; take off anything you already have.</p>}
      <ErrorNote error={error} />
    </div>
  );
}
