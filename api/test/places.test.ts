import assert from "node:assert/strict";
import { test } from "node:test";
import { AddressSearchError, googlePlacesSearch, toAddress } from "../src/places.js";

// Stands in for the Google Places API, so the request and response handling are checked offline.
function fakeFetch(respond: (url: URL) => { status: number; body: unknown }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const { status, body } = respond(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const c = (longText: string, types: string[], shortText = longText) => ({ longText, shortText, types });
const downingStreet = [
  c("10", ["street_number"]),
  c("Downing Street", ["route"], "Downing St"),
  c("London", ["postal_town"]),
  c("Greater London", ["administrative_area_level_2", "political"]),
  c("United Kingdom", ["country", "political"], "GB"),
  c("SW1A 2AA", ["postal_code"]),
];

test("suggests UK addresses for what's been typed, with the key and session token", async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      suggestions: [
        {
          placePrediction: {
            placeId: "abc",
            text: { text: "10 Downing Street, London SW1A 2AA, UK" },
            structuredFormat: { mainText: { text: "10 Downing Street" }, secondaryText: { text: "London SW1A 2AA, UK" } },
          },
        },
      ],
    },
  }));
  const suggestions = await googlePlacesSearch("gkey", impl).suggest("10 Downing", "tok12345");
  assert.deepEqual(suggestions, [{ placeId: "abc", text: "10 Downing Street", secondaryText: "London SW1A 2AA, UK" }]);
  const { url, init } = calls[0];
  assert.equal(url.href, "https://places.googleapis.com/v1/places:autocomplete");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "gkey");
  const body = JSON.parse(String(init.body));
  assert.equal(body.input, "10 Downing");
  assert.equal(body.sessionToken, "tok12345");
  assert.deepEqual(body.includedRegionCodes, ["gb"]);
});

test("gets a picked place's address and coordinates in the same session", async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    body: { addressComponents: downingStreet, location: { latitude: 51.5034, longitude: -0.1276 } },
  }));
  const address = await googlePlacesSearch("gkey", impl).details("abc", "tok12345");
  assert.deepEqual(address, {
    line1: "10 Downing Street",
    line2: null,
    town: "London",
    county: "Greater London",
    postcode: "SW1A 2AA",
    latitude: 51.5034,
    longitude: -0.1276,
  });
  assert.equal(calls[0].url.pathname, "/v1/places/abc");
  assert.equal(calls[0].url.searchParams.get("sessionToken"), "tok12345");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-fieldmask"], "addressComponents,location");
});

test("flats and named houses keep their extra lines", () => {
  const a = toAddress({ addressComponents: [c("Flat 2", ["subpremise"]), c("Rose Court", ["premise"]), ...downingStreet] });
  assert.equal(a?.line1, "Flat 2");
  assert.equal(a?.line2, "Rose Court, 10 Downing Street");
});

test("a place with no postcode, or outside the UK, isn't a home address", () => {
  assert.equal(toAddress({ addressComponents: downingStreet.filter((x) => !x.types.includes("postal_code")) }), null);
  assert.equal(toAddress({ addressComponents: [...downingStreet.filter((x) => !x.types.includes("country")), c("France", ["country"], "FR")] }), null);
});

test("Google errors (bad key, API not enabled) are errors", async () => {
  const { impl } = fakeFetch(() => ({ status: 403, body: { error: { status: "PERMISSION_DENIED", message: "API not enabled" } } }));
  await assert.rejects(googlePlacesSearch("k", impl).suggest("x", "tok12345"), AddressSearchError);
});
