-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "batch" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "lockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("action", "attempts", "batch", "createdAt", "id", "lastError", "lockedAt", "lockedBy", "nodeId", "runId", "status", "updatedAt") SELECT "action", "attempts", "batch", "createdAt", "id", "lastError", "lockedAt", "lockedBy", "nodeId", "runId", "status", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_runId_status_idx" ON "Job"("runId", "status");
CREATE INDEX "Job_status_lockedAt_idx" ON "Job"("status", "lockedAt");
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetId" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "waitingOn" TEXT,
    "waitingSince" DATETIME,
    CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("createdAt", "endedAt", "id", "projectId", "startedAt", "status") SELECT "createdAt", "endedAt", "id", "projectId", "startedAt", "status" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_projectId_idx" ON "Run"("projectId");
CREATE INDEX "Run_status_idx" ON "Run"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
