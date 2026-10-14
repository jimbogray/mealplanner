-- Recipes typed in by hand, with no page on the web: the link is optional, and the ingredients and method are
-- kept as typed. (A recipe from a link still has its ingredients read from its page, and no method.)

ALTER TABLE favourite_recipe
    ALTER COLUMN url DROP NOT NULL,
    ADD COLUMN ingredients_text TEXT,
    ADD COLUMN method TEXT;
