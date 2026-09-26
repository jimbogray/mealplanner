-- Marks recipes the family has already cooked. Only Family Managers (admins) can change it.
ALTER TABLE favourite_recipe ADD COLUMN prepared BOOLEAN NOT NULL DEFAULT false;
