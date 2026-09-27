// End-to-end tests against a real Postgres. Each run gets its own schema, so any
// database works; set TEST_DATABASE_URL (or DATABASE_URL). Skipped when neither is set.
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  addDays,
  eventOn,
  type Address,
  mondayOf,
  type AddressSearchResponse,
  type AuthResponse,
  type FamilyMember,
  type FavouriteRecipe,
  type Invite,
  type InvitePreview,
  type Me,
  type DinnerTimes,
  type RecipePreview,
  type Restaurant,
  type RestaurantPreview,
  type ScheduleDay,
  type ScheduleEvent,
  type ScheduleWeek,
} from "@mealplanner/shared";
import { AddressSearchError } from "../src/places.js";
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
        if (url.includes("trattoria")) {
          return {
            url,
            html: `<title>Trattoria</title><h1>Trattoria Roma</h1><p>Proper Roman food. 5 Market Street, Bath BA1 1AB</p>
              <a href="/menu">Menu</a><a href="https://www.opentable.co.uk/r/trattoria-roma">Book a table</a>`,
          };
        }
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
      // Stands in for Google Places: typing "Pennsylvania" finds two addresses and "broken" means Google is down.
      addressSearch: {
        suggest: async (input) => {
          if (input.includes("broken")) throw new AddressSearchError("down");
          if (!input.includes("Pennsylvania")) return [];
          return [
            { placeId: "place-10", text: "1600 Pennsylvania Avenue NW", secondaryText: "Washington, DC 20500, USA" },
            { placeId: "place-downing", text: "Pennsylvania Avenue NW", secondaryText: "Washington, DC, USA" },
          ];
        },
        details: async (placeId) => {
          const places: Record<string, Address | null> = {
            "place-10": { line1: "1600 Pennsylvania Avenue NW", line2: null, city: "Washington", state: "DC", zip: "20500", latitude: 51.5034, longitude: -0.1276 },
            "place-bath": { line1: "1 Main Street", line2: "Apt 2", city: "Burlington", state: "VT", zip: "05401", latitude: 51.38, longitude: -2.36 },
            "place-downing": null,
          };
          if (!(placeId in places)) throw new AddressSearchError("unknown place");
          return places[placeId];
        },
        // Restaurants: "Mill" finds one in Bristol (the only place nearer than London when searching from Bath).
        suggestPlaces: async (input, _token, near) => {
          if (!input.includes("Mill")) return [];
          const bristol = { placeId: "place-mill", text: "The Mill", secondaryText: "3 Mill Lane, Bristol BS1 1AA" };
          const london = { placeId: "place-mill-london", text: "Mill Kitchen", secondaryText: "London" };
          return near ? [bristol, london] : [london, bristol];
        },
        place: async (placeId) => {
          if (placeId === "place-nowhere") return null;
          if (placeId !== "place-mill") throw new AddressSearchError("unknown place");
          return { address: "3 Mill Lane, Bristol BS1 1AA", lat: 51.45, lng: -2.59 };
        },
      },
      // A tiny map: a few known places, "broken" stands for the service being down.
      maps: {
        findPlace: async (query, near) => {
          if (query.includes("broken")) throw new Error("maps down");
          const places: Record<string, { address: string; lat: number; lng: number }> = {
            "1 Main Street, Apt 2, Burlington, VT 05401": { address: "1 Main St, Burlington, VT 05401", lat: 51.38, lng: -2.36 },
            "Pizza Place": { address: "Pizza Place, 5 Market Street, Bath BA1 1AB", lat: 51.4, lng: -2.36 },
            "3 Mill Lane, Bristol": { address: "3 Mill Lane, Bristol BS1 1AA", lat: 51.45, lng: -2.59 },
          };
          const place = places[query];
          // Searching by name only finds places near home.
          if (!place || (query === "Pizza Place" && !near)) return null;
          return place;
        },
        // One minute per hundredth of a degree, give or take.
        driveMinutes: async (from, to) => Math.round((Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng)) * 100),
      },
      // Claude reading a restaurant's page: "trattoria" pages are restaurants; "madeup" ones return a booking link not on the page.
      readRestaurant: async ({ url, text, links }) => {
        if (!text.includes("Trattoria Roma")) return { isRestaurant: false, name: null, cuisine: null, address: null, bookingUrl: null };
        const booking = url.includes("madeup") ? "https://evil.example.com/book" : links.find((l) => l.text === "Book a table")?.url ?? null;
        return { isRestaurant: true, name: "Trattoria Roma", cuisine: "Italian", address: "5 Market Street, Bath BA1 1AB", bookingUrl: booking };
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

  async function call<T = unknown>(method: string, path: string, opts: { token?: string; body?: unknown; actAs?: string } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.actAs ? { "x-act-as": opts.actAs } : {}),
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
      body: { name: "Val", lifeStage: "child", diet: "vegan", allergies: ["sesame", "wheat", "peanut", "peanut"] },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.diet, "vegan");
    assert.deepEqual(added.body.allergies, ["peanut", "wheat", "sesame"]);

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

    // The UK-only allergens (gluten, mustard…) aren't on the US list.
    for (const body of [{ diet: "keto" }, { allergies: ["kryptonite"] }, { allergies: ["gluten"] }, { allergies: ["mustard"] }, { allergies: "peanut" }]) {
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

  test("familiar names: anyone sets their own, a Family Manager sets anyone's", async () => {
    const own = await call<FamilyMember>("PATCH", `/api/family/members/${teenMemberId}`, { token: teenToken, body: { familiarName: "  Tee " } });
    assert.equal(own.status, 200);
    assert.equal(own.body.familiarName, "Tee");
    assert.equal((await call("PATCH", `/api/family/members/${babyId}`, { token: teenToken, body: { familiarName: "Bub" } })).status, 403);

    const baby = await call<FamilyMember>("PATCH", `/api/family/members/${babyId}`, { token: parentToken, body: { familiarName: "Bub" } });
    assert.equal(baby.status, 200);
    assert.equal(baby.body.familiarName, "Bub");
    // Changing something else keeps it; a blank one clears it.
    const kept = await call<FamilyMember>("PATCH", `/api/family/members/${babyId}`, { token: parentToken, body: { diet: "none" } });
    assert.equal(kept.body.familiarName, "Bub");
    const cleared = await call<FamilyMember>("PATCH", `/api/family/members/${babyId}`, { token: parentToken, body: { familiarName: " " } });
    assert.equal(cleared.body.familiarName, null);
    const tooLong = { familiarName: "x".repeat(41) };
    assert.equal((await call("PATCH", `/api/family/members/${babyId}`, { token: parentToken, body: tooLong })).status, 400);

    const me = await call<Me>("GET", "/api/me", { token: parentToken });
    assert.equal(me.body.members.find((m) => m.id === teenMemberId)?.familiarName, "Tee");
    await call("PATCH", `/api/family/members/${teenMemberId}`, { token: teenToken, body: { familiarName: null } });
  });

  test("a Family Manager can switch to another member and gets only their permissions", async () => {
    const asTeen = await call<Me>("GET", "/api/me", { token: parentToken, actAs: teenMemberId });
    assert.equal(asTeen.status, 200);
    assert.equal(asTeen.body.member?.id, teenMemberId);
    assert.equal(asTeen.body.signedInAs?.id, parentMe.member!.id);
    assert.equal((await call<Me>("GET", "/api/me", { token: parentToken })).body.signedInAs, null);
    // Acting as yourself is the same as not switching.
    const asSelf = await call<Me>("GET", "/api/me", { token: parentToken, actAs: parentMe.member!.id });
    assert.equal(asSelf.body.signedInAs, null);

    // As the teenager, a Family Manager can't manage the family, but can edit the teenager.
    const opts = { token: parentToken, actAs: teenMemberId };
    assert.equal((await call("POST", "/api/family/members", { ...opts, body: { name: "X", lifeStage: "baby" } })).status, 403);
    assert.equal((await call("PATCH", `/api/family/members/${babyId}`, { ...opts, body: { name: "X" } })).status, 403);
    assert.equal((await call("PATCH", `/api/family/members/${teenMemberId}`, { ...opts, body: { diet: "none" } })).status, 200);
    // Members without a login can be switched to as well.
    assert.equal((await call<Me>("GET", "/api/me", { token: parentToken, actAs: babyId })).body.member?.id, babyId);

    // Only a Family Manager can switch, and only to their own family.
    assert.equal((await call("GET", "/api/me", { token: teenToken, actAs: babyId })).status, 403);
    assert.equal((await call("GET", "/api/family/weeks", { token: teenToken, actAs: babyId })).status, 403);
    assert.equal((await call("GET", "/api/me", { token: parentToken, actAs: "00000000-0000-4000-8000-000000000000" })).status, 404);
    assert.equal((await call("GET", "/api/me", { token: parentToken, actAs: "nope" })).status, 404);
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
      assert.equal(res.body.averageRating, null);
      assert.equal(res.body.myRating, null);
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

    test("each family member can rate one, and everyone sees the average", async () => {
      const path = `/api/family/recipes/${pancakesId}/rating`;
      let res = await call<FavouriteRecipe>("PUT", path, { token: teenToken, body: { stars: 5 } });
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [5, 5, 1]);
      res = await call<FavouriteRecipe>("PUT", path, { token: parentToken, body: { stars: 2 } });
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [2, 3.5, 2]);
      // Rating again replaces the member's own rating.
      res = await call<FavouriteRecipe>("PUT", path, { token: teenToken, body: { stars: 3 } });
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [3, 2.5, 2]);
      const list = await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: parentToken });
      const listed = list.body.find((r) => r.id === pancakesId)!;
      assert.deepEqual([listed.myRating, listed.averageRating], [2, 2.5]);
      // 0 stars clears it.
      res = await call<FavouriteRecipe>("PUT", path, { token: parentToken, body: { stars: 0 } });
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [null, 3, 1]);
      for (const stars of [6, -1, 2.5, "4", null]) {
        assert.equal((await call("PUT", path, { token: parentToken, body: { stars } })).status, 400, String(stars));
      }
    });

    test("a Family Manager can rate as another member, who then sees it as their own", async () => {
      const path = `/api/family/recipes/${pancakesId}/rating`;
      const res = await call<FavouriteRecipe>("PUT", path, { token: parentToken, actAs: babyId, body: { stars: 4 } });
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [4, 3.5, 2]);
      const asParent = (await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: parentToken })).body;
      assert.equal(asParent.find((r) => r.id === pancakesId)!.myRating, null);
      const asBaby = (await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: parentToken, actAs: babyId })).body;
      assert.equal(asBaby.find((r) => r.id === pancakesId)!.myRating, 4);
      await call("PUT", path, { token: parentToken, actAs: babyId, body: { stars: 0 } });
    });

    test("other families can't see or remove them", async () => {
      const other = await call<AuthResponse>("POST", "/api/auth/signup", {
        body: { email: "recipes-other@example.com", password: "password123", name: "Ola", lifeStage: "adult", familyName: "Others" },
      });
      assert.deepEqual((await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: other.body.token })).body, []);
      assert.equal((await call("DELETE", `/api/family/recipes/${pancakesId}`, { token: other.body.token })).status, 404);
      const patch = await call("PATCH", `/api/family/recipes/${pancakesId}`, { token: other.body.token, body: { prepared: true } });
      assert.equal(patch.status, 404);
      const rate = await call("PUT", `/api/family/recipes/${pancakesId}/rating`, { token: other.body.token, body: { stars: 1 } });
      assert.equal(rate.status, 404);
      assert.equal((await call("GET", "/api/family/recipes")).status, 401);
    });

    test("any family member can remove one", async () => {
      assert.equal((await call("DELETE", `/api/family/recipes/${pancakesId}`, { token: teenToken })).status, 204);
      assert.equal((await call("DELETE", `/api/family/recipes/${pancakesId}`, { token: teenToken })).status, 404);
      const list = await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: parentToken });
      assert.equal(list.body.length, 1);
    });
  });

  describe("restaurants", () => {
    let pizzaId: string;

    test("any family member can add one, with an optional link and notes", async () => {
      const res = await call<Restaurant>("POST", "/api/family/restaurants", {
        token: teenToken,
        body: { name: "  Luigi's Pizza ", url: "luigis.example.com/menu#mains", notes: "Kids eat free on Tuesdays." },
      });
      assert.equal(res.status, 201);
      pizzaId = res.body.id;
      assert.equal(res.body.name, "Luigi's Pizza");
      assert.equal(res.body.url, "https://luigis.example.com/menu");
      assert.equal(res.body.notes, "Kids eat free on Tuesdays.");
      assert.ok(res.body.addedBy);
      const plain = await call<Restaurant>("POST", "/api/family/restaurants", { token: parentToken, body: { name: "Anchor Fish Bar", url: "", notes: " " } });
      assert.equal(plain.status, 201);
      assert.deepEqual([plain.body.url, plain.body.notes], [null, null]);
      const list = await call<Restaurant[]>("GET", "/api/family/restaurants", { token: parentToken });
      assert.deepEqual(
        list.body.map((r) => r.name),
        ["Anchor Fish Bar", "Luigi's Pizza"],
      );
    });

    test("with a link, the cuisine, address and booking link are read from the restaurant's page", async () => {
      const res = await call<Restaurant>("POST", "/api/family/restaurants", {
        token: parentToken,
        body: { name: "Trattoria Roma", url: "https://trattoria.example.com/" },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(
        [res.body.cuisine, res.body.address, res.body.bookingUrl],
        ["Italian", "5 Market Street, Bath BA1 1AB", "https://www.opentable.co.uk/r/trattoria-roma"],
      );
      // What's typed in wins, and a booking link that isn't on the page is dropped.
      const typed = await call<Restaurant>("POST", "/api/family/restaurants", {
        token: parentToken,
        body: { name: "Trattoria Two", url: "https://trattoria.example.com/madeup", cuisine: "Roman", address: "1 Other Road" },
      });
      assert.deepEqual([typed.body.cuisine, typed.body.address, typed.body.bookingUrl], ["Roman", "1 Other Road", null]);
      // A page that isn't a restaurant's, or can't be read, leaves the details blank.
      for (const [name, url] of [["Shop", "https://shop.example.com/"], ["Offline", "https://unreachable.example.com/"]]) {
        const other = await call<Restaurant>("POST", "/api/family/restaurants", { token: parentToken, body: { name, url } });
        assert.equal(other.status, 201);
        assert.deepEqual([other.body.cuisine, other.body.address, other.body.bookingUrl], [null, null, null]);
        await call("DELETE", `/api/family/restaurants/${other.body.id}`, { token: parentToken });
      }
      // Editing reads the page again only when the link changes, filling in what's blank.
      const path = `/api/family/restaurants/${typed.body.id}`;
      const kept = await call<Restaurant>("PUT", path, { token: parentToken, body: { name: "Trattoria Two", url: "https://trattoria.example.com/madeup" } });
      assert.deepEqual([kept.body.cuisine, kept.body.bookingUrl], [null, null]);
      const relinked = await call<Restaurant>("PUT", path, { token: parentToken, body: { name: "Trattoria Two", url: "https://trattoria.example.com/two" } });
      assert.deepEqual([relinked.body.cuisine, relinked.body.bookingUrl], ["Italian", "https://www.opentable.co.uk/r/trattoria-roma"]);
      for (const id of [res.body.id, typed.body.id]) await call("DELETE", `/api/family/restaurants/${id}`, { token: parentToken });
      const bad = await call("POST", "/api/family/restaurants", { token: parentToken, body: { name: "X", bookingUrl: "javascript:alert(1)" } });
      assert.equal(bad.status, 400);
    });

    test("a link alone is enough: the name and details are previewed, then saved as corrected", async () => {
      const preview = await call<RestaurantPreview>("POST", "/api/family/restaurants/preview", {
        token: parentToken,
        body: { url: "https://trattoria.example.com/" },
      });
      assert.equal(preview.status, 200);
      assert.deepEqual(preview.body, {
        url: "https://trattoria.example.com/",
        found: true,
        name: "Trattoria Roma",
        cuisine: "Italian",
        address: "5 Market Street, Bath BA1 1AB",
        bookingUrl: "https://www.opentable.co.uk/r/trattoria-roma",
        alreadySaved: null,
      });
      // Pages that aren't a restaurant's, or can't be read, find nothing; the person types it in.
      for (const url of ["https://shop.example.com/", "https://unreachable.example.com/"]) {
        const other = await call<RestaurantPreview>("POST", "/api/family/restaurants/preview", { token: parentToken, body: { url } });
        assert.deepEqual([other.body.found, other.body.name, other.body.cuisine], [false, null, null]);
      }
      const noUrl = await call("POST", "/api/family/restaurants/preview", { token: parentToken, body: { url: "not a link" } });
      assert.equal(noUrl.status, 400);

      // Saving what was checked (with a corrected cuisine and a blank booking link) doesn't read the page again.
      const saved = await call<Restaurant>("POST", "/api/family/restaurants", {
        token: parentToken,
        body: { name: "Trattoria Roma", url: preview.body.url, cuisine: "Roman", address: preview.body.address, readLink: false },
      });
      assert.equal(saved.status, 201);
      assert.deepEqual([saved.body.cuisine, saved.body.bookingUrl], ["Roman", null]);
      const again = await call<RestaurantPreview>("POST", "/api/family/restaurants/preview", {
        token: parentToken,
        body: { url: "https://trattoria.example.com/" },
      });
      assert.equal(again.body.alreadySaved, "Trattoria Roma");
      await call("DELETE", `/api/family/restaurants/${saved.body.id}`, { token: parentToken });

      // Adding with only a link reads the name from it; with no name to be found, it asks for one.
      const linkOnly = await call<Restaurant>("POST", "/api/family/restaurants", { token: parentToken, body: { url: "https://trattoria.example.com/" } });
      assert.equal(linkOnly.status, 201);
      assert.deepEqual([linkOnly.body.name, linkOnly.body.cuisine], ["Trattoria Roma", "Italian"]);
      const duplicate = await call("POST", "/api/family/restaurants", { token: parentToken, body: { url: "https://trattoria.example.com/two" } });
      assert.equal(duplicate.status, 409);
      await call("DELETE", `/api/family/restaurants/${linkOnly.body.id}`, { token: parentToken });
      const nameless = await call("POST", "/api/family/restaurants", { token: parentToken, body: { url: "https://shop.example.com/" } });
      assert.equal(nameless.status, 400);
      const nothing = await call("POST", "/api/family/restaurants", { token: parentToken, body: {} });
      assert.equal(nothing.status, 400);
    });

    test("names are unique within the family, ignoring case", async () => {
      const res = await call("POST", "/api/family/restaurants", { token: parentToken, body: { name: "luigi's pizza" } });
      assert.equal(res.status, 409);
    });

    test("details are validated", async () => {
      for (const body of [{ name: "" }, { name: "X", url: "javascript:alert(1)" }, { name: "X", url: "not a link" }, { name: "X".repeat(121) }]) {
        assert.equal((await call("POST", "/api/family/restaurants", { token: parentToken, body })).status, 400, JSON.stringify(body));
      }
    });

    test("any family member can edit one", async () => {
      const path = `/api/family/restaurants/${pizzaId}`;
      const res = await call<Restaurant>("PUT", path, { token: parentToken, body: { name: "Luigi's", notes: "Book ahead at weekends." } });
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.name, res.body.url, res.body.notes], ["Luigi's", null, "Book ahead at weekends."]);
      const clash = await call("PUT", path, { token: parentToken, body: { name: "ANCHOR FISH BAR" } });
      assert.equal(clash.status, 409);
    });

    test("each family member can rate one, and everyone sees the average", async () => {
      const path = `/api/family/restaurants/${pizzaId}/rating`;
      let res = await call<Restaurant>("PUT", path, { token: teenToken, body: { stars: 5 } });
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [5, 5, 1]);
      res = await call<Restaurant>("PUT", path, { token: parentToken, body: { stars: 2 } });
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [2, 3.5, 2]);
      // Rating again replaces the member's own rating.
      res = await call<Restaurant>("PUT", path, { token: teenToken, body: { stars: 3 } });
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [3, 2.5, 2]);
      const list = await call<Restaurant[]>("GET", "/api/family/restaurants", { token: parentToken });
      const listed = list.body.find((r) => r.id === pizzaId)!;
      assert.deepEqual([listed.myRating, listed.averageRating], [2, 2.5]);
      // Editing keeps the ratings.
      const edited = await call<Restaurant>("PUT", `/api/family/restaurants/${pizzaId}`, { token: parentToken, body: { name: "Luigi's" } });
      assert.deepEqual([edited.body.myRating, edited.body.ratingCount], [2, 2]);
      // 0 stars clears it.
      res = await call<Restaurant>("PUT", path, { token: parentToken, body: { stars: 0 } });
      assert.deepEqual([res.body.myRating, res.body.averageRating, res.body.ratingCount], [null, 3, 1]);
      for (const stars of [6, -1, 2.5, "4", null]) {
        assert.equal((await call("PUT", path, { token: parentToken, body: { stars } })).status, 400, String(stars));
      }
    });

    test("other families can't see, edit or remove them", async () => {
      const other = await call<AuthResponse>("POST", "/api/auth/signup", {
        body: { email: "restaurants-other@example.com", password: "password123", name: "Ola", lifeStage: "adult", familyName: "Others" },
      });
      const token = other.body.token;
      assert.deepEqual((await call<Restaurant[]>("GET", "/api/family/restaurants", { token })).body, []);
      // Another family can use the same name.
      assert.equal((await call("POST", "/api/family/restaurants", { token, body: { name: "Luigi's" } })).status, 201);
      assert.equal((await call("PUT", `/api/family/restaurants/${pizzaId}`, { token, body: { name: "Mine" } })).status, 404);
      assert.equal((await call("DELETE", `/api/family/restaurants/${pizzaId}`, { token })).status, 404);
      assert.equal((await call("PUT", `/api/family/restaurants/${pizzaId}/rating`, { token, body: { stars: 1 } })).status, 404);
      assert.equal((await call("GET", "/api/family/restaurants")).status, 401);
    });

    test("any family member can remove one", async () => {
      assert.equal((await call("DELETE", `/api/family/restaurants/${pizzaId}`, { token: teenToken })).status, 204);
      assert.equal((await call("DELETE", `/api/family/restaurants/${pizzaId}`, { token: teenToken })).status, 404);
      const list = await call<Restaurant[]>("GET", "/api/family/restaurants", { token: parentToken });
      assert.deepEqual(
        list.body.map((r) => r.name),
        ["Anchor Fish Bar"],
      );
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

    test("days of this week that have already passed can't be planned", async () => {
      if (today === thisWeek) return; // Monday: nothing has passed yet.
      const res = await call("POST", "/api/family/weeks", {
        token: teenToken,
        body: { startsOn: thisWeek, today, days: [{ date: thisWeek, memberIds: [], guests: 0 }] },
      });
      assert.equal(res.status, 400);
    });

    test("adding this week plans from today, with who's joining and guests as given", async () => {
      const sunday = addDays(thisWeek, 6);
      const remaining = Array.from({ length: 7 }, (_, i) => addDays(thisWeek, i)).filter((d) => d >= today);
      const days = remaining.map((date) =>
        date === sunday ? { date, memberIds: [everyone[0]], guests: 3 } : { date, memberIds: everyone, guests: 0 },
      );
      const res = await call<ScheduleWeek>("POST", "/api/family/weeks", { token: teenToken, body: { startsOn: thisWeek, today, days } });
      assert.equal(res.status, 201);
      assert.equal(res.body.startsOn, thisWeek);
      assert.deepEqual(
        res.body.days.map((d) => d.date),
        Array.from({ length: 7 }, (_, i) => addDays(thisWeek, i)).filter((d) => d >= today),
      );
      // Two days back, so the one-day time zone allowance doesn't apply.
      if (addDays(thisWeek, 1) < today) {
        const past = await call("PATCH", `/api/family/weeks/${thisWeek}/days/${thisWeek}`, { token: teenToken, body: { memberIds: [], guests: 0 } });
        assert.equal(past.status, 404);
      }
      for (const d of res.body.days) {
        if (d.date === sunday) assert.deepEqual(d, { date: sunday, eatOut: false, memberIds: [everyone[0]], guests: 3, meal: null });
        else assert.deepEqual(d, { date: d.date, eatOut: false, memberIds: everyone, guests: 0, meal: null });
      }
    });

    test("then only the week after the last one, once", async () => {
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: thisWeek, today } })).status, 409);
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: addDays(thisWeek, 14), today } })).status, 409);
      const next = await call<ScheduleWeek>("POST", "/api/family/weeks", { token: parentToken, body: { startsOn: addDays(thisWeek, 7), today } });
      assert.equal(next.status, 201);
      assert.equal(next.body.days.length, 7);
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
      assert.deepEqual(res.body, { date: monday, eatOut: false, memberIds: [], guests: 2, meal: null });
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

    test("a day can be removed from a week, and added back", async () => {
      const startsOn = addDays(thisWeek, 7);
      const wednesday = addDays(startsOn, 2);
      assert.equal((await call("DELETE", `/api/family/weeks/${startsOn}/days/${wednesday}`, { token: teenToken })).status, 204);
      assert.equal((await call("DELETE", `/api/family/weeks/${startsOn}/days/${wednesday}`, { token: teenToken })).status, 404);
      const week = (await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: parentToken })).body.find((w) => w.startsOn === startsOn)!;
      assert.equal(week.days.length, 6);
      assert.ok(!week.days.some((d) => d.date === wednesday));
      const back = await call<ScheduleDay>("PATCH", `/api/family/weeks/${startsOn}/days/${wednesday}`, {
        token: parentToken,
        body: { memberIds: [], guests: 1 },
      });
      assert.deepEqual(back.body, { date: wednesday, eatOut: false, memberIds: [], guests: 1, meal: null });
    });

    test("eating out clears who's joining and guests, and can be undone", async () => {
      const startsOn = addDays(thisWeek, 7);
      const friday = addDays(startsOn, 4);
      const out = await call<ScheduleDay>("PATCH", `/api/family/weeks/${startsOn}/days/${friday}`, {
        token: teenToken,
        body: { eatOut: true, memberIds: everyone, guests: 4 },
      });
      assert.equal(out.status, 200);
      assert.deepEqual(out.body, { date: friday, eatOut: true, memberIds: [], guests: 0, meal: null });
      const week = (await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: parentToken })).body.find((w) => w.startsOn === startsOn)!;
      assert.deepEqual(week.days.find((d) => d.date === friday), out.body);
      const back = await call<ScheduleDay>("PATCH", `/api/family/weeks/${startsOn}/days/${friday}`, {
        token: teenToken,
        body: { eatOut: false, memberIds: everyone, guests: 0 },
      });
      assert.deepEqual(back.body, { date: friday, eatOut: false, memberIds: everyone, guests: 0, meal: null });
      const bad = await call("PATCH", `/api/family/weeks/${startsOn}/days/${friday}`, { token: teenToken, body: { eatOut: "yes" } });
      assert.equal(bad.status, 400);
    });

    test("a week can be added with days out", async () => {
      const startsOn = addDays(thisWeek, 14);
      const res = await call<ScheduleWeek>("POST", "/api/family/weeks", {
        token: parentToken,
        body: { startsOn, today, days: [{ date: startsOn, eatOut: true }] },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.days, [{ date: startsOn, eatOut: true, memberIds: [], guests: 0, meal: null }]);
      assert.equal((await call("DELETE", `/api/family/weeks/${startsOn}`, { token: parentToken })).status, 204);
    });

    test("a week keeps at least one day, and can be added with only some days", async () => {
      const startsOn = addDays(thisWeek, 14);
      assert.equal((await call("POST", "/api/family/weeks", { token: parentToken, body: { startsOn, today, days: [] } })).status, 400);
      const res = await call<ScheduleWeek>("POST", "/api/family/weeks", {
        token: parentToken,
        body: { startsOn, today, days: [{ date: startsOn, memberIds: everyone, guests: 0 }] },
      });
      assert.deepEqual(res.body.days.map((d) => d.date), [startsOn]);
      assert.equal((await call("DELETE", `/api/family/weeks/${startsOn}/days/${startsOn}`, { token: parentToken })).status, 400);
      assert.equal((await call("DELETE", `/api/family/weeks/${startsOn}`, { token: parentToken })).status, 204);
    });

    test("a Family Manager chooses meals: a recipe eating in, a restaurant eating out, or typed in", async () => {
      const startsOn = addDays(thisWeek, 7);
      const [monday, tuesday] = [startsOn, addDays(startsOn, 1)];
      const recipe = (
        await call<FavouriteRecipe>("POST", "/api/family/recipes", {
          token: parentToken,
          body: { url: "https://www.example.com/recipes/lasagne", name: "Lasagne" },
        })
      ).body;
      const restaurant = (await call<Restaurant>("POST", "/api/family/restaurants", { token: parentToken, body: { name: "Pizza Place" } })).body;
      const patch = (date: string, body: unknown, token = parentToken) =>
        call<ScheduleDay>("PATCH", `/api/family/weeks/${startsOn}/days/${date}`, { token, body });

      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: { name: "Soup" } }, teenToken)).status, 403);
      const lasagne = await patch(monday, { memberIds: everyone, guests: 0, meal: { recipeId: recipe.id } });
      assert.equal(lasagne.status, 200);
      assert.deepEqual(lasagne.body.meal, { name: "Lasagne", mealKit: false, recipeId: recipe.id, restaurantId: null, url: recipe.url });
      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: { restaurantId: restaurant.id } })).status, 400);
      assert.equal((await patch(tuesday, { eatOut: true, meal: { recipeId: recipe.id } })).status, 400);
      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: { recipeId: "00000000-0000-0000-0000-000000000000" } })).status, 400);
      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: { name: " " } })).status, 400);

      // Each day a recipe or restaurant is picked for shows on it.
      const chosen = async () => ({
        recipe: (await call<FavouriteRecipe[]>("GET", "/api/family/recipes", { token: teenToken })).body.find((r) => r.id === recipe.id)!.chosenOn,
        restaurant: (await call<Restaurant[]>("GET", "/api/family/restaurants", { token: teenToken })).body.find((r) => r.id === restaurant.id)!.chosenOn,
      });
      assert.deepEqual(await chosen(), { recipe: [monday], restaurant: [] });
      const out = await patch(tuesday, { eatOut: true, meal: { restaurantId: restaurant.id } });
      assert.deepEqual(await chosen(), { recipe: [monday], restaurant: [tuesday] });
      assert.deepEqual(out.body.meal, { name: "Pizza Place", mealKit: false, recipeId: null, restaurantId: restaurant.id, url: null });

      // Anyone can still change who's joining; the meal stays.
      const kept = await patch(monday, { memberIds: [everyone[0]], guests: 2 }, teenToken);
      assert.equal(kept.body.meal?.recipeId, recipe.id);
      // Eating in again drops the restaurant.
      const backIn = await patch(tuesday, { memberIds: everyone, guests: 0 }, teenToken);
      assert.equal(backIn.body.meal, null);
      assert.deepEqual((await chosen()).restaurant, []);
      const typed = await patch(tuesday, { memberIds: everyone, guests: 0, meal: { name: " Takeaway curry " } });
      assert.deepEqual(typed.body.meal, { name: "Takeaway curry", mealKit: false, recipeId: null, restaurantId: null, url: null });

      // Removing the recipe keeps its name on the schedule.
      assert.equal((await call("DELETE", `/api/family/recipes/${recipe.id}`, { token: parentToken })).status, 204);
      const week = (await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: teenToken })).body.find((w) => w.startsOn === startsOn)!;
      assert.deepEqual(week.days.find((d) => d.date === monday)!.meal, { name: "Lasagne", mealKit: false, recipeId: null, restaurantId: null, url: null });
      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: null })).body.meal, null);
      assert.equal((await call("DELETE", `/api/family/restaurants/${restaurant.id}`, { token: parentToken })).status, 204);
    });

    test("a Family Manager can choose a meal kit for eating in, saying which one or not", async () => {
      const startsOn = addDays(thisWeek, 7);
      const [monday, tuesday] = [startsOn, addDays(startsOn, 1)];
      const patch = (date: string, body: unknown, token = parentToken) =>
        call<ScheduleDay>("PATCH", `/api/family/weeks/${startsOn}/days/${date}`, { token, body });

      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: { mealKit: true } }, teenToken)).status, 403);
      const kit = await patch(monday, { memberIds: everyone, guests: 0, meal: { mealKit: true } });
      assert.equal(kit.status, 200);
      assert.deepEqual(kit.body.meal, { name: "", mealKit: true, recipeId: null, restaurantId: null, url: null });
      const named = await patch(monday, { memberIds: everyone, guests: 0, meal: { mealKit: true, name: " Chicken katsu " } });
      assert.deepEqual(named.body.meal, { name: "Chicken katsu", mealKit: true, recipeId: null, restaurantId: null, url: null });
      assert.equal((await patch(tuesday, { eatOut: true, meal: { mealKit: true } })).status, 400);
      assert.equal((await patch(monday, { memberIds: everyone, guests: 0, meal: { mealKit: "yes" } })).status, 400);

      // It stays when who's joining changes, and goes when the day becomes eating out.
      assert.equal((await patch(monday, { memberIds: [everyone[0]], guests: 1 }, teenToken)).body.meal?.mealKit, true);
      assert.equal((await patch(monday, { eatOut: true }, teenToken)).body.meal, null);
    });

    test("meals can be chosen when a week is added, by a Family Manager only", async () => {
      const startsOn = addDays(thisWeek, 14);
      const days = [{ date: startsOn, memberIds: everyone, guests: 0, meal: { name: "Roast chicken" } }];
      assert.equal((await call("POST", "/api/family/weeks", { token: teenToken, body: { startsOn, today, days } })).status, 403);
      const res = await call<ScheduleWeek>("POST", "/api/family/weeks", { token: parentToken, body: { startsOn, today, days } });
      assert.equal(res.status, 201);
      assert.equal(res.body.days[0].meal?.name, "Roast chicken");
      assert.equal((await call("DELETE", `/api/family/weeks/${startsOn}`, { token: parentToken })).status, 204);
    });

    test("anyone in the family adds events, one-off or weekly, with who's going and when", async () => {
      const date = addDays(thisWeek, 9); // Wednesday next week
      const body = { title: "Football", date, startTime: "17:00", endTime: "18:30", memberIds: [everyone[0]], weekly: true };
      const added = await call<ScheduleEvent>("POST", "/api/family/events", { token: teenToken, body: { ...body, title: " Football " } });
      assert.equal(added.status, 201);
      assert.deepEqual({ ...added.body, id: undefined }, { ...body, id: undefined, until: null });

      for (const bad of [
        { ...body, title: " " },
        { ...body, startTime: "5pm" },
        { ...body, endTime: "17:00" },
        { ...body, endTime: "16:00" },
        { ...body, memberIds: [] },
        { ...body, memberIds: ["00000000-0000-0000-0000-000000000000"] },
        { ...body, date: "2026-02-30" },
        { ...body, weekly: "yes" },
      ]) {
        assert.equal((await call("POST", "/api/family/events", { token: teenToken, body: bad })).status, 400, JSON.stringify(bad));
      }

      const oneOff = await call<ScheduleEvent>("POST", "/api/family/events", {
        token: parentToken,
        body: { title: "Work dinner", date, startTime: "19:00", endTime: "22:00", memberIds: everyone, weekly: false, until: addDays(date, 7) },
      });
      assert.equal(oneOff.body.until, null);

      // Other families don't see or change them.
      const other = await call<AuthResponse>("POST", "/api/auth/login", { body: { email: "jones@example.com", password: "password123" } });
      assert.deepEqual((await call<ScheduleEvent[]>("GET", "/api/family/events", { token: other.body.token })).body, []);
      assert.equal((await call("PATCH", `/api/family/events/${added.body.id}`, { token: other.body.token, body: { title: "X" } })).status, 404);
      assert.equal((await call("DELETE", `/api/family/events/${added.body.id}`, { token: other.body.token })).status, 404);

      const list = (await call<ScheduleEvent[]>("GET", "/api/family/events", { token: parentToken })).body;
      assert.deepEqual(list.map((e) => e.title), ["Football", "Work dinner"]);

      // Changing only some fields keeps the rest; stopping a weekly event sets its last day.
      const changed = await call<ScheduleEvent>("PATCH", `/api/family/events/${added.body.id}`, {
        token: parentToken,
        body: { endTime: "19:00", memberIds: everyone, until: addDays(date, 13) },
      });
      assert.equal(changed.status, 200);
      assert.deepEqual(changed.body, { ...added.body, endTime: "19:00", memberIds: [...everyone].sort(), until: addDays(date, 13) });
      assert.ok(eventOn(changed.body, addDays(date, 7)));
      assert.ok(!eventOn(changed.body, addDays(date, 14)));
      assert.ok(!eventOn(changed.body, addDays(date, 1)));
      assert.equal(
        (await call("PATCH", `/api/family/events/${added.body.id}`, { token: parentToken, body: { until: addDays(date, -1) } })).status,
        400,
      );

      assert.equal((await call("DELETE", `/api/family/events/${added.body.id}`, { token: teenToken })).status, 204);
      assert.equal((await call("DELETE", `/api/family/events/${oneOff.body.id}`, { token: teenToken })).status, 204);
      assert.deepEqual((await call<ScheduleEvent[]>("GET", "/api/family/events", { token: parentToken })).body, []);
    });

    test("a week can be removed", async () => {
      assert.equal((await call("DELETE", `/api/family/weeks/${addDays(thisWeek, 7)}`, { token: parentToken })).status, 204);
      const weeks = await call<ScheduleWeek[]>("GET", "/api/family/weeks", { token: parentToken });
      assert.deepEqual(weeks.body.map((w) => w.startsOn), [thisWeek]);
    });
  });

  describe("home address", () => {
    const session = "session-token-1";

    test("a family starts with no address, and the app says address search is available", async () => {
      const me = (await call<Me>("GET", "/api/me", { token: parentToken })).body;
      assert.equal(me.family?.address, null);
      assert.equal(me.addressSearch, true);
    });

    test("a Family Manager can search for addresses as they type", async () => {
      const search = (input: string, sessionToken = session) =>
        call<AddressSearchResponse>("POST", "/api/family/address/search", { token: parentToken, body: { input, sessionToken } });
      const res = await search("1600 Pennsylvania");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.suggestions.map((s) => s.text), ["1600 Pennsylvania Avenue NW", "Pennsylvania Avenue NW"]);
      assert.deepEqual((await search("nowhere")).body.suggestions, []);
      assert.equal((await search(" ")).status, 400);
      assert.equal((await search("1600 Pennsylvania", "")).status, 400);
      assert.equal((await search("broken")).status, 502);
    });

    test("picking a suggestion saves its full address and coordinates", async () => {
      const res = await call("PUT", "/api/family/address", { token: parentToken, body: { placeId: "place-10", sessionToken: session } });
      assert.equal(res.status, 200);
      const saved = { line1: "1600 Pennsylvania Avenue NW", line2: null, city: "Washington", state: "DC", zip: "20500", latitude: 51.5034, longitude: -0.1276 };
      assert.deepEqual((await call<Me>("GET", "/api/me", { token: parentToken })).body.family?.address, saved);
    });

    test("a pick that isn't a full US street address is refused", async () => {
      const street = await call("PUT", "/api/family/address", { token: parentToken, body: { placeId: "place-downing", sessionToken: session } });
      assert.equal(street.status, 400);
      assert.equal((await call("PUT", "/api/family/address", { token: parentToken, body: { sessionToken: session } })).status, 400);
      assert.equal((await call("PUT", "/api/family/address", { token: parentToken, body: { placeId: "gone", sessionToken: session } })).status, 502);
      assert.equal((await call<Me>("GET", "/api/me", { token: parentToken })).body.family?.address?.city, "Washington");
    });

    test("everyone in the family sees the address, but only a Family Manager can change or search", async () => {
      const token = teenToken;
      assert.equal((await call<Me>("GET", "/api/me", { token })).body.family?.address?.city, "Washington");
      assert.equal((await call("PUT", "/api/family/address", { token, body: { placeId: "place-bath", sessionToken: session } })).status, 403);
      assert.equal((await call("DELETE", "/api/family/address", { token })).status, 403);
      assert.equal((await call("POST", "/api/family/address/search", { token, body: { input: "Pennsylvania", sessionToken: session } })).status, 403);
    });

    test("the address can be removed", async () => {
      assert.equal((await call("DELETE", "/api/family/address", { token: parentToken })).status, 204);
      assert.equal((await call<Me>("GET", "/api/me", { token: parentToken })).body.family?.address, null);
    });
  });

  describe("dinner times", () => {
    const put = (body: unknown, token = parentToken) => call<DinnerTimes>("PUT", "/api/family/dinner-times", { token, body });
    const times = async () => (await call<Me>("GET", "/api/me", { token: teenToken })).body.family?.dinnerTimes;

    test("a family starts with no usual dinner times", async () => {
      assert.deepEqual(await times(), { weekday: null, weekend: null });
    });

    test("a Family Manager can set either or both, and everyone sees them", async () => {
      const res = await put({ weekday: "18:30", weekend: null });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { weekday: "18:30", weekend: null });
      assert.deepEqual((await put({ weekday: "18:30", weekend: "19:15" })).body, { weekday: "18:30", weekend: "19:15" });
      assert.deepEqual(await times(), { weekday: "18:30", weekend: "19:15" });
    });

    test("times must be HH:MM, and blank clears them", async () => {
      for (const weekday of ["6pm", "24:00", "18:3", 1830]) assert.equal((await put({ weekday, weekend: null })).status, 400);
      assert.deepEqual((await put({ weekday: "", weekend: null })).body, { weekday: null, weekend: null });
      assert.deepEqual(await times(), { weekday: null, weekend: null });
    });

    test("only a Family Manager can change them", async () => {
      assert.equal((await put({ weekday: "17:00", weekend: null }, teenToken)).status, 403);
    });
  });

  describe("restaurant driving times", () => {
    let token: string;

    before(async () => {
      const res = await call<AuthResponse>("POST", "/api/auth/signup", {
        body: { email: "drives@example.com", password: "password123", name: "Dee", lifeStage: "adult", familyName: "Drivers" },
      });
      token = res.body.token;
    });

    async function add(body: Record<string, unknown>) {
      const res = await call<Restaurant>("POST", "/api/family/restaurants", { token, body });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body;
    }

    test("without a home address there's no driving time, but a typed address is kept", async () => {
      const r = await add({ name: "Mill", address: "3 Mill Lane, Bristol" });
      assert.deepEqual([r.address, r.driveMinutes], ["3 Mill Lane, Bristol", null]);
      const byName = await add({ name: "Pizza Place" });
      assert.deepEqual([byName.address, byName.driveMinutes], [null, null]);
    });

    test("with a home address, adding one works out the drive from home", async () => {
      const home = { placeId: "place-bath", sessionToken: "session-token-2" };
      assert.equal((await call("PUT", "/api/family/address", { token, body: home })).status, 200);
      // Found by name near home.
      const found = await add({ name: "Pizza Place Two" });
      assert.deepEqual([found.address, found.driveMinutes], [null, null]); // Not on the map.
      // One added before there was a home is looked up again when it's next saved.
      const list = await call<Restaurant[]>("GET", "/api/family/restaurants", { token });
      const pizza = list.body.find((r) => r.name === "Pizza Place")!;
      const res = await call<Restaurant>("PUT", `/api/family/restaurants/${pizza.id}`, { token, body: { name: "Pizza Place" } });
      assert.deepEqual([res.body.address, res.body.driveMinutes], ["Pizza Place, 5 Market Street, Bath BA1 1AB", 2]);
      // By a typed address, which is kept as typed.
      const bristol = await add({ name: "Bristol Mill", address: "3 Mill Lane, Bristol" });
      assert.deepEqual([bristol.address, bristol.driveMinutes], ["3 Mill Lane, Bristol", 30]);
    });

    test("a home address typed in before address search (no coordinates) is found on the map", async () => {
      const me = (await call<Me>("GET", "/api/me", { token })).body;
      await db.query("UPDATE family SET address_latitude = NULL, address_longitude = NULL WHERE id = $1", [me.family!.id]);
      const r = await add({ name: "Another Mill", address: "3 Mill Lane, Bristol" });
      assert.equal(r.driveMinutes, 30);
    });

    test("changing the address works the drive out again; other edits keep it", async () => {
      const r = await add({ name: "Moving Mill", address: "3 Mill Lane, Bristol" });
      const path = `/api/family/restaurants/${r.id}`;
      let res = await call<Restaurant>("PUT", path, { token, body: { name: "Moving Mill", address: r.address, notes: "Nice" } });
      assert.deepEqual([res.body.notes, res.body.driveMinutes], ["Nice", 30]);
      res = await call<Restaurant>("PUT", path, { token, body: { name: "Moving Mill", address: "somewhere unknown" } });
      assert.deepEqual([res.body.address, res.body.driveMinutes], ["somewhere unknown", null]);
    });

    test("the address can be picked from suggestions, nearest home first", async () => {
      const session = "restaurant-session-1";
      // The home, with its coordinates, is where suggestions are centred.
      assert.equal((await call("PUT", "/api/family/address", { token, body: { placeId: "place-bath", sessionToken: session } })).status, 200);
      const res = await call<AddressSearchResponse>("POST", "/api/family/restaurants/address/search", {
        token,
        body: { input: "Mill", sessionToken: session },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.suggestions.map((s) => s.placeId), ["place-mill", "place-mill-london"]);
      const picked = await add({ name: "Picked Mill", address: "The Mill", placeId: "place-mill", sessionToken: session });
      assert.deepEqual([picked.address, picked.driveMinutes], ["3 Mill Lane, Bristol BS1 1AA", 30]);
      // Picking again when editing replaces the address.
      const edited = await call<Restaurant>("PUT", `/api/family/restaurants/${picked.id}`, {
        token,
        body: { name: "Picked Mill", address: "The Mill", placeId: "place-nowhere", sessionToken: session },
      });
      assert.equal(edited.status, 400);
      const missing = await call("POST", "/api/family/restaurants", { token, body: { name: "No Session", placeId: "place-mill" } });
      assert.equal(missing.status, 400);
    });

    test("if the map service is down the restaurant is still saved", async () => {
      const r = await add({ name: "Broken", address: "broken street" });
      assert.deepEqual([r.address, r.driveMinutes], ["broken street", null]);
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

    test("Google's redirect-mode form post is handed to the web app in the URL fragment", async () => {
      const post = (form: Record<string, string>) =>
        fetch(`${base}/api/auth/google/redirect`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form),
          redirect: "manual",
        });
      const res = await post({ credential: "a.b.c", g_csrf_token: "x" });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "http://web.test/auth/google#credential=a.b.c");
      const missing = await post({ g_csrf_token: "x" });
      assert.equal(missing.status, 303);
      assert.match(missing.headers.get("location") ?? "", /^http:\/\/web\.test\/auth\/google#error=/);
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
