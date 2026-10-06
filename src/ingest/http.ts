import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Tells GOV.UK who is calling, so they can tell this traffic apart from a browser. */
export const USER_AGENT = "uk-visa-guidance-agent (unofficial, personal project)";

/**
 * What one cache file holds.
 * The fetch time is stored inside the file, so it survives a copy of the folder.
 */
export type CachedResponse = {
  url: string;
  /** ISO 8601. */
  fetched_at: string;
  /** The API response, unchanged. */
  response: unknown;
};

export type JsonResult =
  | { ok: true; data: unknown; fetched_at: string; from_cache: boolean }
  | { ok: false; reason: string };

/** Gets one JSON document. `cacheFile` is a path inside the cache folder, for example "content/graduate-visa.json". */
export type GetJson = (url: string, cacheFile: string) => Promise<JsonResult>;

export type HttpOptions = {
  cacheDir: string;
  /** When true, cached files are ignored and fetched again. */
  refresh?: boolean;
  /** Gap between the start of two requests. 200 ms gives 5 requests per second. */
  minGapMs?: number;
  /** How many times one URL is tried before giving up. */
  maxTries?: number;
  /** Wait before the first retry. It doubles for each retry after that. */
  backoffMs?: number;
  /** Tests pass fakes for these two, so they need no network and no real waiting. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type HttpStats = { requests: number; cache_hits: number };

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the one function the fetch step uses to get JSON.
 * It reads the cache first. On a miss it calls the network, at a limited rate, and retries
 * the errors that are worth retrying. It never throws, so one bad page cannot stop a long run.
 */
export function createHttp(options: HttpOptions): { getJson: GetJson; stats: HttpStats } {
  const {
    cacheDir,
    refresh = false,
    minGapMs = 200,
    maxTries = 4,
    backoffMs = 1000,
    fetchFn = fetch,
    sleep = realSleep,
  } = options;

  const stats: HttpStats = { requests: 0, cache_hits: 0 };

  // The time the next request may start. Every caller books the next free slot before it waits,
  // so the rate limit holds across all the workers that share this function.
  let nextSlot = 0;

  async function waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minGapMs;
    if (slot > now) {
      await sleep(slot - now);
    }
  }

  /** One network call with retries. Returns the parsed body or the reason it failed. */
  async function fetchWithRetry(
    url: string,
  ): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
    let reason = "";
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      await waitForSlot();
      stats.requests += 1;
      try {
        const response = await fetchFn(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          // A hung connection would block one worker for the whole run.
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) {
          return { ok: true, data: await response.json() };
        }
        reason = `HTTP ${response.status}`;
        // 429 means slow down and 5xx means the server had a problem. Both can pass on a retry.
        // Other codes, such as 404, will not change, so there is no point asking again.
        const worthRetrying = response.status === 429 || response.status >= 500;
        if (!worthRetrying) {
          return { ok: false, reason };
        }
      } catch (error) {
        // A dropped connection, a timeout or a body that is not JSON.
        reason = error instanceof Error ? error.message : String(error);
      }
      if (attempt < maxTries) {
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }
    return { ok: false, reason: `${reason} (gave up after ${maxTries} tries)` };
  }

  async function getJson(url: string, cacheFile: string): Promise<JsonResult> {
    const path = join(cacheDir, cacheFile);

    if (!refresh && existsSync(path)) {
      try {
        const cached = JSON.parse(readFileSync(path, "utf8")) as CachedResponse;
        stats.cache_hits += 1;
        return { ok: true, data: cached.response, fetched_at: cached.fetched_at, from_cache: true };
      } catch {
        // A cache file cut short by a crash is not valid JSON. Treat it as a miss and fetch again.
      }
    }

    const result = await fetchWithRetry(url);
    if (!result.ok) {
      // Failures are not cached, so the next run tries them again.
      return result;
    }

    const entry: CachedResponse = {
      url,
      fetched_at: new Date().toISOString(),
      response: result.data,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry));
    return { ok: true, data: result.data, fetched_at: entry.fetched_at, from_cache: false };
  }

  return { getJson, stats };
}
