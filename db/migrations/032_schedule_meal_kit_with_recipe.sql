-- A meal kit can come with one of the family's recipes (the kit's recipe card), so a day can have both.
ALTER TABLE schedule_day
    DROP CONSTRAINT schedule_day_meal_kit_at_home,
    ADD CONSTRAINT schedule_day_meal_kit_at_home CHECK (NOT meal_kit OR (NOT eat_out AND NOT take_out));
