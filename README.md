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

```
browser (apps/web) ──HTTP──> Fastify API (apps/server) ──> one ClinicalRuntime per patient
                                                             ├─ screen run      (per situation, ~4–5 s)
                                                             ├─ answer run      (per follow-up question, ~2–3 s)
                                                             └─ background, once per patient, in parallel:
                                                                  fact index + review, contradiction scan
                                                           SQLite store per patient (.data/)
```

What we built:
- `packages/patient-record`: loads a patient's documents, decodes `<BR>` and HTML entities, splits each document into numbered passages (sentences and table rows) and checks that a quote appears in a passage.
- `packages/shared`: types shared by server and web.
- `apps/server`, a Fastify API with one runtime per patient folder in `data/`:
  - **Fact index** (`agent/factIndex.ts`): once per patient, in the background, the record is cut into parts of at most 40 passages. Each part is indexed by one model run and then checked by a second run that compares every value with its passages, correcting or dropping what the passage does not say. The parts run in parallel, so the index is ready in about 20 s.
  - **Screen** (`agent/clinical.ts`): per situation, one model run reads the whole record and the fact index, works out what this role needs for this task and submits the screen through a tool, picking indexed facts by ID and marking needs as "not documented" when the record has nothing. Until the index is ready, a screen reads the whole record alone, so no screen waits for the background work.
  - **Citations** (`agent/citations.ts`): every quote must appear word for word in the passage it cites (spacing and case aside; "…" may join two pieces). A failed check goes back to the model to fix; a fact that still fails is dropped, so every fact on screen links to its passage.
  - **Contradictions** (`agent/clinical.ts`, `agent/measurements.ts`): a model scan in two passes over all documents, plus rule checks such as a BMI that does not match the height and weight in the same letter. Each contradiction links all its passages.
  - **Assessment and checks** (`agent/assess.ts`, `agent/safety.ts`, `agent/clarify.ts`, `agent/basics.ts`): rules that mark each fact as current, old or contradicted, run drug checks such as sick-day and pre-operative pausing rules (from the guidance in `references/`), and list what to clarify with the patient.
  - **Follow-up answers** (`agent/answers.ts`): a question about the record, answered from the documents with cited facts.
  - Durable model runs with [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) on [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai): every screen, index, scan and model turn is kept in SQLite, so results survive a restart and a repeated situation is served from the store.
- `apps/web`: React and Vite UI with the situation input (typed or dictated), the screen, a document panel that highlights the cited passage, the patient overview with vital charts, and notes.

Models and services:

| Job                           | Model                        | Reasoning |
| ----------------------------- | ---------------------------- | --------- |
| Screens and follow-up answers | `openai-codex/gpt-6.1-terra` | low       |
| Fact index and its review     | `openai-codex/gpt-6.1-terra` | low       |
| Contradiction scan            | `openai-codex/gpt-6.1-terra` | high      |

The model is reached through the user's ChatGPT sign-in (OpenAI Responses API) on ChatGPT's fast mode (`service_tier: priority`). Any other pi-ai provider works by setting `MODEL` and its API key in `.env`; see `.env.example` for every setting. No other external service is used. The patient data stays local apart from the model calls.

## Metric results

Measured with `pnpm eval --set all` on 30 October 2026, on a fresh store with the default settings above. The eval types each situation's title and description into the app and grades the screen against `cases/expected.json` with regular expressions over the fact text, so a "MISS" can still be a correct answer worded differently.

| Metric                         | Result                                                                                                                     | Target     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Correct answers (5 situations) | 13 of 15                                                                                                                   | 15 of 15   |
| Traceability                   | Every fact on screen quotes its linked passage word for word (checked in code; facts that fail are dropped)                | 100%       |
| Invented facts                 | Not counted by hand yet; every fact must quote its passage, and the index review drops values the passage does not support | 0          |
| Contradictions                 | 7 real, 0 false alarms                                                                                                     | 5 or more  |
| Load time, slowest of the 5    | 4.9 s                                                                                                                      | under 10 s |

What does not work yet:
- **2.3, the date of the planned operation.** The screen shows "Quadrantectomy and IORT" with its date in the date column, but that column shows month and year only (05/16), not the day, 16 May 2016.
- **3.3, the weight change.** The screen shows 66 kg and a loss of 12 kg since June 2015, but not the 78 kg and 67 kg it was computed from.
- **The first screen right after the first start** reads the whole record while the fact index is being built (about 20 s per patient) and takes 9–16 s. Every screen after that takes 4–5 s, and a repeated situation is served from the store.
- Across runs the model picks slightly different facts: an earlier run with high reasoning for the index scored 14 of 15, and six of the seven benchmark runs before the parallel index scored 33 of 33 on the five situations and six held-out ones.
