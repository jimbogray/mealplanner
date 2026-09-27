-- What's for dinner each day: one of the family's recipes (eating in), one of its restaurants (eating out),
-- or just typed in. meal_name is kept if the recipe or restaurant is later removed.
ALTER TABLE schedule_day
    ADD COLUMN meal_name          TEXT,
    ADD COLUMN meal_recipe_id     UUID REFERENCES favourite_recipe(id) ON DELETE SET NULL,
    ADD COLUMN meal_restaurant_id UUID REFERENCES restaurant(id) ON DELETE SET NULL,
    ADD CONSTRAINT schedule_day_meal_named CHECK (meal_name IS NOT NULL OR (meal_recipe_id IS NULL AND meal_restaurant_id IS NULL)),
    ADD CONSTRAINT schedule_day_recipe_at_home CHECK (NOT eat_out OR meal_recipe_id IS NULL),
    ADD CONSTRAINT schedule_day_restaurant_out CHECK (eat_out OR meal_restaurant_id IS NULL);
