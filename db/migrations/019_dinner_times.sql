-- The family's usual dinner times, optional: Monday to Friday, and Saturday and Sunday.
ALTER TABLE family
    ADD COLUMN dinner_weekday TIME,
    ADD COLUMN dinner_weekend TIME;
