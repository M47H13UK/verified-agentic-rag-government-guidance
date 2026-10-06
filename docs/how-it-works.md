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
