import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { isAdmin, isAuthenticated } from "../lib/auth.js";

// GET  /api/members            -> list
// POST /api/members            -> create (admin)
// PUT  /api/members/{id}       -> update (admin)
// DELETE /api/members/{id}     -> deactivate (admin)
async function members(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return { status: 401 };
  const id = req.params.id;

  if (req.method === "GET") {
    const { rows } = await query(
      `SELECT id, household_id AS "householdId", name, phone_e164 AS "phoneE164",
              email, dietary_prefs AS "dietaryPrefs", role, active
         FROM family_member WHERE household_id = $1 ORDER BY name`,
      [HOUSEHOLD_ID()],
    );
    return { jsonBody: rows };
  }

  if (!isAdmin(req)) return { status: 403, jsonBody: { error: "admin role required" } };
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (req.method === "POST") {
    const { rows } = await query(
      `INSERT INTO family_member (household_id, name, phone_e164, email, dietary_prefs, role)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'member')) RETURNING id`,
      [HOUSEHOLD_ID(), body.name, body.phoneE164, body.email ?? null, body.dietaryPrefs ?? {}, body.role],
    );
    return { status: 201, jsonBody: { id: rows[0]?.id } };
  }

  if (req.method === "PUT" && id) {
    await query(
      `UPDATE family_member SET name=$2, phone_e164=$3, email=$4, dietary_prefs=$5, role=$6, active=$7
       WHERE id=$1 AND household_id=$8`,
      [id, body.name, body.phoneE164, body.email ?? null, body.dietaryPrefs ?? {}, body.role ?? "member", body.active ?? true, HOUSEHOLD_ID()],
    );
    return { status: 204 };
  }

  if (req.method === "DELETE" && id) {
    await query(`UPDATE family_member SET active=FALSE WHERE id=$1 AND household_id=$2`, [id, HOUSEHOLD_ID()]);
    return { status: 204 };
  }

  return { status: 400 };
}

app.http("members", {
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "members/{id?}",
  handler: members,
});
