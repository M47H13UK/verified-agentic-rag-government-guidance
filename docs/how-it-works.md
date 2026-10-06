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

## Step 3. Search tools

**What it does.** It gives the agent its only two abilities, as plain functions that can be run from the command line. `searchGuidance` finds passages by keyword. `readPassage` returns one passage in full.

**The pieces.**

- `src/tools/searchGuidance.ts` runs a MongoDB text search and returns up to 8 hits, best first. Each hit has the passage ID, page title, heading path, link, last updated date and a snippet of about 80 words.
- `makeSnippet` in the same file picks which 80 words to show. It slides a window over the passage and keeps the one that contains the most query words.
- `src/tools/readPassage.ts` returns the full text of one passage and the IDs of the passages before and after it. `getPassagesById` looks up several passages at once, which the verifier and the page need later.
- `src/cli.ts` is the command line entry point. `npm run search -- "graduate visa how long"` and `npm run read -- "/graduate-visa#overview#2"`.

**Why it is built this way.**

- The tools are plain functions that take a database and return data. They know nothing about the agent. The agent step wraps them, and a different model provider could wrap the same functions later.
- Search returns snippets, not full passages. Eight full passages would be about 2,000 words per search, and the agent often searches twice. Short results keep each run cheap, and the agent opens only what it needs.
- The text index does the ranking. MongoDB stems words, so "studying" matches "study". It drops common words such as "how". It scores a match in the title or a heading five times higher than a match in the body, because the weights are set that way in the index.
- The sort has a tie-break on the passage ID. Two passages can score the same, and without the tie-break the order could change between runs.
- The snippet ignores words from the page title. Every passage of the Graduate visa guide contains "Graduate visa", so those words say nothing about which part of the passage matters. This came from a real run. The first version showed the start of the passage, the agent never saw the line about work, and it never opened the passage.

**What could break.**

- The corpus is not loaded. The search returns nothing and the command line says to run `npm run ingest`.
- The text index is missing. MongoDB rejects a `$text` query with "text index required". The index is created by the load step.
- Keyword search misses a passage that uses different words from the question. "Can I work full time" does not match "work in most jobs" on the word "full". The eval measures how often this happens with the retrieval hit rate. Embeddings are the next step only if that number shows a problem.

## Step 4. Agent SDK spike

**What it does.** It runs the smallest possible agent before the real one is built. One `query()` call, one custom tool, built-in tools off, a structured answer and tracing hooks. The SDK docs leave five points open, and everything later depends on them, so they are tested first.

**The pieces.**

- `scripts/spike.ts` is the whole spike. `npm run spike` prints one line per message from the stream. `npm run spike -- --raw` prints every message in full. Flags change the model, the effort and the turn cap.
- It needs no database. Its one tool reads the sample passages from `data/sample/`.

**What the spike found.** Tested on 6 October 2026 with SDK version 0.3.285.

| Open point                                                                 | Answer                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `outputFormat` still work with `tools: []`?                           | Yes. The SDK adds its own tool called `StructuredOutput`, and `tools: []` does not remove it. The init message lists exactly two tools, `StructuredOutput` and the custom one.                                                                             |
| Does the structured answer count toward `maxTurns`?                        | Yes. One tool call needs `maxTurns: 2`. With `maxTurns: 1` the run ends with `error_max_turns`. So the cap must be the number of tool turns plus one.                                                                                                      |
| Does `tools: []` remove `ToolSearch`?                                      | Yes. `ToolSearch` is not in the tool list and the model calls the custom tool directly. `alwaysLoad: true` is not needed.                                                                                                                                  |
| Does a hook with no matcher fire for internal calls?                       | Yes. `PreToolUse` and `PostToolUse` both fire for `StructuredOutput`. The trace must skip any tool that is not one of ours.                                                                                                                                |
| Does `effort: "xhigh"` work on Opus 5.5? What about `effort` on Haiku 4.5? | `xhigh` on Opus 5.5 runs normally. Passing `effort` with Haiku 4.5 also runs with no error. The SDK types say the effort goes through "model-support downgrades", so it is dropped for a model without the setting. The project leaves it unset for Haiku. |

**Other things the spike showed.**

