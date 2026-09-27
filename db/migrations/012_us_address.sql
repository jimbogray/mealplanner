-- The family's home address is a US address: city, two-letter state and ZIP code
-- instead of the UK's town, county and postcode.

-- A UK address saved before the switch can't be shown the US way, so it's removed
-- (a Family Manager adds the home address again with the US search).
UPDATE family
   SET address_line1 = NULL, address_line2 = NULL, address_town = NULL, address_county = NULL,
       address_postcode = NULL, address_latitude = NULL, address_longitude = NULL
 WHERE address_postcode IS NOT NULL AND address_postcode !~ '^[0-9]{5}$';

ALTER TABLE family RENAME COLUMN address_town TO address_city;
ALTER TABLE family RENAME COLUMN address_county TO address_state;
ALTER TABLE family RENAME COLUMN address_postcode TO address_zip;
