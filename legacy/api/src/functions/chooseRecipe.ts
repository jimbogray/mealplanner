import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { isAuthenticated } from "../lib/auth.js";
import { sendSms } from "../lib/acs.js";

// POST /api/choose-recipe  { recipeId: string, notifyFamily?: boolean }
async function chooseRecipe(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return { status: 401 };
  const body = (await req.json().catch(() => ({}))) as { recipeId?: string; notifyFamily?: boolean };
  if (!body.recipeId) return { status: 400, jsonBody: { error: "recipeId required" } };
  const household = HOUSEHOLD_ID();

  const { rows } = await query<{ id: string; title: string }>(
    `UPDATE meal_event me
        SET recipe_id = $2, status = 'planned'
      WHERE me.household_id = $1 AND me.date = CURRENT_DATE
      RETURNING me.id,
        (SELECT title FROM recipe WHERE id = $2) AS title`,
    [household, body.recipeId],
  );
  if (!rows[0]) return { status: 404, jsonBody: { error: "no meal event for today" } };

  if (body.notifyFamily) {
    const { rows: members } = await query<{ phoneE164: string }>(
      `SELECT fm.phone_e164 AS "phoneE164"
         FROM attendance_response ar JOIN family_member fm ON fm.id = ar.member_id
        WHERE ar.meal_event_id = $1 AND ar.response = 'yes'`,
      [rows[0].id],
    );
    for (const m of members) {
      try {
        await sendSms(m.phoneE164, `Tonight's dinner: ${rows[0].title}. See you at the table!`);
      } catch (e) {
        ctx.error("notify failed", e);
      }
    }
  }

  return { status: 200, jsonBody: { ok: true, title: rows[0].title } };
}

app.http("chooseRecipe", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "choose-recipe",
  handler: chooseRecipe,
});
