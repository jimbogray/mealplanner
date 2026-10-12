-- Weeks a weekly event isn't on: the one day it's skipped, with the other weeks left as they are.
CREATE TABLE schedule_event_skip (
    event_id UUID NOT NULL REFERENCES schedule_event(id) ON DELETE CASCADE,
    day      DATE NOT NULL,
    PRIMARY KEY (event_id, day)
);
