-- A day's dinner can be a meal kit (eating in), optionally with which one in meal_name.
ALTER TABLE schedule_day
    ADD COLUMN meal_kit BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT schedule_day_meal_kit_at_home CHECK (NOT meal_kit OR (NOT eat_out AND meal_recipe_id IS NULL));
