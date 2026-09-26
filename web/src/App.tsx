import type { ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { FamilyPage } from "./pages/Family";
import { JoinPage } from "./pages/Join";
import { LoginPage } from "./pages/Login";
import { SignupPage } from "./pages/Signup";
import { useSession } from "./session";

export function App() {
  const { me, signOut } = useSession();

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          {me?.family ? me.family.name : "Family"}
        </Link>
        {me && (
          <div className="auth">
            <span className="note">{me.user.email}</span>
            <button className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main>
        {me === undefined ? (
          <p className="note">Loading…</p>
        ) : (
          <Routes>
            <Route path="/" element={me ? <Navigate to="/family" replace /> : <Navigate to="/signup" replace />} />
            <Route path="/signup" element={me ? <Navigate to="/family" replace /> : <SignupPage />} />
            <Route path="/login" element={me ? <Navigate to="/family" replace /> : <LoginPage />} />
            <Route path="/join/:code" element={<JoinPage />} />
            <Route
              path="/family"
              element={
                <RequireSignIn>
                  <FamilyPage />
                </RequireSignIn>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </>
  );
}

function RequireSignIn({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const location = useLocation();
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
