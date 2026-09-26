import { MAX_GUESTS, mondayOf, nextWeekToAdd, weekDays, type FamilyMember, type ScheduleDay, type ScheduleWeek } from "@mealplanner/shared";
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
            days={weekDays(adding).map((date) => ({ date, memberIds: members.map((m) => m.id), guests: 0 }))}
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
        <Week key={w.startsOn} week={w} members={members} isCurrent={w.startsOn === thisWeek} onChange={replace} onRemove={() => void remove(w)} />
      ))}
      {past.length > 0 && (
        <details className="past-weeks">
          <summary>Earlier weeks ({past.length})</summary>
          <div className="stack">
            {past.map((w) => (
              <Week key={w.startsOn} week={w} members={members} isCurrent={false} onChange={replace} onRemove={() => void remove(w)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Week({
  week,
  members,
  isCurrent,
  onChange,
  onRemove,
}: {
  week: ScheduleWeek;
  members: FamilyMember[];
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
          days={week.days}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSave={async (days) => {
            // Only send the days that changed.
            const changed = days.filter((d, i) => !sameDay(d, week.days[i]));
            const saved = await Promise.all(changed.map((d) => api.updateDay(week.startsOn, d.date, { memberIds: d.memberIds, guests: d.guests })));
            onChange({ ...week, days: week.days.map((d) => saved.find((s) => s.date === d.date) ?? d) });
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
        {isCurrent && <span className="note small">from {dayLabel(week.startsOn)}</span>}
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
          <li key={d.date}>
            <span className="day-name">{dayLabel(d.date)}</span>
            <span className="diners">{dinersSummary(d, members)}</span>
            <span className="diner-count">{d.memberIds.length + d.guests} for dinner</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sameDay(a: ScheduleDay, b: ScheduleDay): boolean {
  return a.guests === b.guests && a.memberIds.length === b.memberIds.length && a.memberIds.every((id) => b.memberIds.includes(id));
}

function dinersSummary(day: ScheduleDay, members: FamilyMember[]): string {
  const joining = members.filter((m) => day.memberIds.includes(m.id));
  const names = joining.length === members.length && members.length > 1 ? "Everyone" : joining.map((m) => m.name).join(", ");
  const guests = day.guests ? `${day.guests} ${day.guests === 1 ? "guest" : "guests"}` : "";
  return [names, guests].filter(Boolean).join(" + ") || "No one";
}

/** A week's days, each with who's joining for dinner (tick boxes) and a number of guests. */
function WeekForm({
  title,
  members,
  days: initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  title: string;
  members: FamilyMember[];
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

  async function submit(e: FormEvent) {
    e.preventDefault();
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
        <p className="hint">Tick who's joining for dinner each day, and add any guests.</p>
      </div>
      <ul className="day-form">
        {days.map((d) => (
          <li key={d.date}>
            <fieldset>
              <legend>{dayLabel(d.date, "long")}</legend>
              <div className="day-fields">
                <div className="chips">
                  {members.map((m) => (
                    <label key={m.id} className="chip">
                      <input type="checkbox" checked={d.memberIds.includes(m.id)} onChange={(e) => toggle(d, m.id, e.target.checked)} />
                      {m.name}
                    </label>
                  ))}
                </div>
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
              </div>
            </fieldset>
          </li>
        ))}
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
