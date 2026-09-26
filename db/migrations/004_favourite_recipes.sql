-- A family's favourite recipes, each a link to a recipe page on the web.

CREATE TABLE favourite_recipe (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id       UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    -- Read from the page by an LLM when it's added, or typed in when that isn't possible.
    name            TEXT NOT NULL,
    description     TEXT,
    cooking_minutes INTEGER CHECK (cooking_minutes > 0),
    main_protein    TEXT,
    -- From the page's metadata.
    image_url       TEXT,
    site_name       TEXT,
    added_by        UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (family_id, url)
);
