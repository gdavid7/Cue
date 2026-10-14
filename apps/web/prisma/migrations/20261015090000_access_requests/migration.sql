-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT NOT NULL,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessRequest_email_key" ON "AccessRequest"("email");

-- CreateIndex
CREATE INDEX "AccessRequest_status_createdAt_idx" ON "AccessRequest"("status", "createdAt");

-- Everyone who already has an account stays approved, so turning the waitlist
-- on later can't lock anyone out. They already use Cue, so nobody is notified.
INSERT INTO "AccessRequest" ("id", "createdAt", "updatedAt", "email", "name", "source", "status", "decidedAt", "decidedBy", "notifiedAt")
SELECT
    'existing_' || "id",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    lower(trim("email")),
    "name",
    'existing_user',
    'APPROVED',
    CURRENT_TIMESTAMP,
    'migration',
    CURRENT_TIMESTAMP
FROM "User"
ON CONFLICT ("email") DO NOTHING;
