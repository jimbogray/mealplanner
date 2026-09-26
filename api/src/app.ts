import { createServer, type Server } from "node:http";
import type { AuthResponse, Family, FamilyMember, FavouriteRecipe, Invite, InvitePreview, LifeStage, Me, RecipePreview } from "@mealplanner/shared";
import { createSession, hashPassword, hashToken, bearerToken, newInviteCode, requireUser, verifyPassword } from "./auth.js";
import { withTransaction, type Db, type Tx } from "./db.js";
import { GoogleTokenError, verifyGoogleIdToken, type GoogleIdentity, type KeySource } from "./google.js";
import { HttpError, listener, Router, type Request } from "./http.js";
import { fetchPage, pageImages, pageText, parseRecipeMeta, type PageFetcher } from "./recipe-meta.js";
import type { RecipeReader } from "./recipe-reader.js";
import * as v from "./validate.js";

export const INVITE_DAYS = 14;

type Queryable = Pick<Db, "query">;

interface MemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  name: string;
  life_stage: FamilyMember["lifeStage"];
  diet: FamilyMember["diet"];
  allergies: FamilyMember["allergies"];
  role: FamilyMember["role"];
  email: string | null;
  created_at: Date;
}

const MEMBER_SELECT = `SELECT m.id, m.family_id, m.user_id, m.name, m.life_stage, m.diet, m.allergies, m.role, u.email, m.created_at
  FROM family_member m LEFT JOIN app_user u ON u.id = m.user_id`;

function toMember(r: MemberRow): FamilyMember {
  return {
    id: r.id,
    name: r.name,
    lifeStage: r.life_stage,
    diet: r.diet,
    allergies: r.allergies,
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
  if (ctx.member.role !== "admin") throw new HttpError(403, "Only a Family Manager can do that");
  return ctx;
}

/** Loads a member of the caller's family, or 404. */
async function familyMember(db: Queryable, familyId: string, id: string): Promise<MemberRow> {
  const row = (await db.query<MemberRow>(`${MEMBER_SELECT} WHERE m.id = $1 AND m.family_id = $2`, [v.uuid(id), familyId]))
    .rows[0];
  if (!row) throw new HttpError(404, "That family member doesn't exist");
  return row;
}

/** Family Managers who can actually sign in (a manager added without a login can't manage anything yet). */
async function adminCount(db: Queryable, familyId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM family_member WHERE family_id = $1 AND role = 'admin' AND user_id IS NOT NULL",
    [familyId],
  );
  return rows[0].n;
}

/** The new member's name and life stage, validated only when a new member row is actually created. */
type Profile = () => { name: string; lifeStage: LifeStage };

function profileFrom(b: Record<string, unknown>, fallbackName: string | null = null): Profile {
  return () => ({
    name: v.text(typeof b.name === "string" && b.name.trim() ? b.name : fallbackName, "Your name"),
    lifeStage: v.lifeStage(b.lifeStage),
  });
}

async function createFamily(tx: Tx, userId: string, familyName: string, profile: Profile): Promise<void> {
  const { name, lifeStage } = profile();
  const { rows } = await tx.query<{ id: string }>("INSERT INTO family (name) VALUES ($1) RETURNING id", [familyName]);
  await tx.query(
    "INSERT INTO family_member (family_id, user_id, name, life_stage, role) VALUES ($1, $2, $3, $4, 'admin')",
    [rows[0].id, userId, name, lifeStage],
  );
}

/**
 * Uses up an invite and adds the user to its family: as the invite's existing member if it
 * names one, otherwise as a new member. Locks the invite row so a code can't be used twice.
 */
