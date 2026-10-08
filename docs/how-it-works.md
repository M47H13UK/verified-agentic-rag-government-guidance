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
- `total_cost_usd` matches the list prices. One Haiku run used 3,133 input and 466 output tokens and reported $0.005463, which is 3,133 at $1 per million plus 466 at $5 per million. Step 10 found that this holds only for a model the installed SDK has the right prices for, and moved the price table into the project.
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

## Step 7. Verifier and repair

**What it does.** It checks every claim of a draft answer twice before the answer is shown. The quote check from step 6 runs first. Then a second model reads each claim next to the passages it cites. The same model call checks the summary against the claims. A claim that fails gets one repair attempt. A claim that still fails is removed. A summary that cannot be trusted is rebuilt from the claims that are left.

**The pieces.**

- `src/llm/types.ts` defines `StructuredCall`. It is one model call that returns an object matching a Zod schema. The verifier receives this function as an argument, so tests pass a fake and never call a model. This step adds the `zod` dependency.
- `src/verify/verifier.ts` holds the verifier.
- `VERIFIER_MODEL` is the model ID of the verifier. It is the same in every setup, so the setups differ only in the answering model.
- `verdictSchema` is the Zod schema for the verifier's output. It has one verdict per claim. A verdict is `supported`, `partially_supported` or `not_supported`, with a one sentence reason and an optional `fix`. It also has `summary_supported`, which is true or false, and a one sentence `summary_reason`. Both are required.
- `VERIFIER_SYSTEM_PROMPT` tells the model to judge only whether the cited passage text supports the claim as written, and to use no outside knowledge. A claim that is stronger or broader than the text is `not_supported`. The example in the prompt is a claim that says "any job" when the passage says "most jobs". For the summary, the prompt asks whether every fact in it is covered by a claim that was marked `supported` or `partially_supported`. A sentence saying that something could not be confirmed is allowed.
- `buildVerifierPrompt(question, summary, claims, passages)` writes the question, the summary, then each claim with its index, its quotes and the full text of every passage it cites. Each passage comes with its heading path, URL and updated date.
- `makeVerifier(call, model)` returns a `VerifierFn`. It makes one model call for all claims and the summary. It returns one verdict per claim with `checked_by: "verifier"`, and `summarySupported`.
- `src/verify/repair.ts` has `buildRepairFeedback(answer, failedVerdicts)`. It writes the text that goes to the agent as `RunOptions.feedback` on the repair attempt. The text names each failed claim, the reason and the suggested fix. It also lists the claims that passed with their quotes, and asks for the full answer again.
- `src/pipeline.ts` has `runPipeline(question, setup, deps, existingDraft)`. It runs the steps below in order and returns a `Run`.
- `src/usage.ts` has `ZERO_USAGE` and `addUsage(a, b)`, which adds two usage records.
- `tests/verifier.test.ts`, `tests/repair.test.ts` and `tests/pipeline.test.ts` use a fake backend and a fake model call with the sample passages.

`runPipeline` does this:

1. It gets the draft from the backend, or uses `existingDraft` when one is passed.
2. With the verifier off, the draft is the final answer. `verification` is null and `final_verdicts` is empty.
3. With the verifier on, it looks up every cited passage once and runs the quote check on all claims. The claims that passed go to the verifier model, together with the summary. When no claim passed, there is no model call and the summary is not checked.
4. When no claim is `not_supported`, there is no repair. A `partially_supported` claim is kept and does not start a repair. A summary that is not supported does not start a repair either.
5. When a claim is `not_supported`, the agent runs once more with the feedback text. The repaired answer goes through both checks again, and so does its summary. The summary verdict of this second pass is then the one that counts.
6. Claims of the repaired answer that are still `not_supported` are removed. When the repair returned no valid answer, the draft is used with its failed claims removed, and the summary verdict of the first pass counts.
7. The summary is replaced when a claim was removed, or when the verifier said the summary is not supported. Code builds the new summary. It is the texts of the kept claims joined with one space. When neither happened, the model's summary is kept.
8. When every claim was removed, the summary is `NOT_CONFIRMED`, which reads "The draft answer could not be confirmed against the guidance." An answered answer with no claims left becomes `declined`. Its summary and its `declined_reason` are both set to that text.

The `VerificationRecord` says what happened. `dropped_by_quote_check` and `dropped_by_verifier` count the `not_supported` claims of the first pass. `claims_after_repair` is the size of the repaired answer before it was checked. `unconfirmed` holds the text of each claim that was removed from the answer that is shown. `summary_replaced` is true when a claim was removed or the verifier did not support the summary. `extra_usage` and `extra_latency_ms` add up the verifier calls and the repair run.

**Why it is built this way.**

