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

## Step 2. Chunk and load

**What it does.** It turns the cached GOV.UK responses into passages of about 150 to 400 words and loads them into MongoDB with a text index. On 6 October 2026 that gave 1,966 pages, 28,392 passages and 7,457,426 words in about 20 seconds.

**The pieces.**

- `src/ingest/parse.ts` reads one Content API document. A guide keeps its text in `details.parts`, one entry per part. A step by step page keeps its steps as data in `details.step_by_step_nav`. Every other kept format has one HTML string in `details.body`. `htmlToBlocks` walks the HTML with cheerio and returns an ordered list of blocks. A block is a heading with its level, a paragraph, a list item or a table row. Link text is kept and the markup is dropped. A table row becomes one line with `|` between the cells. Icons, images, footnotes and attachment boxes are removed. A page that has moved, is not in English or has no text is skipped with a reason.
- `src/ingest/chunk.ts` turns the blocks of one part into passages, in four small steps. It works out the heading path of every block. It cuts the part into sections at each h2, and an h2 section keeps its h3 sub-sections. It cuts a section over 400 words at the next heading level down, and at paragraph starts once there are no headings left. It merges a section under 150 words with the sections after it, up to 400 words. A section that is still short joins the one before when that fits.
- `src/ingest/load.ts` has `buildCorpus`, which parses and chunks every page in the manifest. It has `loadPassages`, which drops the `pages` and `passages` collections, inserts the new documents and calls `ensureIndexes`. `ensureIndexes` creates the text index `passage_text` on `title` (weight 5), `heading_path` (weight 5), `headings` (weight 3) and `text` (weight 1), and a normal index on `base_path`, `part_slug` and `n`.
- `src/ingest/cli.ts` gains `npm run ingest:load`. `npm run ingest` runs the fetch and then the load.
- `results/corpus.json` holds the numbers of the last load. It is committed, because the README quotes it.
- `tests/parse.test.ts`, `tests/chunk.test.ts` and `tests/load.test.ts` cover the three files. The main test chunks the Graduate visa sample and expects the 13 passages in `data/sample/passages.json`, field for field.

**Why it is built this way.**

- GOV.UK writes one topic under one heading. A passage that follows the headings is about one thing, so a search hit and a quote make sense without the rest of the page.
- A passage ID is `<base_path>#<part_slug>#<n>`, for example `/graduate-visa#overview#2`. It can be read by a person and it says which page and part a quote came from.
- The heading a passage starts at goes into `heading_path` and is left out of `text`. The index gives the heading path 5 times the weight of the text, so repeating it would count it twice. Headings merged in later stay in `text` as their own lines and are listed in `headings`.
- A long section is cut into pieces of about the same size. Filling each piece to 400 words would leave a scrap at the end. A cut is made where a new paragraph starts, so a list stays with the sentence that introduces it.
- The only characters added to the words from GOV.UK are line breaks and the `|` between table cells. A quote can then be checked against the passage word for word.
- Each load replaces the corpus. Running it twice leaves the same 28,392 passages, not two copies. The collections are dropped and the text index is built once after the insert. Emptying them and inserting with the index in place took 26 seconds in a test, against 5.
- HTML is parsed with cheerio. Reading nested tags with regular expressions goes wrong quickly.

**What could break.**

- A page changes on GOV.UK. A new section moves the numbers of the passages after it, so an old passage ID can point at different text after a new fetch. The eval names pages, not passage IDs, for this reason.
- Some passages are outside the target. 26,112 of 28,392 are between 150 and 400 words. 2,272 are shorter. 948 of those are publication pages whose only HTML is a short summary, and most of the rest sit between two long sections. 8 are longer, up to 932 words, because one paragraph or table row is never cut.
- A long table is cut between rows. Only the first passage holds the header row. A line break inside a table cell becomes a space, so a cell that lists items on separate lines reads as one run of words.
- Footnote markers such as "[footnote 1]" and the footnote list are dropped. 210 pages have them, mostly country policy notes. Their passage text differs from the page by those markers.
- 8 pages with 196 passages are Welsh or Chinese translations that GOV.UK labels as English, so they are in the corpus. Only `locale` is checked, and that skipped 1 page.
- Something reads the corpus during a load. The collections are missing or half full for a few seconds.
- `ensureIndexes` is called on its own when an index named `passage_text` exists with other weights. MongoDB refuses to change an index. A load is not affected, because it drops the collection first.
- `npm run ingest:load` is run before any fetch. It stops and says to run `npm run ingest:fetch` first.
