import { daysToPlan, MAX_GUESTS, mondayOf, nextWeekToAdd, weekDays, type FamilyMember, type ScheduleDay, type ScheduleWeek } from "@mealplanner/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNote, errorMessage } from "../components/Field";
import { useSession } from "../session";

/** The family's weekly schedule: who's in for dinner each day, Monday to Sunday. */
export function SchedulePage() {
  const { me } = useSession();
  if (!me) return null;
  if (!me.family) return <Navigate to="/family" replace />;
  return <Schedule members={me.members} />;
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

function Schedule({ members }: { members: FamilyMember[] }) {
  const [weeks, setWeeks] = useState<ScheduleWeek[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = localToday();
  const thisWeek = mondayOf(today);

  useEffect(() => {
    api.weeks().then(setWeeks, (err) => setError(errorMessage(err)));
  }, []);

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
        <p className="note">Who's in for dinner each day. Weeks run Monday to Sunday; anyone in the family can change them.</p>
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
            dates={daysToPlan(adding, today)}
            days={daysToPlan(adding, today).map((date) => everyone(date, members))}
            submitLabel="Add week"
            onCancel={() => setAdding(null)}
            onSave={async (days) => {
              const week = await api.addWeek({ startsOn: adding, today, days });
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
              <Week key={w.startsOn} week={w} members={members} today={today} isCurrent={false} onChange={replace} onRemove={() => void remove(w)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** A day with the whole family joining and no guests. */
function everyone(date: string, members: FamilyMember[]): ScheduleDay {
  return { date, eatOut: false, memberIds: members.map((m) => m.id), guests: 0 };
}

function Week({
  week,
  members,
  today,
  isCurrent,
  onChange,
  onRemove,
}: {
  week: ScheduleWeek;
  members: FamilyMember[];
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
            const saved = await Promise.all(changed.map((d) => api.updateDay(week.startsOn, d.date, { eatOut: d.eatOut, memberIds: d.memberIds, guests: d.guests })));
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
            <span className="diners">{dinersSummary(d, members)}</span>
            <span className="diner-count">{d.eatOut ? "" : `${d.memberIds.length + d.guests} for dinner`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sameDay(a: ScheduleDay, b: ScheduleDay): boolean {
  return a.eatOut === b.eatOut && a.guests === b.guests && a.memberIds.length === b.memberIds.length && a.memberIds.every((id) => b.memberIds.includes(id));
}

function dinersSummary(day: ScheduleDay, members: FamilyMember[]): string {
  if (day.eatOut) return "Eating out";
  const joining = members.filter((m) => day.memberIds.includes(m.id));
  const names = joining.length === members.length && members.length > 1 ? "Everyone" : joining.map((m) => m.name).join(", ");
  const guests = day.guests ? `${day.guests} ${day.guests === 1 ? "guest" : "guests"}` : "";
  return [names, guests].filter(Boolean).join(" + ") || "No one";
}

/**
 * A week's days, each with who's joining for dinner (toggle pills) and a number of guests.
 * Any of `dates` can be taken out of the schedule, or put back in; saving passes the days still in it.
 */
function WeekForm({
  title,
  members,
  dates,
  days: initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  title: string;
  members: FamilyMember[];
  dates: string[];
  days: ScheduleDay[];
  submitLabel: string;
  onSave: (days: ScheduleDay[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [days, setDays] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(date: string, change: Partial<ScheduleDay>) {
    setDays((list) => list.map((d) => (d.date === date ? { ...d, ...change } : d)));
  }

  function toggle(day: ScheduleDay, memberId: string, joining: boolean) {
    update(day.date, { memberIds: joining ? [...day.memberIds, memberId] : day.memberIds.filter((id) => id !== memberId) });
  }

  /** Eating out takes everyone and any guests off that day; eating in again starts from the whole family. */
  function setEatOut(date: string, eatOut: boolean) {
    update(date, eatOut ? { eatOut, memberIds: [], guests: 0 } : { eatOut, memberIds: members.map((m) => m.id), guests: 0 });
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
        <p className="hint">Tap who's joining for dinner each day, and add any guests.</p>
      </div>
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
