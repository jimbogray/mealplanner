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
const whiteHouse = [
  c("1600", ["street_number"]),
  c("Pennsylvania Avenue Northwest", ["route"], "Pennsylvania Avenue NW"),
  c("Washington", ["locality", "political"]),
  c("District of Columbia", ["administrative_area_level_1", "political"], "DC"),
  c("United States", ["country", "political"], "US"),
  c("20500", ["postal_code"]),
];
const without = (type: string) => whiteHouse.filter((x) => !x.types.includes(type));

test("suggests US addresses for what's been typed, with the key and session token", async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      suggestions: [
        {
          placePrediction: {
            placeId: "abc",
            text: { text: "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA" },
            structuredFormat: { mainText: { text: "1600 Pennsylvania Avenue NW" }, secondaryText: { text: "Washington, DC 20500, USA" } },
          },
        },
      ],
    },
  }));
  const suggestions = await googlePlacesSearch("gkey", impl).suggest("1600 Penn", "tok12345");
  assert.deepEqual(suggestions, [{ placeId: "abc", text: "1600 Pennsylvania Avenue NW", secondaryText: "Washington, DC 20500, USA" }]);
  const { url, init } = calls[0];
  assert.equal(url.href, "https://places.googleapis.com/v1/places:autocomplete");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "gkey");
  const body = JSON.parse(String(init.body));
  assert.equal(body.input, "1600 Penn");
  assert.equal(body.sessionToken, "tok12345");
  assert.deepEqual(body.includedRegionCodes, ["us"]);
  assert.equal(body.languageCode, "en-US");
});

test("gets a picked place's address and coordinates in the same session", async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    body: { addressComponents: whiteHouse, location: { latitude: 38.8977, longitude: -77.0365 } },
  }));
  const address = await googlePlacesSearch("gkey", impl).details("abc", "tok12345");
  assert.deepEqual(address, {
    line1: "1600 Pennsylvania Avenue Northwest",
    line2: null,
    city: "Washington",
    state: "DC",
    zip: "20500",
    latitude: 38.8977,
    longitude: -77.0365,
  });
  assert.equal(calls[0].url.pathname, "/v1/places/abc");
  assert.equal(calls[0].url.searchParams.get("sessionToken"), "tok12345");
  assert.equal(calls[0].url.searchParams.get("regionCode"), "us");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-fieldmask"], "addressComponents,location");
});

test("an apartment goes on the second line", () => {
  assert.equal(toAddress({ addressComponents: [c("4B", ["subpremise"]), ...whiteHouse] })?.line2, "Apt 4B");
  assert.equal(toAddress({ addressComponents: [c("Suite 200", ["subpremise"]), ...whiteHouse] })?.line2, "Suite 200");
});

test("a New York borough is the city", () => {
  const brooklyn = [...without("locality"), c("Brooklyn", ["sublocality_level_1", "sublocality", "political"])];
  assert.equal(toAddress({ addressComponents: brooklyn })?.city, "Brooklyn");
});

test("a ZIP+4 is kept to its five digits", () => {
  const zip4 = [...without("postal_code"), c("20500-0003", ["postal_code"])];
  assert.equal(toAddress({ addressComponents: zip4 })?.zip, "20500");
});

test("a place without a street, state or ZIP code, or outside the US, isn't a home address", () => {
  assert.equal(toAddress({ addressComponents: without("postal_code") }), null);
  assert.equal(toAddress({ addressComponents: without("administrative_area_level_1") }), null);
  assert.equal(toAddress({ addressComponents: without("street_number").filter((x) => !x.types.includes("route")) }), null);
  assert.equal(toAddress({ addressComponents: [...without("country"), c("Canada", ["country"], "CA")] }), null);
});

test("a restaurant's address drops the country", async () => {
  const { impl } = fakeFetch(() => ({
    status: 200,
    body: { formattedAddress: "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA", location: { latitude: 38.9, longitude: -77 } },
  }));
  const found = await googlePlacesSearch("gkey", impl).place("abc", "tok12345");
  assert.deepEqual(found, { address: "1600 Pennsylvania Avenue NW, Washington, DC 20500", lat: 38.9, lng: -77 });
});

test("Google errors (bad key, API not enabled) are errors", async () => {
  const { impl } = fakeFetch(() => ({ status: 403, body: { error: { status: "PERMISSION_DENIED", message: "API not enabled" } } }));
  await assert.rejects(googlePlacesSearch("k", impl).suggest("x", "tok12345"), AddressSearchError);
});
