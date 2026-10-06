import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { passagesCollection } from "../src/db";
import { samplePassages } from "./helpers/fixtures";
import { createTestDb } from "./helpers/testDb";

describe("MongoDB connection", () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  });

  afterAll(async () => {
    await drop();
  });

  it("answers a ping", async () => {
    const reply = await db.command({ ping: 1 });
    expect(reply.ok).toBe(1);
  });

  it("stores a passage and reads it back by its ID", async () => {
    const passage = samplePassages()[1]!;
    await passagesCollection(db).insertOne(passage);

    const found = await passagesCollection(db).findOne({ _id: "/graduate-visa#overview#2" });
    expect(found).toEqual(passage);
  });
});
