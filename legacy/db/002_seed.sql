-- Optional local dev seed. Run after 001_init.sql against your local Postgres.

INSERT INTO household (id, name, dinner_poll_time, timezone)
VALUES ('00000000-0000-0000-0000-000000000001', 'The Gray Family', '15:00', 'Europe/London')
ON CONFLICT DO NOTHING;

INSERT INTO family_member (household_id, name, phone_e164, email, role, dietary_prefs)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'James',  '+447700900001', 'james@example.com', 'admin',  '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000001', 'Alex',   '+447700900002', NULL, 'member', '{"vegetarian": true}'::jsonb),
  ('00000000-0000-0000-0000-000000000001', 'Sam',    '+447700900003', NULL, 'member', '{"dislikes": ["mushrooms"]}'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO inventory_item (household_id, name, quantity, unit, category, expires_on)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Chicken breast', 4,   'unit', 'meat',    CURRENT_DATE + 2),
  ('00000000-0000-0000-0000-000000000001', 'Onion',          3,   'unit', 'veg',     CURRENT_DATE + 20),
  ('00000000-0000-0000-0000-000000000001', 'Rice',           500, 'g',    'staple',  NULL),
  ('00000000-0000-0000-0000-000000000001', 'Tomatoes',       6,   'unit', 'veg',     CURRENT_DATE + 4),
  ('00000000-0000-0000-0000-000000000001', 'Cheddar',        200, 'g',    'dairy',   CURRENT_DATE + 15)
ON CONFLICT DO NOTHING;
