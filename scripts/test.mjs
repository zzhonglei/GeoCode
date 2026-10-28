// Runs GeoCode's own tests by suite: each part's unit tests, which touch stand-ins alone, and the tests on the real
// QGIS, the real Earth Engine and the installed base environment. Every run gets a home and a temporary folder of its
// own, so no test reaches the user's files but what is handed to it, and every result is read from the runner's JUnit
// report: what ran, what was skipped and why, and where a failure is.
//
// Usage:  node scripts/test.mjs [--list] <suite|changed|all>... [--file <test file>]...
//   suites   kernel ui web electron geoengine qgis gee osm scripts
//   changed  the suites the working tree's changes against HEAD call for
//   all      every suite
//   --file   one test file, run as its suite runs it
//   --list   prints what would run and why, and runs nothing
// Exits 1 when something failed, 3 when nothing failed but something was not run, and 2 on a usage error.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const at = (...parts) => path.join(top, ...parts)
const relative = (file) => path.relative(top, file).split(path.sep).join('/')

/** Files under a folder of the repository whose name `keep` matches, as repository paths. */
export const walk = (root, keep, found = []) => {
  if (!fs.existsSync(at(root))) return found
  for (const entry of fs.readdirSync(at(root), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const inside = `${root}/${entry.name}`
    if (entry.isDirectory()) walk(inside, keep, found)
    else if (keep.test(entry.name)) found.push(inside)
  }
  return found.sort()
}

/**
 * A run of one runner over some files. `tool` says how to ask it for a JUnit report; `only` picks the cases counted
 * when the runner is told to run some of a file's; `real` names what a real-software run is handed.
 */
const step = (cwd, tool, command, args, files, extra = {}) => ({
  cwd,
  tool,
  command,
  args: [...args, ...files.map((file) => argument(tool, cwd, file))],
  files,
  ...extra,
})

// Bun takes a file it is given as a part of paths to match, and would run `x.test.tsx` beside `x.test.ts`.
const argument = (tool, cwd, file) => `${tool === 'bun' ? './' : ''}${path.posix.relative(cwd, file)}`

// In a kernel package's test folder: GeoCode's own files, run whole, and upstream files holding GeoCode cases, of
// which only those whose name has `GeoCode:` run.
const OWN = /(^|\/)(geocode-[^/]*\.test\.tsx?|geocode\/.*\.test\.tsx?)$/
const MENTIONS = /["'`]GeoCode: /

const kernelSteps = () =>
  fs.readdirSync(at('kernel', 'packages')).flatMap((name) => {
    const where = `kernel/packages/${name}`
    const files = walk(`${where}/test`, /\.test\.tsx?$/)
    const own = files.filter((file) => OWN.test(file))
    const cases = files.filter((file) => !OWN.test(file) && MENTIONS.test(fs.readFileSync(at(file), 'utf8')))
    return [
      ...(own.length ? [step(where, 'bun', 'bun', ['run', 'test'], own)] : []),
      ...(cases.length
        ? [step(where, 'bun', 'bun', ['run', 'test', '-t', 'GeoCode:'], cases, { only: /GeoCode:/ })]
        : []),
    ]
  })

// The desktop's GeoCode tests live in each package's geocode folder.
const UI = 'desktop/packages/ui'
const WEB = 'desktop/packages/web'
const ELECTRON = 'desktop/packages/electron'

// One process a file, as the package's own script runs them: the UI's modules keep state for the process.
const uiSteps = () => walk(`${UI}/src/geocode`, /\.test\.tsx?$/).map((file) => step(UI, 'bun', 'bun', ['test'], [file]))

const webSteps = () => {
  const files = walk(`${WEB}/server/geocode`, /\.test\.m?js$/)
  return files.length ? [step(WEB, 'vitest', 'bun', ['run', 'test'], files)] : []
}

// The time limit turns a wait a test forgot into a failure, not a hang.
const electronSteps = () => {
  const files = walk(`${ELECTRON}/geocode`, /\.test\.mjs$/)
  return files.length ? [step(ELECTRON, 'node', 'node', ['--test', '--test-timeout=10000'], files)] : []
}

// GeoEngine's unit tests by the domain whose folder holds them; the engine's own sit in no folder.
const UNIT = ['engine', 'python', 'qgis', 'gee', 'osm']
export const unitDomain = (file) => /^geoengine\/test\/unit\/([^/]+)\//.exec(file)?.[1] ?? 'engine'

// One file after another: some tests start processes and check that they were ended.
// Given no file, node would look for tests itself and run the real ones.
const geoengineSteps = (domains = UNIT) => {
  const files = walk('geoengine/test/unit', /\.test\.ts$/).filter((file) => domains.includes(unitDomain(file)))
  return files.length ? [step('geoengine', 'node', 'node', ['--test', '--test-concurrency=1'], files)] : []
}

const realSteps = (domain) => () => [
  step('geoengine', 'node', 'node', ['--test'], [`geoengine/test/real/${domain}.test.ts`], { real: domain }),
]

const scriptsSteps = () => [step('', 'node', 'node', ['--test'], walk('scripts', /\.test\.mjs$/))]

export const SUITES = {
  kernel: kernelSteps,
  ui: uiSteps,
  web: webSteps,
  electron: electronSteps,
  geoengine: geoengineSteps,
  qgis: realSteps('qgis'),
  gee: realSteps('gee'),
  osm: realSteps('osm'),
  scripts: scriptsSteps,
}

// Where a test file belongs, for --file; and every file that looks like a test in the folders above, so that one no
// suite would run is reported rather than passed over.
const LOOKS_LIKE_A_TEST = /\.(test|spec|vitest)\.[cm]?[jt]sx?$/
const OWN_FOLDERS = [`${UI}/src/geocode`, `${WEB}/server/geocode`, `${ELECTRON}/geocode`, 'geoengine/test', 'scripts']
const OWN_IN_KERNEL = /(^|\/)(geocode-[^/]*|geocode\/.*)$/

export const unrun = () => {
  const run = new Set(Object.values(SUITES).flatMap((steps) => steps().flatMap((each) => each.files)))
  const kernel = fs
    .readdirSync(at('kernel', 'packages'))
    .flatMap((name) => walk(`kernel/packages/${name}/test`, LOOKS_LIKE_A_TEST))
    .filter((file) => OWN_IN_KERNEL.test(file))
  return [...OWN_FOLDERS.flatMap((folder) => walk(folder, LOOKS_LIKE_A_TEST)), ...kernel].filter(
    (file) => !run.has(file),
  )
}

const REAL = ['qgis', 'gee', 'osm']
// Whose scripts run in the bundled Python environment.
const ENVIRONMENT = ['gee', 'osm']

// Several tests of the kernel and the desktop read or import another part's sources, so a change anywhere but in
// GeoEngine's tests runs them all; they are quick. GeoEngine's own tests touch GeoEngine alone.
const EVERY = ['kernel', 'ui', 'web', 'electron']

/**
 * The suites a changed file calls for. `geoengine/<domain>` is the part of GeoEngine's unit tests in that domain's
 * folder, `geoengine` all of them.
 */
export const calledFor = (file) => {
  // The parts of the app's checks that have tests of their own; the paths check reads PATHS.md, as its test does.
  if (file === 'docs/PATHS.md' || /^scripts\/app\/(paths|network)\./.test(file)) return ['scripts']
  // Markdown under src/ or test/ can be source or a fixture, as the kernel's skills are.
  if (file.endsWith('.md') && !/(^|\/)(src|test)\//.test(file)) return []
  if (/^scripts\/test(\.test)?\.mjs$/.test(file)) return Object.keys(SUITES)
  if (/^scripts\/foreign-writes\./.test(file)) return ['scripts']
  // The checks of the packaged app are tried by running them on it.
  if (file.startsWith('scripts/app/')) return []
  // The app's version is the one geocodekit is installed at.
  if (file === `${ELECTRON}/package.json`) return [...EVERY, 'geoengine/python']
  if (!file.startsWith('geoengine/')) return EVERY
  const inside = file.slice('geoengine/'.length)
  // A test file touches only its own layer; a support file, the layers of the domain it serves.
  if (inside.startsWith('test/unit/')) return [`geoengine/${unitDomain(file)}`]
  const real = /^test\/real\/([^/.]+)\./.exec(inside)
  if (real) return [real[1]]
  const support = /^test\/support\/([^/.]+)\.ts$/.exec(inside)?.[1]
  if (REAL.includes(support)) return [`geoengine/${support}`, support]
  if (support === 'python') return ['geoengine/python']
  if (support) return ['geoengine', ...REAL]
  const domain = /^(?:src|python\/geocodekit)\/([^/]+)\//.exec(inside)?.[1]
  if (REAL.includes(domain)) return [...EVERY, `geoengine/${domain}`, domain]
  // The rest of the geocode package, the environment's manifest and lock, and how its interpreters start.
  if (/^(python|environment|src\/python)\//.test(inside) || inside === 'src/bundled.ts') {
    return [...EVERY, 'geoengine/python', ...ENVIRONMENT.map((each) => `geoengine/${each}`), ...ENVIRONMENT]
  }
  // What every domain stands on: the engine, its runtime and configuration.
  return [...EVERY, 'geoengine', ...REAL]
}

const changes = () => {
  // Paths as they are: quoted, a Chinese one would match no part.
  const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: top, encoding: 'utf8' })
  const listed = (...args) =>
    git(...args)
      .split('\n')
      .filter(Boolean)
  // Both sides of a rename: what moved away can break the tests where it was.
  const tracked = listed('diff', '--name-only', '--no-renames', 'HEAD')
  const untracked = listed('ls-files', '--others', '--exclude-standard')
  return [...new Set([...tracked, ...untracked])]
}

// What the real suites are handed from the user's own files, found before the home is swapped. The data folder holds
// the base environment GeoCode installed; GEOENGINE_DATA names another.
const realData = () => process.env.GEOENGINE_DATA ?? path.join(os.homedir(), '.local', 'share', 'geocode')
const CREDENTIALS = path.join('.config', 'earthengine', 'credentials')

// Why a suite is not run here, or null. The gee tests use the user's credentials and quota, so they run only when
// told the project.
const withheld = (suite) => {
  if (suite !== 'gee') return null
  if (!process.env.GEOENGINE_GEE_PROJECT) return 'set GEOENGINE_GEE_PROJECT=<project ID> to run it on your quota'
  if (!fs.existsSync(path.join(os.homedir(), CREDENTIALS))) return `no Earth Engine credentials in ~/${CREDENTIALS}`
  return null
}

// The user's variables that would point a test at their own folders, accounts or repositories, or at an upstream
// app's; the switches of the runtimes the app runs on, which it removes for itself; and keys and secrets, as the
// kernel's own test script removes them.
const MOVED = [
  /^(XDG_(CONFIG|DATA|CACHE|STATE)_HOME|GEOENGINE_DATA|CODEX_HOME|CLAUDE_CONFIG_DIR|SSH_AUTH_SOCK)$/i,
  /^(OPENCODE|OPENCHAMBER|OTEL|BUN|ELECTRON|GIT|CLOUDSDK)_/i,
  /^(AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i,
  /(^|_)(API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i,
]

/** The environment of a run: the user's, with a home and temporary folder of its own and nothing pointing elsewhere. */
export const sandboxed = (environment, home, platform = process.platform) => {
  const temporary = path.join(home, 'tmp')
  const kept = Object.entries(environment).filter(([name]) => !MOVED.some((pattern) => pattern.test(name)))
  return {
    ...Object.fromEntries(kept),
    HOME: home,
    TMPDIR: temporary,
    ...(platform === 'win32'
      ? {
          USERPROFILE: home,
          TMP: temporary,
          TEMP: temporary,
          APPDATA: path.join(home, 'AppData', 'Roaming'),
          LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        }
      : {}),
  }
}

/** A run's own home, with what a real suite is handed. */
const homeFor = (each) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-test-home-'))
  fs.mkdirSync(path.join(home, 'tmp'))
  const env = sandboxed(process.env, home)
  if (each.real) env.GEOENGINE_DATA = realData()
  // A copy: what the test does with it stays in the home that is removed after.
  if (each.real === 'gee') {
    fs.mkdirSync(path.dirname(path.join(home, CREDENTIALS)), { recursive: true })
    fs.copyFileSync(path.join(os.homedir(), CREDENTIALS), path.join(home, CREDENTIALS))
  }
  return { home, env }
}

/** The arguments asking a runner for a JUnit report in `report`, beside its usual output. */
const reported = (each, report) => {
  if (each.tool === 'node') {
    // Before the files: given after them, node takes the options for none.
    const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit']
    return [each.args[0], ...reporters, `--test-reporter-destination=${report}`, ...each.args.slice(1)]
  }
  if (each.tool === 'vitest')
    return [...each.args, '--reporter=default', '--reporter=junit', `--outputFile.junit=${report}`]
  return [...each.args, '--reporter=junit', `--reporter-outfile=${report}`]
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) =>
    name.startsWith('#x') || name.startsWith('#X')
      ? point(parseInt(name.slice(2), 16), whole)
      : name.startsWith('#')
        ? point(Number(name.slice(1)), whole)
        : (ENTITIES[name] ?? whole),
  )
const point = (code, whole) => (code <= 0x10ffff ? String.fromCodePoint(code) : whole)
// A tag's attributes, short of the `/` that closes an empty one; a value may hold `>`.
const TAG = '((?:[^>"/]|"[^"]*"|/(?!>))*)'
const attributes = (text) =>
  Object.fromEntries([...text.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]))

