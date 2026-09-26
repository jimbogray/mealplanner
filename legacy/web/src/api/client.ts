import type {
  FamilyMember,
  InventoryItem,
  MealEvent,
  Recipe,
  RecipeSuggestion,
} from "@mealplanner/shared";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} /api/${path} -> ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface AttendanceView {
  memberId: string;
  name: string;
  response: "yes" | "no" | "pending";
  respondedAt: string | null;
}

export interface TodayView {
  event: MealEvent | null;
  attendance: AttendanceView[];
  recipe: Recipe | null;
}

export const api = {
  members: () => req<FamilyMember[]>("members"),
  addMember: (m: Partial<FamilyMember>) => req<{ id: string }>("members", { method: "POST", body: JSON.stringify(m) }),
  deleteMember: (id: string) => req<void>(`members/${id}`, { method: "DELETE" }),

  inventory: () => req<InventoryItem[]>("inventory"),
  addItem: (i: Partial<InventoryItem>) => req<{ id: string }>("inventory", { method: "POST", body: JSON.stringify(i) }),
  updateItem: (id: string, i: Partial<InventoryItem>) => req<void>(`inventory/${id}`, { method: "PUT", body: JSON.stringify(i) }),
  deleteItem: (id: string) => req<void>(`inventory/${id}`, { method: "DELETE" }),

  today: () => req<TodayView>("meal-events/today"),
  suggest: (headcount?: number, discoverNew?: boolean) =>
    req<{ headcount: number; suggestions: RecipeSuggestion[] }>("suggest-recipes", {
      method: "POST",
      body: JSON.stringify({ headcount, discoverNew }),
    }),
  choose: (recipeId: string, notifyFamily?: boolean) =>
    req<{ ok: boolean; title: string }>("choose-recipe", {
      method: "POST",
      body: JSON.stringify({ recipeId, notifyFamily }),
    }),
};

// Current user info from the SWA auth endpoint.
export interface ClientPrincipal {
  userDetails: string;
  userRoles: string[];
}
export async function getMe(): Promise<ClientPrincipal | null> {
  try {
    const res = await fetch("/.auth/me");
    const data = (await res.json()) as { clientPrincipal: ClientPrincipal | null };
    return data.clientPrincipal;
  } catch {
    return null;
  }
}
