# Rules for the assistant

## Documentation

Before making changes, read the relevant project documentation and follow its requirements.

Keep implementation details, rationale, history, measurements, workflows, path conventions, isolation rules, customization guidance, and other project-specific policies aligned with the documentation.

## Writing code

Keep comments sparse and concise. Add a short clause only where omitting it could cause the code to be changed incorrectly later. Do not place explanatory paragraphs above code.

Do not use emoji or bold formatting in code or comments.

Keep rationale, history, measurements, and other explanatory material in the project documentation rather than in source code.

After an edit, check for code that may have become orphaned, using the project's review tooling.

Before trusting a locator, guard, or tripwire, prove that it can fail as intended. Feed it a known match, or temporarily revert the relevant change and confirm that the check turns red.

Inside single-quoted strings, prefer rewording over escaping an apostrophe.

Bash preserves its working directory between calls. Use absolute paths where path ambiguity could matter.

## Commits

Never commit, push, or release unless explicitly asked.

Before committing, audit the entire diff line by line.

Use commit messages in the form:

`type(scope): summary`

Follow with one or two concise English sentences when additional context is needed. Do not include AI attribution.

When splitting a batch of changes, replay and verify each slice independently.

## Verification

All required project verification gates must pass before considering a change complete.

For any operation that may write to disk, run the project's write-detection checks before and after the operation, including at least one real application session where required.

Remember that write-detection checks observe writes, not reads.

## Documentation style

Write project documentation in Chinese.

Use half-width `,` `:` `;` `(` `)` and full-width `。` `、`.

Use corner brackets `「」`.
