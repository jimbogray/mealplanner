import type { InventoryItem, Recipe, RecipeSuggestion } from "@mealplanner/shared";

// Normalise an ingredient/inventory name for loose matching.
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/e?s$/, ""); // crude singularisation
}

/**
 * Score a recipe by how much of it we can already make from the fridge.
 * fridgeMatch = fraction of recipe ingredients present in inventory.
 * Pure function — unit tested in test/fridge-match.test.ts.
 */
export function scoreAgainstInventory(recipe: Recipe, inventory: InventoryItem[]): RecipeSuggestion {
  const have = new Set(inventory.map((i) => norm(i.name)));
  const missing: string[] = [];
  let matched = 0;

  for (const ing of recipe.ingredients) {
    const key = norm(ing.name);
    const present = have.has(key) || [...have].some((h) => h.includes(key) || key.includes(h));
    if (present) matched += 1;
    else missing.push(ing.name);
  }

  const total = recipe.ingredients.length || 1;
  const fridgeMatch = matched / total;
  return {
    recipe,
    fridgeMatch,
    missingIngredients: missing,
    rationale: `${matched} of ${total} ingredients already in the fridge`,
  };
}

export function rankSuggestions(recipes: Recipe[], inventory: InventoryItem[]): RecipeSuggestion[] {
  return recipes
    .map((r) => scoreAgainstInventory(r, inventory))
    .sort((a, b) => b.fridgeMatch - a.fridgeMatch);
}