- A confident answer is not proof. The quote check proves the quoted words are real. It cannot tell that "you can work in any job" goes further than "work in most jobs". A model that reads the claim and the passage side by side can.
- The verifier is a separate call with a narrow job. It did not write the answer. It sees only the claim and the cited text, and it is told to use nothing else.
- The quote check runs first because it is free and exact. Claims that fail it never reach the model, so no tokens are spent on them.
- One call for all claims is cheaper than one call per claim. Each claim still carries its own passages, so a claim is judged only against what it cites.
- The summary is checked because the user reads it first and it has no quotes of its own. In a live run a model wrote "you can work full-time" in the summary. No claim and no passage said so. Checking the claims alone does not catch that.
- The summary is compared with the claims, not with the passages. The claims have already been checked against the passages. A summary that stays within the supported claims stays within the guidance.
- The summary check is part of the same model call as the claims. It adds a few tokens and no extra call.
- The verifier fails closed. When the model call fails, or the output skips a claim, that claim is `not_supported` with the reason "Verifier did not return a verdict." A broken verifier can remove a true claim. It can never let an unchecked claim through. The same goes for the summary. When the call fails, the summary counts as not supported.
- There is exactly one repair. Each attempt costs a full agent run, and a claim that fails twice is more likely to be wrong than badly worded.
- A summary that is not supported does not start a repair. A repair costs a full agent run, and the confirmed claims already hold everything that may be shown.
- The repaired answer is checked from the start. The repair can change claims that had passed or add new ones, so the first verdicts are not reused. It also writes a new summary, so the first summary verdict is not reused either.
- A failed claim is removed, not shown with a warning. The summary is then rebuilt, because the model wrote it before the checks and it may repeat the removed claim.
- The new summary is built by code from the texts of the kept claims. No model writes it, so it cannot say anything that has not passed both checks, and it needs no further check.
- The backend, the verifier and the passage lookup are passed in as `deps`. The pipeline imports no model SDK and no database, so the tests run it with fakes.
- `existingDraft` lets a caller verify a draft it already has. The same draft can then be compared with the verifier off and on, and the agent is paid for once.

- The summary is only replaced when the status is `answered`. The summary of a declined answer explains the refusal, and the summary of a clarifying answer asks the question. Neither is a summary of claims. A trial eval run showed the first version replacing a decline message with claim texts, which made a refusal read like an answer.

**What could break.**

- The verifier model is wrong. It can pass a claim the text does not support, or reject one the text does support. The eval measures this with the unsupported claim rate, with the verifier off and on.
- The verifier is wrong about the summary. It can pass a summary that says more than the claims do. It can also reject a good summary, and the user then reads the claim texts in its place.
- A declined or needs-clarification answer with no claims has its summary shown unchecked, because there are no claims to compare it with. No verifier call is made for it. A visa fact written in such a summary would reach the user.
- A rebuilt summary reads less well than a written one. It repeats the claims word for word, so with five claims it is five sentences long. It also drops any sentence in which the model said what it could not confirm.
- The verifier call fails often, for example on a rate limit. Because it fails closed, most answers would then end as declined. The sign is a high `dropped_by_verifier` with the reason "Verifier did not return a verdict." in `first_pass`.
- The repair makes the answer worse. It can drop a claim that was fine, or return no valid answer. Every claim of the repaired answer is checked again, and a failed repair falls back to the draft without its failed claims.
- The backend throws instead of returning `answer: null`. `runPipeline` then rejects, and the caller has to handle the error.
- The record has no field for the verifier's error message, for its `summary_reason`, or for the trace of the repair run. To debug those, log them where the real model call and the real backend are built.
- `extra_latency_ms` adds up the times that the calls report. The passage lookup and the quote check add a few milliseconds that are not counted.

## Step 8. Gold set

**What it does.** It fixes the file format of the gold set, checks the file for drafting mistakes by code, and gives a local page where a person checks every question against GOV.UK before any eval run.

**How the questions were written.** `eval/personas.md` describes six invented users. A model drafted 60 questions from the stored passages, 20 at a time, with a quote as evidence for every expected point. A second model then answered each question from scratch, compared its answer with the draft, and fixed or flagged what it found. Two more reviews followed. One was by a model from a different vendor, which saw only the questions and their passages. The other could search the whole corpus. Between them they flagged 28 of the 60 questions, and their verdicts differed on 24. Each flagged question was settled against the stored pages. A 61st question was added later that day at the owner's request. It was drafted from the stored passages in the same way and had the same two reviews. The doubts that the pages could not settle are in the `notes` field, starting with `CHECK:`. At this step every question was marked as not verified. In step 10 the owner read the set on the check page, against the stored pages, and signed off all 61. Nobody compared the answers with the live site.

**The pieces.**

- `eval/personas.md` holds the six personas. Each question carries the number of one of them.

- `eval/questions.jsonl` is the gold set. Each line is one question as a JSON object. Shown here over several lines, as an example. The real IDs run from q001 to q061.

  ```json
  {
    "id": "q000",
    "persona": 1,
    "category": "single_page",
    "question": "How long does a Graduate visa last?",
    "expected_behaviour": "answer",
    "expected_points": ["It lasts 3 years if you have a PhD or other doctoral qualification."],
    "gold_sources": ["/graduate-visa/overview"],
    "must_not_say": ["A Graduate visa can be extended."],
    "notes": "The point is in the overview part.",
    "evidence": [
      {
        "point": "It lasts 3 years if you have a PhD or other doctoral qualification.",
        "passage_id": "/graduate-visa#overview#2",
        "quote": "If you have a PhD or other doctoral qualification, it will last for 3 years."
      }
    ],
    "verified_by": null,
    "verified_on": null
  }
  ```

  | Field                        | Meaning                                                                                                                           |
  | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
  | `id`                         | Unique ID. Results are stored under it.                                                                                           |
  | `persona`                    | 1 to 6.                                                                                                                           |
  | `category`                   | `single_page`, `multi_page`, `numbers`, `not_covered`, `personal_judgement`, `false_premise` or `ambiguous`.                      |
  | `expected_behaviour`         | `answer`, `decline` or `clarify`.                                                                                                 |
  | `expected_points`            | Facts a correct answer must contain. Empty for decline and clarify questions.                                                     |
  | `gold_sources`               | Page paths that hold the answer. `/graduate-visa` is a whole page. `/graduate-visa/overview` is one part of a guide.              |
  | `must_not_say`               | Known wrong or outdated statements.                                                                                               |
  | `notes`                      | Optional drafting notes.                                                                                                          |
  | `evidence`                   | Optional. Where each expected point comes from, as a passage ID and a quote. It helps the hand check. It is not used for scoring. |
  | `verified_by`, `verified_on` | Who checked the question by hand and on which date. Both are `null` until then.                                                   |

