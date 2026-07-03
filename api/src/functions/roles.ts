import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { query, HOUSEHOLD_ID } from "../lib/db.js";

// Static Web Apps calls this after every sign-in (its "rolesSource") with the
// signed-in user's info, and expects { roles: string[] } back. We grant
// "admin" when the user's email (AAD userDetails) matches an active
// family_member row with role='admin'.
async function roles(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const body = (await req.json().catch(() => ({}))) as { userDetails?: string };
  const email = body.userDetails?.trim().toLowerCase();
  if (!email) return { jsonBody: { roles: [] } };

  const { rows } = await query(
    `SELECT role FROM family_member
      WHERE household_id = $1 AND active AND lower(email) = $2`,
    [HOUSEHOLD_ID(), email],
  );

  return { jsonBody: { roles: rows[0]?.role === "admin" ? ["admin"] : [] } };
}

app.http("roles", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "roles",
  handler: roles,
});
