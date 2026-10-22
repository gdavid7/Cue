-- Its own migration (and transaction), so checking existing rows holds only
-- a SHARE UPDATE EXCLUSIVE lock and sends keep logging meanwhile.
ALTER TABLE "DraftSendLog" VALIDATE CONSTRAINT "DraftSendLog_composeAssistReplyId_fkey";
ALTER TABLE "DraftSendLog" VALIDATE CONSTRAINT "DraftSendLog_one_draft_source_check";
