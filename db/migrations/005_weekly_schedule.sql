-- The family's weekly schedule: for each day, who's joining for dinner and how many guests.

-- A week always starts on a Monday.
CREATE TABLE schedule_week (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id  UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    starts_on  DATE NOT NULL CHECK (extract(isodow FROM starts_on) = 1),
    created_by UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (family_id, starts_on)
);

-- One row per day of the week (Monday to Sunday).
CREATE TABLE schedule_day (
    week_id UUID NOT NULL REFERENCES schedule_week(id) ON DELETE CASCADE,
    day     DATE NOT NULL,
    guests  INTEGER NOT NULL DEFAULT 0 CHECK (guests BETWEEN 0 AND 50),
    PRIMARY KEY (week_id, day)
);

-- Family members joining for dinner that day.
CREATE TABLE schedule_diner (
    week_id   UUID NOT NULL,
    day       DATE NOT NULL,
    member_id UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    PRIMARY KEY (week_id, day, member_id),
    FOREIGN KEY (week_id, day) REFERENCES schedule_day(week_id, day) ON DELETE CASCADE
);