- `eval/review-log.json` records what the two model reviews said about each question. Each entry has the question `id`, a `bundle_review` and a `corpus_review` that are each `ok`, `doubt` or `fix`, a `decision` and a one-line `summary`. The decision is `not_flagged`, `no_change`, `note_only` or `changed`. The check page uses the file to sort its queue. The file is optional.
- `src/eval/types.ts` holds the `GoldQuestion` and `Category` types.
- `src/eval/questions.ts` reads and writes the file. `questionSchema` is the Zod schema. It rejects an unknown category, a persona outside 1 to 6 and a misspelt key. `loadQuestions(path)` skips blank lines and stops at a bad line with an error that names the line number. `saveQuestions(path, questions)` writes a temporary file and renames it over the real one. `assertAllVerified(questions)` throws and lists the IDs of the questions nobody has checked. It is there for the eval runner to call before a run.
- `src/eval/lint.ts` holds `lintQuestions(questions, passages, sourceExists)`. It is plain code with no database. It returns a list of problems, each with a question ID, a level and a message. A problem about the whole set has the ID `null`. Errors are a duplicate ID, an answer question with no expected point or no gold source, a gold source that matches no passage, an evidence passage that does not exist, an evidence quote that fails the quote check of step 6, evidence written for a point the question does not have, and `verified_by` set without `verified_on` or the other way round. Warnings are a decline or clarify question with expected points, an expected point with no evidence, evidence from a passage that no gold source covers, and a category more than 2 questions away from its target. The targets are single_page 18, multi_page 11, numbers 10, not_covered 8, personal_judgement 6, false_premise 5 and ambiguous 3.
- The same file has two MongoDB lookups. `findPassagesForSource(db, source)` returns the passages a gold source points at. `lintWithDb(db, questions)` fetches what the lint needs and runs it. `passageMatchesSource` is the one place that holds the rule for matching a gold source to a passage.
- `scripts/gold-lint.ts` is `npm run gold:lint`. It prints the problems under the ID of their question, a table of counts by category and persona, and how many questions are verified. The exit code is 1 when there is any error. `--file` reads another file, for example a batch of drafts.
- `scripts/gold-check.ts` is `npm run gold:check`. It starts a small HTTP server on `127.0.0.1:4174`, built with `node:http` only, and opens the page in the browser. `--port` changes the port. `--no-open` leaves the browser alone. `--name` sets the name written to `verified_by`. Without it the name comes from `git config user.name`. The API has six routes:

  | Route                       | What it returns                                                                                                                          |
  | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /api/questions`        | Every question, the lint problems and the verifier's name. Also `reviews` when `review-log.json` is in the folder of the questions file. |
  | `GET /api/passages?source=` | The passages a gold source points at, ordered by part and position.                                                                      |
  | `GET /api/passage?id=`      | One passage.                                                                                                                             |
  | `GET /api/search?q=`        | The hits of `searchGuidance`, the same search the agent uses.                                                                            |
  | `GET /api/audio?id=`        | The recorded clip of that question as WAV audio, or a 404 when it has none.                                                              |
  | `PUT /api/questions/<id>`   | Checks the body against `questionSchema`, replaces that question in the file and returns it.                                             |

  `reviews` is an object keyed by question ID. Each value has `bundle_review`, `corpus_review`, `decision` and `summary`. When `review-log.json` is missing or cannot be read, the reply has no `reviews` key.

- `scripts/gold-check.html` is the page. It is one file with inline CSS and plain JavaScript, with a light and a dark theme. It is laid out as a marking desk. A person reads an answer key next to its source and confirms it.
  - The strip at the top is the mark sheet. It has one cell per question in file order. A verified cell is green with a check mark. A red corner marks a question that needs a decision from the person checking. A grey corner marks a question that was reworded after the reviews. The count next to it says how many questions are verified.
  - The left column is the queue. It sorts the questions into four groups, and a question sits in the first one whose rule it meets. "Needs your decision" holds every question with `CHECK:` in its notes. "Reworded after review" holds the questions with the decision `changed` in the review log. "Reviewers disagreed" holds the other questions where either review was not `ok`. "Both reviewers passed" holds the rest. Without a review log there are two groups, "Needs your decision" and "The rest". A checkbox hides the verified questions.
  - The middle column shows the open question as a document. Nothing in it is a field. It gives the persona and the category in words, then the question, then a statement of what a correct reply does. For an answer question the expected points follow, each with its evidence quote under it. For a decline or clarify question a short text says what to check instead. For a clarify question the missing fact follows, then a table of how the answer changes with it, one case per row. Then come the must-not-say statements, the notes, one line from the review log and the lint problems. A sentence in the notes that starts with `CHECK:` is set apart under the words "To check" and comes first. The rest of the notes is a list with one sentence to a line. A passage ID in the notes is cut short and is a button that brings that passage into view in the right column.
  - The `notes` field is plain text, and the page reads three marks in it. A line break starts a new line. A line that starts with `- ` is a list item. A sentence that starts with `Missing fact:` names what a clarify question leaves out. The list right after it holds the cases. Each case is a short label, a colon and a sentence, such as `- Graduate: a wife on her own visa cannot become a dependant.` A passage ID in brackets in a case is shown under its sentence. Notes without these marks still work. They are cut into sentences.
  - The bar under the question has the buttons "Verify and next", "Edit" and "Next". For a verified question it shows who verified it and when, with a button to remove the verification.
  - "Edit" swaps the document for a form with every field of the question. "Save changes" writes the file and goes back to the document. "Cancel" drops the edits. It asks first when there are any.
  - The right column shows the stored passages of each gold source with a link to the live GOV.UK page. A passage that the evidence or the notes point at is shown in full, with the evidence quotes highlighted. The other passages of the source wait behind one button. Clicking a piece of evidence scrolls to its quote. For a decline or clarify question, and for any question with no gold source, the column also lists what `GET /api/search` returns for the question text. That is what the agent's own search finds. A search field at the bottom finds any other passage.
  - A round button before the question ID reads the question aloud, at 1, 1.5 or 2 times normal speed. It plays the clip that `npm run gold:audio` recorded for the question with the local Kokoro voice. When there is no clip, the browser's own voice reads the text. The clips are optional and live in `data/audio/`, which is not in git. A clip is named by a hash of the question text, so it can never play for a question that was edited after it was recorded.
  - The keys are `J` for the next question, `K` to read the question aloud or to stop it, `H` for the previous question, `V` to verify the open question and go to the next, `E` to edit, `/` for the search field and `Esc` to leave a field or the edit view. `P` reads aloud as well. The keys are off while a field has the cursor.
  - Below 1100 pixels the queue becomes a menu and the source moves under the question.
  - The address keeps the open question after `#`. `?theme=dark` forces the dark theme and `?edit=1` opens the edit view. Both are there for testing.
