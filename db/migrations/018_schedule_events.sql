-- Things on a day that affect dinner (a match, a work do): who's going and when. A weekly event repeats every
-- seven days from `day`, until `until` if it's been stopped.
CREATE TABLE schedule_event (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id  UUID NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    day        DATE NOT NULL,
    starts_at  TIME NOT NULL,
    ends_at    TIME NOT NULL CHECK (ends_at > starts_at),
    weekly     BOOLEAN NOT NULL DEFAULT false,
    until      DATE CHECK (until >= day),
    created_by UUID REFERENCES family_member(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedule_event_family ON schedule_event (family_id, day);

CREATE TABLE schedule_event_member (
    event_id  UUID NOT NULL REFERENCES schedule_event(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, member_id)
);
