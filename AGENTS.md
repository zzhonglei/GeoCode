# Rules for agents

GeoCode is a desktop AI application for geographic work, built on two upstreams whose source lives in this repository: OpenCode in `kernel/` and OpenChamber in `desktop/`.

## Read first

- `docs/CONVENTIONS.md` is authoritative for code style and comments, changes to upstream code, tests, documentation, and commit messages. Read it before changing anything.
- `docs/UPSTREAM.md` governs importing and upgrading the upstreams; `docs/DEVELOPMENT.md` covers installing, building, and running.
- `.artifacts/` holds the maintainer's private working notes and is not tracked. When it exists, read `.artifacts/OPEN.md` first. Never reference it from source code or from `docs/`.

## Working with the maintainer

- Never commit, push, or release unless explicitly asked. A request to commit does not include pushing.
- Before committing, audit the entire diff. When a batch is split into several commits, verify each slice on its own.
- Ask before changing anything outside the repository, such as a Python environment or global tool configuration.
- Before deleting anything, look at the target and confirm with the maintainer.

## Verification

- A change is complete only when the project's checks pass.
- Before trusting a locator, guard, or tripwire, prove that it can fail: feed it a known match, or revert the change it protects and confirm that it turns red.
- Run `scripts/foreign-writes.sh before` and `after` around any operation that may write to disk, and around at least one real application session when a change affects runtime paths. It observes writes, not reads.
- After an edit, run `node scripts/dead-code.mjs` on the touched files.
- Before committing changes to `desktop/`, run `node scripts/own-anti-slop.mjs`.
- Treat conclusions from delegated agents as leads, and verify the ones a decision depends on.

## Shell

- Bash keeps its working directory between calls. Use absolute paths where it matters.
- Inside single-quoted strings, reword rather than escape an apostrophe.
