# Rules for agents

GeoCode is a desktop AI application for geographic work: `kernel/` is its kernel, based on OpenCode; `desktop/` is the desktop app, based on OpenChamber; `geoengine/` is its geo engine.

## Read first

- `docs/development/CONVENTIONS.md` holds the project's rules, `docs/development/DEVELOPMENT.md` how to build and run, and `docs/development/TESTING.md` how to test. Read all three before changing anything.
- The other files in `docs/` describe the design of each part; read the one for the part you change.
- `.artifacts/` holds the maintainer's private notes and is not tracked. When it exists, read its `README.md`, `WORKFLOW.md`, and `OPEN.md` before starting: they add the maintainer's own rules to the conventions. Never reference `.artifacts/` from source code or from `docs/`.

## Always

- Never commit, push, or release unless explicitly asked.
- Make and commit every change as `.artifacts/WORKFLOW.md` says, when it exists.
- Before deleting anything, look at it and confirm with the maintainer.
- Ask before changing anything outside the repository.
- Run tests only through `node scripts/test.mjs` (see `docs/development/TESTING.md`); never run a package's test command directly: it does not swap the home, and some write the user's real one.
- Report what you verified and what you did not; when a check fails, was skipped, or was not run, say so.
