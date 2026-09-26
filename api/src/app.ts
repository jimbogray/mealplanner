import { createServer, type Server } from "node:http";
import type { AuthResponse, Family, FamilyMember, FavouriteRecipe, Invite, InvitePreview, Me } from "@mealplanner/shared";
import { createSession, hashPassword, hashToken, bearerToken, newInviteCode, requireUser, verifyPassword } from "./auth.js";
import { withTransaction, type Db, type Tx } from "./db.js";
import { GoogleTokenError, verifyGoogleIdToken, type GoogleIdentity, type KeySource } from "./google.js";
import { HttpError, listener, Router, type Request } from "./http.js";
import { fallbackTitle, fetchRecipeMeta, type RecipeMeta, type RecipeMetaFetcher } from "./recipe-meta.js";
import * as v from "./validate.js";

export const INVITE_DAYS = 14;

type Queryable = Pick<Db, "query">;

interface MemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  name: string;
  life_stage: FamilyMember["lifeStage"];
  role: FamilyMember["role"];
  email: string | null;
  created_at: Date;
}

const MEMBER_SELECT = `SELECT m.id, m.family_id, m.user_id, m.name, m.life_stage, m.role, u.email, m.created_at
  FROM family_member m LEFT JOIN app_user u ON u.id = m.user_id`;

function toMember(r: MemberRow): FamilyMember {
  return {
    id: r.id,
    name: r.name,
    lifeStage: r.life_stage,
    role: r.role,
    hasAccount: r.user_id !== null,
    email: r.email,
    createdAt: r.created_at.toISOString(),
  };
}

async function loadMe(db: Queryable, userId: string, email: string): Promise<Me> {
  const user = { id: userId, email };
  const self = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [userId])).rows[0];
  if (!self) return { user, family: null, member: null, members: [] };
  const fam = (await db.query<{ id: string; name: string; created_at: Date }>("SELECT * FROM family WHERE id = $1", [self.family_id]))
    .rows[0];
  const members = (
    await db.query<MemberRow>(
      `${MEMBER_SELECT} WHERE m.family_id = $1
        ORDER BY array_position(ARRAY['adult','teenager','child','toddler','baby']::life_stage[], m.life_stage), m.created_at`,
      [self.family_id],
    )
  ).rows.map(toMember);
  const family: Family = { id: fam.id, name: fam.name, createdAt: fam.created_at.toISOString() };
  return { user, family, member: toMember(self), members };
}

/** The signed-in user's own family_member row, or 403 if they aren't in a family. */
async function requireMember(db: Db, req: Request): Promise<{ userId: string; email: string; member: MemberRow }> {
  const user = await requireUser(db, req);
  const member = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.user_id = $1`, [user.userId])).rows[0];
  if (!member) throw new HttpError(403, "You're not part of a family yet");
  return { ...user, member };
}

async function requireAdmin(db: Db, req: Request) {
  const ctx = await requireMember(db, req);
  if (ctx.member.role !== "admin") throw new HttpError(403, "Only a family admin can do that");
  return ctx;
}

/** Loads a member of the caller's family, or 404. */
async function familyMember(db: Queryable, familyId: string, id: string): Promise<MemberRow> {
  const row = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.id = $1 AND m.family_id = $2`, [v.uuid(id), familyId]))
    .rows[0];
  if (!row) throw new HttpError(404, "That family member doesn't exist");
  return row;
}

async function adminCount(db: Queryable, familyId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM family_member WHERE family_id = $1 AND role = 'admin'",
    [familyId],
  );
  return rows[0].n;
}

async function createFamily(tx: Tx, userId: string, familyName: string, name: string, lifeStage: string): Promise<void> {
  const { rows } = await tx.query<{ id: string }>("INSERT INTO family (name) VALUES ($1) RETURNING id", [familyName]);
  await tx.query(
    "INSERT INTO family_member (family_id, user_id, name, life_stage, role) VALUES ($1, $2, $3, $4, 'admin')",
    [rows[0].id, userId, name, lifeStage],
  );
}

