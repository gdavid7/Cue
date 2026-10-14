-- Store Gmail approvals in the form sign-ins are matched in: Gmail ignores
-- dots and "+tags" in the local part, and googlemail.com is gmail.com. A row
-- whose canonical form is already taken keeps its raw form, which sign-in
-- lookups also match.
WITH canonical AS (
    SELECT
        "id",
        "email",
        CASE
            WHEN split_part("email", '@', 2) IN ('gmail.com', 'googlemail.com')
                THEN replace(split_part(split_part("email", '@', 1), '+', 1), '.', '') || '@gmail.com'
            ELSE "email"
        END AS "canonicalEmail"
    FROM "AccessRequest"
),
movable AS (
    SELECT DISTINCT ON ("canonicalEmail") "id", "canonicalEmail"
    FROM canonical
    WHERE "canonicalEmail" <> "email"
      AND NOT EXISTS (
          SELECT 1 FROM "AccessRequest" existing
          WHERE existing."email" = canonical."canonicalEmail"
      )
    ORDER BY "canonicalEmail", "id"
)
UPDATE "AccessRequest" request
SET "email" = movable."canonicalEmail", "updatedAt" = CURRENT_TIMESTAMP
FROM movable
WHERE request."id" = movable."id";
