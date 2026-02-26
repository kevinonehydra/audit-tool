-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('photo', 'video', 'audio');

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "type" "EvidenceType" NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "metaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Evidence_auditId_idx" ON "Evidence"("auditId");

-- CreateIndex
CREATE INDEX "Evidence_type_idx" ON "Evidence"("type");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
