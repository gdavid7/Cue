-- CreateTable
CREATE TABLE "ComposeAssistReply" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "outcomes" JSONB NOT NULL,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "ComposeAssistReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComposeAssistReply_emailAccountId_threadId_updatedAt_idx" ON "ComposeAssistReply"("emailAccountId", "threadId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ComposeAssistReply" ADD CONSTRAINT "ComposeAssistReply_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "DraftSendLog" ADD COLUMN "composeAssistReplyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DraftSendLog_composeAssistReplyId_key" ON "DraftSendLog"("composeAssistReplyId");

-- AddForeignKey
ALTER TABLE "DraftSendLog" ADD CONSTRAINT "DraftSendLog_composeAssistReplyId_fkey" FOREIGN KEY ("composeAssistReplyId") REFERENCES "ComposeAssistReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A send log compares the sent reply against exactly one draft source.
ALTER TABLE "DraftSendLog" DROP CONSTRAINT "DraftSendLog_one_draft_source_check";
ALTER TABLE "DraftSendLog" ADD CONSTRAINT "DraftSendLog_one_draft_source_check" CHECK (num_nonnulls("executedActionId", "suggestedReplyDraftId", "composeAssistReplyId") = 1);
