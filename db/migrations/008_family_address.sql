-- The family's home address (UK style). All null until a Family Manager adds one.

ALTER TABLE family
    ADD COLUMN address_line1 TEXT,
    ADD COLUMN address_line2 TEXT,
    ADD COLUMN address_town  TEXT,
    ADD COLUMN address_county TEXT,
    ADD COLUMN address_postcode TEXT,
    -- From the postcode lookup, for working out travel times; null for a typed-in address.
    ADD COLUMN address_latitude  DOUBLE PRECISION,
    ADD COLUMN address_longitude DOUBLE PRECISION;
