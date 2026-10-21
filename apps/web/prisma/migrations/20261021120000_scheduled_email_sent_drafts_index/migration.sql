-- CreateIndex
CREATE INDEX "ScheduledEmail_emailAccountId_status_sentAt_idx" ON "ScheduledEmail"("emailAccountId", "status", "sentAt");
