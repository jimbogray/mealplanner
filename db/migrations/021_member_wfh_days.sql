-- The weekdays an adult usually works from home (1 = Monday … 5 = Friday); new schedule weeks start from these.
ALTER TABLE family_member
    ADD COLUMN wfh_days SMALLINT[] NOT NULL DEFAULT '{}' CHECK (wfh_days <@ ARRAY[1, 2, 3, 4, 5]::smallint[]);
