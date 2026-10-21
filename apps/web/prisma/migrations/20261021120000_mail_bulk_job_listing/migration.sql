-- CreateTable
CREATE TABLE "MailBulkJobListing" (
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "scope" JSONB NOT NULL,
    "pageToken" TEXT,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "MailBulkJobListing_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "MailBulkJobListing_emailAccountId_createdAt_idx" ON "MailBulkJobListing"("emailAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "MailBulkJobListing" ADD CONSTRAINT "MailBulkJobListing_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
