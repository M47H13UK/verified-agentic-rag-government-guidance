import type { Db } from "mongodb";
import { runsCollection } from "./db";
import type { Run } from "./types";

/** Stores one finished run, with its answer, trace, verdicts, tokens and cost. */
export async function saveRun(db: Db, run: Run): Promise<void> {
  await runsCollection(db).insertOne(run);
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  return runsCollection(db).findOne({ _id: id });
}
