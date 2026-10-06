# Reading the build step by step

The build is tagged in git as `step-00`, `step-01` and so on. Each tag is a complete snapshot that runs. Two commands let you read the build in that order.

## `npm run review`

It builds `review/index.html` and opens it in the browser. The page has one section per step, with the diff against the step before it and links to GitHub. Lockfiles, data files and very large files start collapsed.

- Notes for a step go in `review/notes/step-NN.md`, in Markdown. They show above that step's diff.
- Git ignores the `review/` folder, so the page and the notes stay on your machine.
- `npm run review -- --no-open` builds the page without opening it.

## `npm run step <n>`

It checks out one step into its own folder next to the repository, for example `../uk-visa-guidance-agent-steps/step-03`. The main checkout is not touched.

- `npm run step 3` creates the folder or reuses it, runs `npm ci` there, and links your `.env` instead of copying it.
- Then run `npm run typecheck` and `npm test` in that folder.
- `npm run step -- 3 --no-install` skips `npm ci`.
- `npm run step list` lists the steps. `npm run step clean` removes the step folders.
