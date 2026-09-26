// End-to-end tests against a real Postgres. Each run gets its own schema, so any
// database works; set TEST_DATABASE_URL (or DATABASE_URL). Skipped when neither is set.
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  addDays,
  mondayOf,
  type AuthResponse,
  type FamilyMember,
  type FavouriteRecipe,
  type Invite,
  type InvitePreview,
  type Me,
  type RecipePreview,
  type ScheduleDay,
  type ScheduleWeek,
} from "@mealplanner/shared";
import { createApp } from "../src/app.js";
import { createPool, migrate, type Db } from "../src/db.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `test_${process.pid}_${Date.now()}`;

// A stand-in for Google's signing key, so Google sign-in can be tested offline.
const GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

function googleToken(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "test-kid", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, iat: now, exp: now + 3600, email_verified: true, ...claims }),
  ).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(opts.key ?? googleKey.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

describe("API", { skip: url ? false : "set TEST_DATABASE_URL to run API tests" }, () => {
  let admin: Db;
  let db: Db;
  let server: ReturnType<typeof createApp>;
  let base: string;

  before(async () => {
    admin = createPool(url!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createPool(url!, { options: `-c search_path=${schema}` });
    await migrate(db);
    server = createApp(db, {
      webOrigins: ["http://web.test"],
      google: { clientId: GOOGLE_CLIENT_ID, keys: async () => new Map([["test-kid", googleKey.publicKey]]) },
      // Stand in for the web and for Claude, so tests stay offline.
      fetchPage: async (url) => {
        if (url.includes("unreachable")) throw new Error("offline");
        // "noimage" pages have no share image, just photos in the page for Claude to choose from.
        const head = url.includes("noimage")
          ? `<title>Page title</title>`
          : `<title>Page title</title><meta property="og:image" content="/p.jpg"><meta property="og:site_name" content="Good Food">`;
        return {
          url,
          html: `${head}<h1>${url.includes("shop") ? "Buy pans" : "Easy pancakes"}</h1>
            <img src="/step-1.jpg" alt="Whisking"><img src="/done.jpg" alt="A stack of pancakes">`,
        };
      },
      readRecipe: async ({ url, text, images }) => {
        const none = { name: null, description: null, cookingMinutes: null, mainProtein: null, imageUrl: null };
        if (text.includes("Buy pans")) return { isRecipe: false, ...none };
        if (text.includes("Easy pancakes")) {
          // Claude picks the finished-dish photo, or (for "badpick") a URL that isn't on the page.
          const pick = url.includes("badpick") ? "https://evil.example.com/x.jpg" : images.find((i) => i.alt?.includes("stack"))?.url ?? null;
          return { isRecipe: true, name: "Easy pancakes", description: "Thin, lemony pancakes.", cookingMinutes: 25, mainProtein: "Eggs", imageUrl: pick };
        }
        throw new Error("unexpected page text: " + text);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  async function call<T = unknown>(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }

  let parentToken: string;
  let parentMe: Me;

  test("sign up creates a family with the signer as admin", async () => {
    const res = await call<AuthResponse>("POST", "/api/auth/signup", {
      body: { email: "Parent@Example.com", password: "password123", name: "Alex", lifeStage: "adult", familyName: "The Smiths" },
    });
    assert.equal(res.status, 201);
    parentToken = res.body.token;
    parentMe = res.body.me;
    assert.equal(parentMe.user.email, "parent@example.com");
    assert.equal(parentMe.family?.name, "The Smiths");
    assert.equal(parentMe.member?.role, "admin");
    assert.equal(parentMe.member?.lifeStage, "adult");
    assert.equal(parentMe.members.length, 1);
  });

  test("sign up validates input", async () => {
    const bad = [
      { email: "x@y.com", password: "short", name: "A", lifeStage: "adult", familyName: "F" },
      { email: "not-an-email", password: "password123", name: "A", lifeStage: "adult", familyName: "F" },
      { email: "x@y.com", password: "password123", name: "A", lifeStage: "elder", familyName: "F" },
      { email: "x@y.com", password: "password123", name: "A", lifeStage: "adult" },
      { email: "x@y.com", password: "password123", name: " ", lifeStage: "adult", familyName: "F" },
    ];
    for (const body of bad) assert.equal((await call("POST", "/api/auth/signup", { body })).status, 400, JSON.stringify(body));
  });

  test("the same email can't sign up twice", async () => {
    const res = await call("POST", "/api/auth/signup", {
      body: { email: "parent@example.COM", password: "password123", name: "Dup", lifeStage: "adult", familyName: "Dups" },
    });
    assert.equal(res.status, 409);
  });

  test("login works with the right password only", async () => {
    assert.equal((await call("POST", "/api/auth/login", { body: { email: "parent@example.com", password: "nope-nope" } })).status, 401);
    const res = await call<AuthResponse>("POST", "/api/auth/login", { body: { email: " PARENT@example.com", password: "password123" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.me.family?.id, parentMe.family?.id);
  });

  test("/api/me needs a valid token", async () => {
    assert.equal((await call("GET", "/api/me")).status, 401);
    assert.equal((await call("GET", "/api/me", { token: "bogus" })).status, 401);
    assert.equal((await call("GET", "/api/me", { token: parentToken })).status, 200);
  });

  let babyId: string;

  test("an admin can add members without a login, one per life stage", async () => {
    for (const [name, lifeStage] of [
      ["Bea", "baby"],
      ["Tom", "toddler"],
      ["Cal", "child"],
    ]) {
      const res = await call<FamilyMember>("POST", "/api/family/members", { token: parentToken, body: { name, lifeStage } });
      assert.equal(res.status, 201);
      assert.equal(res.body.lifeStage, lifeStage);
      assert.equal(res.body.hasAccount, false);
      if (lifeStage === "baby") babyId = res.body.id;
    }
    const me = (await call<Me>("GET", "/api/me", { token: parentToken })).body;
    // Oldest first.
    assert.deepEqual(
      me.members.map((m) => m.lifeStage),
      ["adult", "child", "toddler", "baby"],
    );
  });

  test("an admin can change a member's life stage", async () => {
    const res = await call<FamilyMember>("PATCH", `/api/family/members/${babyId}`, { token: parentToken, body: { lifeStage: "toddler" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.lifeStage, "toddler");
    assert.equal(res.body.name, "Bea");
  });

  test("members have a diet and allergies, editable by an admin", async () => {
    const added = await call<FamilyMember>("POST", "/api/family/members", {
      token: parentToken,
      body: { name: "Val", lifeStage: "child", diet: "vegan", allergies: ["sesame", "peanut", "peanut"] },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.diet, "vegan");
    assert.deepEqual(added.body.allergies, ["peanut", "sesame"]);

    const baby = await call<FamilyMember>("PATCH", `/api/family/members/${babyId}`, {
      token: parentToken,
      body: { diet: "vegetarian", allergies: ["dairy", "egg"] },
    });
    assert.equal(baby.body.diet, "vegetarian");
    assert.deepEqual(baby.body.allergies, ["dairy", "egg"]);
    assert.equal(baby.body.lifeStage, "toddler");

    const cleared = await call<FamilyMember>("PATCH", `/api/family/members/${added.body.id}`, {
      token: parentToken,
      body: { diet: "none", allergies: [] },
    });
    assert.equal(cleared.body.diet, "none");
    assert.deepEqual(cleared.body.allergies, []);

    for (const body of [{ diet: "keto" }, { allergies: ["kryptonite"] }, { allergies: "peanut" }]) {
      assert.equal((await call("PATCH", `/api/family/members/${babyId}`, { token: parentToken, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call("DELETE", `/api/family/members/${added.body.id}`, { token: parentToken })).status, 204);
  });

  test("an admin-added member can later be invited to sign in as themselves", async () => {
    const dad = await call<FamilyMember>("POST", "/api/family/members", {
      token: parentToken,
      body: { name: "Dad", lifeStage: "adult", diet: "vegetarian", allergies: ["fish"] },
    });
    assert.equal(dad.body.hasAccount, false);
    const invite = await call<Invite>("POST", "/api/family/invites", { token: parentToken, body: { memberId: dad.body.id } });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.memberName, "Dad");

    const preview = await call<InvitePreview>("GET", `/api/invites/${invite.body.code}`);
    assert.equal(preview.body.memberName, "Dad");

    // No name or life stage needed: the member already has them.
    const joined = await call<AuthResponse>("POST", "/api/auth/signup", {
      body: { email: "dad@example.com", password: "password123", inviteCode: invite.body.code },
    });
    assert.equal(joined.status, 201);
    const me = joined.body.me;
    assert.equal(me.member?.id, dad.body.id);
    assert.equal(me.member?.hasAccount, true);
    assert.equal(me.member?.email, "dad@example.com");
    assert.equal(me.member?.diet, "vegetarian");
    assert.deepEqual(me.member?.allergies, ["fish"]);
    assert.equal(me.members.filter((m) => m.name === "Dad").length, 1);

    // A member who now has a login can't get another member invite.
    assert.equal((await call("POST", "/api/family/invites", { token: parentToken, body: { memberId: dad.body.id } })).status, 400);
    // Removing the member drops the login's membership, not the login.
    assert.equal((await call("DELETE", `/api/family/members/${dad.body.id}`, { token: parentToken })).status, 204);
    assert.equal((await call<Me>("GET", "/api/me", { token: joined.body.token })).body.family, null);
  });

  test("a member invite is deleted with its member", async () => {
    const kid = await call<FamilyMember>("POST", "/api/family/members", { token: parentToken, body: { name: "Kid", lifeStage: "teenager" } });
    const invite = await call<Invite>("POST", "/api/family/invites", { token: parentToken, body: { memberId: kid.body.id } });
    await call("DELETE", `/api/family/members/${kid.body.id}`, { token: parentToken });
    assert.equal((await call("GET", `/api/invites/${invite.body.code}`)).status, 404);
  });

  test("only adults and teenagers can be invited to sign in or made managers", async () => {
    const child = await call<FamilyMember>("POST", "/api/family/members", { token: parentToken, body: { name: "Tiny", lifeStage: "child" } });
    assert.equal((await call("POST", "/api/family/invites", { token: parentToken, body: { memberId: child.body.id } })).status, 400);
    assert.equal((await call("PATCH", `/api/family/members/${child.body.id}`, { token: parentToken, body: { role: "admin" } })).status, 400);
    assert.equal(
      (await call("POST", "/api/family/members", { token: parentToken, body: { name: "Tot", lifeStage: "toddler", role: "admin" } })).status,
      400,
    );
    await call("DELETE", `/api/family/members/${child.body.id}`, { token: parentToken });
  });

  let teenToken: string;
  let teenMemberId: string;

  test("an invite link lets a teenager join the family once", async () => {
    const created = await call<Invite>("POST", "/api/family/invites", { token: parentToken });
    assert.equal(created.status, 201);
    const code = created.body.code;

    const preview = await call<InvitePreview>("GET", `/api/invites/${code.toLowerCase()}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.familyName, "The Smiths");
    assert.equal(preview.body.invitedBy, "Alex");

    const listed = await call<Invite[]>("GET", "/api/family/invites", { token: parentToken });
    assert.deepEqual(listed.body.map((i) => i.code), [code]);

    const joined = await call<AuthResponse>("POST", "/api/auth/signup", {
      body: { email: "teen@example.com", password: "password123", name: "Sam", lifeStage: "teenager", inviteCode: code },
    });
    assert.equal(joined.status, 201);
    teenToken = joined.body.token;
    teenMemberId = joined.body.me.member!.id;
    assert.equal(joined.body.me.family?.id, parentMe.family?.id);
    assert.equal(joined.body.me.member?.role, "member");
    assert.equal(joined.body.me.members.length, 5);

    const reuse = await call("POST", "/api/auth/signup", {
      body: { email: "other@example.com", password: "password123", name: "X", lifeStage: "adult", inviteCode: code },
    });
    assert.equal(reuse.status, 410);
    // The failed sign-up rolled back, so the email is still free.
    assert.equal((await call("POST", "/api/auth/login", { body: { email: "other@example.com", password: "password123" } })).status, 401);
    assert.equal((await call("GET", `/api/invites/${code}`)).status, 410);
    assert.deepEqual((await call<Invite[]>("GET", "/api/family/invites", { token: parentToken })).body, []);
  });

  test("unknown and expired invites are rejected", async () => {
    assert.equal((await call("GET", "/api/invites/NOPENOPENOPE")).status, 404);
    const created = await call<Invite>("POST", "/api/family/invites", { token: parentToken });
    await db.query("UPDATE invite SET expires_at = now() - interval '1 minute' WHERE id = $1", [created.body.id]);
    assert.equal((await call("GET", `/api/invites/${created.body.code}`)).status, 410);
  });

  test("a non-admin can edit themselves but not manage the family", async () => {
    const self = await call<FamilyMember>("PATCH", `/api/family/members/${teenMemberId}`, { token: teenToken, body: { lifeStage: "adult" } });
    assert.equal(self.status, 200);
    assert.equal(self.body.lifeStage, "adult");
    assert.equal((await call("PATCH", `/api/family/members/${babyId}`, { token: teenToken, body: { name: "X" } })).status, 403);
    assert.equal((await call("PATCH", `/api/family/members/${teenMemberId}`, { token: teenToken, body: { role: "admin" } })).status, 403);
    assert.equal((await call("POST", "/api/family/members", { token: teenToken, body: { name: "X", lifeStage: "baby" } })).status, 403);
    assert.equal((await call("POST", "/api/family/invites", { token: teenToken })).status, 403);
    assert.equal((await call("DELETE", `/api/family/members/${babyId}`, { token: teenToken })).status, 403);
  });

  test("members of another family are invisible", async () => {
    const other = await call<AuthResponse>("POST", "/api/auth/signup", {
      body: { email: "jones@example.com", password: "password123", name: "Jo", lifeStage: "adult", familyName: "The Joneses" },
    });
    assert.equal((await call("PATCH", `/api/family/members/${babyId}`, { token: other.body.token, body: { name: "X" } })).status, 404);
    assert.equal((await call("DELETE", `/api/family/members/${babyId}`, { token: other.body.token })).status, 404);
  });

  describe("favourite recipes", () => {
    let pancakesId: string;
    const pancakes = "https://www.example.com/recipes/pancakes";

    test("previewing a recipe link reads its details from the page", async () => {
      const res = await call<RecipePreview>("POST", "/api/family/recipes/preview", { token: teenToken, body: { url: `${pancakes}#method` } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        url: pancakes,
        isRecipe: true,
        name: "Easy pancakes",
        description: "Thin, lemony pancakes.",
        cookingMinutes: 25,
        mainProtein: "Eggs",
        imageUrl: "https://www.example.com/p.jpg",
        siteName: "Good Food",
        alreadySaved: false,
      });
    });

    test("without a share image, Claude's pick of the page's photos is used", async () => {
      const res = await call<RecipePreview>("POST", "/api/family/recipes/preview", {
        token: teenToken,
        body: { url: "https://www.example.com/noimage/pancakes" },
      });
      assert.equal(res.body.imageUrl, "https://www.example.com/done.jpg");
      const bad = await call<RecipePreview>("POST", "/api/family/recipes/preview", {
        token: teenToken,
        body: { url: "https://www.example.com/noimage/badpick" },
      });
      assert.equal(bad.body.imageUrl, null);
    });

    test("any family member can save one, and the whole family sees it", async () => {
      const preview = (await call<RecipePreview>("POST", "/api/family/recipes/preview", { token: teenToken, body: { url: pancakes } })).body;
      const res = await call<FavouriteRecipe>("POST", "/api/family/recipes", { token: teenToken, body: preview });
      assert.equal(res.status, 201);
      pancakesId = res.body.id;
      assert.equal(res.body.name, "Easy pancakes");
      assert.equal(res.body.cookingMinutes, 25);
      assert.equal(res.body.mainProtein, "Eggs");
      assert.equal(res.body.addedBy, "Sam");
      assert.equal(res.body.prepared, false);
      const list = await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: parentToken });
      assert.deepEqual(list.body.map((r) => r.id), [pancakesId]);
    });

    test("the same link can't be saved twice", async () => {
      const preview = await call<RecipePreview>("POST", "/api/family/recipes/preview", { token: parentToken, body: { url: pancakes } });
      assert.equal(preview.body.alreadySaved, true);
      const res = await call("POST", "/api/family/recipes", { token: parentToken, body: { url: pancakes, name: "Again" } });
      assert.equal(res.status, 409);
    });

    test("a page that isn't a recipe is flagged, and can still be saved with typed-in details", async () => {
      const url = "https://shop.example.com/pans";
      const preview = await call<RecipePreview>("POST", "/api/family/recipes/preview", { token: parentToken, body: { url } });
      assert.equal(preview.body.isRecipe, false);
      assert.equal(preview.body.name, null);
      assert.equal(preview.body.cookingMinutes, null);
      const saved = await call<FavouriteRecipe>("POST", "/api/family/recipes", {
        token: parentToken,
        body: { ...preview.body, name: "Granny's pan curry", mainProtein: "Lamb", cookingMinutes: 90, description: "" },
      });
      assert.equal(saved.status, 201);
      assert.equal(saved.body.description, null);
      assert.equal(saved.body.cookingMinutes, 90);
    });

    test("a page that can't be read comes back empty for the person to fill in", async () => {
      const preview = await call<RecipePreview>("POST", "/api/family/recipes/preview", {
        token: parentToken,
        body: { url: "unreachable.example.com/stew/" },
      });
      assert.equal(preview.body.url, "https://unreachable.example.com/stew/");
      assert.equal(preview.body.isRecipe, null);
      assert.equal(preview.body.name, null);
    });

    test("saved details are validated", async () => {
      for (const body of [
        { url: "javascript:alert(1)", name: "X" },
        { url: "ftp://example.com/x", name: "X" },
        { url: "not a link", name: "X" },
        { url: "https://user:pw@example.com/", name: "X" },
        { url: "https://example.com/a", name: "" },
        { url: "https://example.com/a", name: "X", cookingMinutes: 12.5 },
        { url: "https://example.com/a", name: "X", imageUrl: "javascript:alert(1)" },
      ]) {
        assert.equal((await call("POST", "/api/family/recipes", { token: parentToken, body })).status, 400, JSON.stringify(body));
      }
    });

    test("only a Family Manager can mark one as prepared", async () => {
      const path = `/api/family/recipes/${pancakesId}`;
      assert.equal((await call("PATCH", path, { token: teenToken, body: { prepared: true } })).status, 403);
      assert.equal((await call("PATCH", path, { token: parentToken, body: { prepared: "yes" } })).status, 400);
      const res = await call<FavouriteRecipe>("PATCH", path, { token: parentToken, body: { prepared: true } });
      assert.equal(res.status, 200);
      assert.equal(res.body.prepared, true);
      assert.equal(res.body.name, "Easy pancakes");
      const list = await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: teenToken });
      assert.equal(list.body.find((r) => r.id === pancakesId)?.prepared, true);
      assert.equal((await call<FavouriteRecipe>("PATCH", path, { token: parentToken, body: { prepared: false } })).body.prepared, false);
    });

    test("other families can't see or remove them", async () => {
      const other = await call<AuthResponse>("POST", "/api/auth/signup", {
        body: { email: "recipes-other@example.com", password: "password123", name: "Ola", lifeStage: "adult", familyName: "Others" },
      });
      assert.deepEqual((await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: other.body.token })).body, []);
      assert.equal((await call("DELETE", `/api/family/recipes/${pancakesId}`, { token: other.body.token })).status, 404);
      const patch = await call("PATCH", `/api/family/recipes/${pancakesId}`, { token: other.body.token, body: { prepared: true } });
      assert.equal(patch.status, 404);
      assert.equal((await call("GET", "/api/family/recipes")).status, 401);
    });

    test("any family member can remove one", async () => {
      assert.equal((await call("DELETE", `/api/family/recipes/${pancakesId}`, { token: teenToken })).status, 204);
      assert.equal((await call("DELETE", `/api/family/recipes/${pancakesId}`, { token: teenToken })).status, 404);
      const list = await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: parentToken });
      assert.equal(list.body.length, 1);
    });
  });

  describe("weekly schedule", () => {
    const today = new Date().toISOString().slice(0, 10);
    const thisWeek = mondayOf(today);
    let everyone: string[];

    before(async () => {
      everyone = (await call<Me>("GET", "/api/me", { token: parentToken })).body.members.map((m) => m.id).sort();
    });

    test("starts empty, and weeks must start on a Monday", async () => {
      assert.deepEqual((await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: parentToken })).body, []);
      const tuesday = addDays(thisWeek, 1);
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: tuesday, today } })).status, 400);
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: "2026-02-30", today } })).status, 400);
    });

    test("only this week can be added first", async () => {
      const res = await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: addDays(thisWeek, 7), today } });
      assert.equal(res.status, 409);
      const stale = await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: thisWeek, today: "2020-01-01" } });
      assert.equal(stale.status, 400);
    });

    test("adding a week defaults to everyone joining with no guests, unless days say otherwise", async () => {
      const friday = addDays(thisWeek, 4);
      const res = await call<ScheduleWeek>("POST", "/api/family/weeks", {
        token: teenToken,
        body: { startsOn: thisWeek, today, days: [{ date: friday, memberIds: [everyone[0]], guests: 3 }] },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.startsOn, thisWeek);
      assert.deepEqual(
        res.body.days.map((d) => d.date),
        Array.from({ length: 7 }, (_, i) => addDays(thisWeek, i)),
      );
      for (const d of res.body.days) {
        if (d.date === friday) assert.deepEqual(d, { date: friday, memberIds: [everyone[0]], guests: 3 });
        else assert.deepEqual(d, { date: d.date, memberIds: everyone, guests: 0 });
      }
    });

    test("then only the week after the last one, once", async () => {
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: thisWeek, today } })).status, 409);
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: addDays(thisWeek, 14), today } })).status, 409);
      const next = await call<ScheduleWeek>("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: addDays(thisWeek, 7), today } });
      assert.equal(next.status, 201);
      const weeks = await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: teenToken });
      assert.deepEqual(weeks.body.map((w) => w.startsOn), [thisWeek, addDays(thisWeek, 7)]);
    });

    test("days are validated", async () => {
      const startsOn = addDays(thisWeek, 14);
      for (const days of [
        [{ date: addDays(thisWeek, 7), memberIds: [], guests: 0 }],
        [{ date: startsOn, memberIds: [], guests: -1 }],
        [{ date: startsOn, memberIds: [], guests: 1.5 }],
        [{ date: startsOn, memberIds: ["00000000-0000-0000-0000-000000000000"], guests: 0 }],
        [
          { date: startsOn, memberIds: [], guests: 0 },
          { date: startsOn, memberIds: [], guests: 1 },
        ],
      ]) {
        assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn, today, days } })).status, 400, JSON.stringify(days));
      }
    });

    test("anyone in the family can change a day", async () => {
      const monday = addDays(thisWeek, 7);
      const res = await call<ScheduleDay>("PATCH", `/api/family/weeks/${monday}/days/${monday}`, {
        token: teenToken,
        body: { memberIds: [], guests: 2 },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { date: monday, memberIds: [], guests: 2 });
      const outside = await call("PATCH", `/api/family/weeks/${monday}/days/${thisWeek}`, { token: teenToken, body: { memberIds: [], guests: 0 } });
      assert.equal(outside.status, 404);
      const missing = addDays(thisWeek, 21);
      assert.equal((await call("PATCH", `/api/family/weeks/${missing}/days/${missing}`, { token: teenToken, body: { memberIds: [], guests: 0 } })).status, 404);
    });

    test("other families can't see or change it", async () => {
      const other = await call<AuthResponse>("POST", "/api/auth/signup", {
        body: { email: "schedule-other@example.com", password: "password123", name: "Pat", lifeStage: "adult", familyName: "The Others" },
      });
      const token = other.body.token;
      assert.deepEqual((await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token })).body, []);
      assert.equal((await call("PATCH", `/api/family/weeks/${thisWeek}/days/${thisWeek}`, { token, body: { memberIds: [], guests: 0 } })).status, 404);
      assert.equal((await call("DELETE", `/api/family/weeks/${thisWeek}`, { token })).status, 404);
      // Their own week can't include our members.
      const res = await call("POST", "/api/family/weeks", {
        token,
        body: { startsOn: thisWeek, today, days: [{ date: thisWeek, memberIds: [everyone[0]], guests: 0 }] },
      });
      assert.equal(res.status, 400);
      assert.equal((await call("GET", "/api/family/weeks")).status, 401);
    });

    test("a week can be removed", async () => {
      assert.equal((await call("DELETE", `/api/family/weeks/${addDays(thisWeek, 7)}`, { token: parentToken })).status, 204);
      const weeks = await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: parentToken });
      assert.deepEqual(weeks.body.map((w) => w.startsOn), [thisWeek]);
    });
  });

  test("the last admin can't step down or leave", async () => {
    const adminId = parentMe.member!.id;
    assert.equal((await call("PATCH", `/api/family/members/${adminId}`, { token: parentToken, body: { role: "member" } })).status, 400);
    assert.equal((await call("DELETE", `/api/family/members/${adminId}`, { token: parentToken })).status, 400);
  });

  test("a Family Manager can add a Co-Manager, who only counts once they can sign in", async () => {
    const adminId = parentMe.member!.id;
    const co = await call<FamilyMember>("POST", "/api/family/members", {
      token: parentToken,
      body: { name: "Jo", lifeStage: "adult", role: "admin" },
    });
    assert.equal(co.status, 201);
    assert.equal(co.body.role, "admin");
    assert.equal(co.body.hasAccount, false);
    assert.equal((await call("POST", "/api/family/members", { token: parentToken, body: { name: "X", lifeStage: "adult", role: "boss" } })).status, 400);
    // Jo can't sign in yet, so the only manager who can still can't step down.
    assert.equal((await call("PATCH", `/api/family/members/${adminId}`, { token: parentToken, body: { role: "member" } })).status, 400);
    // A manager without a login can be demoted or removed freely.
    assert.equal((await call<FamilyMember>("PATCH", `/api/family/members/${co.body.id}`, { token: parentToken, body: { role: "member" } })).body.role, "member");
    assert.equal((await call<FamilyMember>("PATCH", `/api/family/members/${co.body.id}`, { token: parentToken, body: { role: "admin" } })).body.role, "admin");
    assert.equal((await call("DELETE", `/api/family/members/${co.body.id}`, { token: parentToken })).status, 204);
  });

  test("a removed member keeps their login and can start or join another family", async () => {
    assert.equal((await call("DELETE", `/api/family/members/${teenMemberId}`, { token: parentToken })).status, 204);
    const me = await call<Me>("GET", "/api/me", { token: teenToken });
    assert.equal(me.body.family, null);
    assert.equal((await call("POST", "/api/family/invites", { token: teenToken })).status, 403);

    const invite = await call<Invite>("POST", "/api/family/invites", { token: parentToken });
    const rejoined = await call<Me>("POST", `/api/invites/${invite.body.code}/accept`, {
      token: teenToken,
      body: { name: "Sam", lifeStage: "teenager" },
    });
    assert.equal(rejoined.status, 200);
    assert.equal(rejoined.body.family?.id, parentMe.family?.id);
    assert.equal((await call("POST", "/api/family", { token: teenToken, body: { familyName: "Mine", name: "Sam", lifeStage: "adult" } })).status, 409);
  });

  test("logout ends the session", async () => {
    assert.equal((await call("POST", "/api/auth/logout", { token: teenToken })).status, 204);
    assert.equal((await call("GET", "/api/me", { token: teenToken })).status, 401);
  });

  test("CORS allows only the configured web origin", async () => {
    const ok = await fetch(`${base}/api/me`, { method: "OPTIONS", headers: { origin: "http://web.test" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://web.test");
    const no = await fetch(`${base}/api/me`, { method: "OPTIONS", headers: { origin: "http://evil.test" } });
    assert.equal(no.headers.get("access-control-allow-origin"), null);
  });

  describe("Sign in with Google", () => {
    const google = (body: Record<string, unknown>) => call<AuthResponse>("POST", "/api/auth/google", { body });

    test("an unknown Google account can't just sign in", async () => {
      const res = await google({ credential: googleToken({ sub: "g-new", email: "new@gmail.com" }) });
      assert.equal(res.status, 404);
    });

    test("signing up with Google creates a family, then signs in", async () => {
      const credential = googleToken({ sub: "g-1", email: "Kim@Gmail.com", name: "Kim Park" });
      const res = await google({ credential, lifeStage: "adult", familyName: "The Parks" });
      assert.equal(res.status, 201);
      assert.equal(res.body.me.user.email, "kim@gmail.com");
      assert.equal(res.body.me.member?.name, "Kim Park");
      assert.equal(res.body.me.member?.role, "admin");
      assert.equal(res.body.me.family?.name, "The Parks");

      const again = await google({ credential: googleToken({ sub: "g-1", email: "kim@gmail.com" }) });
      assert.equal(again.status, 200);
      assert.equal(again.body.me.family?.id, res.body.me.family?.id);
      // No password on this account, so password sign-in never works.
      assert.equal((await call("POST", "/api/auth/login", { body: { email: "kim@gmail.com", password: "" } })).status, 401);
    });

    test("joining through an invite with Google", async () => {
      const invite = await call<Invite>("POST", "/api/family/invites", { token: parentToken });
      const res = await google({
        credential: googleToken({ sub: "g-2", email: "gran@gmail.com", name: "Gran" }),
        lifeStage: "adult",
        inviteCode: invite.body.code,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.me.family?.id, parentMe.family?.id);
      assert.equal(res.body.me.member?.role, "member");
    });

    test("Google links to an existing password account with the same email", async () => {
      const res = await google({ credential: googleToken({ sub: "g-parent", email: "parent@example.com" }) });
      assert.equal(res.status, 200);
      assert.equal(res.body.me.member?.id, parentMe.member?.id);
      // The password still works too.
      assert.equal((await call("POST", "/api/auth/login", { body: { email: "parent@example.com", password: "password123" } })).status, 200);
      // A different Google account claiming the same email is refused.
      assert.equal((await google({ credential: googleToken({ sub: "g-other", email: "parent@example.com" }) })).status, 409);
    });

    test("bad Google tokens are rejected", async () => {
      const now = Math.floor(Date.now() / 1000);
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const bad = [
        googleToken({ sub: "g-1", email: "kim@gmail.com" }, { key: other.privateKey }),
        googleToken({ sub: "g-1", email: "kim@gmail.com" }, { kid: "unknown" }),
        googleToken({ sub: "g-1", email: "kim@gmail.com", aud: "someone-else" }),
        googleToken({ sub: "g-1", email: "kim@gmail.com", iss: "https://evil.example" }),
        googleToken({ sub: "g-1", email: "kim@gmail.com", exp: now - 3600 }),
        googleToken({ sub: "g-1", email: "kim@gmail.com", email_verified: false }),
        "not.a.token",
      ];
      for (const credential of bad) assert.equal((await google({ credential })).status, 401, credential.slice(0, 40));
      assert.equal((await google({})).status, 400);
    });
  });

  test("unknown routes and methods", async () => {
    assert.equal((await call("GET", "/api/nope")).status, 404);
    assert.equal((await call("PUT", "/api/me")).status, 405);
    assert.equal((await call("GET", "/api/health")).status, 200);
  });
});
