import {
  AISLE_LABELS,
  AISLES,
  formatQuantity,
  mondayOf,
  shoppingItems,
  stepQuantity,
  type Quantity,
  type ShoppingItem,
  type ShoppingList,
} from "@mealplanner/shared";
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage } from "../components/Field";
import { AddToList, capitalise, withHave } from "../components/Ingredients";
import { useSession } from "../session";

/** The family's shopping list, from the ingredients of the recipes on the schedule, grouped as a store lays them out. */
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

/** "Mon 13 Oct": the list can run across weeks, so the date as well as the day. */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function Shopping() {
  const [list, setList] = useState<ShoppingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = localToday();

  useEffect(() => {
    let live = true;
    api.shopping(today).then(
      (l) => live && setList(l),
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [today]);

  async function setBought(item: ShoppingItem, bought: boolean) {
    if (!list) return;
    const change = (b: boolean) => (l: ShoppingList | null) =>
      l && { ...l, items: l.items.map((i) => (i.key === item.key ? { ...i, bought: b } : i)) };
    setList(change(bought));
    try {
      await api.setBought({ key: item.key, bought });
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
      await api.setQuantity({ key: item.key, quantity });
    } catch (err) {
      setList(before);
      setError(errorMessage(err));
    }
  }

  /** Empties the list, after checking. */
  async function clearList() {
    if (!list || !window.confirm("Clear the shopping list? Everything on it, including anything added or ticked off, will be removed.")) return;
    setError(null);
    try {
      setList(await api.clearShopping(today));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function needAfterAll(date: string, name: string) {
    if (!list) return;
    const before = list;
    setList(withHave(list, date, name, false));
    try {
      await api.setHave(mondayOf(date), date, { name, have: false });
    } catch (err) {
      setList(before);
      setError(errorMessage(err));
    }
  }

  const shown = list;
  const toBuy = shown?.items.filter((i) => !i.bought).length ?? 0;
  const unread = shown?.meals.filter((m) => !m.ingredients) ?? [];
  const inHouse = shown?.meals.flatMap((m) => (m.ingredients ?? []).filter((i) => i.have).map((i) => ({ meal: m, name: i.name }))) ?? [];

  return (
    <div className="stack">
      <section className="card">
        <h1>Shopping List</h1>
        <p className="note">
          Everything the recipes on the schedule from today on need, plus anything added, grouped by aisle. Untick what's already in the
          house on the{" "}
          <Link to="/schedule">Schedule</Link>, and tick things off here as they go in the basket. Use − and + to change how much.
        </p>
        {shown && shown.items.length > 0 && (
          <div className="shopping-summary">
            <p className="shopping-count">
              {toBuy === 0 ? "All bought" : `${toBuy} to buy`}
              {toBuy > 0 && toBuy < shown.items.length && `, ${shown.items.length - toBuy} bought`}
            </p>
            <button type="button" className="link danger" onClick={() => void clearList()}>
              Clear list
            </button>
          </div>
        )}
      </section>
      <ErrorNote error={error} />
      {!shown && !error && <p className="note center">Reading the recipes' ingredients…</p>}
      {shown && (
        <section className="card">
          <h2>Anything else?</h2>
          <AddToList list={shown} today={today} onChange={setList} />
        </section>
      )}
      {shown && shown.items.length === 0 && shown.meals.some((m) => m.ingredients?.length) && (
        <p className="note center">Nothing to buy. Add anything above, or put things back from Already in the house below.</p>
      )}
      {shown && shown.meals.length === 0 && shown.extras.length === 0 && (
        <p className="note center">
          Nothing on the list yet. Pick meals from your recipes on the <Link to="/schedule">Schedule</Link> and their ingredients show
          up here, or add anything above.
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
              Couldn't read the ingredients for {unread.map((m) => `${m.name} (${dayLabel(m.date)})`).join(", ")}, so{" "}
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
                      {capitalise(name)} <span className="note small">for {meal.name} ({dayLabel(meal.date)})</span>
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