/**
 * The cases of a JUnit report, each with its file as a repository path. Bun and node name the file in `file`, vitest
 * in `classname`; only Bun gives the line, so for the others it is taken from where the failure points into the file.
 * Bun's `classname` is the case's describe blocks, which `-t` matches with its name.
 */
export const cases = (xml, cwd, tool) =>
  [...xml.matchAll(new RegExp(`<testcase\\b${TAG}(?:/>|>([\\s\\S]*?)</testcase>)`, 'g'))].flatMap(
    ([, head, body = '']) => {
      const tag = attributes(head)
      const file = relative(path.resolve(at(cwd), tag.file ?? tag.classname ?? ''))
      const skipped = new RegExp(`<skipped\\b${TAG}`).exec(body)
      const failure = new RegExp(`<(failure|error)\\b${TAG}(?:/>|>([\\s\\S]*?)</\\1>)`).exec(body)
      const name = tool === 'bun' && tag.classname ? `${tag.classname} › ${tag.name}` : tag.name
      // Node reports a file that holds no test as a case named as the file was given: no test, unless it failed to load.
      if (!failure && tag.name === path.relative(at(cwd), at(file)).split(path.sep).join('/')) return []
      const detail = failure ? decode(failure[3] ?? '') : ''
      const line = tag.line ?? new RegExp(`${path.basename(file).replace(/\./g, '\\.')}:(\\d+)`).exec(detail)?.[1]
      return {
        file,
        line: line ? Number(line) : undefined,
        name,
        // Node lists a todo case that threw as failed too, and does not count it as a failure itself.
        status:
          skipped && (!failure || attributes(skipped[1]).type === 'todo') ? 'skipped' : failure ? 'failed' : 'passed',
        reason: skipped ? attributes(skipped[1]).message || undefined : undefined,
        // The element's text keeps the lines node's attribute runs together.
        message: failure ? (detail || attributes(failure[2]).message || 'failed').trim() : undefined,
      }
    },
  )

