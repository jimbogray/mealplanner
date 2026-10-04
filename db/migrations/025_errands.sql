-- Errands the family takes turns at (walk the dog, empty the dishwasher…).
CREATE TABLE errand (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id  UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    -- The secret in the public "whose turn" and "next turn" links; a new one breaks the old links.
    link_token TEXT NOT NULL UNIQUE,
    -- Whose turn it is; null (or someone no longer taking part) means the first participant's.
    turn_member_id UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_by UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX errand_family_idx ON errand (family_id);

-- Who takes part, in turn order.
CREATE TABLE errand_participant (
    errand_id UUID NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    position  INT NOT NULL,
    PRIMARY KEY (errand_id, member_id)
);

-- What happened to an errand. Names are copied in so the history still reads right after someone leaves.
CREATE TABLE errand_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Keeps entries in order when two land in the same instant.
    seq         BIGINT GENERATED ALWAYS AS IDENTITY,
    errand_id   UUID NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    action      TEXT NOT NULL CHECK (action IN ('created', 'done', 'turn', 'changed', 'link')),
    -- Whose turn it was, and whose it is now.
    turn_name   TEXT,
    next_name   TEXT,
    -- Who did it in the app; null when it came through the public link.
    by_name     TEXT,
    via_link    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX errand_history_idx ON errand_history (errand_id, seq DESC);
