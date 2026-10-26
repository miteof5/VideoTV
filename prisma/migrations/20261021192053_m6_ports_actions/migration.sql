-- AlterTable
ALTER TABLE "Job" ADD COLUMN "action" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Edge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "targetHandle" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Edge_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Edge" ("id", "projectId", "source", "target") SELECT "id", "projectId", "source", "target" FROM "Edge";
DROP TABLE "Edge";
ALTER TABLE "new_Edge" RENAME TO "Edge";
CREATE INDEX "Edge_projectId_idx" ON "Edge"("projectId");
CREATE UNIQUE INDEX "Edge_source_target_targetHandle_key" ON "Edge"("source", "target", "targetHandle");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
