import type { Me } from "@mealplanner/shared";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getActingAs, getToken, setActingAs, setToken } from "./api";

interface Session {
  /** undefined while loading, null when signed out. */
  me: Me | null | undefined;
  signIn: (token: string, me: Me) => void;
  signOut: () => Promise<void>;
  setMe: (me: Me) => void;
  refresh: () => Promise<void>;
  /** For a Family Manager: use the app as another member (their id), or as themselves again (null). */
  actAs: (memberId: string | null) => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(getToken() ? undefined : null);

  const refresh = useCallback(async () => {
    if (!getToken()) return setMe(null);
    try {
      setMe(await api.me());
    } catch (err) {
      // The member we switched to was removed, or we're no longer a Family Manager: go back to ourselves.
      if (err instanceof ApiError && (err.status === 403 || err.status === 404) && getActingAs()) {
        setActingAs(null);
        try {
          return setMe(await api.me());
        } catch (retryErr) {
          err = retryErr;
        }
      }
      if (err instanceof ApiError && err.status === 401) setToken(null);
      setMe(null);
    }
  }, []);

  const actAs = useCallback(
    async (memberId: string | null) => {
      setActingAs(memberId);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback((token: string, next: Me) => {
    setActingAs(null);
    setToken(token);
    setMe(next);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setToken(null);
    setActingAs(null);
    setMe(null);
  }, []);

  return <SessionContext.Provider value={{ me, signIn, signOut, setMe, refresh, actAs }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
