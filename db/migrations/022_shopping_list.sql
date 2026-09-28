-- Ingredients read from a recipe's page (once, then kept), for the weekly shopping list.
ALTER TABLE favourite_recipe ADD COLUMN ingredients_read_at TIMESTAMPTZ;

CREATE TABLE recipe_ingredient (
    recipe_id UUID NOT NULL REFERENCES favourite_recipe(id) ON DELETE CASCADE,
    position  INT NOT NULL,
    name      TEXT NOT NULL,
    quantity  TEXT,
    aisle     TEXT NOT NULL,
    PRIMARY KEY (recipe_id, position)
);

-- Ingredients of a day's recipe already in the house, so they stay off the shopping list.
-- Keyed by recipe too, so picking a different recipe starts afresh.
CREATE TABLE schedule_have (
    week_id   UUID NOT NULL,
    day       DATE NOT NULL,
    recipe_id UUID NOT NULL REFERENCES favourite_recipe(id) ON DELETE CASCADE,
    item      TEXT NOT NULL,
    PRIMARY KEY (week_id, day, recipe_id, item),
    FOREIGN KEY (week_id, day) REFERENCES schedule_day(week_id, day) ON DELETE CASCADE
);

-- Shopping list items ticked off as bought, per week.
CREATE TABLE shopping_bought (
    week_id UUID NOT NULL REFERENCES schedule_week(id) ON DELETE CASCADE,
    item    TEXT NOT NULL,
    PRIMARY KEY (week_id, item)
);
