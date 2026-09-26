# Rules for agents

GeoCode is a desktop AI application for geographic work. It is a thin fork of two vendored upstreams: OpenCode V2 in `kernel/` and OpenChamber 2 in `desktop/`. Most rules here exist so that both upstreams can keep being merged for the long term.

## Documentation

Before making changes, read the relevant documentation in `docs/` and follow its requirements. `docs/CONVENTIONS.md` governs code, patches, and upstream merges.

Keep implementation details, rationale, history, measurements, workflows, path conventions, isolation rules, customization guidance, and other project-specific policies aligned with the documentation.

`.artifacts/` holds the maintainer's private working notes and is not tracked. When it exists, read `.artifacts/OPEN.md` first for the current state and next steps. Never reference it from source code.

## Upstream code

Prefer configuration, environment variables, plugins, external processes, and UI changes over source patches, in that order. A source patch states why the options above it cannot do the job.

Do not fix upstream defects. Compare against the pristine branches, `kernel-upstream` and `chamber-upstream`, to decide whether a behavior is upstream's or ours.

Every patch must be found by the marker grep in `docs/CONVENTIONS.md`. Masked upstream lines stay byte-identical.

New upstream versions enter only by re-vendoring onto the pristine branches, never by merging upstream history directly.

## Writing code

Write code, comments, and commit messages in English.

Keep comments sparse and concise. Add a short clause only where omitting it could cause the code to be changed incorrectly later. Do not place explanatory paragraphs above code.

Do not use emoji or bold formatting in code or comments.

Keep rationale, history, measurements, and other explanatory material in the project documentation rather than in source code.

After an edit, check for code that may have become orphaned, using the project's review tooling.

Before trusting a locator, guard, or tripwire, prove that it can fail as intended. Feed it a known match, or temporarily revert the relevant change and confirm that the check turns red.

Inside single-quoted strings, prefer rewording over escaping an apostrophe.

Bash preserves its working directory between calls. Use absolute paths where path ambiguity could matter.

## Changes outside the code

Ask before changing anything outside the repository, such as a Python environment or global tool configuration.

Before deleting anything, look at the target and confirm with the maintainer.

## Commits

Never commit, push, or release unless explicitly asked. A request to commit does not include pushing.

Before committing, audit the entire diff line by line.

Use commit messages in the form:

`type(scope): summary`

Follow with one or two concise English sentences when additional context is needed. Do not include AI attribution.

When splitting a batch of changes, replay and verify each slice independently.

## Verification

All required project verification gates must pass before considering a change complete.

For any operation that may write to disk, run the project's write-detection checks before and after the operation, including at least one real application session where required.

Remember that write-detection checks observe writes, not reads.

Treat conclusions from delegated agents as leads, and verify the ones a decision depends on yourself.

## Documentation style

Write project documentation in Chinese.

Use half-width `,` `:` `;` `(` `)` and full-width `。` `、`.

Use corner brackets `「」`.
