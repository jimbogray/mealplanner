import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";
import { isAuthenticated } from "../lib/auth.js";

// CRUD for fridge inventory. Any authenticated family member can edit stock.
async function inventory(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return { status: 401 };
  const id = req.params.id;

  if (req.method === "GET") {
    const { rows } = await query(
      `SELECT id, household_id AS "householdId", name, quantity, unit, category,
              to_char(expires_on,'YYYY-MM-DD') AS "expiresOn", updated_at AS "updatedAt"
         FROM inventory_item WHERE household_id = $1
        ORDER BY expires_on NULLS LAST, name`,
      [HOUSEHOLD_ID()],
    );
    return { jsonBody: rows };
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (req.method === "POST") {
    const { rows } = await query(
      `INSERT INTO inventory_item (household_id, name, quantity, unit, category, expires_on)
       VALUES ($1,$2,COALESCE($3,1),COALESCE($4,'unit'),COALESCE($5,'other'),$6) RETURNING id`,
      [HOUSEHOLD_ID(), body.name, body.quantity, body.unit, body.category, body.expiresOn ?? null],
    );
    return { status: 201, jsonBody: { id: rows[0]?.id } };
  }

  if (req.method === "PUT" && id) {
    await query(
      `UPDATE inventory_item SET name=$2, quantity=$3, unit=$4, category=$5, expires_on=$6, updated_at=now()
       WHERE id=$1 AND household_id=$7`,
      [id, body.name, body.quantity, body.unit, body.category, body.expiresOn ?? null, HOUSEHOLD_ID()],
    );
    return { status: 204 };
  }

  if (req.method === "DELETE" && id) {
    await query(`DELETE FROM inventory_item WHERE id=$1 AND household_id=$2`, [id, HOUSEHOLD_ID()]);
    return { status: 204 };
  }

  return { status: 400 };
}

app.http("inventory", {
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "inventory/{id?}",
  handler: inventory,
});
