-- A day the family eats out: no one is at dinner at home, so it has no diners and no guests.
ALTER TABLE schedule_day ADD COLUMN eat_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE schedule_day ADD CONSTRAINT schedule_day_eat_out_no_guests CHECK (NOT eat_out OR guests = 0);
