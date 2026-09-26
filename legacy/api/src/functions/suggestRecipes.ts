import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { DietaryPrefs, InventoryItem, Recipe } from "@mealplanner/shared";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { isAuthenticated } from "../lib/auth.js";
import { suggestRecipes as aiSuggest, embed } from "../lib/ai.js";
import { rankSuggestions } from "../lib/fridge-match.js";
import { webSearch } from "../lib/webSearch.js";

// POST /api/suggest-recipes  { headcount?: number, discoverNew?: boolean }
async function suggestRecipes(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return { status: 401 };
  const body = (await req.json().catch(() => ({}))) as { headcount?: number; discoverNew?: boolean };
  const household = HOUSEHOLD_ID();

  // Headcount: explicit override, else today's confirmed 'yes' count.
  let headcount = body.headcount ?? 0;
  if (!headcount) {
    const { rows } = await query(
      `SELECT headcount FROM meal_event WHERE household_id=$1 AND date=CURRENT_DATE`,
      [household],
    );
    headcount = rows[0]?.headcount ?? 2;
  }

  const { rows: inventory } = await query<InventoryItem>(
    `SELECT id, household_id AS "householdId", name, quantity, unit, category,
            to_char(expires_on,'YYYY-MM-DD') AS "expiresOn", updated_at AS "updatedAt"
       FROM inventory_item WHERE household_id=$1`,
    [household],
  );

  const { rows: prefRows } = await query<{ dietaryPrefs: DietaryPrefs }>(
    `SELECT dietary_prefs AS "dietaryPrefs" FROM family_member
      WHERE household_id=$1 AND active=TRUE`,
    [household],
  );

  const { rows: favRows } = await query<{ title: string }>(
    `SELECT r.title FROM recipe r
       JOIN recipe_rating rr ON rr.recipe_id = r.id
      GROUP BY r.id, r.title
      ORDER BY AVG(rr.score) DESC, COUNT(*) DESC
      LIMIT 5`,
  );

  let webContext: string | undefined;
  if (body.discoverNew) {
    const topItems = inventory.slice(0, 6).map((i) => i.name).join(", ");
    webContext = await webSearch(`quick family dinner recipes using ${topItems}`).catch((e) => {
      ctx.warn("web search failed", e);
      return undefined;
    });
  }

  const drafts = await aiSuggest({
    headcount,
    inventory,
    prefs: prefRows.map((p) => p.dietaryPrefs),
    favouriteTitles: favRows.map((f) => f.title),
    webContext,
  });

  // Persist drafts as recipes (with embeddings) so they can be chosen/rated later.
  const saved: Recipe[] = [];
  for (const d of drafts) {
    let embedding: number[] = [];
    try {
      embedding = await embed(`${d.title}. ${d.tags.join(", ")}`);
    } catch (e) {
      ctx.warn("embedding failed", e);
    }
    const { rows } = await query<Recipe>(
      `INSERT INTO recipe (title, ingredients, steps, tags, source_url, image_url, nutrition, embedding, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ai')
       RETURNING id, title, ingredients, steps, tags, source_url AS "sourceUrl",
                 image_url AS "imageUrl", nutrition, created_by AS "createdBy"`,
      [
        d.title,
        JSON.stringify(d.ingredients),
        JSON.stringify(d.steps),
        d.tags,
        d.sourceUrl,
        d.imageUrl,
        d.nutrition ? JSON.stringify(d.nutrition) : null,
        embedding.length ? `[${embedding.join(",")}]` : null,
      ],
    );
    if (rows[0]) saved.push(rows[0]);
  }

  const suggestions = rankSuggestions(saved, inventory);
  return { jsonBody: { headcount, suggestions } };
}

app.http("suggestRecipes", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "suggest-recipes",
  handler: suggestRecipes,
});
