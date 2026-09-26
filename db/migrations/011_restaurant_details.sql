-- What kind of food a restaurant serves, and where to book a table. Typed in, or read from its web page by Claude.
ALTER TABLE restaurant
    ADD COLUMN cuisine     TEXT,
    ADD COLUMN booking_url TEXT;