- `tests/eval/questions.test.ts` and `tests/eval/lint.test.ts` cover the file format and every lint check, using the sample passages and quotes in `data/sample/`.

**Why it is built this way.**

- A person checks every question because every score in the eval is measured against these answers. The questions are drafted by a model from the stored passages. A model can misread a page, and the stored copy can be older than the live page. A wrong gold answer marks a correct answer as wrong, or a wrong answer as correct, and no later step can notice. So the check is done once, by hand, before any eval run. In this build it was done against the stored pages that the check page shows. A check against the live site would also catch a stored copy that is out of date, and that was not done.
- The lint runs first because a person's time is the expensive part. Code can tell that a quote is not in its passage or that a page path does not exist. The person then only judges what code cannot, which is whether the question is realistic and whether the points are right and complete.
- The drafter records evidence for each point. Finding one sentence on a long page takes minutes. Reading a highlighted sentence takes seconds. The evidence quote goes through the same quote check as the agent's answers, so a made-up quote is caught before anyone reads it.
- Editing the question text, the expected behaviour, the points, the sources or the must-not-say statements of a verified question removes its verification on save. The person checked the old words, so the check no longer applies. Editing the notes or the evidence keeps it, because neither is used for scoring.
- The file is JSONL with keys in a fixed order. A changed question is one changed line in a git diff, and saving a question never reorders the others.
- `saveQuestions` writes a temporary file and renames it. A rename either happens or does not, so a crash during the write cannot leave half a file.
- The server reads the file again on every request. The file is the only copy of the questions, so an edit made in an editor or by git shows up on the next request and the server can never hold stale data.
- The page has no build step and no library. It is opened a few times, by one person, and the code has to stay easy to read from top to bottom.
- The page opens on a document to read, not on a form. The work is to read a question and confirm it, and most questions need no edit. The form is one key away.
- The queue starts with the questions that a model review changed or left a doubt on. A person with little time then spends it where a mistake is most likely.
- A decline question has no evidence to check. What can be checked is that the agent's search really finds no answer, so the page shows the search results for the question.
- The server binds to `127.0.0.1`, because the page can change a file on the machine. It also refuses any request whose `Host` header is not its own address. That stops a website in the same browser from pointing its domain name at 127.0.0.1 and calling the API.
- Text from the questions file and from GOV.UK is always added to the page as text nodes, never as HTML.
- Errors and warnings are separate. An error means the file is wrong and fails `npm run gold:lint`. A warning is something to look at, such as a category that is short of its target while the set is still being drafted.

**What could break.**

- The corpus is not loaded. Every gold source and evidence passage is then reported as missing. `npm run gold:lint` prints a line that says the database has no passages.
- A line of the file is not valid. Both commands stop with an error that names the line number.
- The corpus is ingested again and a page has changed. An evidence quote that is no longer in its passage becomes a lint error. That is the signal to check the question again.
- The page copies the rules of `normaliseForQuote` in JavaScript to place the highlights. If the rules in `src/verify/quoteCheck.ts` change and the page is not updated, a quote can pass the lint and still show "This quote is not in the passage" on the page.
- Two questions share an ID. The lint reports it. The page opens and saves the first of the two, so fix the IDs in the file first.
- `review-log.json` is missing or is not valid. The page still works. Its queue then has two groups, sorted by the notes alone.
- The corpus is ingested again. The last line of the source column gives the date of the stored copy as fixed text, so it has to be changed by hand.
- The page sets its colours with the CSS function `light-dark()`. A browser from before 2024 does not know it and shows the page without its colours.
- Port 4174 is in use. The server says so. Pass `--port`.
- Git has no user name and `--name` is not given. The server stops and asks for a name.
- `open` only exists on macOS. On another system the server prints the address to open by hand.
- The passages of a whole page are ordered by part slug, which is alphabetical and not the order of the guide. A passage does not store the position of its part.
- The process is killed between the write and the rename. `eval/questions.jsonl.tmp` is left behind and the real file is untouched. Delete the leftover file.

