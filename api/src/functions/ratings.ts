import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { query } from "../lib/db.js";
import { isAuthenticated } from "../lib/auth.js";

// POST /api/ratings  { memberId, recipeId, score }
// Records a post-meal rating that feeds the "favourites" learning loop.
async function ratings(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return { status: 401 };
  const body = (await req.json().catch(() => ({}))) as { memberId?: string; recipeId?: string; score?: number };
  if (!body.recipeId || !body.score) return { status: 400, jsonBody: { error: "recipeId and score required" } };
  if (body.score < 1 || body.score > 5) return { status: 400, jsonBody: { error: "score must be 1..5" } };

  await query(
    `INSERT INTO recipe_rating (member_id, recipe_id, score)
     VALUES ($1,$2,$3)
     ON CONFLICT (member_id, recipe_id, cooked_on)
       DO UPDATE SET score = EXCLUDED.score`,
    [body.memberId, body.recipeId, body.score],
  );
  return { status: 201, jsonBody: { ok: true } };
}

app.http("ratings", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ratings",
  handler: ratings,
});
