-- AlterTable
ALTER TABLE "SnoozedThread" ADD COLUMN "restoreAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ScheduledEmail" ADD COLUMN "reminderAttempts" INTEGER NOT NULL DEFAULT 0;
