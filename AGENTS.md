# Agent notes

## Checks

- `pnpm check` runs Biome on the whole repo, every typecheck and every test. Run it before calling a change done.
- Passage IDs and texts (`packages/patient-record/src/passages.ts`) feed the model prompts and the cached screens in `.data/agent.sqlite`. Changing how a letter is split invalidates both, so compare the passages against `HEAD` on all eight letters after touching the splitter.
- Editing `SCREEN_RULES` or `ANSWER_RULES` changes the cache key, so every screen or follow-up answer is generated again and spends model calls. The "To clarify" list and the patient basics are computed from the cached screen on each request, so changing them costs nothing.
- `.data/agent.sqlite` also holds the notes clinicians record (`track1.notes`), not only caches. Deleting it to clear the caches deletes those notes too.
- The scripted model in `apps/server/test/screens.test.ts` takes a second script for `submit_answer`, for follow-up questions.

## Checking the UI without a model account

`pnpm dev` needs the ChatGPT sign-in and spends model calls. For UI checks, run the server on a scripted model instead: `ClinicalRuntime.open` with `MemoryStorage`, the faux provider as `scriptedModels` in `apps/server/test/screens.test.ts` sets it up, and `buildApp(runtime, { webDist })` on a `vite build --outDir` output. Without `login`, `/api/auth` does not exist, so add a route that answers `{ signedIn: true, ... }`. Keep such a script in a gitignored folder (any `dist/`) and delete it afterwards.
