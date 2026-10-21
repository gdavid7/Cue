-- AlterTable
ALTER TABLE "ScheduledAction" ADD COLUMN     "executionAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "executionStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ScheduledAction_status_executionStartedAt_idx" ON "ScheduledAction"("status", "executionStartedAt");
