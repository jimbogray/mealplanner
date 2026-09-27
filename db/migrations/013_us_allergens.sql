-- Allergies are the US's 9 major food allergens (keep in sync with ALLERGENS in
-- shared/src/index.ts) instead of the UK's 14: wheat replaces gluten, and molluscs,
-- mustard, celery, lupin and sulphites (not major allergens in the US) are dropped.

ALTER TABLE family_member DROP CONSTRAINT family_member_allergies_check;

-- Saved allergies: gluten becomes wheat, the dropped ones go, in the new list's order.
UPDATE family_member
   SET allergies = ARRAY(
         SELECT l.a
           FROM unnest(ARRAY['dairy', 'egg', 'fish', 'crustaceans', 'tree_nuts', 'peanut', 'wheat', 'soy', 'sesame'])
                WITH ORDINALITY AS l(a, i)
          WHERE l.a = ANY(array_replace(allergies, 'gluten', 'wheat'))
          ORDER BY l.i);

ALTER TABLE family_member
    ADD CONSTRAINT family_member_allergies_check CHECK (allergies <@ ARRAY[
        'dairy', 'egg', 'fish', 'crustaceans', 'tree_nuts', 'peanut', 'wheat', 'soy', 'sesame'
    ]::TEXT[]);
