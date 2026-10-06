// Checks that MongoDB is reachable. Run with `npm run db:ping`.
import { closeDb, getDb } from "../src/db";
import { loadEnv } from "../src/env";

loadEnv();

try {
  const db = await getDb();
  const reply = await db.command({ ping: 1 });
  console.log(`MongoDB ping ok=${reply.ok}, database "${db.databaseName}"`);
} catch (error) {
  console.error("MongoDB is not reachable. Start it, then try again.");
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await closeDb();
}
