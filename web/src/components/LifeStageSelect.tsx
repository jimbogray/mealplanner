import { LIFE_STAGE_LABELS, LIFE_STAGES, type LifeStage } from "@mealplanner/shared";

export function LifeStageSelect({
  value,
  onChange,
  id,
  disabled,
  label = "Life stage",
}: {
  value: LifeStage;
  onChange: (value: LifeStage) => void;
  id?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <select id={id} aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as LifeStage)}>
      {LIFE_STAGES.slice()
        .reverse()
        .map((stage) => (
          <option key={stage} value={stage}>
            {LIFE_STAGE_LABELS[stage]}
          </option>
        ))}
    </select>
  );
}

export function LifeStageBadge({ stage }: { stage: LifeStage }) {
  return <span className={`badge stage-${stage}`}>{LIFE_STAGE_LABELS[stage].replace(/ \(.*\)$/, "")}</span>;
}