/**
 * A suite's outcome from its runs: each with the files it was given, how it ended, and the cases its report holds.
 * FAIL when a run failed or a case did, or a file ran no test; NOT RUN when every case was skipped; PASS otherwise.
 */
export const judge = (runs) => {
  const all = runs.flatMap((each) => each.cases)
  const failed = all.filter((each) => each.status === 'failed')
  const skipped = all.filter((each) => each.status === 'skipped')
  const problems = []
  for (const each of runs) {
    const ended = each.ended
    if (ended.error) problems.push({ run: each, text: `could not start ${each.command}: ${ended.error}` })
    else if (ended.timedOut) problems.push({ run: each, text: `stopped after ${ended.timedOut} min` })
    else if (ended.signal) problems.push({ run: each, text: `ended by ${ended.signal}` })
    else if (ended.status !== 0 && !each.cases.some((one) => one.status === 'failed')) {
      problems.push({ run: each, text: `exited with ${ended.status} with no failed case in its report` })
    }
    if (!each.files.length) problems.push({ run: each, text: 'was given no files' })
    for (const file of each.files) {
      if (!each.cases.some((one) => one.file === file)) problems.push({ run: each, text: `${file} ran no tests` })
    }
    for (const file of each.focused ?? []) {
      problems.push({ run: each, text: `${file} has a .only, which keeps the file's other cases from running` })
    }
  }
  if (!runs.length) problems.push({ text: 'found no test files' })
  const counts = {
    tests: all.length,
    passed: all.length - failed.length - skipped.length,
    failed: failed.length,
    skipped: skipped.length,
  }
  const reasons = [...new Set(skipped.map((each) => each.reason ?? 'skipped'))]
  const status = failed.length || problems.length ? 'FAIL' : counts.passed === 0 ? 'NOT RUN' : 'PASS'
  return { status, counts, failed, problems, reasons }
}

