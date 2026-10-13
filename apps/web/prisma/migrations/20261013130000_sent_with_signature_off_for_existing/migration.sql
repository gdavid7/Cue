-- The footer was on by default and added without being shown, so no existing
-- "on" reflects a choice. Everyone starts off; the setting turns it back on.
UPDATE "EmailAccount" SET "includeSentWithSignature" = false WHERE "includeSentWithSignature" = true;
