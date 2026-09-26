// Looks up UK addresses by postcode with Ideal Postcodes (ideal-postcodes.co.uk), which is
// pay-as-you-go: a lookup costs a few pence and only happens when someone asks for one.
import type { Address } from "@mealplanner/shared";

/** Every address at a postcode (already normalised, e.g. "SW1A 2AA"); empty if the postcode doesn't exist. */
export type AddressLookup = (postcode: string) => Promise<Address[]>;

/** The lookup service couldn't be used (bad key, no balance, down). */
export class AddressLookupError extends Error {}

const BASE_URL = "https://api.ideal-postcodes.co.uk/v1/postcodes/";

/** One premise in an Ideal Postcodes postcode lookup (only the fields used here). */
interface IdealAddress {
  line_1: string;
  line_2?: string;
  line_3?: string;
  post_town: string;
  county?: string;
  postcode: string;
  latitude?: number;
  longitude?: number;
}

export function toAddress(a: IdealAddress): Address {
  const line2 = [a.line_2, a.line_3].filter((l) => l && l.trim()).join(", ");
  return {
    line1: a.line_1,
    line2: line2 || null,
    // Royal Mail post towns are upper case ("LONDON"); show them the way people write them.
    town: titleCase(a.post_town),
    county: a.county?.trim() || null,
    postcode: a.postcode,
    latitude: typeof a.latitude === "number" ? a.latitude : null,
    longitude: typeof a.longitude === "number" ? a.longitude : null,
  };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

export function idealPostcodesLookup(apiKey: string, fetchImpl: typeof fetch = fetch): AddressLookup {
  return async (postcode) => {
    const results: Address[] = [];
    // Big postcodes (a block of flats) come back in pages of 100.
    for (let page = 0; page < 10; page++) {
      const url = `${BASE_URL}${encodeURIComponent(postcode.replace(/\s+/g, ""))}?api_key=${encodeURIComponent(apiKey)}&page=${page}`;
      let res: Response;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        throw new AddressLookupError(`Couldn't reach Ideal Postcodes: ${String(err)}`);
      }
      const data = (await res.json().catch(() => null)) as { code?: number; message?: string; result?: IdealAddress[] } | null;
      if (res.status === 404 && data?.code === 4040) return results;
      if (!res.ok || !Array.isArray(data?.result)) {
        throw new AddressLookupError(`Ideal Postcodes said ${res.status} ${data?.code ?? ""} ${data?.message ?? ""}`.trim());
      }
      results.push(...data.result.map(toAddress));
      if (data.result.length < 100) break;
    }
    return results;
  };
}
