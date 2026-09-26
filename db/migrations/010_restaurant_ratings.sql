-- Each family member's star rating (1 to 5) for one of the family's restaurants.
-- A member with no row hasn't rated it; clearing a rating deletes the row.
CREATE TABLE restaurant_rating (
    restaurant_id UUID NOT NULL REFERENCES restaurant(id) ON DELETE CASCADE,
    member_id     UUID NOT NULL REFERENCES family_member(id) ON DELETE CASCADE,
    stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (restaurant_id, member_id)
);
