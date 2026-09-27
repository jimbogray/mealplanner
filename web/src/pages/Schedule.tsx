import {
  ALLERGEN_LABELS,
  ALLERGENS,
  daysToPlan,
  MAX_GUESTS,
  MAX_MEAL_NAME,
  mondayOf,
  nextWeekToAdd,
  weekDays,
  type Allergen,
  type FamilyMember,
  type MealInput,
  type ScheduleDay,
  type ScheduleMeal,
  type ScheduleWeek,
  type UpdateDayRequest,
} from "@mealplanner/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage } from "../components/Field";
import { useSession } from "../session";

/** The family's weekly schedule: who's in for dinner each day, Monday to Sunday. */
export function SchedulePage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family) return <Navigate to="/family" replace />;
  return <Schedule members={me.members} isManager={me.member?.role === "admin"} />;
}

/** The family's recipes and restaurants a Family Manager can pick meals from. */
interface MealChoices {
  recipes: { id: string; name: string; url: string }[];
  restaurants: { id: string; name: string; url: string | null }[];
}

/** Today's date where the person is, "YYYY-MM-DD". */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(date: string, weekday: "short" | "long" = "short"): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday, day: "numeric", month: "short" });
}

function weekLabel(startsOn: string): string {
  return `Week of ${dayLabel(startsOn)}`;
}