const FOCUSED = /\b(?:test|it|describe|suite)(?:\.\w+)*\.only\b/

// Long enough for the real Earth Engine to compose and download its images.
const LIMIT_MINUTES = 30

/** Runs one step in a home of its own; its output goes to a log beside its report. */
const execute = (each, logs, index) => {
  const report = path.join(logs, `${index}.xml`)
  const log = path.join(logs, `${index}.log`)
  const args = reported(each, report)
  const { home, env } = homeFor(each)
  const output = fs.openSync(log, 'w')
  const ran = spawnSync(each.command, args, {
    cwd: at(each.cwd),
    env,
    stdio: ['ignore', output, output],
    timeout: LIMIT_MINUTES * 60 * 1000,
  })
  fs.closeSync(output)
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch (error) {
    console.log(`\n  could not remove ${home}: ${error.message}`)
  }
  const xml = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : ''
  const found = cases(xml, each.cwd, each.tool)
    .filter((one) => !each.only || each.only.test(one.name))
    .map((one) => ({ ...one, log }))
  const timedOut = ran.error?.code === 'ETIMEDOUT' ? LIMIT_MINUTES : undefined
  return {
    ...each,
    args,
    log,
    // Bun runs only a file's focused cases and reports none of the rest.
    focused: each.files.filter((file) => FOCUSED.test(fs.readFileSync(at(file), 'utf8'))),
    cases: found,
    ended: {
      status: ran.status,
      signal: timedOut ? null : ran.signal,
      error: timedOut ? undefined : ran.error?.message,
      timedOut,
    },
  }
}

