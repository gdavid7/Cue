-- CreateTable
CREATE TABLE "SuggestedReplyDraft" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "SuggestedReplyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SuggestedReplyDraft_emailAccountId_draftId_key" ON "SuggestedReplyDraft"("emailAccountId", "draftId");

-- CreateIndex
CREATE INDEX "SuggestedReplyDraft_emailAccountId_threadId_idx" ON "SuggestedReplyDraft"("emailAccountId", "threadId");

-- AddForeignKey
ALTER TABLE "SuggestedReplyDraft" ADD CONSTRAINT "SuggestedReplyDraft_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "DraftSendLog" ALTER COLUMN "executedActionId" DROP NOT NULL,
ADD COLUMN "suggestedReplyDraftId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DraftSendLog_suggestedReplyDraftId_key" ON "DraftSendLog"("suggestedReplyDraftId");

-- AddForeignKey
ALTER TABLE "DraftSendLog" ADD CONSTRAINT "DraftSendLog_suggestedReplyDraftId_fkey" FOREIGN KEY ("suggestedReplyDraftId") REFERENCES "SuggestedReplyDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A send log compares the sent reply against exactly one draft.
ALTER TABLE "DraftSendLog" ADD CONSTRAINT "DraftSendLog_one_draft_source_check" CHECK (num_nonnulls("executedActionId", "suggestedReplyDraftId") = 1);
