# How it works

This file explains the project one build step at a time. Each section says what the step added, why it is built that way, and what could break.

## Step 0. Setup

**What it does.** It sets up an empty TypeScript project that can be type checked, linted and tested, and that can talk to MongoDB.

**The pieces.**

- `src/types.ts` holds the shared types. `Passage` is one chunk of a GOV.UK page. `StructuredAnswer` is the typed answer the agent returns. `AnswerResult` is one agent run with its trace and usage. `VerificationRecord` is what the verifier did to an answer. `Run` is everything about one answered question.
- `src/db.ts` connects to MongoDB. It keeps one `MongoClient` for the whole process, because the client manages its own pool of connections. It also names the three collections, `pages`, `passages` and `runs`.
- `src/env.ts` loads the `.env` file. The Agent SDK does not read `.env` by itself, so each entry point calls `loadEnv()` first.
- `data/sample/` holds real GOV.UK responses from 5 October 2026. Tests read these files, so they never need the network.
- `tests/helpers/testDb.ts` gives each test file its own database with a random name, and drops it at the end.
- `.github/workflows/ci.yml` runs lint, the type check and the unit tests on every push. A second job runs gitleaks, which scans the history for secrets.

**Why it is built this way.**

- MongoDB has no fixed schema. A collection accepts any document. The TypeScript types are the schema, so they live in one file that every other file imports.
- Tests use a throwaway database. They can never touch the real corpus, and two test files can run at the same time.
- The paid eval never runs in CI. CI has no token, and a push should never spend money.

**What could break.**

- MongoDB is not running. `npm run db:ping` fails within 3 seconds and says so. Start it with `brew services run mongodb/brew/mongodb-community`.
- An API key is set in the shell. It outranks the subscription token, so runs would bill the key. Later steps check which credential a run used.

## Step 1. Fetch

**What it does.** It asks GOV.UK which pages UK Visas and Immigration has published, downloads each one as JSON, and keeps a copy on disk. On 6 October 2026 that was 1,170 pages and 798 HTML attachments, fetched with 1,974 requests in 6 minutes 37 seconds.

**The pieces.**

- `src/ingest/http.ts` builds `getJson`, the one function that talks to GOV.UK. It looks in the cache first. On a miss it calls the network with Node's built-in `fetch`, at most 5 requests per second, and sends a `User-Agent` that names this project. It retries a 429, a 5xx or a dropped connection up to 4 times, and waits 1, 2 and 4 seconds between tries. It never throws. It returns the data or the reason it failed. A cache file that was cut short by a crash counts as a miss, and the page is fetched again.
- `src/ingest/listPages.ts` lists pages with the Search API. It makes one request per kept format (`guide`, `answer`, `detailed_guide`, `guidance`, `step_by_step_nav`) and asks again with a higher `start` until it has every result. It also fetches the count of documents per format, so the CLI can show what was kept and what was skipped.
- `src/ingest/fetchPages.ts` fetches each page from the Content API, 4 at a time. It reads `details.attachments` on every page. An attachment with `attachment_type` of `html` is a page of its own, so it is fetched too and gets the format `html_publication`. Every other attachment is counted by file type and skipped. The file also maps a page path to a cache file name and reads and writes the manifest.
- `src/ingest/cli.ts` is what `npm run ingest:fetch` runs. It prints the count per format, the attachments fetched and skipped, the failures, the time taken and the path of one raw file. `npm run ingest:fetch -- --refresh` ignores the cache.
- `data/raw/` is the cache. It is git-ignored. `search/` holds the Search API responses and `content/` holds one file per page. Each file stores the URL, the time it was fetched and the response as GOV.UK sent it. `_manifest.json` records the snapshot date, the list of pages, the failures, and how many requests and seconds it took to build the cache.
- `tests/http.test.ts`, `tests/listPages.test.ts` and `tests/fetchPages.test.ts` use a fake `fetch` from `tests/helpers/fakeFetch.ts`. They cover pagination, a cache hit and a cache miss, a retry after a 429, giving up after repeated 5xx replies, and the file name mapping.

**Why it is built this way.**

- Page paths come only from the Search API. A guessed path can point at a page that was moved or never existed.
- Everything is cached, so a second run makes no requests and works offline. The later steps can be rebuilt many times without asking GOV.UK again.
- The fetch time is stored inside each cache file. A copy of the folder keeps it, which a file date would not.
- The request count and the seconds in the manifest are totals for the whole cache. A run that is answered from the cache leaves them alone, so the numbers the README quotes do not change when the corpus is rebuilt.
- One page failing must not waste a six minute run. A failure is written to the manifest with its reason and the run carries on. Failures are not cached, so the next run tries them again.
- The rate limit books a time slot for each request before it waits. That keeps the limit true when 4 workers share it.
- `details.attachments` is the only attachment source used. In this snapshot it held all 798 HTML attachments. `details.documents` is the same list rendered as HTML and was present on 714 of 963 publication pages. `links.children` missed one.

**What could break.**

- GOV.UK is slow or returns errors. The run finishes anyway and lists the failures. Run it again and only the missing pages are fetched.
- The Search API fails. There is no page list without it, so this is the one error that stops the run.
- The cache is out of date. Guidance changes often. Run with `--refresh` to take a new snapshot.
- A page is listed but has moved. The Content API answers with a document of type `redirect`. It is cached like any page and the load step skips it. There was 1 in this snapshot.
- PDFs are not read. This is a version 1 limit. The run skipped 1,144 PDFs, 96 external links and 24 other files. 413 of the 963 publication pages have no HTML attachment, so only their short summary is in the corpus.
- Two paths could map to the same file name if a path held characters outside letters, digits, dots and dashes. No GOV.UK path in this snapshot does.
