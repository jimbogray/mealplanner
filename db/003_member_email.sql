-- Adds an email column to correlate a signed-in AAD user (userDetails claim)
-- to a family_member row, so the /api/roles function can grant the "admin"
-- SWA role to whoever is marked role='admin' in the household.

ALTER TABLE family_member ADD COLUMN email TEXT;
