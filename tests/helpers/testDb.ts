import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { closeDb, getDb } from "../../src/db";

/**
 * Creates a database with a random name for one test file.
 * Each file gets its own, so test files can run at the same time without touching each other
 * or the real corpus. Call `drop()` in `afterAll`.
 */
export async function createTestDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const db = await getDb(`visa_test_${randomUUID().slice(0, 8)}`);
  return {
    db,
    drop: async () => {
      await db.dropDatabase();
      await closeDb();
    },
  };
}
