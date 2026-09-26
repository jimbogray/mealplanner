-- Sign in with Google. A login can have a password, a Google account, or both.

ALTER TABLE app_user ALTER COLUMN password_hash DROP NOT NULL;
-- Google's stable account id (the ID token's "sub" claim).
ALTER TABLE app_user ADD COLUMN google_sub TEXT UNIQUE;
ALTER TABLE app_user ADD CONSTRAINT app_user_has_credential CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);
