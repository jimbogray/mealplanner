import assert from "node:assert/strict";
import { test } from "node:test";
import { AddressLookupError, idealPostcodesLookup } from "../src/address-lookup.js";

// Stands in for the Ideal Postcodes API, so the request and response handling are checked offline.
function fakeFetch(respond: (url: URL) => { status: number; body: unknown }) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status, body } = respond(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, urls };
}

const premise = {
  line_1: "Flat 2",
  line_2: "10 Downing Street",
  line_3: "",
  post_town: "LONDON",
  county: "London",
  postcode: "SW1A 2AA",
  latitude: 51.5034,
  longitude: -0.1276,
};

test("looks up every address at a postcode with the API key", async () => {
  const { impl, urls } = fakeFetch(() => ({ status: 200, body: { code: 2000, message: "Success", result: [premise] } }));
  const addresses = await idealPostcodesLookup("ak_test", impl)("SW1A 2AA");
  assert.equal(urls[0].origin + urls[0].pathname, "https://api.ideal-postcodes.co.uk/v1/postcodes/SW1A2AA");
  assert.equal(urls[0].searchParams.get("api_key"), "ak_test");
  assert.deepEqual(addresses, [
    { line1: "Flat 2", line2: "10 Downing Street", town: "London", county: "London", postcode: "SW1A 2AA", latitude: 51.5034, longitude: -0.1276 },
  ]);
});

test("pages through postcodes with more than 100 addresses", async () => {
  const { impl, urls } = fakeFetch((url) => ({
    status: 200,
    body: { code: 2000, result: Array(url.searchParams.get("page") === "0" ? 100 : 3).fill(premise) },
  }));
  assert.equal((await idealPostcodesLookup("k", impl)("SW1A 2AA")).length, 103);
  assert.equal(urls.length, 2);
});

test("an unknown postcode has no addresses", async () => {
  const { impl } = fakeFetch(() => ({ status: 404, body: { code: 4040, message: "Postcode not found", suggestions: [] } }));
  assert.deepEqual(await idealPostcodesLookup("k", impl)("ZZ9 9ZZ"), []);
});

test("a bad key or empty balance is an error", async () => {
  for (const [status, code] of [[401, 4010], [402, 4020]]) {
    const { impl } = fakeFetch(() => ({ status, body: { code, message: "No" } }));
    await assert.rejects(idealPostcodesLookup("k", impl)("SW1A 2AA"), AddressLookupError);
  }
});
