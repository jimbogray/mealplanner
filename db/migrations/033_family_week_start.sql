-- A family's weeks can start on Sunday instead of Monday. Changing it regroups the family's days into weeks
-- starting on the new day, so a day's diners, working from home and "have" items follow it to its new week.
ALTER TABLE family
    ADD COLUMN week_starts_on TEXT NOT NULL DEFAULT 'monday' CHECK (week_starts_on IN ('monday', 'sunday'));

ALTER TABLE schedule_week
    DROP CONSTRAINT schedule_week_starts_on_check,
    ADD CONSTRAINT schedule_week_starts_on_check CHECK (EXTRACT(isodow FROM starts_on) IN (1, 7));

ALTER TABLE schedule_diner
    DROP CONSTRAINT schedule_diner_week_id_day_fkey,
    ADD CONSTRAINT schedule_diner_week_id_day_fkey FOREIGN KEY (week_id, day) REFERENCES schedule_day(week_id, day) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE schedule_wfh
    DROP CONSTRAINT schedule_wfh_week_id_day_fkey,
    ADD CONSTRAINT schedule_wfh_week_id_day_fkey FOREIGN KEY (week_id, day) REFERENCES schedule_day(week_id, day) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE schedule_have
    DROP CONSTRAINT schedule_have_week_id_day_fkey,
    ADD CONSTRAINT schedule_have_week_id_day_fkey FOREIGN KEY (week_id, day) REFERENCES schedule_day(week_id, day) ON DELETE CASCADE ON UPDATE CASCADE;
