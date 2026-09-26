-- Per-member diet and allergies, and invites that let an existing member (added by an
-- admin) sign in as themselves.

ALTER TABLE family_member
    ADD COLUMN diet TEXT NOT NULL DEFAULT 'none' CHECK (diet IN ('none', 'vegetarian', 'vegan')),
    -- The UK's 14 major food allergens (keep in sync with ALLERGENS in shared/src/index.ts).
    ADD COLUMN allergies TEXT[] NOT NULL DEFAULT '{}' CHECK (allergies <@ ARRAY[
        'gluten', 'dairy', 'egg', 'peanut', 'tree_nuts', 'soy', 'fish', 'crustaceans',
        'molluscs', 'sesame', 'mustard', 'celery', 'lupin', 'sulphites'
    ]::TEXT[]);

-- When set, accepting the invite gives this (login-less) member a login instead of
-- creating a new member.
ALTER TABLE invite ADD COLUMN member_id UUID REFERENCES family_member(id) ON DELETE CASCADE;