## Step 9. Eval harness

**What it does.** It runs every gold question through every model setup, has a judge model read each answer, and turns the results into a table and a cost and correctness frontier. Every model call is passed in as a function, so the harness is tested with fakes and no test spends money.

**The pieces.**

- `eval/rubric.md` defines each metric, holds the judge's instructions word for word and states the rule that picks the two headline setups. It was fixed before any results existed.
- `src/eval/types.ts` and `src/llm/types.ts` hold the shared shapes. `EvalRecord` is one run. `Grade` is the scoring of one run. `StructuredCall` is one model call that returns an object matching a Zod schema.
- `src/eval/wiring.ts` builds the real parts the eval needs. `answer` is the same `createAnswerFn` the command line uses, `judge` is one call to the judge model, and `getPassages` reads MongoDB. Everything else in `src/eval` takes these as plain functions, so the tests run on fakes.
- `src/eval/setups.ts` lists the setups, the verifier model and the judge model. There were 8 at this step and step 10 added two. `twinOf` pairs H1 with H0, and so on.
- `src/eval/questions.ts` loads `eval/questions.jsonl` and checks every line. A bad line stops the load, and the error names the line number.
- `src/eval/files.ts` reads and writes JSONL. A line is only ever added at the end of a file.
- `src/eval/run.ts` is the runner. It keeps a few runs under way at once and writes each one to `results/runs/<setup>-r<repeat>.jsonl` as it finishes.
- `src/eval/judge.ts` makes one judge call per answer. The judge says which expected points are present and whether each claim is supported by the passages it cites.
- `src/eval/grade.ts` turns a run and the judge's reading of it into a `Grade`, with plain code. It writes `results/grades/<setup>-r<repeat>.jsonl`.
- `src/eval/metrics.ts` and `src/eval/frontier.ts` build the rows of the results table, find the frontier and apply the headline rule.
- `src/eval/report.ts` writes `results/summary.json`, `results/summary.md` and `results/frontier.md`.
- `src/eval/judgeAudit.ts` draws a seeded random sample of the judge's decisions for a person to label. It then scores how often the person and the judge agree.
- `src/eval/cli.ts` is the command line. `src/eval/wiring.ts` is the one place that connects the eval to the real pipeline, the judge model and the database.

The commands, in the order they are used:

```bash
npm run eval -- run --setups H0,H1 --limit 5 --repeat 1 --concurrency 4
npm run eval -- grade --setups H0,H1 --repeat 1
npm run eval -- report
npm run eval -- audit-sample
npm run eval -- audit-score
```

`--repeat` is the number of the repeat, not a count. For three repeats, run the first two commands with `--repeat 1`, then `--repeat 2`, then `--repeat 3`.

**Why it is built this way.**

- The judge reads and code scores. The judge returns small yes or no decisions and `grade.ts` does the arithmetic. A score can be traced back to the decisions behind it, and a formula can change without a new judge call.
- The judge names points and claims by number, so nothing depends on a model copying a sentence exactly. It never sees which setup wrote an answer, so it cannot favour one. If it skips a point or a claim, the run is judged again. A gap is never filled with a guess.
- Runs and grades are files that only grow. Each finished run is written at once, so a crash loses only the runs that were under way. On the next start the runner skips what is done.
- A failed run is written down, not hidden. It is not counted as done, so the next start runs it again. After 5 failures in a row the batch stops, because that usually means a rate limit or an auth problem.
- A verifier-on setup reuses the draft of its verifier-off twin. The gap between the two is then the verifier and nothing else. If each wrote its own draft, the gap would also include the random difference between two drafts. Reuse also halves the agent calls.
- The rubric and the headline rule were written before any results existed. A test checks that the judge prompt and the rule in the code match the rubric word for word.

- A run with no answer is one of two things. When the agent itself failed, by using up its turns or never producing an answer in the right shape, the record is a result. It scores 0 and is never run again, because running a question until it passes would flatter the setup. When something around the agent failed, such as a rate limit or a dropped connection, the record is not a result and the question is run again on the next start.

**What could break.**

- The plan's usage limit is reached in the middle of a run. Five failures in a row stop the batch with a clear message. Finished questions are on disk, so the same command carries on later. The progress line shows the share of the plan already used.
- A run ends without an answer. It scores 0, shows in the Errors column, and the report opens with a warning. It may be a rate limit and not the fault of the model. Run the same command again to retry it, then grade and report again. A retry gives the model a second attempt, so do not rerun a finished batch only to clear errors that are real.
- The questions file is edited after a run. The runner, the grader and the report stop with an error when a question was reworded. A change to the expected points alone is not detected, so delete `results/grades` and grade again. Give a trial run with `--allow-unverified` its own `--out` folder, or the real run will treat its answers as finished.
- A verifier-on setup is run before its twin. It then writes its own drafts and the pair no longer shares them. Run both setups of a pair in one command.
- The grades are stale. After a rerun, run `grade` again before `report`. The report leaves out any run whose grade no longer matches it and says how many it left out.
- The judge is wrong. It is a model, and it is the same model as four of the setups it grades. `audit-sample` and `audit-score` measure how often it agrees with a person.
- A gap between two setups is noise. With 61 questions, one question is worth 1.6 points of correctness. Run more repeats and read the lowest and highest repeat in the table before trusting a gap of a few points.

