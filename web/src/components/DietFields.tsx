import { ALLERGEN_LABELS, ALLERGENS, DIET_LABELS, DIETS, type Allergen, type Diet } from "@mealplanner/shared";

export function DietFields({
  diet,
  allergies,
  onDiet,
  onAllergies,
  idPrefix,
}: {
  diet: Diet;
  allergies: Allergen[];
  onDiet: (diet: Diet) => void;
  onAllergies: (allergies: Allergen[]) => void;
  idPrefix: string;
}) {
  function toggle(a: Allergen, on: boolean) {
    onAllergies(ALLERGENS.filter((x) => (x === a ? on : allergies.includes(x))));
  }
  return (
    <div className="diet-fields">
      <fieldset>
        <legend>Diet</legend>
        <div className="chips">
          {DIETS.map((d) => (
            <label key={d} className="chip">
              <input type="radio" name={`${idPrefix}-diet`} value={d} checked={diet === d} onChange={() => onDiet(d)} />
              {DIET_LABELS[d]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Allergies</legend>
        <div className="chips">
          {ALLERGENS.map((a) => (
            <label key={a} className="chip">
              <input type="checkbox" checked={allergies.includes(a)} onChange={(e) => toggle(a, e.target.checked)} />
              {ALLERGEN_LABELS[a]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** One line such as "Vegan · Allergic to peanuts, sesame", or null when there's nothing to say. */
export function dietSummary(diet: Diet, allergies: Allergen[]): string | null {
  const parts: string[] = [];
  if (diet !== "none") parts.push(DIET_LABELS[diet]);
  if (allergies.length) parts.push(`Allergic to ${allergies.map((a) => ALLERGEN_LABELS[a].toLowerCase()).join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}
