-- Family meal planner — initial schema (PostgreSQL 15+).
-- Requires the pgvector extension for recipe embeddings.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector

CREATE TABLE household (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    dinner_poll_time TIME NOT NULL DEFAULT '15:00',
    timezone         TEXT NOT NULL DEFAULT 'Europe/London'
);

CREATE TABLE family_member (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id  UUID NOT NULL REFERENCES household(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    phone_e164    TEXT NOT NULL,
    dietary_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (household_id, phone_e164)
);

CREATE TABLE inventory_item (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES household(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    quantity     NUMERIC NOT NULL DEFAULT 1,
    unit         TEXT NOT NULL DEFAULT 'unit',
    category     TEXT NOT NULL DEFAULT 'other',
    expires_on   DATE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_household_idx ON inventory_item (household_id);

CREATE TABLE recipe (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
    steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    source_url  TEXT,
    image_url   TEXT,
    nutrition   JSONB,
    embedding   vector(1536),                 -- text-embedding-3-small dimension
    created_by  TEXT NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai','web','manual')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Approximate nearest-neighbour index for "more like our favourites".
CREATE INDEX recipe_embedding_idx ON recipe USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE recipe_rating (
    member_id UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    recipe_id UUID NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
    score     SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
    cooked_on DATE NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (member_id, recipe_id, cooked_on)
);

CREATE TABLE meal_event (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES household(id) ON DELETE CASCADE,
    date         DATE NOT NULL,
    recipe_id    UUID REFERENCES recipe(id) ON DELETE SET NULL,
    status       TEXT NOT NULL DEFAULT 'polling' CHECK (status IN ('polling','planned','cooked')),
    headcount    INT NOT NULL DEFAULT 0,
    UNIQUE (household_id, date)
);

CREATE TABLE attendance_response (
    meal_event_id UUID NOT NULL REFERENCES meal_event(id) ON DELETE CASCADE,
    member_id     UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    response      TEXT NOT NULL DEFAULT 'pending' CHECK (response IN ('yes','no','pending')),
    responded_at  TIMESTAMPTZ,
    PRIMARY KEY (meal_event_id, member_id)
);

CREATE TABLE sms_log (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction      TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
    from_number    TEXT NOT NULL,
    to_number      TEXT NOT NULL,
    body           TEXT NOT NULL,
    acs_message_id TEXT,
    status         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
