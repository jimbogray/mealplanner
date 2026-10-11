-- Take-out: the family eats at home (who's joining and guests as usual) with food from a restaurant.
ALTER TABLE schedule_day
    ADD COLUMN take_out BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT schedule_day_out_or_take_out CHECK (NOT (eat_out AND take_out)),
    DROP CONSTRAINT schedule_day_recipe_at_home,
    ADD CONSTRAINT schedule_day_recipe_at_home CHECK (NOT (eat_out OR take_out) OR meal_recipe_id IS NULL),
    DROP CONSTRAINT schedule_day_restaurant_out,
    ADD CONSTRAINT schedule_day_restaurant_out CHECK (eat_out OR take_out OR meal_restaurant_id IS NULL),
    DROP CONSTRAINT schedule_day_meal_kit_at_home,
    ADD CONSTRAINT schedule_day_meal_kit_at_home CHECK (NOT meal_kit OR (NOT eat_out AND NOT take_out AND meal_recipe_id IS NULL));
