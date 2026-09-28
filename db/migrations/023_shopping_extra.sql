-- Items added to a week's shopping list by hand (not from a recipe), e.g. milk or loo roll.
CREATE TABLE shopping_extra (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_id    UUID NOT NULL REFERENCES schedule_week(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    aisle      TEXT NOT NULL,
    added_by   UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shopping_extra_name ON shopping_extra (week_id, lower(name));