function Schedule({ members, isManager }: { members: FamilyMember[]; isManager: boolean }) {
  const [weeks, setWeeks] = useState<ScheduleWeek[] | null>(null);
  const [choices, setChoices] = useState<MealChoices | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = localToday();
  const thisWeek = mondayOf(today);

  useEffect(() => {
    api.weeks().then(setWeeks, (err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (!isManager) return;
    Promise.all([api.recipes(), api.restaurants()]).then(
      ([recipes, restaurants]) => setChoices({ recipes, restaurants }),
      // Meals can still be typed in.
      () => setChoices({ recipes: [], restaurants: [] }),
    );
  }, [isManager]);

  const next = weeks ? nextWeekToAdd(weeks.map((w) => w.startsOn), today) : null;
  const upcoming = (weeks ?? []).filter((w) => w.startsOn >= thisWeek);
  const past = (weeks ?? []).filter((w) => w.startsOn < thisWeek).reverse();

  function replace(week: ScheduleWeek) {
    setWeeks((list) => (list ?? []).map((w) => (w.startsOn === week.startsOn ? week : w)));
  }

  async function remove(week: ScheduleWeek) {
    if (!window.confirm(`Remove the ${weekLabel(week.startsOn).toLowerCase()} from the schedule?`)) return;
    setError(null);
    try {
      await api.removeWeek(week.startsOn);
      setWeeks((list) => (list ?? []).filter((w) => w.startsOn !== week.startsOn));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h1>Schedule</h1>
        <p className="note">
          Who's in for dinner each day, and what's cooking. Weeks run Monday to Sunday; anyone in the family can change who's in, and a
          Family Manager picks the meals.
        </p>
        {next && !adding && (
          <div className="row">
            <button onClick={() => setAdding(next)}>
              Add {next === thisWeek ? "this week" : `week of ${dayLabel(next)}`}
            </button>
          </div>
        )}
        {adding && (
          <WeekForm
            title={next === thisWeek ? "This week" : weekLabel(adding)}
            members={members}
            choices={isManager ? choices : null}
            dates={daysToPlan(adding, today)}
            days={daysToPlan(adding, today).map((date) => everyone(date, members))}
            submitLabel="Add week"
            onCancel={() => setAdding(null)}
            onSave={async (days) => {
              const week = await api.addWeek({ startsOn: adding, today, days: days.map((d) => ({ date: d.date, ...dayRequest(d, isManager) })) });
              setWeeks((list) => [...(list ?? []), week].sort((a, b) => a.startsOn.localeCompare(b.startsOn)));
              setAdding(null);
            }}
          />
        )}
      </section>
      <ErrorNote error={error} />
      {weeks && upcoming.length === 0 && !adding && <p className="note center">No weeks planned yet. Add this week above.</p>}
      {upcoming.map((w) => (
        <Week
          key={w.startsOn}
          week={w}
          members={members}
          choices={isManager ? choices : null}
          today={today}
          isCurrent={w.startsOn === thisWeek}
          onChange={replace}
          onRemove={() => void remove(w)}
        />
      ))}
      {past.length > 0 && (
        <details className="past-weeks">
          <summary>Earlier weeks ({past.length})</summary>
          <div className="stack">
            {past.map((w) => (
              <Week
                key={w.startsOn}
                week={w}
                members={members}
                choices={isManager ? choices : null}
                today={today}
                isCurrent={false}
                onChange={replace}
                onRemove={() => void remove(w)}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** A day with the whole family joining, no guests and no meal yet. */
function everyone(date: string, members: FamilyMember[]): ScheduleDay {
  return { date, eatOut: false, memberIds: members.map((m) => m.id), guests: 0, meal: null };
}

/** What to send for a day. Only a Family Manager sends the meal. */
function dayRequest(d: ScheduleDay, isManager: boolean): UpdateDayRequest {
  return { eatOut: d.eatOut, memberIds: d.memberIds, guests: d.guests, ...(isManager ? { meal: mealRequest(d.meal) } : {}) };
}

function mealRequest(meal: ScheduleMeal | null): MealInput | null {
  if (!meal) return null;
  if (meal.recipeId) return { recipeId: meal.recipeId };
  if (meal.restaurantId) return { restaurantId: meal.restaurantId };
  return meal.name.trim() ? { name: meal.name.trim() } : null;
}

/** Allergies of the family members joining that day, in the usual order. */
function allergiesFor(day: ScheduleDay, members: FamilyMember[]): Allergen[] {
  const joining = members.filter((m) => day.memberIds.includes(m.id));
  return ALLERGENS.filter((a) => joining.some((m) => m.allergies.includes(a)));
}

function AllergyNote({ day, members }: { day: ScheduleDay; members: FamilyMember[] }) {
  const allergies = allergiesFor(day, members);
  if (!allergies.length) return null;
  return <span className="allergy-note">Allergies: {allergies.map((a) => ALLERGEN_LABELS[a]).join(", ")}</span>;
}

function Week({
  week,
  members,
  choices,
  today,
  isCurrent,
  onChange,
  onRemove,
}: {
  week: ScheduleWeek;
  members: FamilyMember[];
  choices: MealChoices | null;
  today: string;
  isCurrent: boolean;
  onChange: (week: ScheduleWeek) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const title = isCurrent ? "This week" : weekLabel(week.startsOn);

  if (editing) {
    return (
      <section className="card">
        <WeekForm
          title={title}
          members={members}
          choices={choices}
          // Days already in the schedule, plus any removed ones that haven't passed yet (so they can be added back).
          dates={weekDays(week.startsOn).filter((date) => date >= today || week.days.some((d) => d.date === date))}
          days={week.days}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSave={async (days) => {
            // Only send what changed: new or edited days first, then removals (a week must keep a day).
            const changed = days.filter((d) => {
              const before = week.days.find((b) => b.date === d.date);
              return !before || !sameDay(d, before);
            });
            const removed = week.days.filter((b) => !days.some((d) => d.date === b.date));
            const saved = await Promise.all(changed.map((d) => api.updateDay(week.startsOn, d.date, dayRequest(d, choices !== null))));
            await Promise.all(removed.map((d) => api.removeDay(week.startsOn, d.date)));
            onChange({ ...week, days: days.map((d) => saved.find((s) => s.date === d.date) ?? d) });
            setEditing(false);
          }}
        />
      </section>
    );
  }

  return (
    <section className="card">
      <div className="week-head">
        <h2>{title}</h2>
        {isCurrent && <span className="note small">from {dayLabel(week.days[0]?.date ?? week.startsOn)}</span>}
        <div className="week-actions">
          <button className="link" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="link danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      <ul className="days">
        {week.days.map((d) => (
          <li key={d.date} className={d.eatOut ? "eat-out" : undefined}>
            <span className="day-name">{dayLabel(d.date)}</span>
            <span className="day-details">
              <span className="diners">{dinersSummary(d, members)}</span>
              {d.meal && (
                <span className="meal">
                  {d.meal.url ? (
                    <a href={d.meal.url} target="_blank" rel="noopener noreferrer">
                      {d.meal.name}
                    </a>
                  ) : (
                    d.meal.name
                  )}
                </span>
              )}
              <AllergyNote day={d} members={members} />
            </span>
            <span className="diner-count">{d.eatOut ? "" : `${d.memberIds.length + d.guests} for dinner`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sameDay(a: ScheduleDay, b: ScheduleDay): boolean {
  return (
    a.eatOut === b.eatOut &&
    a.guests === b.guests &&
    a.memberIds.length === b.memberIds.length &&
    a.memberIds.every((id) => b.memberIds.includes(id)) &&
    JSON.stringify(mealRequest(a.meal)) === JSON.stringify(mealRequest(b.meal))
  );
}

function dinersSummary(day: ScheduleDay, members: FamilyMember[]): string {
  if (day.eatOut) return "Eating out";
  const joining = members.filter((m) => day.memberIds.includes(m.id));
  const names = joining.length === members.length && members.length > 1 ? "Everyone" : joining.map((m) => m.name).join(", ");
  const guests = day.guests ? `${day.guests} ${day.guests === 1 ? "guest" : "guests"}` : "";
  return [names, guests].filter(Boolean).join(" + ") || "No one";
}

/**
 * A week's days, each with who's joining for dinner (toggle pills), a number of guests and, for a Family
 * Manager (when `choices` is given), the meal. Any of `dates` can be taken out of the schedule, or put back
 * in; saving passes the days still in it.
 */
function WeekForm({
  title,
  members,
  choices,
  dates,
  days: initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  title: string;
  members: FamilyMember[];
  choices: MealChoices | null;
  dates: string[];
  days: ScheduleDay[];
  submitLabel: string;
  onSave: (days: ScheduleDay[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [days, setDays] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  function update(date: string, change: Partial<ScheduleDay>) {
    setDays((list) => list.map((d) => (d.date === date ? { ...d, ...change } : d)));
  }

  function toggle(day: ScheduleDay, memberId: string, joining: boolean) {
    update(day.date, { memberIds: joining ? [...day.memberIds, memberId] : day.memberIds.filter((id) => id !== memberId) });
  }

  /** Eating out takes everyone and any guests off that day; eating in again starts from the whole family. */
  function setEatOut(date: string, eatOut: boolean) {
    update(date, eatOut ? { eatOut, memberIds: [], guests: 0, meal: null } : { eatOut, memberIds: members.map((m) => m.id), guests: 0, meal: null });
  }

  /** Typing a saved recipe's (or, eating out, restaurant's) name links it; anything else is kept as typed. */
  function setMeal(day: ScheduleDay, text: string) {
    const options = day.eatOut ? choices?.restaurants : choices?.recipes;
    const match = options?.find((o) => o.name.toLowerCase() === text.trim().toLowerCase());
    const meal: ScheduleMeal | null = !text
      ? null
      : match
        ? { name: text, recipeId: day.eatOut ? null : match.id, restaurantId: day.eatOut ? match.id : null, url: match.url }
        : { name: text, recipeId: null, restaurantId: null, url: null };
    update(day.date, { meal });
  }

  function removeDay(date: string) {
    setDays((list) => list.filter((d) => d.date !== date));
  }

  function addBack(date: string) {
    setDays((list) => [...list, everyone(date, members)].sort((a, b) => a.date.localeCompare(b.date)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (days.length === 0) {
      setError("Keep at least one day, or remove the whole week instead.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(days);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={submit}>
      <div>
        <h2>{title}</h2>
        <p className="hint">
          Tap who's joining for dinner each day, and add any guests.
          {choices && " Pick a meal from your recipes (or restaurants, eating out), or type one in."}
        </p>
      </div>
      {choices && (
        <>
          <datalist id={`${listId}-recipes`}>
            {choices.recipes.map((r) => (
              <option key={r.id} value={r.name} />
            ))}
          </datalist>
          <datalist id={`${listId}-restaurants`}>
            {choices.restaurants.map((r) => (
              <option key={r.id} value={r.name} />
            ))}
          </datalist>
        </>
      )}
      <ul className="day-form">
        {dates.map((date) => {
          const d = days.find((day) => day.date === date);
          if (!d) {
            return (
              <li key={date} className="day-removed">
                <span>
                  <s>{dayLabel(date, "long")}</s> <span className="note small">not in the schedule</span>
                </span>
                <button type="button" className="link" onClick={() => addBack(date)}>
                  Add back
                </button>
              </li>
            );
          }
          return (
            <li key={d.date}>
              <fieldset>
                <div className="day-legend">
                  <legend>{dayLabel(d.date, "long")}</legend>
                  <button
                    type="button"
                    className="link danger small"
                    aria-label={`Remove ${dayLabel(d.date, "long")}`}
                    onClick={() => removeDay(d.date)}
                  >
                    Remove
                  </button>
                </div>
                <div className="day-fields">
                  <div className="chips">
                    {!d.eatOut &&
                      members.map((m) => (
                        <label key={m.id} className="chip toggle">
                          <input type="checkbox" checked={d.memberIds.includes(m.id)} onChange={(e) => toggle(d, m.id, e.target.checked)} />
                          {m.name}
                        </label>
                      ))}
                    <label className="chip toggle eat-out">
                      <input type="checkbox" checked={d.eatOut} onChange={(e) => setEatOut(d.date, e.target.checked)} />
                      Eat out
                    </label>
                  </div>
                  {!d.eatOut && (
                    <label className="guests">
                      Guests
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAX_GUESTS}
                        value={d.guests}
                        onChange={(e) => update(d.date, { guests: Math.min(MAX_GUESTS, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                      />
                    </label>
                  )}
                </div>
                {choices && (
                  <label className="meal-field">
                    <span>{d.eatOut ? "Restaurant" : "Meal"}</span>
                    <input
                      list={`${listId}-${d.eatOut ? "restaurants" : "recipes"}`}
                      maxLength={MAX_MEAL_NAME}
                      placeholder={d.eatOut ? "Pick a restaurant or type one" : "Pick a recipe or type a meal"}
                      value={d.meal?.name ?? ""}
                      onChange={(e) => setMeal(d, e.target.value)}
                    />
                    {(d.meal?.recipeId || d.meal?.restaurantId) && (
                      <span className="hint">{d.meal.recipeId ? "From your recipes" : "From your restaurants"}</span>
                    )}
                  </label>
                )}
                <AllergyNote day={d} members={members} />
              </fieldset>
            </li>
          );
        })}
      </ul>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
