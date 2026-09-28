import type { FamilyPreferences } from "@mealplanner/shared";
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

function perWeek(n: number): string {
  return n === 0 ? "None" : `${n} a week`;
}

function CountSelect({ id, value, max, disabled, onChange }: { id: string; value: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: max + 1 }, (_, n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

/** The family's preferences: usual dinner times (mid-week and weekend, both optional), and eat-outs and meal kits a week. */
export function PreferencesCard({ prefs, isAdmin }: { prefs: FamilyPreferences; isAdmin: boolean }) {
  const [editing, setEditing] = useState(false);
  const times = prefs.dinnerTimes;
  const notSet = <span className="note">Not set</span>;

  return (
    <section className="card">
      <h2>Preferences</h2>
      {editing ? (
        <PreferencesForm prefs={prefs} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="preferences">
            <dt>Mid-week dinner</dt>
            <dd>{times.weekday ? showTime(times.weekday) : notSet}</dd>
            <dt>Weekend dinner</dt>
            <dd>{times.weekend ? showTime(times.weekend) : notSet}</dd>
            <dt>Eating out</dt>
            <dd>{perWeek(prefs.eatOutsPerWeek)}</dd>
            <dt>Meal kits</dt>
            <dd>{perWeek(prefs.mealKitsPerWeek)}</dd>
          </dl>
          {isAdmin ? (
            <div className="row">
              <button className="secondary" onClick={() => setEditing(true)}>
                Change preferences
              </button>
            </div>
          ) : (
            <p className="note small">A Family Manager can change these.</p>
          )}
        </>
      )}
    </section>
  );
}

function PreferencesForm({ prefs, onDone }: { prefs: FamilyPreferences; onDone: () => void }) {
  const { refresh } = useSession();
  const times = prefs.dinnerTimes;
  // A time saved before the half-hour choices (e.g. 18:15) starts as "Not set".
  const [weekday, setWeekday] = useState(TIME_CHOICES.includes(times.weekday ?? "") ? times.weekday! : "");
  const [weekend, setWeekend] = useState(TIME_CHOICES.includes(times.weekend ?? "") ? times.weekend! : "");
  const [eatOuts, setEatOuts] = useState(prefs.eatOutsPerWeek);
  const [mealKits, setMealKits] = useState(prefs.mealKitsPerWeek);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.setPreferences({
        dinnerTimes: { weekday: weekday || null, weekend: weekend || null },
        eatOutsPerWeek: eatOuts,
        mealKitsPerWeek: mealKits,
      });
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
      <Field label="Eat out per week" htmlFor="eat-outs">
        <CountSelect id="eat-outs" value={eatOuts} max={7 - mealKits} disabled={saving} onChange={setEatOuts} />
      </Field>
      <Field label="Meal kits per week" htmlFor="meal-kits">
        <CountSelect id="meal-kits" value={mealKits} max={7 - eatOuts} disabled={saving} onChange={setMealKits} />
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