## Step 10. Full runs

**What it does.** It runs the whole eval and commits the results. All 61 questions go through 10 setups, three times each. A judge reads every answer and the report is written. A sample of the judge's decisions is drawn for a person to label, to check the judge. The numbers in the README come from the files this step added to `results/`.

**What was run.** The runs were made in one night, from 23:29 UTC on 7 October to 01:58 UTC on 8 October 2026, with 4 runs under way at once.

| Part        | Setups               | Repeats | Runs     | What it is for                                             |
| ----------- | -------------------- | ------- | -------- | ---------------------------------------------------------- |
| Pass 1      | All 10               | 1       | 610      | The map of correctness against cost, and the headline pick |
| Pass 2      | All 10               | 2 and 3 | 1,220    | A lowest and a highest repeat for every row                |
| Judge audit | A sample from pass 1 | 1       | 45 items | How often the judge agrees with a person                   |

- A verifier-on setup checks the draft of its verifier-off twin, so the 1,830 runs hold 915 drafts by the agent.
- `results/pass-1/` is a copy of the report as it stood after pass 1. The headline rule picked OX0 and OM0 from those numbers, before pass 2 started. With three repeats the rule still picks the same two.
- The plan was to repeat only the two headline setups in pass 2. The runs turned out to be fast, so every setup was repeated. Every row then has a range, and the gap a verifier makes can be read against the spread between repeats.
- The audit sample was drawn from pass 1 with seed 1, before pass 2 wrote any grade. It has 30 claims and 15 answers.
- No run failed for a reason outside the agent. 16 runs ended without an answer and score 0. They come from 8 drafts, each counted for both setups of its pair. Seven are Haiku 4.5 drafts that used up their turns. One is a Sonnet 5.5 draft that did not return an answer in the right shape after 5 attempts.

**The pieces this step added.**

- `eval/questions.jsonl` is signed off. The owner read the set on the check page of step 8 and signed off all 61 questions on 8 October 2026. The questions were checked against the stored copy of the guidance, not against the live site.
- `src/eval/setups.ts` has two more setups, H5-0 and H5-1, for `claude-haiku-5-5`. The model came out while the eval was being run.
- `src/llm/prices.ts` holds the list prices of the four models and works out what a set of token counts costs. `usageFromResult` in `src/llm/sdk.ts` now prices each model's tokens with it. Before, it took the SDK's own estimate.
- `scripts/judge-audit.ts`, `scripts/judge-audit.html` and `scripts/lib/auditSheet.ts` are the page for labelling the audit sheet. `npm run judge:check` starts it on `127.0.0.1:4175`. It shows one item at a time. A claim is shown next to the passages it cites, with the quoted words highlighted. An answer is shown next to the expected points as a tick list. The judge's rules from the rubric are printed next to the buttons, so the person and the judge apply the same rules. The page reads and writes `eval/judge-audit.csv` only. It never opens the key file with the judge's labels.
- `src/eval/report.ts` adds the judge agreement to `summary.json` and `summary.md` once the sheet has labels. `npm run eval -- report` scores the sheet on the way. A different number of repeats between setups is a note under the table and no longer a warning.
- `src/cli.ts` asks with Opus 5.5 at medium effort when no model is named. Before, it asked with Haiku 4.5.
- `eval/rubric.md` lists these changes under "Changes", with the date and the reason.
- `results/runs/` and `results/grades/` hold every run and every grade. `results/summary.json`, `results/summary.md` and `results/frontier.md` are the report.

**Why it is built this way.**

- The price table is in the project because the SDK's table was wrong twice. Its figure for 61 Sonnet 5.5 runs was compared with the token counts. It fitted a cache read price of $0.20 per million tokens, and the list price is $0.10. It has no price for Haiku 5.5 at all and charges an unknown model at the highest rate it knows, so a question that costs $0.002 showed as $0.24. The SDK marks that case with `costBasis: "unknown"` in `modelUsage`. A table in the project can be checked against the pricing page line by line, and it does not change when the SDK is updated.
- Cache writes are priced at the one hour rate. The raw usage of a run shows that the SDK writes one hour cache entries on a subscription token, and the SDK's own estimate uses that rate too.
- The runs made before the price fix were thrown away and made again. A stored run keeps one total per kind of token, summed over models, so it could not be priced again exactly. None of those runs had been graded.
- The headline setups were fixed after pass 1 and a copy of that report was kept. Picking them after seeing every repeat would let the choice follow the noise.
- The audit sample was drawn before pass 2 so that it comes from one known set of runs. The person labels without seeing the judge's labels, and the page keeps the two files apart.
- The default of `npm run ask` follows the eval. It is OM0, the cheaper headline setup, with the verifier on. In the runs the verifier cost about 2 cents more per answer and no unsupported claim got past it on that model.

**What could break.**

- A new model is used and has no row in `LIST_PRICES`. The run still works. Its cost is then the SDK's estimate, and a line on standard error says so. A test fails if a model of the eval has no price.
- A list price changes. The table is dated and has to be edited by hand. Runs already on disk keep the cost worked out when they ran.
- A prompt for Haiku 5.5 goes over 100,000 tokens. It then costs five times as much per token, and the table only has the lower price. The largest prompt in these runs is far below that.
- The audit sheet is drawn again with `--force` after it was labelled. The labels are gone. The page refuses a save when the row it loaded is no longer the row on disk.
- The questions file is edited after the runs. A reworded question stops the report with an error. A changed expected point is not detected, so grade again.
- The plan's usage limit is reached in the middle of a pass. The batch stops after 5 failures in a row and the same command carries on later.

