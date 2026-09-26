// Finds UK addresses as people type, with Google Places (New): Autocomplete for the suggestions,
// then Place Details for the one they pick. Both calls share a session token, which Google bills
// as one session rather than per keystroke.
import { normalisePostcode, type Address, type AddressSuggestion } from "@mealplanner/shared";

export interface AddressSearch {
  /** Addresses matching what's been typed so far. */
  suggest(input: string, sessionToken: string): Promise<AddressSuggestion[]>;
  /** The full address of a suggestion, or null if it isn't a complete UK address (no postcode, say). */
  details(placeId: string, sessionToken: string): Promise<Address | null>;
}

/** Google couldn't be used (bad key, API not enabled, quota, down). */
export class AddressSearchError extends Error {}

const BASE_URL = "https://places.googleapis.com/v1/";

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

/** Turns a place's address components into the family's address, or null if it's not a full UK address. */
export function toAddress(place: Place): Address | null {
  const parts = place.addressComponents ?? [];
  const get = (type: string) => parts.find((c) => c.types.includes(type))?.longText?.trim() || null;
  if (get("country") && parts.find((c) => c.types.includes("country"))?.shortText !== "GB") return null;
  const street = [get("street_number"), get("route")].filter(Boolean).join(" ") || null;
  // e.g. "Flat 2", "Rose Cottage", "10 Downing Street"
  const lines = [get("subpremise"), get("premise"), street].filter((l): l is string => l !== null);
  const town = get("postal_town") ?? get("locality");
  const postcode = normalisePostcode(get("postal_code") ?? "");
  if (!lines.length || !town || !postcode) return null;
  return {
    line1: lines[0],
    line2: lines.slice(1).join(", ") || null,
    town,
    county: get("administrative_area_level_2"),
    postcode,
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

  return {
    async suggest(input, sessionToken) {
      const data = await call<{ suggestions?: { placePrediction?: Prediction }[] }>("places:autocomplete", {
        method: "POST",
        fieldMask: "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
        body: JSON.stringify({
          input,
          sessionToken,
          includedRegionCodes: ["gb"],
          regionCode: "gb",
          languageCode: "en-GB",
          includedPrimaryTypes: ["street_address", "premise", "subpremise"],
        }),
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
    },

    async details(placeId, sessionToken) {
      const query = new URLSearchParams({ sessionToken, languageCode: "en-GB", regionCode: "gb" });
      const place = await call<Place>(`places/${encodeURIComponent(placeId)}?${query}`, {
        method: "GET",
        fieldMask: "addressComponents,location",
      });
      return toAddress(place);
    },
  };
}
