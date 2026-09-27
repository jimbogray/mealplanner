// Finds US addresses as people type, with Google Places (New): Autocomplete for the suggestions,
// then Place Details for the one they pick. Both calls share a session token, which Google bills
// as one session rather than per keystroke.
import { normaliseZip, type Address, type AddressSuggestion } from "@mealplanner/shared";

export interface AddressSearch {
  /** Addresses matching what's been typed so far. */
  suggest(input: string, sessionToken: string): Promise<AddressSuggestion[]>;
  /** The full address of a suggestion, or null if it isn't a complete US address (no ZIP code, say). */
  details(placeId: string, sessionToken: string): Promise<Address | null>;
  /** Places (restaurants, cafés, pubs) and addresses matching what's been typed, nearest `near` first. */
  suggestPlaces(input: string, sessionToken: string, near: { lat: number; lng: number } | null): Promise<AddressSuggestion[]>;
  /** Where a suggested place is: its one-line address and coordinates. Null if Google has no location for it. */
  place(placeId: string, sessionToken: string): Promise<FoundPlace | null>;
}

export interface FoundPlace {
  /** e.g. "1600 Pennsylvania Avenue NW, Washington, DC 20500" */
  address: string;
  lat: number;
  lng: number;
}

/** How far around home to prefer places, in metres (Google's maximum). */
const NEARBY_METRES = 50_000;

/** Google couldn't be used (bad key, API not enabled, quota, down). */
export class AddressSearchError extends Error {}

const BASE_URL = "https://places.googleapis.com/v1/";

/** Only US addresses and places are suggested. */
const REGION = { regionCode: "us", languageCode: "en-US" };

interface Prediction {
  placeId: string;
  text?: { text: string };
  structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
}

interface Component {
  longText: string;
  shortText?: string;
  types: string[];
}

interface Place {
  addressComponents?: Component[];
  location?: { latitude: number; longitude: number };
}

/** Turns a place's address components into the family's address, or null if it's not a full US address. */
export function toAddress(place: Place): Address | null {
  const parts = place.addressComponents ?? [];
  const component = (type: string) => parts.find((c) => c.types.includes(type));
  const get = (type: string) => component(type)?.longText?.trim() || null;
  if (get("country") && component("country")?.shortText !== "US") return null;
  const street = [get("street_number"), get("route")].filter(Boolean).join(" ") || null;
  // Google gives an apartment as just "4B"; a building name ("premise") is rare in the US.
  const unit = get("subpremise");
  const lines = [street ?? get("premise"), unit && (/^\d/.test(unit) ? `Apt ${unit}` : unit)].filter(
    (l): l is string => !!l,
  );
  // New York's boroughs (Brooklyn, Queens…) come as a sublocality rather than a locality.
  const city = get("locality") ?? get("sublocality_level_1") ?? get("postal_town");
  const state = component("administrative_area_level_1")?.shortText?.trim().toUpperCase() ?? "";
  const zip = normaliseZip(get("postal_code") ?? "");
  if (!street || !city || !/^[A-Z]{2}$/.test(state) || !zip) return null;
  return {
    line1: lines[0],
    line2: lines.slice(1).join(", ") || null,
    city,
    state,
    zip,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
  };
}

export function googlePlacesSearch(apiKey: string, fetchImpl: typeof fetch = fetch): AddressSearch {
  async function call<T>(path: string, init: RequestInit & { fieldMask: string }): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(BASE_URL + path, {
        ...init,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey, "x-goog-fieldmask": init.fieldMask },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new AddressSearchError(`Couldn't reach Google Places: ${String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: { status?: string; message?: string } }) | null;
    if (!res.ok || !data) {
      throw new AddressSearchError(`Google Places said ${res.status} ${data?.error?.status ?? ""} ${data?.error?.message ?? ""}`.trim());
    }
    return data;
  }

  async function autocomplete(request: Record<string, unknown>): Promise<AddressSuggestion[]> {
    const data = await call<{ suggestions?: { placePrediction?: Prediction }[] }>("places:autocomplete", {
      method: "POST",
      fieldMask: "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
      body: JSON.stringify({ includedRegionCodes: [REGION.regionCode], ...REGION, ...request }),
    });
    return (data.suggestions ?? []).flatMap(({ placePrediction: p }) =>
      p?.placeId
        ? [
            {
              placeId: p.placeId,
              text: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
              secondaryText: p.structuredFormat?.secondaryText?.text ?? null,
            },
          ]
        : [],
    );
  }

  return {
    suggest(input, sessionToken) {
      return autocomplete({ input, sessionToken, includedPrimaryTypes: ["street_address", "premise", "subpremise"] });
    },

    suggestPlaces(input, sessionToken, near) {
      // Any kind of place, so typing a restaurant's name, its street or its ZIP code all work.
      return autocomplete({
        input,
        sessionToken,
        ...(near && { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: NEARBY_METRES } } }),
      });
    },

    async place(placeId, sessionToken) {
      const query = new URLSearchParams({ sessionToken, ...REGION });
      const found = await call<{ formattedAddress?: string; location?: { latitude: number; longitude: number } }>(
        `places/${encodeURIComponent(placeId)}?${query}`,
        { method: "GET", fieldMask: "formattedAddress,location" },
      );
      const address = found.formattedAddress?.replace(/, USA$/, "").trim();
      if (!found.location || !address) return null;
      return { address, lat: found.location.latitude, lng: found.location.longitude };
    },

    async details(placeId, sessionToken) {
      const query = new URLSearchParams({ sessionToken, ...REGION });
      const place = await call<Place>(`places/${encodeURIComponent(placeId)}?${query}`, {
        method: "GET",
        fieldMask: "addressComponents,location",
      });
      return toAddress(place);
    },
  };
}
