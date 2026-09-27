-- Adults working from home that day (more time to cook).
CREATE TABLE schedule_wfh (
    week_id   UUID NOT NULL,
    day       DATE NOT NULL,
    member_id UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    PRIMARY KEY (week_id, day, member_id),
    FOREIGN KEY (week_id, day) REFERENCES schedule_day(week_id, day) ON DELETE CASCADE
);
