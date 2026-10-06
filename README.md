# UK visa guidance agent

An unofficial assistant that answers UK student and graduate visa questions from published government guidance. Every claim comes with a word for word quote and a link, and a verifier checks each claim against its source before the answer is shown.

This project is not affiliated with GOV.UK or the Home Office. It gives general information, not legal advice. Always check the page it links to.

The build is in progress. The full README, with measured results, comes with the last step.

## Run it

```bash
npm install
cp .env.example .env
npm run db:ping
npm test
```

You need Node 22 or later and MongoDB running locally.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md). It grows by one section per build step.

## Licence

The code is under the MIT licence.

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
