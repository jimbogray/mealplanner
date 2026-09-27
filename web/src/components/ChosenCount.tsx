// How many times a recipe or restaurant has been picked as a day's meal on the schedule, e.g. "3x".

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function ChosenCount({ dates }: { dates: string[] }) {
  const n = dates.length;
  const title = n ? `On the schedule ${n} ${n === 1 ? "time" : "times"}: ${dates.map(dayLabel).join(", ")}` : "Not on the schedule yet";
  return (
    <span className={n ? "chosen-count" : "chosen-count none"} title={title} aria-label={title}>
      {n}x
    </span>
  );
}