async function acceptInvite(tx: Tx, code: string, userId: string, profile: Profile): Promise<void> {
  const invite = (
    await tx.query<{ id: string; family_id: string; member_id: string | null; accepted_at: Date | null; expired: boolean }>(
      "SELECT id, family_id, member_id, accepted_at, expires_at <= now() AS expired FROM invite WHERE code = $1 FOR UPDATE",
      [code.trim().toUpperCase()],
    )
  ).rows[0];
  if (!invite) throw new HttpError(404, "That invite link isn't valid");
  if (invite.accepted_at) throw new HttpError(410, "That invite link has already been used");
  if (invite.expired) throw new HttpError(410, "That invite link has expired, ask for a new one");
  let memberId: string;
  if (invite.member_id) {
    const { rows } = await tx.query<{ id: string }>(
      "UPDATE family_member SET user_id = $1 WHERE id = $2 AND user_id IS NULL RETURNING id",
      [userId, invite.member_id],
    );
    if (!rows[0]) throw new HttpError(410, "That person already has their own login");
    memberId = rows[0].id;
  } else {
    const { name, lifeStage } = profile();
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO family_member (family_id, user_id, name, life_stage, role) VALUES ($1, $2, $3, $4, 'member') RETURNING id",
      [invite.family_id, userId, name, lifeStage],
    );
    memberId = rows[0].id;
  }
  await tx.query("UPDATE invite SET accepted_by = $1, accepted_at = now() WHERE id = $2", [memberId, invite.id]);
}

interface InviteRow {
  id: string;
  code: string;
  member_id: string | null;
  member_name: string | null;
  created_at: Date;
  expires_at: Date;
}