/** Uses up an invite and adds the user to its family. Locks the invite row so a code can't be used twice. */
async function acceptInvite(tx: Tx, code: string, userId: string, name: string, lifeStage: string): Promise<void> {
  const invite = (
    await tx.query<{ id: string; family_id: string; accepted_at: Date | null; expired: boolean }>(
      "SELECT id, family_id, accepted_at, expires_at <= now() AS expired FROM invite WHERE code = $1 FOR UPDATE",
      [code.trim().toUpperCase()],
    )
  ).rows[0];
  if (!invite) throw new HttpError(404, "That invite link isn't valid");
  if (invite.accepted_at) throw new HttpError(410, "That invite link has already been used");
  if (invite.expired) throw new HttpError(410, "That invite link has expired, ask for a new one");
  const { rows } = await tx.query<{ id: string }>(
    "INSERT INTO family_member (family_id, user_id, name, life_stage, role) VALUES ($1, $2, $3, $4, 'member') RETURNING id",
    [invite.family_id, userId, name, lifeStage],
  );
  await tx.query("UPDATE invite SET accepted_by = $1, accepted_at = now() WHERE id = $2", [rows[0].id, invite.id]);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface AppOptions {
  /** Origins allowed to call the API from a browser. */
  webOrigins: string[];
  /** Enables Sign in with Google when set. */
  google?: { clientId: string; keys: KeySource };
  /** Reads a recipe page's title and image; defaults to fetching the page. */
  fetchRecipeMeta?: RecipeMetaFetcher;
}

/** Optional sign-up fields: a new family name, or an invite code to join one. */
function familyChoice(b: Record<string, unknown>): { familyName: string | null; inviteCode: string | null } {
  const familyName = typeof b.familyName === "string" && b.familyName.trim() ? v.text(b.familyName, "Family name") : null;
  const inviteCode = typeof b.inviteCode === "string" && b.inviteCode.trim() ? b.inviteCode : null;
  return { familyName, inviteCode };
}

interface RecipeRow {
  id: string;
  url: string;
  title: string;
  image_url: string | null;
  site_name: string | null;
  added_by: string | null;
  created_at: Date;
}

const RECIPE_SELECT = `SELECT r.id, r.url, r.title, r.image_url, r.site_name, m.name AS added_by, r.created_at
  FROM favourite_recipe r LEFT JOIN family_member m ON m.id = r.added_by`;

function toRecipe(r: RecipeRow): FavouriteRecipe {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    imageUrl: r.image_url,
    siteName: r.site_name,
    addedBy: r.added_by,
    createdAt: r.created_at.toISOString(),
  };
}

