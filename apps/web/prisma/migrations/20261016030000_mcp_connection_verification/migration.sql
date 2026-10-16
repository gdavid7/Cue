-- AlterTable
ALTER TABLE "McpConnection" ADD COLUMN     "needsReconnectAt" TIMESTAMP(3),
ADD COLUMN     "verifiedAs" TEXT,
ADD COLUMN     "verifiedAsId" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);