## Step 11. API and React page

**What it does.** It adds a small web API and a one-page web app. The page has three views. Ask sends a question and shows the answer with its quoted sources. Trace shows what the agent did for one run. Results shows the eval table and a chart of correctness against cost. `npm run api` uses the real agent and verifier. `npm run api:mock` serves canned data, which costs nothing and needs no credential.

Run it in two terminals:

```sh
npm run api:mock   # the API on port 8787, with mock data
npm run web        # the page, on the address Vite prints
```

**The pieces.**

- `src/server/app.ts` builds the API with Hono. `createApp(deps)` takes everything it needs as one object, so the real server, the mock server and the tests share the same routes. `POST /api/ask` checks the question, calls `deps.answer`, saves the run and returns it with the passages it cites. `GET /api/runs/:id` returns a stored run. `GET /api/results` returns the eval summary. `GET /api/setups` fills the dropdown and says whether the data is mock.
- `src/server/types.ts` holds `ServerDeps` and the response shapes. `AnswerFn` and `PassageLookup` come from `src/types.ts`. That file imports nothing from Node, so the web page can import these types too.
- `src/server/index.ts` starts the server. `createRealDeps()` is the one place where the real parts get connected. `answer` is the same `createAnswerFn` the command line and the eval use, runs are read and written in MongoDB, and the results come from `results/summary.json`.
- `src/server/mock.ts` builds mock dependencies. The canned answer uses real passages and real quotes from `data/sample/`. Every number in it is made up. A question with the word "approved" gets a declined answer and a question under four words gets a clarifying question, so all three answer shapes can be seen. The mock summary uses the setup list from `src/eval/setups.ts` and the frontier rule from `src/eval/frontier.ts`. Four of its setups have three repeats and the rest have one, and it has a judge audit, so the Results view can be seen in full.
- `src/eval/types.ts` holds the eval types that the Results view reads.
- `vite.config.ts` tells Vite that the page lives in `web/` and passes `/api` calls on to the API.
- `web/index.html` is the one HTML file. `web/src/main.tsx` starts React inside it.
- `web/src/App.tsx` holds the tabs, the mock banner, the footer and the run on screen. `web/src/api.ts` has the four `fetch` calls.
- `web/src/views/Ask.tsx`, `Trace.tsx` and `Results.tsx` are the three views. `web/src/components/Answer.tsx` draws one answer. `web/src/components/CostChart.tsx` draws the chart as plain SVG.
- `web/src/format.ts` turns numbers and dates into text. `web/src/examples.ts` lists the example questions. `web/src/styles.css` is the one stylesheet.
- `tests/server.test.ts` calls the routes with `app.request`, which needs no network and no open port.

**Why it is built this way.**

- The API gets its dependencies passed in. The routes never import the agent or MongoDB, so the tests run without either and mock mode cannot spend money.
- The API sends the cited passages with the run. The page can show the page title, the link and the last-updated date next to each quote without a second request.
- Every error is JSON with one `error` field. The details go to the server log. A stack trace never reaches the browser.
- When saving a run fails, the answer is still returned. It has already been paid for.
- The page calls `/api` on its own address and Vite passes the call on. The browser never makes a cross-origin request, so the API needs no CORS setup.
- The server listens on `127.0.0.1` only. A question can cost money, so other machines on the network cannot reach it.
- The page imports types from `src/` with `import type`. These imports vanish when the page is built, so no server code ends up in the browser. `npm run typecheck` checks the server and the page, so the two cannot disagree about a response.
- All three views stay mounted and the tabs only hide them. An answer that is still loading is not lost when you look at another tab.
- The chart is plain SVG with no chart library. The cost axis is a log scale, so each marked value is about double the one before it. The cheapest setup costs under one cent an answer and the most expensive costs tens of cents. On a straight scale the cheap setups would sit on top of each other in the left corner. The correctness axis starts at the ten below the lowest setup. The caption says both. Frontier setups are filled dots joined by a line and the others are hollow rings, so the chart can be read without colour. The table above it has the same numbers.
- The eval repeats only some setups. A row that ran more than once shows its number of repeats, and the lowest and the highest repeat under correctness and unsupported claims. A row that ran once shows one number. The chart draws the same range as a thin line through the dot.
- The Results view says in one sentence how often the judge agreed with a person. It reads `judge_audit` from the summary. When that is null it says the agreement has not been measured yet.
- Nothing in the page counts the setups or reads meaning into a setup ID. The dropdown, the table and the chart are built from the lists the API sends, so a new setup such as `H5-0` needs no change in the page.
- In mock mode a banner stays at the top of the screen while you scroll, so no made-up number is shown without its label.

**Coming from React Native.**

What is the same:

- Components, props, `useState`, `useEffect`, `fetch` and TypeScript work the same way.
- A list is still `array.map(...)` with a `key`.

What differs:

- There is no `View` or `Text`. You write HTML elements such as `div`, `p`, `button`, `table` and `form`. The element you pick matters, because keyboards and screen readers treat a `button` and a `div` differently.
- Styles live in a CSS file and are attached with `className`. There is no `StyleSheet.create`. Layout is not flexbox by default, so a container asks for it with `display: flex` or `display: grid`.
- `onPress` is `onClick`. `onChangeText` is `onChange`, and the text is in `event.target.value`.
- A `form` reloads the page when it is submitted. `event.preventDefault()` stops that.
- The page scrolls by itself. There is no `ScrollView`.
- Light and dark colours come from the CSS rule `prefers-color-scheme`. There is no `useColorScheme`.
- Vite does the job of Metro. It serves the code while you work, and `npm run web:build` bundles it into `web/dist`.

