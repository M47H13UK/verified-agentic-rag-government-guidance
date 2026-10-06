import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeReply = { status?: number; body: unknown };

/**
 * A stand-in for `fetch`, so tests never touch the network.
 * `reply` decides what each URL answers. `calls` lists every URL that was asked for, in order.
 */
export function fakeFetch(reply: (url: string) => FakeReply): {
  fetchFn: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body } = reply(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

/** Creates an empty folder for one test to use as its cache. Call `remove()` when done. */
export function tempDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "visa-ingest-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
