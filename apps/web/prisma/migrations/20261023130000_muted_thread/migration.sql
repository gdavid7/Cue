-- CreateTable
CREATE TABLE "MutedThread" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "threadId" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "MutedThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MutedThread_emailAccountId_createdAt_idx" ON "MutedThread"("emailAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MutedThread_emailAccountId_threadId_key" ON "MutedThread"("emailAccountId", "threadId");

-- AddForeignKey
ALTER TABLE "MutedThread" ADD CONSTRAINT "MutedThread_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
