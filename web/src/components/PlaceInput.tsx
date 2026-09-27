// An address box that suggests places as you type (restaurants, cafés, streets, ZIP codes), nearest home first.
import type { AddressSuggestion } from "@mealplanner/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/** What was picked from the suggestions: sent with the save so the API can look up where it is. */
export interface PickedPlace {
  placeId: string;
  sessionToken: string;
}

/**
 * A text box whose value can be typed freely; with `search` on, matching places are listed underneath
 * and picking one fills the box and reports the pick. Typing again after a pick drops it.
 */
export function PlaceInput({
  id,
  value,
  onChange,
  search,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string, picked: PickedPlace | null) => void;
  search: boolean;
  className?: string;
}) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[] | null>(null);
  const [typed, setTyped] = useState(false);
  const session = useRef(crypto.randomUUID());
  const latest = useRef(0);

  useEffect(() => {
    const query = value.trim();
    if (!search || !typed || query.length < 3) {
      setSuggestions(null);
      return;
    }
    const n = ++latest.current;
    const timer = setTimeout(() => {
      api.searchRestaurantAddress({ input: query, sessionToken: session.current }).then(
        (res) => n === latest.current && setSuggestions(res.suggestions),
        // Suggestions are a convenience: if they fail, the address can still be typed.
        () => n === latest.current && setSuggestions(null),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [value, typed, search]);

  function pick(s: AddressSuggestion) {
    onChange([s.text, s.secondaryText].filter(Boolean).join(", "), { placeId: s.placeId, sessionToken: session.current });
    setTyped(false);
    setSuggestions(null);
    // The next search is a new Google session.
    session.current = crypto.randomUUID();
  }

  return (
    <div className="address-search">
      <input
        id={id}
        className={className}
        value={value}
        onChange={(e) => {
          setTyped(true);
          onChange(e.target.value, null);
        }}
        onKeyDown={(e) => e.key === "Escape" && setSuggestions(null)}
        maxLength={200}
        autoComplete="off"
        placeholder={search ? "Start typing the address, ZIP code or restaurant name" : undefined}
      />
      {suggestions && suggestions.length > 0 && (
        <ul className="suggestions" aria-label="Matching places">
          {suggestions.map((s) => (
            <li key={s.placeId}>
              <button type="button" onClick={() => pick(s)}>
                <strong>{s.text}</strong>
                {s.secondaryText && <span className="note small">{s.secondaryText}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
