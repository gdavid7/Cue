-- Cue's rules used to sort mail by applying a mailbox label each, and its
-- "Needs reply" and "Reading" tabs read those labels. Both now read Cue's own
-- database, so existing accounts move over without having to re-add the tabs.
-- Mirrors addCueTabs/repointLabelTab; anything the person changed is kept.

DROP TABLE IF EXISTS "cue_tab_repoint";

-- Tabs still reading only the labels those rules applied. Collected before the
-- label actions go, since they are the only record of which labels were Cue's.
CREATE TEMP TABLE "cue_tab_repoint" AS
SELECT split."id", tab."systemTypes", tab."matchAll"
FROM "MailSplit" split
JOIN (VALUES
  ('Needs reply', ARRAY['TO_REPLY'], true),
  ('Reading', ARRAY['NEWSLETTER', 'MARKETING'], false)
) AS tab("name", "systemTypes", "matchAll") ON tab."name" = split."name"
WHERE EXISTS (
    SELECT 1 FROM "MailSplitFilter" filter WHERE filter."mailSplitId" = split."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "MailSplitFilter" filter
    WHERE filter."mailSplitId" = split."id"
      AND NOT (
        filter."kind" = 'LABEL'
        AND filter."value" IN (
          SELECT action."labelId"
          FROM "Action" action
          JOIN "Rule" rule ON rule."id" = action."ruleId"
          WHERE rule."emailAccountId" = split."emailAccountId"
            AND rule."systemType"::text = ANY(tab."systemTypes")
            AND action."type" = 'LABEL'
            AND action."labelId" IS NOT NULL
        )
      )
  );

DELETE FROM "MailSplitFilter"
WHERE "mailSplitId" IN (SELECT "id" FROM "cue_tab_repoint");

INSERT INTO "MailSplitFilter" ("id", "kind", "value", "order", "mailSplitId")
SELECT
  gen_random_uuid()::text,
  'CUE'::"MailSplitFilterKind",
  system_type."value",
  system_type."order" - 1,
  repoint."id"
FROM "cue_tab_repoint" repoint
CROSS JOIN LATERAL unnest(repoint."systemTypes")
  WITH ORDINALITY AS system_type("value", "order");

UPDATE "MailSplit" split
SET "matchAll" = repoint."matchAll", "updatedAt" = CURRENT_TIMESTAMP
FROM "cue_tab_repoint" repoint
WHERE split."id" = repoint."id";

DROP TABLE "cue_tab_repoint";

-- Rules whose only action is the label Cue added stop labelling the mailbox and
-- keep sorting into Cue's database. A rule with other actions, or a label the
-- person renamed, is theirs and stays as it is. The name comparison matches
-- normalizeLabelName.
DELETE FROM "Action" action
USING "Rule" rule
WHERE rule."id" = action."ruleId"
  AND action."type" = 'LABEL'
  AND btrim(regexp_replace(
        regexp_replace(regexp_replace(lower(coalesce(action."label", '')), '[-_.]', ' ', 'g'), '\s+', ' ', 'g'),
        '^/+|/+$', '', 'g'
      )) = CASE rule."systemType"
        WHEN 'TO_REPLY' THEN 'to reply'
        WHEN 'AWAITING_REPLY' THEN 'awaiting reply'
        WHEN 'FYI' THEN 'fyi'
        WHEN 'ACTIONED' THEN 'actioned'
        WHEN 'NEWSLETTER' THEN 'newsletter'
        WHEN 'MARKETING' THEN 'marketing'
      END
  AND NOT EXISTS (
    SELECT 1 FROM "Action" other
    WHERE other."ruleId" = action."ruleId" AND other."id" <> action."id"
  );
