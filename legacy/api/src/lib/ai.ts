import { AzureOpenAI } from "openai";
import type { DietaryPrefs, InventoryItem, Recipe } from "@mealplanner/shared";

function getClient(): AzureOpenAI {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) throw new Error("Azure OpenAI env vars are not set");
  return new AzureOpenAI({ endpoint, apiKey, apiVersion: "2024-08-01-preview" });
}

interface SuggestParams {
  headcount: number;
  inventory: InventoryItem[];
  prefs: DietaryPrefs[];
  favouriteTitles: string[];
  webContext?: string;
}

// Recipe shape returned by the model (no id/embedding yet).
export type DraftRecipe = Omit<Recipe, "id" | "createdBy">;

/** Ask Azure OpenAI for a handful of dinner ideas matched to fridge + preferences. */
export async function suggestRecipes(p: SuggestParams): Promise<DraftRecipe[]> {
  const client = getClient();
  const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "gpt-4o-mini";

  const sys =
    "You are a family meal planner. Suggest dinner recipes that make maximal use of the " +
    "ingredients already in the fridge, respect every dietary preference, and serve the given headcount. " +
    "Return ONLY JSON matching the schema.";

  const user = JSON.stringify({
    headcount: p.headcount,
    fridge: p.inventory.map((i) => `${i.quantity}${i.unit} ${i.name}`),
    dietaryPreferences: p.prefs,
    recentFavourites: p.favouriteTitles,
    webContext: p.webContext ?? null,
    schema: {
      recipes: [
        {
          title: "string",
          ingredients: [{ name: "string", quantity: "number?", unit: "string?" }],
          steps: ["string"],
          tags: ["string"],
          sourceUrl: "string|null",
          imageUrl: "string|null",
          nutrition: "object|null",
        },
      ],
    },
  });

  const res = await client.chat.completions.create({
    model: deployment,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as { recipes?: DraftRecipe[] };
  return parsed.recipes ?? [];
}

/** Embed text (e.g. a recipe title + tags) for pgvector similarity search. */
export async function embed(text: string): Promise<number[]> {
  const client = getClient();
  const deployment = process.env.AZURE_OPENAI_EMBED_DEPLOYMENT ?? "text-embedding-3-small";
  const res = await client.embeddings.create({ model: deployment, input: text });
  return res.data[0]?.embedding ?? [];
}
