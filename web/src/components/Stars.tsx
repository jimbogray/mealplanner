// Star ratings, shared by recipes and restaurants: each family member rates 1 to 5, and everyone sees the average.

/** The family's average, e.g. "★ 4.5"; nothing when nobody has rated it. */
export function AverageRating({ average, count, className = "tile-average" }: { average: number | null; count: number; className?: string }) {
  if (average === null) return null;
  return (
    <span
      className={className}
      title={`Family average from ${count} ${count === 1 ? "rating" : "ratings"}`}
      aria-label={`Family average ${average} out of 5`}
    >
      ★ {average.toFixed(1)}
    </span>
  );
}

/** The signed-in member's own rating. Pressing their current rating again clears it (0). */
export function StarRating({ mine, onRate }: { mine: number | null; onRate: (stars: number) => void }) {
  return (
    <span className="stars" role="group" aria-label="Your rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={mine !== null && n <= mine ? "star on" : "star"}
          aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
          aria-pressed={mine === n}
          title={mine === n ? "Clear your rating" : `Rate ${n} out of 5`}
          onClick={() => onRate(mine === n ? 0 : n)}
        >
          ★
        </button>
      ))}
    </span>
  );
}
