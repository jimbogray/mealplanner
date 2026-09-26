import type {
  AddFavouriteRequest,
  AuthResponse,
  CreateFamilyRequest,
  FamilyMember,
  FavouriteRecipe,
  GoogleAuthRequest,
  Invite,
  InvitePreview,
  LoginRequest,
  Me,
  MemberInput,
  RecipePreview,
  MemberUpdate,
  SignupRequest,
} from "@mealplanner/shared";

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const TOKEN_KEY = "family.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode etc.: the session just won't survive a reload.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  signup: (body: SignupRequest) => request<AuthResponse>("POST", "/api/auth/signup", body),
  login: (body: LoginRequest) => request<AuthResponse>("POST", "/api/auth/login", body),
  google: (body: GoogleAuthRequest) => request<AuthResponse>("POST", "/api/auth/google", body),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () => request<Me>("GET", "/api/me"),

  createFamily: (body: CreateFamilyRequest) => request<Me>("POST", "/api/family", body),
  renameFamily: (name: string) => request<void>("PATCH", "/api/family", { name }),
  addMember: (body: MemberInput) => request<FamilyMember>("POST", "/api/family/members", body),
  updateMember: (id: string, body: MemberUpdate) => request<FamilyMember>("PATCH", `/api/family/members/${id}`, body),
  removeMember: (id: string) => request<void>("DELETE", `/api/family/members/${id}`),

  invites: () => request<Invite[]>("GET", "/api/family/invites"),
  createInvite: (memberId?: string) => request<Invite>("POST", "/api/family/invites", memberId ? { memberId } : {}),
  revokeInvite: (id: string) => request<void>("DELETE", `/api/family/invites/${id}`),
  previewInvite: (code: string) => request<InvitePreview>("GET", `/api/invites/${encodeURIComponent(code)}`),
  acceptInvite: (code: string, body: Partial<MemberInput>) => request<Me>("POST", `/api/invites/${encodeURIComponent(code)}/accept`, body),


  recipes: () => request<FavouriteRecipe[]>("GET", "/api/family/recipes"),
  previewRecipe: (url: string) => request<RecipePreview>("POST", "/api/family/recipes/preview", { url }),
  addRecipe: (body: AddFavouriteRequest) => request<FavouriteRecipe>("POST", "/api/family/recipes", body),
  removeRecipe: (id: string) => request<void>("DELETE", `/api/family/recipes/${id}`),
};

export function inviteUrl(code: string): string {
  return `${window.location.origin}/join/${code}`;
}
