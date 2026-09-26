import { useEffect, useState } from "react";
import { api, type TodayView } from "../api/client";

export function Dashboard() {
  const [data, setData] = useState<TodayView | null>(null);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api.today().then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <p className="error">Couldn't load today: {err}</p>;
  if (!data) return <p>Loading…</p>;

  const yes = data.attendance.filter((a) => a.response === "yes").length;

  return (
    <div className="stack">
      <section className="card">
        <h2>Tonight's headcount</h2>
        {data.event ? (
          <>
            <p className="big">{yes} eating</p>
            <ul className="attendance">
              {data.attendance.map((a) => (
                <li key={a.memberId} className={`resp-${a.response}`}>
                  {a.name} — {a.response}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No dinner poll has run yet today.</p>
        )}
      </section>

      <section className="card">
        <h2>Chosen recipe</h2>
        {data.recipe ? (
          <article>
            <h3>{data.recipe.title}</h3>
            {data.recipe.imageUrl && <img src={data.recipe.imageUrl} alt={data.recipe.title} />}
            <h4>Ingredients</h4>
            <ul>
              {data.recipe.ingredients.map((i, n) => (
                <li key={n}>{[i.quantity, i.unit, i.name].filter(Boolean).join(" ")}</li>
              ))}
            </ul>
            <h4>Method</h4>
            <ol>
              {data.recipe.steps.map((s, n) => (
                <li key={n}>{s}</li>
              ))}
            </ol>
          </article>
        ) : (
          <p>
            No recipe chosen yet. Head to <strong>Recipes</strong> to get suggestions.
          </p>
        )}
      </section>
    </div>
  );
}
