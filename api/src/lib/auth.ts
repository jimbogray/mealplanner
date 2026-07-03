import type { HttpRequest } from "@azure/functions";

// Azure Static Web Apps injects an "x-ms-client-principal" header (base64 JSON)
// describing the signed-in user, including their assigned roles.
export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

export function getPrincipal(req: HttpRequest): ClientPrincipal | null {
  const header = req.headers.get("x-ms-client-principal");
  if (!header) return null;
  try {
    const json = Buffer.from(header, "base64").toString("utf8");
    return JSON.parse(json) as ClientPrincipal;
  } catch {
    return null;
  }
}

export function isAdmin(req: HttpRequest): boolean {
  const p = getPrincipal(req);
  return !!p && p.userRoles.includes("admin");
}

export function isAuthenticated(req: HttpRequest): boolean {
  // SWA gives every signed-in user the built-in "authenticated" role.
  const p = getPrincipal(req);
  return !!p && p.userRoles.includes("authenticated");
}