export function buildRouter(db: Db, options: Pick<AppOptions, "google" | "fetchRecipeMeta"> = {}): Router {
  const router = new Router();

  router.add("GET", "/api/health", async () => {
    await db.query("SELECT 1");
    return { body: { ok: true } };
  });

  // --- accounts ---------------------------------------------------------

  router.add("POST", "/api/auth/signup", async (req) => {
    const b = v.object(req.body);
    const email = v.email(b.email);
    const password = v.password(b.password);
    const name = v.text(b.name, "Your name");
    const lifeStage = v.lifeStage(b.lifeStage);
    const { familyName, inviteCode } = familyChoice(b);
    if (!familyName && !inviteCode) throw new HttpError(400, "Family name is required");

    const passwordHash = await hashPassword(password);
    const { userId, token } = await withTransaction(db, async (tx) => {
      let userId: string;
      try {
        userId = (
          await tx.query<{ id: string }>("INSERT INTO app_user (email, password_hash) VALUES ($1, $2) RETURNING id", [
            email,
            passwordHash,
          ])
        ).rows[0].id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "An account with that email already exists, sign in instead");
        throw err;
      }
      if (inviteCode) await acceptInvite(tx, inviteCode, userId, name, lifeStage);
      else await createFamily(tx, userId, familyName!, name, lifeStage);
      return { userId, token: await createSession(tx, userId) };
    });
    const body: AuthResponse = { token, me: await loadMe(db, userId, email) };
    return { status: 201, body };
  });

  router.add("POST", "/api/auth/login", async (req) => {
    const b = v.object(req.body);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const user = (
      await db.query<{ id: string; email: string; password_hash: string | null }>(
        "SELECT id, email, password_hash FROM app_user WHERE lower(email) = $1",
        [email],
      )
    ).rows[0];
    if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, "Email or password is incorrect");
    }
    const token = await createSession(db, user.id);
    const body: AuthResponse = { token, me: await loadMe(db, user.id, user.email) };
    return { body };
  });

  // Sign in (or sign up) with a Google ID token from the web app's Google button.
  // Signing up also needs lifeStage plus familyName or inviteCode, like /api/auth/signup.
  router.add("POST", "/api/auth/google", async (req) => {
    const google = options.google;
    if (!google) throw new HttpError(404, "Google sign-in isn't set up");
    const b = v.object(req.body);
    if (typeof b.credential !== "string" || !b.credential) throw new HttpError(400, "Missing Google credential");
    let identity: GoogleIdentity;
    try {
      identity = await verifyGoogleIdToken(b.credential, google.clientId, google.keys);
    } catch (err) {
      if (err instanceof GoogleTokenError) throw new HttpError(401, `Google sign-in failed: ${err.message}`);
      throw err;
    }
    const { familyName, inviteCode } = familyChoice(b);

    const result = await withTransaction(db, async (tx) => {
      // Prefer the account already linked to this Google id; otherwise one with the same (Google-verified) email.
      const existing = (
        await tx.query<{ id: string; google_sub: string | null }>(
          `SELECT id, google_sub FROM app_user WHERE google_sub = $1 OR lower(email) = $2
            ORDER BY (google_sub = $1) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
          [identity.sub, identity.email],
        )
      ).rows[0];

      if (existing) {
        if (existing.google_sub === null) {
          await tx.query("UPDATE app_user SET google_sub = $1 WHERE id = $2", [identity.sub, existing.id]);
        } else if (existing.google_sub !== identity.sub) {
          throw new HttpError(409, "That email is already linked to a different Google account");
        }
        // Opening an invite link while not in a family joins it.
        if (inviteCode) {
          const inFamily = (await tx.query("SELECT 1 FROM family_member WHERE user_id = $1", [existing.id])).rowCount;
          if (!inFamily) {
            const name = v.text(typeof b.name === "string" && b.name.trim() ? b.name : identity.name, "Your name");
            await acceptInvite(tx, inviteCode, existing.id, name, v.lifeStage(b.lifeStage));
          }
        }
        return { userId: existing.id, created: false };
      }

      if (!familyName && !inviteCode) {
        throw new HttpError(404, "No account uses that Google address yet. Create a family, or open your invite link, to sign up.");
      }
      const name = v.text(typeof b.name === "string" && b.name.trim() ? b.name : identity.name, "Your name");
      const lifeStage = v.lifeStage(b.lifeStage);
      const userId = (
        await tx.query<{ id: string }>("INSERT INTO app_user (email, google_sub) VALUES ($1, $2) RETURNING id", [
          identity.email,
          identity.sub,
        ])
      ).rows[0].id;
      if (inviteCode) await acceptInvite(tx, inviteCode, userId, name, lifeStage);
      else await createFamily(tx, userId, familyName!, name, lifeStage);
      return { userId, created: true };
    });

    const token = await createSession(db, result.userId);
    const email = (await db.query<{ email: string }>("SELECT email FROM app_user WHERE id = $1", [result.userId])).rows[0].email;
    const body: AuthResponse = { token, me: await loadMe(db, result.userId, email) };
    return { status: result.created ? 201 : 200, body };
  });

  router.add("POST", "/api/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) await db.query("DELETE FROM session WHERE token_hash = $1", [hashToken(token)]);
    return { status: 204 };
  });

  router.add("GET", "/api/me", async (req) => {
    const { userId, email } = await requireUser(db, req);
    return { body: await loadMe(db, userId, email) };
  });

  // --- family -----------------------------------------------------------

  // For a signed-in user who isn't in a family (e.g. they were removed from one).
  router.add("POST", "/api/family", async (req) => {
    const { userId, email } = await requireUser(db, req);
    const b = v.object(req.body);
    const familyName = v.text(b.familyName, "Family name");
    const name = v.text(b.name, "Your name");
    const lifeStage = v.lifeStage(b.lifeStage);
    await withTransaction(db, async (tx) => {
      try {
        await createFamily(tx, userId, familyName, name, lifeStage);
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "You're already part of a family");
        throw err;
      }
    });
    return { status: 201, body: await loadMe(db, userId, email) };
  });

  router.add("PATCH", "/api/family", async (req) => {
    const { member } = await requireAdmin(db, req);
    const name = v.text(v.object(req.body).name, "Family name");
    await db.query("UPDATE family SET name = $1 WHERE id = $2", [name, member.family_id]);
    return { status: 204 };
  });

  // Add someone without their own login (a baby, a toddler, a child without an email…).
  router.add("POST", "/api/family/members", async (req) => {
    const { member } = await requireAdmin(db, req);
    const b = v.object(req.body);
    const name = v.text(b.name, "Name");
    const lifeStage = v.lifeStage(b.lifeStage);
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO family_member (family_id, name, life_stage) VALUES ($1, $2, $3) RETURNING id",
      [member.family_id, name, lifeStage],
    );
    return { status: 201, body: toMember(await familyMember(db, member.family_id, rows[0].id)) };
  });

  // Admins can edit anyone; everyone can edit their own name and life stage.
  router.add("PATCH", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    const isSelf = target.id === self.id;
    if (self.role !== "admin" && !isSelf) throw new HttpError(403, "Only a family admin can change other members");

    const b = v.object(req.body);
    const name = b.name === undefined ? target.name : v.text(b.name, "Name");
    const lifeStage = b.lifeStage === undefined ? target.life_stage : v.lifeStage(b.lifeStage);
    let role = target.role;
    if (b.role !== undefined) {
      if (b.role !== "admin" && b.role !== "member") throw new HttpError(400, "Role must be admin or member");
      if (self.role !== "admin") throw new HttpError(403, "Only a family admin can change roles");
      if (b.role === "admin" && !target.user_id) throw new HttpError(400, "Only members with their own login can be admins");
      if (b.role === "member" && target.role === "admin" && (await adminCount(db, self.family_id)) <= 1) {
        throw new HttpError(400, "A family needs at least one admin");
      }
      role = b.role;
    }
    await db.query("UPDATE family_member SET name = $1, life_stage = $2, role = $3 WHERE id = $4", [
      name,
      lifeStage,
      role,
      target.id,
    ]);
    return { body: toMember(await familyMember(db, self.family_id, target.id)) };
  });

  router.add("DELETE", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    // Admins can remove anyone; anyone can leave.
    if (self.role !== "admin" && target.id !== self.id) throw new HttpError(403, "Only a family admin can remove members");
    if (target.role === "admin" && (await adminCount(db, self.family_id)) <= 1) {
      throw new HttpError(400, "A family needs at least one admin; make someone else an admin first");
    }
    await db.query("DELETE FROM family_member WHERE id = $1", [target.id]);
    return { status: 204 };
  });

  // --- invites ----------------------------------------------------------

  router.add("GET", "/api/family/invites", async (req) => {
    const { member } = await requireAdmin(db, req);
    const { rows } = await db.query<{ id: string; code: string; created_at: Date; expires_at: Date }>(
      `SELECT id, code, created_at, expires_at FROM invite
        WHERE family_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [member.family_id],
    );
    const body: Invite[] = rows.map((r) => ({
      id: r.id,
      code: r.code,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }));
    return { body };
  });

  router.add("POST", "/api/family/invites", async (req) => {
    const { member } = await requireAdmin(db, req);
    const { rows } = await db.query<{ id: string; code: string; created_at: Date; expires_at: Date }>(
      `INSERT INTO invite (family_id, code, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id, code, created_at, expires_at`,
      [member.family_id, newInviteCode(), member.id, INVITE_DAYS],
    );
    const r = rows[0];
    const body: Invite = { id: r.id, code: r.code, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() };
    return { status: 201, body };
  });

  router.add("DELETE", "/api/family/invites/:id", async (req) => {
    const { member } = await requireAdmin(db, req);
    const { rowCount } = await db.query("DELETE FROM invite WHERE id = $1 AND family_id = $2 AND accepted_at IS NULL", [
      v.uuid(req.params.id),
      member.family_id,
    ]);
    if (!rowCount) throw new HttpError(404, "That invite doesn't exist");
    return { status: 204 };
  });

  // Public: shown on the join page before the invitee signs up.
  router.add("GET", "/api/invites/:code", async (req) => {
    const { rows } = await db.query<{ family_name: string; invited_by: string | null; expires_at: Date; accepted_at: Date | null }>(
      `SELECT f.name AS family_name, m.name AS invited_by, i.expires_at, i.accepted_at
         FROM invite i JOIN family f ON f.id = i.family_id LEFT JOIN family_member m ON m.id = i.created_by
        WHERE i.code = $1`,
      [req.params.code.trim().toUpperCase()],
    );
    const r = rows[0];
    if (!r) throw new HttpError(404, "That invite link isn't valid");
    if (r.accepted_at) throw new HttpError(410, "That invite link has already been used");
    if (r.expires_at <= new Date()) throw new HttpError(410, "That invite link has expired, ask for a new one");
    const body: InvitePreview = { familyName: r.family_name, invitedBy: r.invited_by ?? "A family member", expiresAt: r.expires_at.toISOString() };
    return { body };
  });

  // For a signed-in user who isn't in a family yet.
  router.add("POST", "/api/invites/:code/accept", async (req) => {
    const { userId, email } = await requireUser(db, req);
    const b = v.object(req.body);
    const name = v.text(b.name, "Your name");
    const lifeStage = v.lifeStage(b.lifeStage);
    await withTransaction(db, async (tx) => {
      try {
        await acceptInvite(tx, req.params.code, userId, name, lifeStage);
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "You're already part of a family");
        throw err;
      }
    });
    return { body: await loadMe(db, userId, email) };
  });

  // --- favourite recipes --------------------------------------------------
  // They belong to the family: anyone in it can add or remove one.

  router.add("GET", "/api/family/recipes", async (req) => {
    const { member } = await requireMember(db, req);
    const { rows } = await db.query<RecipeRow>(`${RECIPE_SELECT} WHERE r.family_id = $1 ORDER BY r.created_at DESC`, [
      member.family_id,
    ]);
    const body: FavouriteRecipe[] = rows.map(toRecipe);
    return { body };
  });

  router.add("POST", "/api/family/recipes", async (req) => {
    const { member } = await requireMember(db, req);
    const b = v.object(req.body);
    const url = v.webUrl(b.url, "Recipe link");
    const title = typeof b.title === "string" && b.title.trim() ? v.text(b.title, "Title", 200) : null;
    const duplicate = "That recipe is already one of your favourites";
    if ((await db.query("SELECT 1 FROM favourite_recipe WHERE family_id = $1 AND url = $2", [member.family_id, url])).rowCount) {
      throw new HttpError(409, duplicate);
    }

    let meta: RecipeMeta = { title: null, imageUrl: null, siteName: null };
    try {
      meta = await (options.fetchRecipeMeta ?? fetchRecipeMeta)(url);
    } catch {
      // The page couldn't be read (offline, blocked, not HTML…); save the link anyway.
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO favourite_recipe (family_id, url, title, image_url, site_name, added_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (family_id, url) DO NOTHING RETURNING id`,
      [member.family_id, url, title ?? meta.title ?? fallbackTitle(url), meta.imageUrl, meta.siteName, member.id],
    );
    if (!rows[0]) throw new HttpError(409, duplicate);
    const saved = (await db.query<RecipeRow>(`${RECIPE_SELECT} WHERE r.id = $1`, [rows[0].id])).rows[0];
    return { status: 201, body: toRecipe(saved) };
  });

  router.add("DELETE", "/api/family/recipes/:id", async (req) => {
    const { member } = await requireMember(db, req);
    const { rowCount } = await db.query("DELETE FROM favourite_recipe WHERE id = $1 AND family_id = $2", [
      v.uuid(req.params.id),
      member.family_id,
    ]);
    if (!rowCount) throw new HttpError(404, "That recipe isn't in your favourites");
    return { status: 204 };
  });

  return router;
}

export function createApp(db: Db, options: AppOptions): Server {
  return createServer(listener(buildRouter(db, options), options.webOrigins));
}