- `query()` does throw after an error result. With the turn cap hit, the stream yields a result with subtype `error_max_turns`, and then the loop throws "Reached maximum number of turns". The result message still carries usage and cost.
- `apiKeySource` on the init message is `none` when the subscription token is used.
- Every run makes one extra small call on Haiku, about 900 input tokens, whatever the main model is. It shows up as a second entry in `modelUsage` and is included in `total_cost_usd`. It adds about $0.001 per run at list prices. The project counts it, because it is part of what a run costs.
- `total_cost_usd` matches the list prices. One Haiku run used 3,133 input and 466 output tokens and reported $0.005463, which is 3,133 at $1 per million plus 466 at $5 per million.
- Prompt caching is automatic. The second run on a model reads most of its input from the cache, so a run costs less when another run came shortly before it.
- The stream includes a `rate_limit_event` with the share of the plan's five hour and seven day windows already used. Long eval runs print it.
- The init message lists bundled skills and agents even with `settingSources: []`. They cannot be used, because `tools: []` removes the `Skill` and `Agent` tools.
- On the first run the model joined two lines of the passage with a full stop that is not in the source. The quote was no longer word for word. This is exactly what the quote check in step 6 is for.

**What could break.**

- A newer SDK version changes one of these answers. The spike is kept in the repo so it can be run again after an upgrade.
- An API key is set in the shell. It outranks the subscription token. The init line of the spike shows which one was used.

## Step 5. The agent

**What it does.** It answers one question. The model searches the passages, reads the ones it needs, and returns a typed answer where every claim carries a passage ID and a word for word quote. Every tool call is recorded, and the run is stored in MongoDB.

**The pieces.**

- `src/agent/backend.ts` is the one `query()` call. `createAgentBackend(db)` returns an `AnswerBackend`, which is the only thing the verifier and the eval know about the agent.
- `src/agent/tools.ts` wraps the two functions from step 3 as tools on an MCP server that runs inside this process. The server key is `guidance`, so the model sees `mcp__guidance__search_guidance` and `mcp__guidance__read_passage`.
- `src/agent/prompt.ts` holds the system prompt, five numbered rules with their reasons, and the turn cap.
- `src/agent/schema.ts` defines the answer with Zod and converts it to JSON Schema for the SDK.
- `src/agent/trace.ts` records every tool call with hooks.
- `src/llm/sdk.ts` holds small helpers shared by every SDK call. It reads tokens and cost from the result message, builds the child process environment, and reports which credential is in use.
- `src/runs.ts` saves and loads runs. `src/print.ts` prints an answer and its trace.
- `npm run ask -- "How long does a Graduate visa last?"` runs it. Add `--model claude-sonnet-5-5` or `--effort medium` to change the setup.

**The options, one by one.**