function toInvite(r: InviteRow): Invite {
  return {
    id: r.id,
    code: r.code,
    memberId: r.member_id,
    memberName: r.member_name,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface AppOptions {
  /** Origins allowed to call the API from a browser. */
  webOrigins: string[];
  /** Enables Sign in with Google when set. */
  google?: { clientId: string; keys: KeySource };
  /** Downloads recipe pages; defaults to fetching them from the web. */
  fetchPage?: PageFetcher;
  /** Reads a recipe's details from its page with an LLM. Without it, people type the details in. */
  readRecipe?: RecipeReader;
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
  name: string;
  description: string | null;
  cooking_minutes: number | null;
  main_protein: string | null;
  image_url: string | null;
  site_name: string | null;
  added_by: string | null;
  created_at: Date;
}

const RECIPE_SELECT = `SELECT r.id, r.url, r.name, r.description, r.cooking_minutes, r.main_protein, r.image_url, r.site_name,
    m.name AS added_by, r.created_at
  FROM favourite_recipe r LEFT JOIN family_member m ON m.id = r.added_by`;

function toRecipe(r: RecipeRow): FavouriteRecipe {
  return {
    id: r.id,
    url: r.url,
    name: r.name,
    description: r.description,
    cookingMinutes: r.cooking_minutes,
    mainProtein: r.main_protein,
    imageUrl: r.image_url,
    siteName: r.site_name,
    addedBy: r.added_by,
    createdAt: r.created_at.toISOString(),
  };
}

export function buildRouter(db: Db, options: Pick<AppOptions, "google" | "fetchPage" | "readRecipe"> = {}): Router {
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
    const profile = profileFrom(b);
    const { familyName, inviteCode } = familyChoice(b);
    if (!inviteCode) profile(); // Validate before the (slow) password hash.
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
      if (inviteCode) await acceptInvite(tx, inviteCode, userId, profile);
      else await createFamily(tx, userId, familyName!, profile);
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
    const profile = profileFrom(b, identity.name);

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
          if (!inFamily) await acceptInvite(tx, inviteCode, existing.id, profile);
        }
        return { userId: existing.id, created: false };
      }

      if (!familyName && !inviteCode) {
        throw new HttpError(404, "No account uses that Google address yet. Create a family, or open your invite link, to sign up.");
      }
      const userId = (
        await tx.query<{ id: string }>("INSERT INTO app_user (email, google_sub) VALUES ($1, $2) RETURNING id", [
          identity.email,
          identity.sub,
        ])
      ).rows[0].id;
      if (inviteCode) await acceptInvite(tx, inviteCode, userId, profile);
      else await createFamily(tx, userId, familyName!, profile);
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
    const profile = profileFrom(b);
    profile();
    await withTransaction(db, async (tx) => {
      try {
        await createFamily(tx, userId, familyName, profile);
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

  // Add someone without a login. They can stay that way (a baby, a toddler) or be sent an
  // invite for this member later to sign in as themselves.
  router.add("POST", "/api/family/members", async (req) => {
    const { member } = await requireAdmin(db, req);
    const b = v.object(req.body);
    const name = v.text(b.name, "Name");
    const lifeStage = v.lifeStage(b.lifeStage);
    const diet = b.diet === undefined ? "none" : v.diet(b.diet);
    const allergies = b.allergies === undefined ? [] : v.allergies(b.allergies);
    // A Co-Manager is another Family Manager; they can manage the family once they sign in.
    const role = b.role === undefined ? "member" : v.role(b.role);
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO family_member (family_id, name, life_stage, diet, allergies, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [member.family_id, name, lifeStage, diet, allergies, role],
    );
    return { status: 201, body: toMember(await familyMember(db, member.family_id, rows[0].id)) };
  });

  // Admins can edit anyone; everyone can edit their own name, life stage, diet and allergies.
  router.add("PATCH", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    const isSelf = target.id === self.id;
    if (self.role !== "admin" && !isSelf) throw new HttpError(403, "Only a Family Manager can change other members");

    const b = v.object(req.body);
    const name = b.name === undefined ? target.name : v.text(b.name, "Name");
    const lifeStage = b.lifeStage === undefined ? target.life_stage : v.lifeStage(b.lifeStage);
    const diet = b.diet === undefined ? target.diet : v.diet(b.diet);
    const allergies = b.allergies === undefined ? target.allergies : v.allergies(b.allergies);
    let role = target.role;
    if (b.role !== undefined) {
      const newRole = v.role(b.role);
      if (self.role !== "admin") throw new HttpError(403, "Only a Family Manager can choose who manages the family");
      if (newRole === "member" && target.role === "admin" && target.user_id && (await adminCount(db, self.family_id)) <= 1) {
        throw new HttpError(400, "A family needs at least one Family Manager");
      }
      role = newRole;
    }
    await db.query(
      "UPDATE family_member SET name = $1, life_stage = $2, diet = $3, allergies = $4, role = $5 WHERE id = $6",
      [name, lifeStage, diet, allergies, role, target.id],
    );
    return { body: toMember(await familyMember(db, self.family_id, target.id)) };
  });

  router.add("DELETE", "/api/family/members/:id", async (req) => {
    const { member: self } = await requireMember(db, req);
    const target = await familyMember(db, self.family_id, req.params.id);
    // Admins can remove anyone; anyone can leave.
    if (self.role !== "admin" && target.id !== self.id) throw new HttpError(403, "Only a Family Manager can remove members");
    if (target.role === "admin" && target.user_id && (await adminCount(db, self.family_id)) <= 1) {
      throw new HttpError(400, "A family needs at least one Family Manager; make someone else a Family Manager first");
    }
    await db.query("DELETE FROM family_member WHERE id = $1", [target.id]);
    return { status: 204 };
  });

  // --- invites ----------------------------------------------------------

  router.add("GET", "/api/family/invites", async (req) => {
    const { member } = await requireAdmin(db, req);
    const { rows } = await db.query<InviteRow>(
      `SELECT i.id, i.code, i.member_id, m.name AS member_name, i.created_at, i.expires_at
         FROM invite i LEFT JOIN family_member m ON m.id = i.member_id
        WHERE i.family_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
      [member.family_id],
    );
    const body: Invite[] = rows.map(toInvite);
    return { body };
  });

  router.add("POST", "/api/family/invites", async (req) => {
    const { member } = await requireAdmin(db, req);
    const b = req.body === undefined ? {} : v.object(req.body);
    let target: MemberRow | null = null;
    if (b.memberId !== undefined && b.memberId !== null) {
      target = await familyMember(db, member.family_id, String(b.memberId));
      if (target.user_id) throw new HttpError(400, `${target.name} already has their own login`);
    }
    const { rows } = await db.query<InviteRow>(
      `INSERT INTO invite (family_id, code, created_by, member_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
       RETURNING id, code, member_id, NULL::text AS member_name, created_at, expires_at`,
      [member.family_id, newInviteCode(), member.id, target?.id ?? null, INVITE_DAYS],
    );
    const body = toInvite({ ...rows[0], member_name: target?.name ?? null });
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
    const { rows } = await db.query<{
      family_name: string;
      invited_by: string | null;
      member_name: string | null;
      expires_at: Date;
      accepted_at: Date | null;
    }>(
      `SELECT f.name AS family_name, m.name AS invited_by, t.name AS member_name, i.expires_at, i.accepted_at
         FROM invite i JOIN family f ON f.id = i.family_id
         LEFT JOIN family_member m ON m.id = i.created_by
         LEFT JOIN family_member t ON t.id = i.member_id
        WHERE i.code = $1`,
      [req.params.code.trim().toUpperCase()],
    );
    const r = rows[0];
    if (!r) throw new HttpError(404, "That invite link isn't valid");
    if (r.accepted_at) throw new HttpError(410, "That invite link has already been used");
    if (r.expires_at <= new Date()) throw new HttpError(410, "That invite link has expired, ask for a new one");
    const body: InvitePreview = {
      familyName: r.family_name,
      memberName: r.member_name,
      invitedBy: r.invited_by ?? "A family member",
      expiresAt: r.expires_at.toISOString(),
    };
    return { body };
  });

  // For a signed-in user who isn't in a family yet.
  router.add("POST", "/api/invites/:code/accept", async (req) => {
    const { userId, email } = await requireUser(db, req);
    const profile = profileFrom(req.body === undefined ? {} : v.object(req.body));
    await withTransaction(db, async (tx) => {
      try {
        await acceptInvite(tx, req.params.code, userId, profile);
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

  // Reads a recipe page so the person adding it can check (or fill in) the details before saving.
  router.add("POST", "/api/family/recipes/preview", async (req) => {
    const { member } = await requireMember(db, req);
    const url = v.webUrl(v.object(req.body).url, "Recipe link");
    const alreadySaved = !!(
      await db.query("SELECT 1 FROM favourite_recipe WHERE family_id = $1 AND url = $2", [member.family_id, url])
    ).rowCount;
    const preview: RecipePreview = {
      url,
      isRecipe: null,
      name: null,
      description: null,
      cookingMinutes: null,
      mainProtein: null,
      imageUrl: null,
      siteName: null,
      alreadySaved,
    };
    if (alreadySaved) return { body: preview };

    let page;
    try {
      page = await (options.fetchPage ?? fetchPage)(url);
    } catch {
      return { body: preview }; // Couldn't read it (offline, blocked, not HTML…): they fill it in.
    }
    const meta = parseRecipeMeta(page.html, page.url);
    Object.assign(preview, { name: meta.title, imageUrl: meta.imageUrl, siteName: meta.siteName });
    if (!options.readRecipe) return { body: preview };
    try {
      const images = pageImages(page.html, page.url);
      const details = await options.readRecipe({ url: page.url, text: pageText(page.html), images });
      // The page's own share image wins; otherwise Claude's pick, as long as it really is on the page.
      if (!preview.imageUrl && images.some((i) => i.url === details.imageUrl)) preview.imageUrl = details.imageUrl;
      preview.isRecipe = details.isRecipe;
      // Not a recipe: the page's title is no guess at a dish name, so leave it for the person to type.
      if (!details.isRecipe) preview.name = null;
      else {
        preview.name = details.name?.trim() || meta.title;
        preview.description = details.description?.trim() || null;
        const minutes = Math.round(details.cookingMinutes ?? 0);
        preview.cookingMinutes = minutes > 0 && minutes <= 2880 ? minutes : null;
        preview.mainProtein = details.mainProtein?.trim() || null;
      }
    } catch (err) {
      console.error("Reading a recipe with the LLM failed", err);
    }
    return { body: preview };
  });

  router.add("POST", "/api/family/recipes", async (req) => {
    const { member } = await requireMember(db, req);
    const b = v.object(req.body);
    const url = v.webUrl(b.url, "Recipe link");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO favourite_recipe (family_id, url, name, description, cooking_minutes, main_protein, image_url, site_name, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (family_id, url) DO NOTHING RETURNING id`,
      [
        member.family_id,
        url,
        v.text(b.name, "Recipe name", 200),
        v.optionalText(b.description, "Description", 1000),
        v.optionalMinutes(b.cookingMinutes),
        v.optionalText(b.mainProtein, "Main protein", 80),
        b.imageUrl == null || b.imageUrl === "" ? null : v.webUrl(b.imageUrl, "Image link"),
        v.optionalText(b.siteName, "Site name", 80),
        member.id,
      ],
    );
    if (!rows[0]) throw new HttpError(409, "That recipe is already one of your favourites");
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
