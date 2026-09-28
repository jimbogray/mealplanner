import type { DinnerTimes } from "@mealplanner/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useSession } from "../session";
import { ErrorNote, errorMessage, Field } from "./Field";

/** "18:30" → "6:30 PM" (in the browser's own style of 12-hour time). */
function showTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Dinner time choices: every half hour from 12:00 PM to 11:00 PM. */
const TIME_CHOICES = Array.from({ length: 23 }, (_, i) => `${String(12 + Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);

function TimeSelect({ id, value, disabled, onChange }: { id: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not set</option>
      {TIME_CHOICES.map((t) => (
        <option key={t} value={t}>
          {showTime(t)}
        </option>
      ))}
    </select>
  );
}

/** The family's usual dinner times, mid-week (Monday to Friday) and weekend. Both optional. */
export function DinnerTimesCard({ times, isAdmin }: { times: DinnerTimes; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const hasAny = times.weekday !== null || times.weekend !== null;

  return (
    <section className="card">
      <h2>Dinner times</h2>
      {editing ? (
        <DinnerTimesForm times={times} onDone={() => setEditing(false)} />
      ) : (
        <>
          {hasAny ? (
            <dl className="dinner-times">
              <dt>Mid-week</dt>
              <dd>{times.weekday ? showTime(times.weekday) : <span className="note">Not set</span>}</dd>
              <dt>Weekend</dt>
              <dd>{times.weekend ? showTime(times.weekend) : <span className="note">Not set</span>}</dd>
            </dl>
          ) : (
            <p className="note">
              {isAdmin ? "Add when you usually have dinner, if you like." : "No usual dinner times yet. A Family Manager can add them."}
            </p>
          )}
          {isAdmin && (
            <div className="row">
              <button className={hasAny ? "secondary" : undefined} onClick={() => setEditing(true)}>
                {hasAny ? "Change times" : "Add times"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function DinnerTimesForm({ times, onDone }: { times: DinnerTimes; onDone: () => void }) {
  const { refresh } = useSession();
  // A time saved before the half-hour choices (e.g. 18:15) starts as "Not set".
  const [weekday, setWeekday] = useState(TIME_CHOICES.includes(times.weekday ?? "") ? times.weekday! : "");
  const [weekend, setWeekend] = useState(TIME_CHOICES.includes(times.weekend ?? "") ? times.weekend! : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.setDinnerTimes({ weekday: weekday || null, weekend: weekend || null });
      await refresh();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form className="stack" onSubmit={(e) => void save(e)}>
      <Field label="Mid-week dinner" htmlFor="dinner-weekday" hint="Monday to Friday. Optional.">
        <TimeSelect id="dinner-weekday" value={weekday} disabled={saving} onChange={setWeekday} />
      </Field>
      <Field label="Weekend dinner" htmlFor="dinner-weekend" hint="Saturday and Sunday. Optional.">
        <TimeSelect id="dinner-weekend" value={weekend} disabled={saving} onChange={setWeekend} />
      </Field>
      <ErrorNote error={error} />
      <div className="row">
        <button type="submit" disabled={saving}>
          Save
        </button>
        <button type="button" className="secondary" disabled={saving} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
