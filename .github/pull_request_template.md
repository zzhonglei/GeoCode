<!--
Title it as a commit message, in English: type(scope): summary (CONTRIBUTING.md, section 5).
New features, behavior changes and text for the model need an issue the maintainer agreed to first (section 1).
The description may be written in English or Chinese.
-->

## What and why

<!--
A few short sentences: what the user ran into, what they see now, and why this way if there was a choice.
Write Fixes #<number> for a bug. No file lists: the reviewer reads the diff.
-->



## How it was checked

<!--
The checks and tests you ran and their results; what you tried in the app, on which system, and what you saw.
Say what you did not verify, especially on the other platform (macOS or Windows).
-->



## Screenshots

<!-- For a change to the interface, before and after. Otherwise delete this section. -->

## Checklist

- [ ] This pull request does one thing
- [ ] I ran the type checks and lint of what I changed, and its tests through `node scripts/test.mjs`: `changed` before committing, or its suites by name after
- [ ] Upstream files under `kernel/` and `desktop/` are untouched, or only call into a `geocode/` folder and are marked `GeoCode:`
