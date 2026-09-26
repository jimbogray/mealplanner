// Finds restaurants on the map and times the drive to them from the family's home, with Azure Maps.

export interface Place {
  /** The address the map service found, for people to check it picked the right place. */
  address: string;
  lat: number;
  lng: number;
}

export interface Maps {
  /** Finds a place by address or name, preferring ones near `near`. Null if nothing matches. */
  findPlace(query: string, near?: { lat: number; lng: number } | null): Promise<Place | null>;
  /** Driving time in whole minutes, in typical traffic. Null if there's no road route. */
  driveMinutes(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number | null>;
}

const BASE = "https://atlas.microsoft.com";

/** How far from home to look for a restaurant searched for by name, in metres. */
const NEARBY_METRES = 50_000;

export function azureMaps(key: string, fetchImpl: typeof fetch = fetch): Maps {
  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries({ "api-version": "1.0", ...params })) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { headers: { "subscription-key": key }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Azure Maps ${path} failed (${res.status})`);
    return (await res.json()) as T;
  }

  return {
    async findPlace(query, near) {
      const params: Record<string, string> = { query, limit: "1" };
      if (near) Object.assign(params, { lat: String(near.lat), lon: String(near.lng), radius: String(NEARBY_METRES) });
      const body = await get<{ results?: { address?: { freeformAddress?: string }; poi?: { name?: string }; position: { lat: number; lon: number } }[] }>(
        "/search/fuzzy/json",
        params,
      );
      const hit = body.results?.[0];
      if (!hit) return null;
      const address = [hit.poi?.name, hit.address?.freeformAddress].filter(Boolean).join(", ");
      return { address: address || query, lat: hit.position.lat, lng: hit.position.lon };
    },

    async driveMinutes(from, to) {
      try {
        const body = await get<{ routes?: { summary: { travelTimeInSeconds: number } }[] }>("/route/directions/json", {
          query: `${from.lat},${from.lng}:${to.lat},${to.lng}`,
          travelMode: "car",
          traffic: "false",
        });
        const seconds = body.routes?.[0]?.summary.travelTimeInSeconds;
        return seconds === undefined ? null : Math.max(1, Math.round(seconds / 60));
      } catch (err) {
        // No road between them (e.g. across the sea) comes back as a 400.
        if (err instanceof Error && err.message.includes("(400)")) return null;
        throw err;
      }
    },
  };
}
