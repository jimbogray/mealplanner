-- Families, members, logins and invites (PostgreSQL 13+ for built-in gen_random_uuid).

CREATE TYPE life_stage AS ENUM ('baby', 'toddler', 'child', 'teenager', 'adult');

-- A login. Only people who sign up themselves have one; a baby or toddler is
-- a family_member without an app_user.
CREATE TABLE app_user (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_idx ON app_user (lower(email));

CREATE TABLE family (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE family_member (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id  UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    -- A login belongs to at most one family for now.
    user_id    UUID UNIQUE REFERENCES app_user(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    life_stage life_stage NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX family_member_family_idx ON family_member (family_id);

-- Opaque bearer tokens; only a SHA-256 of the token is stored.
CREATE TABLE session (
    token_hash TEXT PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX session_user_idx ON session (user_id);

-- Shareable invite links. Each code can be used once.
CREATE TABLE invite (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id   UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    code        TEXT NOT NULL UNIQUE,
    created_by  UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_by UUID REFERENCES family_member(id) ON DELETE SET NULL,
    accepted_at TIMESTAMPTZ
);
CREATE INDEX invite_family_idx ON invite (family_id);