const quoted = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
const lines = (text, count) => text.split('\n').slice(0, count).join('\n')
const indent = (text, by = '    ') => text.replace(/^/gm, by)

const tail = (log) =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trimEnd().split('\n').slice(-40).join('\n') : ''

/**
 * What to read when a suite failed: each failed case where it is, and the end of the log of a run that broke or of
 * a failure with no line in the file, as a file that would not load: its report says only that it failed.
 */
const explain = (suite, outcome) => {
  const shown = []
  const logs = new Set()
  const ending = (log) => {
    if (!log || logs.has(log)) return
    logs.add(log)
    if (tail(log)) shown.push(indent(tail(log)))
  }
  for (const each of outcome.failed.slice(0, 20)) {
    shown.push(`  ${each.file}${each.line ? `:${each.line}` : ''}  ${each.name}`)
    if (each.message) shown.push(indent(lines(each.message, 15)))
    if (!each.line) ending(each.log)
  }
  if (outcome.failed.length > 20) shown.push(`  and ${outcome.failed.length - 20} more failed cases`)
  for (const { run, text } of outcome.problems) {
    shown.push(`  ${text}`)
    ending(run?.log)
  }
  const files = [
    ...new Set([
      ...outcome.failed.map((each) => each.file),
      ...outcome.problems.flatMap(({ run }) => run?.files ?? []),
    ]),
  ]
  for (const file of files) shown.push(`  rerun: node scripts/test.mjs --file ${quoted(file)}`)
  for (const log of new Set([...outcome.failed.map((each) => each.log), ...logs])) shown.push(`  full output: ${log}`)
  return `\nFAIL ${suite}\n${shown.join('\n')}`
}

const summary = ({ status, counts, reasons }, seconds) => {
  const time = `${seconds} s`
  if (status === 'NOT RUN') return `NOT RUN  all ${counts.tests} skipped: ${reasons.join('; ')}`
  const skips = counts.skipped ? `, ${counts.skipped} skipped (${reasons.join('; ')})` : ''
  const failures = counts.failed ? `, ${counts.failed} failed` : ''
  return `${status.padEnd(8)} ${counts.passed} passed${failures}${skips}, ${time}`
}

