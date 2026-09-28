import { shoppingItems, type ShoppingList, type ShoppingMeal } from "@mealplanner/shared";

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
  return { ...list, meals, items: shoppingItems(meals, bought) };
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
