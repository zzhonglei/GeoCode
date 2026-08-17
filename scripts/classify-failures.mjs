/* Group the vendored suite's failures by cause.
 *
 * Two deliberate GeoCode changes leave a large block of upstream tests
 * asserting things we no longer ship, and a raw failure count cannot tell that
 * block apart from a real regression. This can, so the question after a merge
 * becomes "did the unexplained bucket grow".
 *
 * bun prints a failure's error text BEFORE the line naming it, so the evidence
 * for a failure is the run of lines since the previous one. */
import fs from "node:fs"

/* Colour comes off before anything is matched.
 *
 * bun writes its reporter output with ANSI escapes even into a file, and they
 * sit INSIDE the text the rules below read — a stack frame reads
 * `<esc>[0m      <esc>[2mat ...`, so the frame filter's `^\s*at ` never fired,
 * and assertion values carry escapes between the characters the identity rule
 * looks for.
 *
 * The failure marker was the worst of it: bun 1.3 writes `✗ <name> [12ms]`,
 * coloured, and this script matched `(fail) <name>`. Nothing matched, so every
 * run reported ZERO failures — the one shape a broken classifier must never
 * take, because "nothing to see" is word for word what a clean merge looks
 * like. Both spellings are accepted so a bun version that restores the older
 * word does not break it a second time. */
const decolour = (text) => text.replace(/\x1b\[[0-9;]*m/g, "")
const FAILURE_LINE = /^(?:✗|\(fail\)) (.+?) \[[\d.]+m?s\]$/

/* Bun prints a stack frame beneath the error text, and that frame carries the
 * absolute path of the test file — which inside this package always contains
 * the string `opencode`. The identity rule below matches on that string, so
 * before the frames were dropped it claimed 75 of the package's 85 failures,
 * and 41 of those named the old identity NOWHERE ELSE. They read as expected
 * rename drift and were not: the prompt-selector failure was one of them.
 *
 * Assertion values are left alone. An on-disk identity failure legitimately
 * shows a path in its Expected or Received, and that path is the evidence. */
const withoutFrames = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*at /.test(line))
    .join("\n")

/** Assertions naming the pre-rename identity, against code that now derives
 * every branded path and file name from the Brand module. */
const namesOldIdentity = (text) =>
  /opencode\.jsonc?|T\/opencode|tmpdir\(\), "opencode"|["'/]opencode["'/]|\.opencode\b/.test(text) &&
  /Expected|NotFound|toBe|toEqual|toContain/.test(text)

const RULES = [
  {
    name: "geographic handoff (expected)",
    // `read` now redirects the formats ReadGeoData opens (GEOKERNEL §10.1 #10),
    // so upstream tests that reach its text or binary path THROUGH one of those
    // extensions stop where they used to continue. `.tiff` is the live case:
    // upstream uses it to prove an unsupported image mime falls through to
    // text, and to GeoCode a .tiff is raster data with a reader of its own.
    //
    // Ordered FIRST because the rules are first-match and the identity rule
    // below is broad enough to claim anything whose evidence mentions a
    // branded temp path — which most of these do.
    test: (text) => /Use the ReadGeoData tool/.test(text),
  },
  {
    name: "agent line-up (expected)",
    // GeoAgent is the only primary and the code-oriented subagents are off, so
    // upstream tests naming build / explore / general have nothing to run.
    // Disabled through the assembly layer, which config can override — so the
    // fix, when we make it, belongs in a shared fixture rather than per test.
    // Three spellings, because the same missing agent surfaces differently
    // depending on who looked for it — and a rule that catches only one leaves
    // the rest sitting in the bucket that is supposed to mean "look at this".
    test: (text) =>
      /Agent not found: .{0,3}(build|explore|general)|Unknown agent type: (build|explore|general)|Available agents: GeoAgent|agent=(build|explore|general)\b|\b(build|explore|general) agent\b/.test(
        text,
      ),
  },
  {
    name: "on-disk identity (expected)",
    test: (text) => namesOldIdentity(withoutFrames(text)),
  },
  {
    name: "was claimed by the stack frame alone — triage debt",
    // Exactly what the identity rule used to take on the strength of the file
    // path. Named and counted rather than tipped into `unexplained`: they are
    // not new, and letting forty of them bury the handful that ARE new would
    // trade one blind spot for another. The bucket empties by classifying its
    // contents into honest rules — never by widening one again. Full list is in
    // the raw output this script was pointed at.
    test: (text) => namesOldIdentity(text),
  },
  {
    name: "feature removed (expected)",
    // GeoCode loads neither external plugins nor `{tool,tools}/*.ts`, so tests
    // for those have nothing to exercise. Whole files that test only this are
    // skipped in test-upstream.sh; this rule is for the ones mixed into a file
    // that still covers something we ship — tool/registry.test.ts above all,
    // where the registry itself is where the geo tools land.
    test: (text) => /custom tool|config-scoped plugin|external plugin/i.test(text),
  },
  {
    name: "environment (locale)",
    // yargs localizes `--help`, so the snapshot only matches on an English
    // machine. Nothing to do with our code.
    test: (text) => /選項|选项|\[布林\]|\[布尔\]/.test(text),
  },
  {
    name: "external dependency",
    test: (text) => /ECONNREFUSED|ENOTFOUND|certificate|EAI_AGAIN|fetch failed|socket hang up/i.test(text),
  },
  { name: "timeout under load", test: (text) => /timed out after/i.test(text) },
]

const UNEXPLAINED = "unexplained — look at these"

for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) continue
  const raw = fs.readFileSync(file, "utf8")
  const lines = decolour(raw).split("\n")
  const failures = []
  let evidence = []
  for (const line of lines) {
    const hit = FAILURE_LINE.exec(line)
    if (hit) {
      failures.push({ name: hit[1], evidence: evidence.join("\n") })
      evidence = []
      continue
    }
    evidence.push(line)
    // Long enough to reach the error printed above a failure, bounded so one
    // huge dump cannot leak its cause onto the next test.
    if (evidence.length > 120) evidence.shift()
  }

  /* Cross-check against the tally bun printed for itself.
   *
   * Everything above depends on one regex still matching the reporter's output,
   * and when it stopped matching the script did not fail — it reported a clean
   * run, which is exactly the answer a clean run gives. This is the only check
   * that does not go through the parser, so it is the only one that can catch
   * the parser. */
  const reported = /^\s*(\d+) fail\b/m.exec(decolour(raw))?.[1]
  if (reported !== undefined && Number(reported) !== failures.length) {
    console.log(
      `\n!! ${file}: bun reported ${reported} failures, this script found ${failures.length}.` +
        `\n   The reporter's format has moved — fix FAILURE_LINE before trusting anything below.`,
    )
  }

  const buckets = new Map()
  for (const failure of failures) {
    const rule = RULES.find((candidate) => candidate.test(`${failure.evidence}\n${failure.name}`))
    const key = rule?.name ?? UNEXPLAINED
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(failure.name)
  }

  console.log(`\n===== ${file} — ${failures.length} failures =====`)
  for (const [key, names] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n## ${key}  (${names.length})`)
    // The expected buckets are counted, not listed; the unexplained one is the
    // whole point of running this, so it is always shown in full.
    if (key !== UNEXPLAINED && names.length > 5) {
      for (const name of names.slice(0, 5)) console.log(`  - ${name}`)
      console.log(`  … and ${names.length - 5} more`)
      continue
    }
    for (const name of names) console.log(`  - ${name}`)
  }
}