| Option            | Value                         | Why                                                                                                                                              |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools`           | `[]`                          | Removes every built-in tool. No files, no shell, no web. The corpus is the only source, which is what makes every claim checkable.               |
| `mcpServers`      | `{ guidance: server }`        | The in-process server with the two tools.                                                                                                        |
| `allowedTools`    | the two full tool names       | MCP tools need explicit permission. This option only pre-approves. It does not restrict, which is why `tools: []` is also needed.                |
| `permissionMode`  | `"dontAsk"`                   | Never prompts. Anything not pre-approved is denied. Left out, a run can start in auto mode.                                                      |
| `settingSources`  | `[]`                          | Left out, the SDK loads the user's own Claude Code settings, instructions and hooks into the agent.                                              |
| `strictMcpConfig` | `true`                        | Only the server passed here is used.                                                                                                             |
| `persistSession`  | `false`                       | One question is one run, so no session file is written.                                                                                          |
| `maxTurns`        | 8 tool turns plus 2           | The spike showed that the structured answer uses a turn. The second spare turn lets the SDK ask again when the answer does not match the schema. |
| `outputFormat`    | the answer's JSON Schema      | The SDK validates the final answer and returns it in `structured_output`.                                                                        |
| `hooks`           | three tool hooks, no matcher  | They record every tool call.                                                                                                                     |
| `env`             | `process.env` plus one flag   | Passing `env` replaces the child's environment, so the parent's is spread in.                                                                    |
| `effort`          | only when the setup names one | Left out, the model uses its own default.                                                                                                        |

**Why it is built this way.**

- The answer is an object, not text. Plain code can then check each claim, which is the next step.
- The schema is written once in Zod. `satisfies z.ZodType<StructuredAnswer>` makes the compiler fail if the schema and the shared type drift apart. `structured_output` is typed `unknown`, so it is parsed with the same schema before use.
- The trace has two sources. Hooks are the main one. They give the input, the response and the duration of each call. The docs warn that hooks may not fire when the turn cap is hit, so the message stream fills in any call the hooks missed.
- The trace keeps the passage IDs each call returned. The eval uses them to tell "the agent never saw the right page" apart from "it saw the page and still got it wrong".
- A new MCP server is made for every run. Runs that happen at the same time then never share one.
- `query()` throws after an error result, so the loop sits in a `try`. A failed run still returns its trace, tokens and cost, with `answer: null` and an `error`.
- The prompt tells the model about the turn cap. In the first live test Haiku searched 11 times for the words "full time", hit the cap and returned nothing. The prompt now says that a few searches are normally enough, and that a fact it cannot find should be reported as not confirmed.

**What could break.**

- The model keeps searching and hits the turn cap. The run returns no answer and the error says `error_max_turns`. The eval counts it as a failed answer.
- The model writes a quote that is not word for word. The agent does not catch this. The quote check in step 6 does.
- The summary says more than the claims do. In one live run the summary said "you can work full-time" while no claim or passage said so. The verifier in step 7 deals with this. The prompt also tells the model that every fact in the summary must be a claim with its own quote.
- The plan's usage limit is reached. The SDK run fails, and the error is recorded on the run.

## Step 6. Quote check

**What it does.** It checks in plain code that every quote in an answer really appears in the passage it cites. A claim whose quotes cannot be found is marked `not_supported` before any model looks at it.

**The pieces.**

- `src/verify/quoteCheck.ts` holds the whole check. It makes no model call and no database call. The caller passes the passages in as a `Map` keyed by passage ID.
- `normaliseForQuote(text)` prepares a quote and a passage for comparison. It turns every run of whitespace into one space, trims the ends, and maps curly quotes, long dashes and non-breaking spaces to their plain forms. It does not change case. It also drops punctuation at the end of a word, and keeps punctuation inside a number, so `£1,035` and `1.5` must still match exactly.
- `checkCitation(citation, passages)` checks one quote. It fails with `passage_not_found` when the passage ID is unknown, with `quote_too_short` when the quote has fewer than 3 words, and with `quote_not_found` when the normalised quote is not inside the normalised passage text.
- `checkClaim(claim, passages)` passes a claim only when it has at least one citation and every citation passes. A claim with no citations fails with `no_citations`.
- `quoteCheck(answer, passages)` returns one `ClaimVerdict` per claim with `checked_by: "quote_check"`. A failed claim gets a one sentence reason such as "Quote not found in passage /graduate-visa#overview#2."
- The agent prompt asks for quotes of at most 40 words (`MAX_QUOTE_WORDS` in `src/agent/schema.ts`).
- `tests/quoteCheck.test.ts` runs the check against the 5 real quotes in `data/sample/quotes.json` and against quotes that were changed on purpose.

**Why it is built this way.**

- A model can write a quote that looks right and is not in the source. Comparing strings catches that every time. It costs nothing and gives the same result on every run. So it runs first, and the verifier model only sees claims with real quotes.
- The comparison is exact apart from a short list of harmless differences. List items in a passage are separate lines, and a quote that covers several items comes back with spaces between them. GOV.UK uses curly apostrophes, and models often retype them as straight ones. Without these rules, real quotes would fail.
- The list stops there. Every extra rule makes it easier for a made-up quote to pass. Case is kept, because copying text never changes its case.
- A quote needs at least 3 words. Words such as "the UK" are in almost every passage, so a very short quote proves nothing.
- One bad citation fails the whole claim. The claim was written with that quote as evidence, so it cannot be trusted as written.
- A quote longer than 40 words is not a failure. Length is a style rule for the prompt. This check is about whether the words are real.
- `supported` from this check means only that the quotes are real. It does not mean the quotes back the claim. That is the job of step 7.

- The punctuation rule came from a real run. A model quoted two list items as "…31 December 2026, 18 months if you apply on or after 1 January 2027." The page has those items on separate lines with no comma and no full stop. Every word was real, but the first version of the check failed the quote, and a true claim was removed. Word-end punctuation carries no facts, so the check now ignores it. Digits and the punctuation inside numbers do carry facts, so they are compared exactly.

**What could break.**

- GOV.UK uses a character the rules do not cover, for example a single ellipsis character. A real quote would then fail with `quote_not_found`. The fix is one more `replace` line in `normaliseForQuote` and a test for it.
- A model shortens a quote with "..." in the middle. The check fails it, and that is intended. A quote must be one continuous run of words.
- A quote starts in one passage and ends in the next. It fails, because each citation is checked against one passage.
- The corpus is ingested again and a page has changed. A stored answer that quoted the old text would fail if it were checked again.