**What could break.**

- The API is not running. The page shows "Could not reach the API". Start it with `npm run api:mock`.
- `npm run api` cannot reach MongoDB. The server does not start. It stops with a `MongoServerSelectionError`. Check `npm run db:ping`.
- `npm run api` has no credential. The server starts, and the first question returns an error that the page shows. Check the `.env` file.
- Port 8787 is taken. Set `API_PORT` for both commands, for example `API_PORT=8911 npm run api:mock` and `API_PORT=8911 npm run web`.
- A type imported by the web page starts to import Node code. The web type check then fails with an error about a missing `node:` module. Shared types belong in `src/types.ts`, which imports nothing.
- Mock runs live in memory. They are gone when the server stops, so an old run ID no longer loads.
- Nothing limits how often a person can ask, and each real answer costs money. The API must stay on `127.0.0.1` until it has a limit.
- Two setups land on almost the same spot in the chart. A verifier-on setup often costs only a little more than its verifier-off twin, so their dots can touch. The labels are kept apart and a frontier dot is drawn on top of a ring. The table has the exact numbers.
- A setup has a cost of zero. A log scale has no place for zero, so the chart draws it at a tenth of a cent.
- React runs each effect twice in development because of `StrictMode`. The page then asks for the setups and the results twice. The built page asks once.
- A claim cites a passage that is missing from the database. The quote is still shown, with a note that the source page was not found.

## Step 12. README and docs

**What it does.** It writes the README from the committed results, adds a second report that breaks the runs down further, and adds two screenshots of the web page. No model was run for the report. It only counts what step 10 stored.

**The pieces.**

- `src/eval/detail.ts` builds `results/detail.md`. `npm run eval -- report` now writes it next to `summary.md`. It has eight tables.
  1. What the two checks did. For each verifier-on setup it counts the claims in the drafts, how many failed the quote check, how many the verifier model did not support or only partly supported, how many runs had a repair, how many claims were still not supported after the repair, and how many summaries were rebuilt.
  2. Pairs that share a draft. When a verifier-on run ends with the same answer as its twin, the judge graded the same text twice, so a different score is the judge's own noise. When the answer changed, the table gives the mean change in correctness.
  3. Correctness by category.
  4. Behaviour. How often the agent answered, declined or asked when it should.
  5. Missing points and retrieval. For each expected point the judge found missing, it looks up the passage the point was drafted from, in the `evidence` field of the question. Then it checks the trace. The passage was never returned by a search, or it was in a search result only, or the agent read it in full. For the passages never returned, one more column counts those where another passage of the same page was returned or read. In those runs the agent had the right page and not the right passage.
  6. The 12 hardest questions.
  7. Runs with no answer, with the reason.
  8. Second opinions on the judge. Two other models labelled the 45 items of the judge audit sample without seeing the judge's labels. The table says how often each one gave the same label as the judge, and lists the items where the labels differ.
- `eval/judge-audit-reviews.json` holds those labels with each reviewer's reasons, the rules the reviewers were given and how each one was run. `scoreReviews` in `src/eval/judgeAudit.ts` compares them with the key file. `npm run eval -- audit-score` prints the result, and `report` writes table 8 from it.
- `README.md` follows the order of a customer project. It gives the results first, then the problem, the demo, how it works, the data, the evaluation, what the eval taught, the limits, what to improve next, deployment notes and the design decisions.
- `docs/img/` holds the two screenshots. They were taken from the page running on the real results, and the answer in `ask.png` is one real run.

**Why it is built this way.**

- Every number in the README can be found in a file under `results/`. The findings that `summary.md` cannot show, such as how many missing points are a search problem, needed their own report. Writing that report as code means it can be rerun and tested, and nobody has to trust a number worked out by hand.
- The retrieval hit rate of step 9 is measured per page. A long page has dozens of passages, so the right page can be in the results while the right passage is not. Table 5 measures the passage. That is what showed that search loses more points than reading does.
- The judge was meant to be checked by a person. That has not happened, so two other models labelled the sample instead. One is the same model as the judge, so its agreement mostly shows that the judge is consistent. The other is from a different model family, so it is the more independent of the two. Both are still models, and the README says so. The sheet stays empty for a person, and `audit-score` reports both kinds of label apart.
- The README says what was not done. No person has labelled the judge audit sheet, the gold set was not compared with the live site, and the search was not improved. A reader can then tell a measured result from a plan. The section on what to improve next lists those plans in order, and each one points back to a finding.

**What could break.**

- The eval is run again. The README is written by hand from the results, so its numbers no longer match. Run `report`, then update the README from `summary.md` and `detail.md`.
- A column of `summary.md` is misread. "Dropped by quote check" and "Dropped by verifier" count the claims that were not supported in the first pass, before the repair. The number of claims removed in the end is in table 1 of `detail.md`.
- A question loses its `evidence` field. Table 5 then counts its missing points as never returned. The linter of step 8 warns about an expected point with no evidence.
- A setup has runs for only some repeats of its twin. The pairs table skips the runs that have no partner and does not say so.
- The audit sample is drawn again. The second opinions then belong to another sample. `scoreReviews` stops with an error when an item of the key has no label from a reviewer.
