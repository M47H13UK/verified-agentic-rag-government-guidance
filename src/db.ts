import { MongoClient, type Collection, type Db } from "mongodb";
import type { Page, Passage, Run } from "./types";

const DEFAULT_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB = "visa_guidance";

let client: MongoClient | null = null;

/**
 * Returns the database, connecting on first use.
 * One MongoClient is shared by the whole process, because it keeps its own connection pool.
 */
export async function getDb(dbName = process.env.MONGODB_DB ?? DEFAULT_DB): Promise<Db> {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI ?? DEFAULT_URI, {
      // Fail fast when MongoDB is not running, instead of waiting 30 seconds.
      serverSelectionTimeoutMS: 3000,
    });
    await client.connect();
  }
  return client.db(dbName);
}

/** Closes the shared connection. Scripts call this at the end so the process can exit. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

// The three collections. The type parameter tells the driver what a document looks like.

export function pagesCollection(db: Db): Collection<Page> {
  return db.collection<Page>("pages");
}

export function passagesCollection(db: Db): Collection<Passage> {
  return db.collection<Passage>("passages");
}

export function runsCollection(db: Db): Collection<Run> {
  return db.collection<Run>("runs");
}
