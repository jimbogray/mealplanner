import type { ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { FamilyPage } from "./pages/Family";
import { GoogleReturnPage } from "./pages/GoogleReturn";
import { JoinPage } from "./pages/Join";
import { LibraryPage } from "./pages/Library";
import { LoginPage } from "./pages/Login";
import { RestaurantsPage } from "./pages/Restaurants";
import { SchedulePage } from "./pages/Schedule";
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
        {me?.family && (
          <nav className="nav">
            <NavLink to="/family">Family</NavLink>
            <NavLink to="/library">Library</NavLink>
            <NavLink to="/schedule">Schedule</NavLink>
            <NavLink to="/restaurants">Restaurants</NavLink>
          </nav>
        )}
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
            <Route path="/auth/google" element={<GoogleReturnPage />} />
            <Route
              path="/family"
              element={
                <RequireSignIn>
                  <FamilyPage />
                </RequireSignIn>
              }
            />
            <Route
              path="/library"
              element={
                <RequireSignIn>
                  <LibraryPage />
                </RequireSignIn>
              }
            />
            <Route
              path="/schedule"
              element={
                <RequireSignIn>
                  <SchedulePage />
                </RequireSignIn>
              }
            />
            <Route
              path="/restaurants"
              element={
                <RequireSignIn>
                  <RestaurantsPage />
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
