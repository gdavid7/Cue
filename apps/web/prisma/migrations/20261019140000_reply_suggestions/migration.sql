-- AlterEnum
ALTER TYPE "DraftEmailStatus" ADD VALUE 'DISMISSED';

-- AlterTable
ALTER TABLE "SuggestedReplyDraft" ADD COLUMN "executedActionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SuggestedReplyDraft_executedActionId_key" ON "SuggestedReplyDraft"("executedActionId");

-- AddForeignKey
ALTER TABLE "SuggestedReplyDraft" ADD CONSTRAINT "SuggestedReplyDraft_executedActionId_fkey" FOREIGN KEY ("executedActionId") REFERENCES "ExecutedAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
