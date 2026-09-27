-- A shorter, everyday name for a member (e.g. "Mum", "Lizzie"), shown around the app instead of
-- their full name when set.

ALTER TABLE family_member ADD COLUMN familiar_name TEXT;