/** The suites and files the arguments ask for, with why; or a usage error. */
export const parse = (args, changed = changes) => {
  const listOnly = args.includes('--list')
  // Suite name to the reasons it is run, and to the domains of it asked for: null, or none asked, is all of it.
  const chosen = new Map()
  const domains = new Map()
  const files = []
  const choose = (selector, reason) => {
    const [suite, domain] = selector.split('/')
    if (!(suite in SUITES) || (domain !== undefined && (suite !== 'geoengine' || !UNIT.includes(domain)))) return false
    chosen.set(suite, [...(chosen.get(suite) ?? []), reason])
    const asked = domains.get(suite)
    if (domain === undefined) domains.set(suite, null)
    else if (asked !== null) domains.set(suite, [...new Set([...(asked ?? []), domain])])
    return true
  }
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === '--list') continue
    if (name === '--file') {
      const file = args[++index]
      if (!file) return { error: '--file needs a test file' }
      files.push(relative(path.resolve(file)))
    } else if (name === 'all') for (const suite of Object.keys(SUITES)) choose(suite, 'all')
    else if (name === 'changed') {
      for (const file of changed()) {
        for (const selector of calledFor(file)) {
          // A real test of a domain not yet registered here would otherwise be skipped without a word.
          if (!choose(selector, file))
            return {
              error: `${file} calls for a suite "${selector}" that scripts/test.mjs does not have: register it there.`,
            }
        }
      }
    } else if (!choose(name, 'named')) return { error: `unknown suite: ${name}` }
  }
  if (!chosen.size && !files.length && !args.some((arg) => arg === 'changed')) {
    return { error: 'usage: node scripts/test.mjs [--list] <suite|changed|all>... [--file <test file>]...' }
  }
  return { listOnly, chosen, domains, files }
}

/** The step that runs one file as its suite would, and the suite it belongs to. */
export const fileStep = (file) => {
  for (const [suite, steps] of Object.entries(SUITES)) {
    for (const each of steps()) {
      if (!each.files.includes(file)) continue
      const prefix = each.args.slice(0, each.args.length - each.files.length)
      return { suite, step: { ...each, args: [...prefix, argument(each.tool, each.cwd, file)], files: [file] } }
    }
  }
  return null
}

const main = () => {
  const parsed = parse(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    process.exit(2)
  }
  const strays = unrun()
  if (strays.length) {
    console.error(`no suite runs these, so they would never run; name them as the suites expect:\n${strays.join('\n')}`)
    process.exit(2)
  }
  // Each entry: a label, the steps it runs, why, and what keeps it from running here.
  const plan = Object.keys(SUITES)
    .filter((suite) => parsed.chosen.has(suite))
    .map((suite) => {
      const domains = parsed.domains.get(suite)
      return {
        label: domains ? `${suite} (${UNIT.filter((each) => domains.includes(each)).join(', ')})` : suite,
        steps: domains ? SUITES[suite](domains) : SUITES[suite](),
        why: parsed.chosen.get(suite),
        withheld: withheld(suite),
      }
    })
  for (const file of parsed.files) {
    const found = fileStep(file)
    if (!found) {
      console.error(`${file} is not a test file any suite runs`)
      process.exit(2)
    }
    plan.push({ label: file, steps: [found.step], why: [`${found.suite} file`], withheld: withheld(found.suite) })
  }
  if (!plan.length) {
    console.log('nothing to run: no change calls for a suite.')
    process.exit(0)
  }

  if (parsed.listOnly) {
    for (const { label, steps, why, withheld: reason } of plan) {
      const shown = why.length > 3 ? [...why.slice(0, 3), `${why.length - 3} more`] : why
      const count = steps.reduce((sum, each) => sum + each.files.length, 0)
      console.log(`${label.padEnd(10)} ${reason ? `NOT RUN  ${reason}` : `${count} files, for ${shown.join(', ')}`}`)
    }
    process.exit(0)
  }

  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-test-run-'))
  const results = []
  let index = 0
  for (const { label, steps, withheld: reason } of plan) {
    if (reason) {
      results.push({ label, line: `NOT RUN  ${reason}`, status: 'NOT RUN' })
      continue
    }
    process.stdout.write(`${label} ... `)
    const begun = Date.now()
    const runs = steps.map((each) => execute(each, logs, index++))
    const outcome = judge(runs)
    const line = summary(outcome, Math.round((Date.now() - begun) / 1000))
    console.log(line)
    results.push({ label, line, status: outcome.status, outcome })
  }

  for (const { label, status, outcome } of results) if (status === 'FAIL') console.log(explain(label, outcome))
  console.log('')
  for (const { label, line } of results) console.log(`${label.padEnd(10)} ${line}`)
  const failed = results.some((each) => each.status === 'FAIL')
  // The logs of a failed run are kept for reading; a clean run leaves nothing.
  if (failed) console.log(`\nlogs: ${logs}`)
  else fs.rmSync(logs, { recursive: true, force: true })
  process.exit(failed ? 1 : results.some((each) => each.status === 'NOT RUN') ? 3 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
