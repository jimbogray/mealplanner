-- A family's favourite restaurants.

CREATE TABLE restaurant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id   UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- The restaurant's website, menu or map listing.
    url         TEXT,
    notes       TEXT,
    -- Where it is: typed in, or found on the map by name near the family's home.
    address     TEXT,
    latitude    DOUBLE PRECISION,
    longitude   DOUBLE PRECISION,
    -- Driving time from the family's home when the restaurant was added (or its address changed).
    drive_minutes INTEGER CHECK (drive_minutes > 0),
    added_by    UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX restaurant_family_name ON restaurant (family_id, lower(name));
