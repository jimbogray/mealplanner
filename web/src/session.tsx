import type { Me } from "@mealplanner/shared";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getToken, setToken } from "./api";

interface Session {
  /** undefined while loading, null when signed out. */
  me: Me | null | undefined;
  signIn: (token: string, me: Me) => void;
  signOut: () => Promise<void>;
  setMe: (me: Me) => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(getToken() ? undefined : null);

  const refresh = useCallback(async () => {
    if (!getToken()) return setMe(null);
    try {
      setMe(await api.me());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setToken(null);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback((token: string, next: Me) => {
    setToken(token);
    setMe(next);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setToken(null);
    setMe(null);
  }, []);

  return <SessionContext.Provider value={{ me, signIn, signOut, setMe, refresh }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
