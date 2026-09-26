import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAgainstInventory, rankSuggestions } from "../src/lib/fridge-match.js";
import type { InventoryItem, Recipe } from "@mealplanner/shared";

const inv = (name: string): InventoryItem => ({
  id: name, householdId: "h", name, quantity: 1, unit: "unit", category: "x",
  expiresOn: null, updatedAt: "",
});

const recipe = (title: string, ings: string[]): Recipe => ({
  id: title, title, ingredients: ings.map((n) => ({ name: n })), steps: [], tags: [],
  sourceUrl: null, imageUrl: null, nutrition: null, createdBy: "ai",
});

test("scores fraction of ingredients present, plural-insensitive", () => {
  const s = scoreAgainstInventory(recipe("r", ["Onion", "Tomatoes", "Beef"]), [inv("onions"), inv("tomato")]);
  assert.equal(s.fridgeMatch, 2 / 3);
  assert.deepEqual(s.missingIngredients, ["Beef"]);
});

test("ranks higher fridge-match first", () => {
  const ranked = rankSuggestions(
    [recipe("low", ["a", "b", "c"]), recipe("high", ["a", "b"])],
    [inv("a"), inv("b")],
  );
  assert.equal(ranked[0]!.recipe.title, "high");
});
