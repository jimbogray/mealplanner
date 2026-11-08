-- Ingredients added to the shopping list from a recipe link carry the recipe's amounts (e.g. "500 g"); adding
-- another recipe that needs the same thing adds its amount too. Things added by hand have none.
ALTER TABLE shopping_extra ADD COLUMN quantities TEXT[] NOT NULL DEFAULT '{}';
