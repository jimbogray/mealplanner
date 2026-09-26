-- A family's favourite recipes, each a link to a recipe page on the web.
-- (003 is left for PR #6's diet and allergy fields.)

CREATE TABLE favourite_recipe (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id  UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    -- Filled from the page's metadata when it's added; falls back to the URL.
    title      TEXT NOT NULL,
    image_url  TEXT,
    site_name  TEXT,
    added_by   UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (family_id, url)
);
