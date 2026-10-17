-- Each time the family cooks a recipe, pressed on its tile. The date is null for a recipe marked as prepared
-- before dates were kept. (Days on the schedule with the recipe as the meal also count once they've passed;
-- those are read from schedule_day, not stored here.)
CREATE TABLE recipe_preparation (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id   UUID NOT NULL REFERENCES favourite_recipe(id) ON DELETE CASCADE,
    prepared_on DATE,
    added_by    UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recipe_preparation_recipe_idx ON recipe_preparation (recipe_id);

INSERT INTO recipe_preparation (recipe_id) SELECT id FROM favourite_recipe WHERE prepared;
ALTER TABLE favourite_recipe DROP COLUMN prepared;
