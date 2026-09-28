-- How many dinners a week the family usually eats out, and has a meal kit. Both start at none.
ALTER TABLE family
    ADD COLUMN eat_outs_per_week INTEGER NOT NULL DEFAULT 0 CHECK (eat_outs_per_week BETWEEN 0 AND 7),
    ADD COLUMN meal_kits_per_week INTEGER NOT NULL DEFAULT 0 CHECK (meal_kits_per_week BETWEEN 0 AND 7);
