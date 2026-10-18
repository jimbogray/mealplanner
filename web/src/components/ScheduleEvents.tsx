// Events on the schedule (a match, a work do): who's going and when, one-off or every week.
import { addDays, displayName, eventOn, MAX_EVENT_TITLE, repeatsOn, type FamilyMember, type ScheduleEvent } from "@mealplanner/shared";
import { createContext, useContext, useState } from "react";
import { api } from "../api";
import { ErrorNote, errorMessage } from "./Field";

interface EventsState {
  events: ScheduleEvent[];
  setEvents: (update: (list: ScheduleEvent[]) => ScheduleEvent[]) => void;
  members: FamilyMember[];
}

export const EventsContext = createContext<EventsState>({ events: [], setEvents: () => {}, members: [] });

/** "17:30" in the person's own clock style, e.g. "5:30 PM". */
function clock(time: string): string {
  return new Date(`2000-01-01T${time}:00`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Every 15 minutes of the day, "00:00" to "23:45". */
const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

/** An hour after `start`, or the last time of the day if that's sooner. */
function anHourAfter(start: string): string {
  const [h, m] = start.split(":").map(Number);
  const later = `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return TIMES.find((t) => t >= later) ?? TIMES.at(-1)!;
}

/**
 * A time of day in 15-minute steps (plus `value` itself, if an older event isn't on a step). `after` leaves out
 * that time and everything before it, and `before` everything from that time on.
 */
function TimeSelect({
  value,
  onChange,
  label,
  after,
  before,
}: {
  value: string;
  onChange: (time: string) => void;
  label: string;
  after?: string;
  before?: string;
}) {
  const steps = TIMES.filter((t) => (!after || t > after) && (!before || t < before));
  const times = steps.includes(value) ? steps : [...steps, value].sort();
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {times.map((t) => (
        <option key={t} value={t}>
          {clock(t)}
        </option>
      ))}
    </select>
  );
}

function who(event: ScheduleEvent, members: FamilyMember[]): string {
  const going = members.filter((m) => event.memberIds.includes(m.id));
  return going.length === members.length && members.length > 1 ? "Everyone" : going.map(displayName).join(", ");
}

/** `showWeekly` marks a repeating event, for when it's being edited; the week view leaves it off. */
function EventLine({ event, showWeekly = false }: { event: ScheduleEvent; showWeekly?: boolean }) {
  const { members } = useContext(EventsContext);
  return (
    <span className="event-line">
      <strong>{event.title}</strong> {clock(event.startTime)}–{clock(event.endTime)}
      {who(event, members) && <> · {who(event, members)}</>}
      {showWeekly && event.weekly && <span className="event-weekly"> · weekly</span>}
    </span>
  );
}

/** The events on a day, in time order; `editable` adds buttons to add, change and remove them. */
export function DayEvents({ date, editable = false }: { date: string; editable?: boolean }) {
  const { events, setEvents } = useContext(EventsContext);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // While editing, a weekly event skipped this week still shows, so it can be brought back.
  const today = events
    .filter((e) => (editable ? repeatsOn(e, date) : eventOn(e, date)))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  if (!editable) {
    if (!today.length) return null;
    return (
      <span className="day-events">
        {today.map((e) => (
          <EventLine key={e.id} event={e} />
        ))}
      </span>
    );
  }

  /** A one-off event, or a weekly one on its first day, is deleted; a later week stops it repeating from then on. */
  async function remove(event: ScheduleEvent) {
    const fromHere = event.weekly && date > event.date;
    const question = fromHere ? `Remove "${event.title}" from this week on?` : `Remove "${event.title}"${event.weekly ? " from every week" : ""}?`;
    if (!window.confirm(question)) return;
    setError(null);
    try {
      if (fromHere) {
        const updated = await api.updateEvent(event.id, { until: addDays(date, -1) });
        setEvents((list) => list.map((e) => (e.id === event.id ? updated : e)));
      } else {
        await api.removeEvent(event.id);
        setEvents((list) => list.filter((e) => e.id !== event.id));
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** Skips a weekly event for just this week, or brings it back. */
  async function skip(event: ScheduleEvent, skipped: boolean) {
    setError(null);
    try {
      const updated = skipped ? await api.skipEvent(event.id, date) : await api.unskipEvent(event.id, date);
      setEvents((list) => list.map((e) => (e.id === event.id ? updated : e)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="day-events editable">
      {today.map((e) =>
        e.skipped.includes(date) ? (
          <div key={e.id} className="event-row skipped">
            <span className="event-line">
              <s>{e.title}</s> skipped this week
            </span>
            <span className="event-actions">
              <button type="button" className="link small" onClick={() => void skip(e, false)}>
                Bring back
              </button>
            </span>
          </div>
        ) : editing === e.id ? (
          <EventForm key={e.id} date={date} event={e} onDone={() => setEditing(null)} />
        ) : (
          <div key={e.id} className="event-row">
            <EventLine event={e} showWeekly />
            <span className="event-actions">
              <button type="button" className="link small" onClick={() => setEditing(e.id)}>
                Edit
              </button>
              {e.weekly && (
                <button type="button" className="link small" onClick={() => void skip(e, true)}>
                  Skip this week
                </button>
              )}
              <button type="button" className="link danger small" onClick={() => void remove(e)}>
                Remove
              </button>
            </span>
          </div>
        ),
      )}
      <ErrorNote error={error} />
      {editing === "new" ? (
        <EventForm date={date} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="link small add-event" onClick={() => setEditing("new")}>
          + Add event
        </button>
      )}
    </div>
  );
}

/**
 * Adds an event on `date`, or changes `event` (every week of it, if it's weekly). It's saved straight away,
 * separately from the week's form.
 */
function EventForm({ date, event, onDone }: { date: string; event?: ScheduleEvent; onDone: () => void }) {
  const { members, setEvents } = useContext(EventsContext);
  const [title, setTitle] = useState(event?.title ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(event?.memberIds ?? []);
  const [startTime, setStartTime] = useState(event?.startTime ?? "17:00");
  const [endTime, setEndTime] = useState(event?.endTime ?? "18:00");
  const [weekly, setWeekly] = useState(event?.weekly ?? false);
  /** A new start leaves the end alone while it's still later; otherwise the end moves to an hour after. */
  function changeStart(time: string) {
    setStartTime(time);
    if (endTime <= time) setEndTime(anHourAfter(time));
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) return setError("Give the event a name.");
    if (!memberIds.length) return setError("Choose who's going.");
    if (endTime <= startTime) return setError("The event has to end after it starts.");
    setSaving(true);
    setError(null);
    try {
      const body = { title, startTime, endTime, memberIds, weekly };
      const saved = event ? await api.updateEvent(event.id, body) : await api.addEvent({ ...body, date });
      setEvents((list) => (event ? list.map((x) => (x.id === event.id ? saved : x)) : [...list, saved]));
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  // Not a <form> of its own, as it sits inside the week's form: Enter saves the event rather than the week.
  return (
    <div
      className="event-form"
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "checkbox") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <label className="event-title">
        <span>Event</span>
        <input
          autoFocus
          maxLength={MAX_EVENT_TITLE}
          placeholder="e.g. Football practice, work dinner"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="chips" role="group" aria-label="Who's going">
        {members.map((m) => (
          <label key={m.id} className="chip toggle">
            <input
              type="checkbox"
              checked={memberIds.includes(m.id)}
              onChange={(e) => setMemberIds((ids) => (e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id)))}
            />
            {displayName(m)}
          </label>
        ))}
      </div>
      <div className="event-times">
        <label>
          From <TimeSelect label="Start time" value={startTime} onChange={changeStart} before={TIMES.at(-1)} />
        </label>
        <label>
          to <TimeSelect label="End time" value={endTime} onChange={setEndTime} after={startTime} />
        </label>
        <label className="chip toggle weekly">
          <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
          Every week
        </label>
      </div>
      {event?.weekly && <p className="hint">Changes apply to every week of this event.</p>}
      <ErrorNote error={error} />
      <div className="row">
        <button type="button" className="small" disabled={saving} onClick={() => void save()}>
          {event ? "Save event" : "Add event"}
        </button>
        <button type="button" className="secondary small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
