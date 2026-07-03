import { NavLink, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import { getMe, type ClientPrincipal } from "./api/client";
import { Dashboard } from "./pages/Dashboard";
import { Inventory } from "./pages/Inventory";
import { Family } from "./pages/Family";
import { Recipes } from "./pages/Recipes";

export function App() {
  const [me, setMe] = useState<ClientPrincipal | null>(null);
  useEffect(() => {
    getMe().then(setMe);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>🍽️ Family meal planner</h1>
        <nav>
          <NavLink to="/">Tonight</NavLink>
          <NavLink to="/inventory">Fridge</NavLink>
          <NavLink to="/recipes">Recipes</NavLink>
          <NavLink to="/family">Family</NavLink>
        </nav>
        <div className="auth">
          {me ? (
            <>
              <span>{me.userDetails}</span>
              <a href="/logout">Sign out</a>
            </>
          ) : (
            <a href="/login">Sign in</a>
          )}
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/family" element={<Family />} />
        </Routes>
      </main>
    </div>
  );
}
