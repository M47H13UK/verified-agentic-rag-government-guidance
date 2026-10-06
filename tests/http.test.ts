import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttp, USER_AGENT, type CachedResponse } from "../src/ingest/http";
import { fakeFetch, tempDir, type FakeReply } from "./helpers/fakeFetch";

const PAGE_URL = "https://www.gov.uk/api/content/graduate-visa";
const FILE = "content/graduate-visa.json";

describe("createHttp", () => {
  let dir: string;
  let remove: () => void;
  // Records the waits instead of waiting, so the tests run in milliseconds.
  let waits: number[];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };

  beforeEach(() => {
    ({ dir, remove } = tempDir());
    waits = [];
  });

  afterEach(() => {
    remove();
  });

  it("fetches on a cache miss and writes the response to the cache", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { title: "Graduate visa" } }));
    const { getJson, stats } = createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0 });

    const result = await getJson(PAGE_URL, FILE);

    expect(result).toMatchObject({ ok: true, data: { title: "Graduate visa" }, from_cache: false });
    expect(calls).toEqual([PAGE_URL]);
    expect(stats).toEqual({ requests: 1, cache_hits: 0 });
    const cached = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as CachedResponse;
    expect(cached.url).toBe(PAGE_URL);
    expect(cached.response).toEqual({ title: "Graduate visa" });
  });

  it("fetches again when the cache file was cut short and is not valid JSON", async () => {
    mkdirSync(join(dir, "content"), { recursive: true });
    writeFileSync(join(dir, FILE), '{"url": "https://www.gov.uk/api/content/gradu');
    const { fetchFn, calls } = fakeFetch(() => ({ body: { title: "Graduate visa" } }));
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0 });

    const result = await getJson(PAGE_URL, FILE);

    expect(result).toMatchObject({ ok: true, data: { title: "Graduate visa" }, from_cache: false });
    expect(calls).toEqual([PAGE_URL]);
  });

  it("answers from the cache on a hit, without calling the network", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { title: "Graduate visa" } }));
    const { getJson, stats } = createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0 });

    const first = await getJson(PAGE_URL, FILE);
    const second = await getJson(PAGE_URL, FILE);

    expect(calls).toHaveLength(1);
    expect(stats).toEqual({ requests: 1, cache_hits: 1 });
    expect(second).toMatchObject({ ok: true, data: { title: "Graduate visa" }, from_cache: true });
    // The fetch time comes from the file, so it is the time of the first call.
    expect(first.ok && second.ok && second.fetched_at === first.fetched_at).toBe(true);
  });

  it("fetches again when refresh is set", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: {} }));
    await createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0 }).getJson(PAGE_URL, FILE);
    await createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0, refresh: true }).getJson(
      PAGE_URL,
      FILE,
    );

    expect(calls).toHaveLength(2);
  });

  it("retries after a 429, waits first, then succeeds", async () => {
    const replies: FakeReply[] = [{ status: 429, body: {} }, { body: { ok: 1 } }];
    const { fetchFn, calls } = fakeFetch(() => replies.shift()!);
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0, backoffMs: 500 });

    const result = await getJson(PAGE_URL, FILE);

    expect(result).toMatchObject({ ok: true, data: { ok: 1 } });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it("gives up after a few 5xx replies and reports the reason instead of throwing", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 503, body: {} }));
    const { getJson } = createHttp({
      cacheDir: dir,
      fetchFn,
      sleep,
      minGapMs: 0,
      maxTries: 3,
      backoffMs: 100,
    });

    const result = await getJson(PAGE_URL, FILE);

    expect(result).toEqual({ ok: false, reason: "HTTP 503 (gave up after 3 tries)" });
    expect(calls).toHaveLength(3);
    // The wait doubles each time. There is no wait after the last try.
    expect(waits).toEqual([100, 200]);
    // A failure is not cached, so the next run tries again.
    expect(existsSync(join(dir, FILE))).toBe(false);
  });

  it("does not retry a 404", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 404, body: {} }));
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 0 });

    expect(await getJson(PAGE_URL, FILE)).toEqual({ ok: false, reason: "HTTP 404" });
    expect(calls).toHaveLength(1);
  });

  it("spaces requests out and sends the User-Agent", async () => {
    let userAgent: string | null = null;
    const fetchFn: typeof fetch = async (_input, init) => {
      userAgent = new Headers(init?.headers).get("User-Agent");
      return new Response("{}");
    };
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, sleep, minGapMs: 200 });

    // Three requests start at the same moment. The second and third must wait for their slot.
    await Promise.all([
      getJson(PAGE_URL, "a.json"),
      getJson(PAGE_URL, "b.json"),
      getJson(PAGE_URL, "c.json"),
    ]);

    expect(userAgent).toBe(USER_AGENT);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(150);
    expect(waits[1]).toBeGreaterThan(350);
  });
});
