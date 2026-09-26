import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { isAuthenticated } from "../lib/auth.js";

// GET /api/meal-events/today -> today's meal event + per-member attendance + chosen recipe.
async function mealEventToday(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return { status: 401 };

  const { rows: events } = await query(
    `SELECT id, household_id AS "householdId", to_char(date,'YYYY-MM-DD') AS date,
            recipe_id AS "recipeId", status, headcount
       FROM meal_event
      WHERE household_id = $1 AND date = CURRENT_DATE`,
    [HOUSEHOLD_ID()],
  );
  const event = events[0];
  if (!event) return { jsonBody: { event: null, attendance: [], recipe: null } };

  const { rows: attendance } = await query(
    `SELECT ar.member_id AS "memberId", fm.name, ar.response,
            ar.responded_at AS "respondedAt"
       FROM attendance_response ar
       JOIN family_member fm ON fm.id = ar.member_id
      WHERE ar.meal_event_id = $1
      ORDER BY fm.name`,
    [event.id],
  );

  let recipe = null;
  if (event.recipeId) {
    const { rows } = await query(
      `SELECT id, title, ingredients, steps, tags, source_url AS "sourceUrl",
              image_url AS "imageUrl", nutrition, created_by AS "createdBy"
         FROM recipe WHERE id = $1`,
      [event.recipeId],
    );
    recipe = rows[0] ?? null;
  }

  return { jsonBody: { event, attendance, recipe } };
}

app.http("mealEventToday", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "meal-events/today",
  handler: mealEventToday,
});
