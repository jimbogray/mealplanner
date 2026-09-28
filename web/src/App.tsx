import { displayName, type Me } from "@mealplanner/shared";
import type { ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { FamilyPage } from "./pages/Family";
import { GoogleReturnPage } from "./pages/GoogleReturn";
import { JoinPage } from "./pages/Join";
import { LibraryPage } from "./pages/Library";
import { LoginPage } from "./pages/Login";
import { RestaurantsPage } from "./pages/Restaurants";
import { SchedulePage } from "./pages/Schedule";
import { ShoppingPage } from "./pages/Shopping";
import { SignupPage } from "./pages/Signup";
import { useSession } from "./session";

export function App() {
  const { me, signOut, actAs } = useSession();
  const signedInAs = me?.signedInAs;

  return (
    <>
      <header className={signedInAs ? "topbar acting" : "topbar"}>
        <Link to="/" className="brand">
          Meal Planner
        </Link>
        {me?.family && (
          <nav className="nav">
            <NavLink to="/schedule">Schedule</NavLink>
            <NavLink to="/shopping">Shopping List</NavLink>
            <NavLink to="/library">Recipes</NavLink>
            <NavLink to="/restaurants">Restaurants</NavLink>
            <NavLink to="/family">Family</NavLink>
          </nav>
        )}
        {me && (
          <div className="auth">
            <UserLabel me={me} onSwitch={(id) => void actAs(id)} />
            <button className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        )}
      </header>
      {signedInAs && me?.member && (
        <div className="acting-banner" role="status">
          <span>
            You're using the app as <strong>{displayName(me.member)}</strong>. Ratings and changes are saved as them, with
            their permissions.
          </span>
          <button className="secondary" onClick={() => void actAs(null)}>
            Switch back to {displayName(signedInAs)}
          </button>
        </div>
      )}
      <main key={me?.member?.id ?? "none"}>
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
              path="/shopping"
              element={
                <RequireSignIn>
                  <ShoppingPage />
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

/**
 * Who's using the app: their familiar name, or for a Family Manager a dropdown of the whole family
 * to switch to someone else (and back).
 */
function UserLabel({ me, onSwitch }: { me: Me; onSwitch: (memberId: string | null) => void }) {
  const self = me.signedInAs ?? me.member;
  if (!self || !me.member) return <span className="note">{me.user.email}</span>;
  if (self.role !== "admin" || me.members.length < 2) {
    return (
      <span className="note" title={me.user.email}>
        {displayName(self)}
      </span>
    );
  }
  return (
    <select
      className="user-switch"
      aria-label="Use the app as"
      title="Use the app as another family member"
      value={me.member.id}
      onChange={(e) => onSwitch(e.target.value === self.id ? null : e.target.value)}
    >
      {me.members.map((m) => (
        <option key={m.id} value={m.id}>
          {displayName(m)}
          {m.id === self.id ? " (you)" : ""}
        </option>
      ))}
    </select>
  );
}

function RequireSignIn({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const location = useLocation();
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
