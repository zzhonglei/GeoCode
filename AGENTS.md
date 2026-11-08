# Rules for agents

GeoCode is a desktop AI application for geographic work: `kernel/` is its kernel, based on OpenCode; `desktop/` is the desktop app, based on OpenChamber; `geoengine/` is its own geo engine. GeoCode keeps merging new upstream versions into `kernel/` and `desktop/`, so changes there follow extra rules.

## What to read

| When | Read |
|---|---|
| Every time, before starting | `docs/development/CONVENTIONS.md`; when `.artifacts/` exists, its `README.md`, `WORKFLOW.md` and `OPEN.md` |
| Before changing any file under `kernel/` or `desktop/` | `.artifacts/UPSTREAM.md` when it exists, otherwise `CONVENTIONS.md` section 3 |
| Before changing a part of GeoCode | its design document under `docs/` (listed in `README.md`) |
| Writing code | the pitfalls in `docs/development/DEVELOPMENT.md` section 8, which tests and type checks do not catch |
| Building, running or packaging the app | `docs/development/DEVELOPMENT.md`, and `.artifacts/METHOD.md` when it exists |
| Writing or running tests | `docs/development/TESTING.md` |
| Upgrading upstream | `.artifacts/UPGRADE.md` and `.artifacts/CLOSED.md` |

`.artifacts/` holds the maintainer's private notes and is not tracked. When it exists, its rules add to the conventions. Never reference `.artifacts/` from source code or from `docs/`.

## Always

- Never commit, push, or release unless explicitly asked.
- Before deleting anything you did not create in this work, look at it and confirm with the maintainer. Files you created yourself, such as sandboxes, clones, downloads and temporary worktrees, may go once nothing is using them.
- Ask before changing anything outside the repository.
- Run tests only through `node scripts/test.mjs`; never run a package's test command directly: it does not swap the home directory, and some write the user's real one.
- Report what you verified and what you did not: say failures, skipped checks, suites that did not run, and platforms not verified, each separately.
