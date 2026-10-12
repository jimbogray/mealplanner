-- The shopping list is one ongoing list for the family, not one per week: what's added by hand, ticked off
-- or changed belongs to the family. Recipe ingredients still come from the days on the schedule (from today on),
-- and what's in the house stays per day (schedule_have).
-- What's on this week's and later weeks' lists carries over; earlier weeks' lists are done with.

ALTER TABLE shopping_extra ADD COLUMN family_id UUID REFERENCES family(id) ON DELETE CASCADE;
ALTER TABLE shopping_bought ADD COLUMN family_id UUID REFERENCES family(id) ON DELETE CASCADE;
ALTER TABLE shopping_quantity ADD COLUMN family_id UUID REFERENCES family(id) ON DELETE CASCADE;

UPDATE shopping_extra t SET family_id = w.family_id FROM schedule_week w WHERE w.id = t.week_id;
UPDATE shopping_bought t SET family_id = w.family_id FROM schedule_week w WHERE w.id = t.week_id;
UPDATE shopping_quantity t SET family_id = w.family_id FROM schedule_week w WHERE w.id = t.week_id;

DELETE FROM shopping_extra t USING schedule_week w WHERE w.id = t.week_id AND w.starts_on < date_trunc('week', current_date)::date;
DELETE FROM shopping_bought t USING schedule_week w WHERE w.id = t.week_id AND w.starts_on < date_trunc('week', current_date)::date;
DELETE FROM shopping_quantity t USING schedule_week w WHERE w.id = t.week_id AND w.starts_on < date_trunc('week', current_date)::date;

-- The same thing on more than one week's list: keep the earliest week's.
DELETE FROM shopping_extra a USING shopping_extra b, schedule_week wa, schedule_week wb
 WHERE wa.id = a.week_id AND wb.id = b.week_id AND a.family_id = b.family_id AND lower(a.name) = lower(b.name)
   AND (wa.starts_on, a.created_at, a.id) > (wb.starts_on, b.created_at, b.id);
DELETE FROM shopping_bought a USING shopping_bought b, schedule_week wa, schedule_week wb
 WHERE wa.id = a.week_id AND wb.id = b.week_id AND a.family_id = b.family_id AND a.item = b.item AND wa.starts_on > wb.starts_on;
DELETE FROM shopping_quantity a USING shopping_quantity b, schedule_week wa, schedule_week wb
 WHERE wa.id = a.week_id AND wb.id = b.week_id AND a.family_id = b.family_id AND a.item = b.item AND wa.starts_on > wb.starts_on;

DROP INDEX shopping_extra_name;
ALTER TABLE shopping_extra DROP COLUMN week_id, ALTER COLUMN family_id SET NOT NULL;
CREATE UNIQUE INDEX shopping_extra_name ON shopping_extra (family_id, lower(name));

ALTER TABLE shopping_bought DROP COLUMN week_id, ALTER COLUMN family_id SET NOT NULL, ADD PRIMARY KEY (family_id, item);
ALTER TABLE shopping_quantity DROP COLUMN week_id, ALTER COLUMN family_id SET NOT NULL, ADD PRIMARY KEY (family_id, item);
