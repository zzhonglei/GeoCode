# Rules for agents

GeoCode is a desktop AI application for geographic work: `kernel/` is its kernel, based on OpenCode; `desktop/` is the desktop app, based on OpenChamber; `geoengine/` is its geo engine.

## Read first

- `docs/development/CONVENTIONS.md` holds the project's rules, and `docs/development/DEVELOPMENT.md` how to build, run, and test. Read both before changing anything.
- The other files in `docs/` describe the design of each part; read the one for the part you change.
- `.artifacts/` holds the maintainer's private notes and is not tracked. When it exists, read its `README.md`, `WORKFLOW.md`, and `OPEN.md` before starting: they add the maintainer's own rules to the conventions. Never reference `.artifacts/` from source code or from `docs/`.

## Always

- Never commit, push, or release unless explicitly asked.
- Before deleting anything, look at it and confirm with the maintainer.
- Ask before changing anything outside the repository.
- Report what you verified and what you did not; when a check fails or was not run, say so.
