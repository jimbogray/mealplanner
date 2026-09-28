import {
  AISLE_LABELS,
  AISLES,
  formatQuantity,
  mondayOf,
  shoppingItems,
  stepQuantity,
  type Quantity,
  type ScheduleWeek,
  type ShoppingItem,
  type ShoppingList,
} from "@mealplanner/shared";
import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage } from "../components/Field";
import { AddToList, capitalise, withHave } from "../components/Ingredients";
import { useSession } from "../session";

/** A week's shopping list, from the ingredients of the recipes on the schedule, grouped as a store lays them out. */
export function ShoppingPage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family) return <Navigate to="/family" replace />;
  return <Shopping />;
}

/** Today's date where the person is, "YYYY-MM-DD". */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function weekday(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });
}

function Shopping() {
  const [params, setParams] = useSearchParams();
  const [weeks, setWeeks] = useState<ScheduleWeek[] | null>(null);
  const [list, setList] = useState<ShoppingList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thisWeek = mondayOf(localToday());

  useEffect(() => {
    api.weeks().then(setWeeks, (err) => setError(errorMessage(err)));
  }, []);

  // This week and those after it; the one asked for, else this week, else the next one planned.
  const upcoming = (weeks ?? []).filter((w) => w.startsOn >= thisWeek);
  const asked = params.get("week");
  const startsOn = (weeks ?? []).some((w) => w.startsOn === asked) ? asked : (upcoming[0]?.startsOn ?? null);
  const choices = asked && startsOn === asked && !upcoming.some((w) => w.startsOn === asked) ? [{ startsOn: asked }, ...upcoming] : upcoming;

  useEffect(() => {
    if (!startsOn) return;
    let live = true;
    setLoading(true);
    setError(null);
    api
      .shopping(startsOn)
      .then(
        (l) => live && setList(l),
        (err) => live && setError(errorMessage(err)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [startsOn]);

  async function setBought(item: ShoppingItem, bought: boolean) {
    if (!list) return;
    const change = (b: boolean) => (l: ShoppingList | null) =>
      l && { ...l, items: l.items.map((i) => (i.key === item.key ? { ...i, bought: b } : i)) };
    setList(change(bought));
    try {
      await api.setBought(list.startsOn, { key: item.key, bought });
    } catch (err) {
      setList(change(!bought));
      setError(errorMessage(err));
    }
  }

  /** Changes how much of an item to buy (null: back to what the recipes add up to), straight away. */
  async function setQuantity(item: ShoppingItem, quantity: Quantity | null) {
    if (!list) return;
    const change = (l: ShoppingList | null): ShoppingList | null => {
      if (!l) return l;
      const adjusted = { ...l.adjusted };
      if (quantity) adjusted[item.key] = quantity;
      else delete adjusted[item.key];
      const bought = l.items.filter((i) => i.bought).map((i) => i.key);
      return { ...l, adjusted, items: shoppingItems(l.meals, bought, l.extras, adjusted) };
    };
    const before = list;
    setList(change);
    try {
      await api.setQuantity(list.startsOn, { key: item.key, quantity });
    } catch (err) {
      setList(before);
      setError(errorMessage(err));
    }
  }

  async function needAfterAll(date: string, name: string) {
    if (!list) return;
    const before = list;
    setList(withHave(list, date, name, false));
    try {
      await api.setHave(list.startsOn, date, { name, have: false });
    } catch (err) {
      setList(before);
      setError(errorMessage(err));
    }
  }

  const shown = list && list.startsOn === startsOn ? list : null;
  const toBuy = shown?.items.filter((i) => !i.bought).length ?? 0;
  const unread = shown?.meals.filter((m) => !m.ingredients) ?? [];
  const inHouse = shown?.meals.flatMap((m) => (m.ingredients ?? []).filter((i) => i.have).map((i) => ({ meal: m, name: i.name }))) ?? [];

  return (
    <div className="stack">
      <section className="card">
        <div className="week-head">
          <h1>Shopping list</h1>
          {choices.length > 1 && startsOn && (
            <select className="week-pick" aria-label="Week" value={startsOn} onChange={(e) => setParams({ week: e.target.value })}>
              {choices.map((w) => (
                <option key={w.startsOn} value={w.startsOn}>
                  {w.startsOn === thisWeek ? "This week" : `Week of ${dayLabel(w.startsOn)}`}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="note">
          Everything the week's recipes need in all, plus anything added, grouped by aisle. Untick what's already in the house on the{" "}
          <Link to="/schedule">Schedule</Link>, and tick things off here as they go in the basket. Use − and + to change how much.
        </p>
        {shown && shown.items.length > 0 && (
          <p className="shopping-count">
            {toBuy === 0 ? "All bought" : `${toBuy} to buy`}
            {toBuy > 0 && toBuy < shown.items.length && `, ${shown.items.length - toBuy} bought`}
          </p>
        )}
      </section>
      <ErrorNote error={error} />
      {weeks && !startsOn && (
        <p className="note center">
          No weeks planned yet. Add one on the <Link to="/schedule">Schedule</Link> and pick recipes for its meals.
        </p>
      )}
      {loading && !shown && <p className="note center">Reading the recipes' ingredients…</p>}
      {shown && (
        <section className="card">
          <h2>Anything else?</h2>
          <AddToList list={shown} onChange={setList} />
        </section>
      )}
      {shown && shown.meals.length === 0 && shown.extras.length === 0 && (
        <p className="note center">
          No recipes picked for this week yet. Pick meals from your recipes on the <Link to="/schedule">Schedule</Link> and their
          ingredients show up here.
        </p>
      )}
      {shown &&
        AISLES.map((aisle) => {
          const items = shown.items.filter((i) => i.aisle === aisle && !i.bought);
          if (!items.length) return null;
          return (
            <section key={aisle} className="card aisle">
              <h2>{AISLE_LABELS[aisle]}</h2>
              <ShoppingItems items={items} onBought={setBought} onQuantity={setQuantity} />
            </section>
          );
        })}
      {shown && shown.items.some((i) => i.bought) && (
        <section className="card aisle in-basket">
          <h2>In basket</h2>
          <ShoppingItems items={shown.items.filter((i) => i.bought)} onBought={setBought} onQuantity={setQuantity} />
        </section>
      )}
      {shown && (unread.length > 0 || inHouse.length > 0) && (
        <section className="card stack">
          {unread.length > 0 && (
            <p className="note">
              Couldn't read the ingredients for {unread.map((m) => `${m.name} (${weekday(m.date)})`).join(", ")}, so{" "}
              {unread.length === 1 ? "it isn't" : "they aren't"} on the list.
            </p>
          )}
          {inHouse.length > 0 && (
            <details className="in-house">
              <summary>Already in the house ({inHouse.length})</summary>
              <ul>
                {inHouse.map(({ meal, name }) => (
                  <li key={`${meal.date}-${name}`}>
                    <span>
                      {capitalise(name)} <span className="note small">for {meal.name} ({weekday(meal.date)})</span>
                    </span>
                    <button className="link small" onClick={() => void needAfterAll(meal.date, name)}>
                      Need it
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

function ShoppingItems({
  items,
  onBought,
  onQuantity,
}: {
  items: ShoppingItem[];
  onBought: (item: ShoppingItem, bought: boolean) => void;
  onQuantity: (item: ShoppingItem, quantity: Quantity | null) => void;
}) {
  return (
    <ul className="shopping-items">
      {items.map((item) => (
        <li key={item.key} className={item.bought ? "bought" : undefined}>
          <label>
            <input type="checkbox" checked={item.bought} onChange={(e) => onBought(item, e.target.checked)} />
            <span className="item-name">{capitalise(item.name)}</span>
          </label>
          <span className="stepper" role="group" aria-label={`How much ${item.name}`}>
            <button
              type="button"
              className="secondary"
              aria-label="Less"
              disabled={stepQuantity(item.amount, -1).amount >= item.amount.amount}
              onClick={() => onQuantity(item, stepQuantity(item.amount, -1))}
            >
              −
            </button>
            <span className={item.adjusted ? "amount adjusted" : "amount"}>{item.quantity ?? formatQuantity(item.amount)}</span>
            <button type="button" className="secondary" aria-label="More" onClick={() => onQuantity(item, stepQuantity(item.amount, 1))}>
              +
            </button>
            {/* Always there (hidden until changed) so the rows line up. */}
            <button
              type="button"
              className={item.adjusted ? "link reset" : "link reset unchanged"}
              title="Back to what the recipes need"
              aria-label="Reset the amount"
              disabled={!item.adjusted}
              onClick={() => onQuantity(item, null)}
            >
              ↺
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
