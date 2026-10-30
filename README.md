# Track 1: Roter Faden

A clinician types their role and task and gets one screen with the patient facts that task needs. Every fact links to the passage it comes from, gaps say "not documented", and contradictions in the documents are flagged.

## Setup

The patient data is not in this repository. Get it from the hackathon repository and copy `data/` and `cases/` into the root of this one (both are git-ignored):

```bash
git clone https://github.com/AIM-Austria/TRACK-1-clinical-documentation.git ../TRACK-1-clinical-documentation
cp -R ../TRACK-1-clinical-documentation/data ../TRACK-1-clinical-documentation/cases .
```

Then, with Node 22.22.3 or newer and pnpm:

```bash
pnpm install
cp .env.example .env   # optional: model and provider settings
pnpm dev               # web on http://localhost:5173, API on http://127.0.0.1:3001
```

By default the app signs in with a ChatGPT account on its sign-in page. To use another provider, set `MODEL` and its API key in `.env`.

| Command      | What it does                                                               |
| ------------ | -------------------------------------------------------------------------- |
| `pnpm dev`   | Web app and API with reload                                                |
| `pnpm start` | Builds the web app and serves it from the API                              |
| `pnpm eval`  | Runs the five situations from `cases/` and writes the screens to `output/` |
| `pnpm check` | Lint, typecheck and tests                                                  |

## Architecture

- `packages/patient-record`: loads the documents, decodes `<BR>` and HTML entities, splits each document into numbered passages (sentences and table rows) and checks that a quote appears in a passage.
- `packages/shared`: types shared by server and web.
- `apps/server`: Fastify API. Per situation, one model run on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) gets the whole record as passages and submits a screen through a tool. Every cited quote is checked against its passage; a failed check is sent back to the model, and facts that still fail are dropped. A separate one-off run finds contradictions, which are stored and shown on every screen. Once per patient, in the background, the record is also indexed fact by fact in parallel parts of at most 40 passages, each reviewed against its passages; screens then pick facts from that index. No screen or answer waits for this background work: until the index is ready, a screen reads the whole record. Results are kept in SQLite under `.data/`.
- `apps/web`: React and Vite UI with the situation input, the screen and a document panel that highlights the cited passage.
