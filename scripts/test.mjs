// Runs GeoCode's own tests by suite: each part's
// unit tests, which touch stand-ins alone, and the tests on the real QGIS, the
// real Earth Engine and the installed base environment, which run only when named
// or when a change calls for them. The suites run one after another, and a failed
// one does not stop the rest.
//
// Usage:  node scripts/test.mjs [--list] <suite|changed|all>...
//   suites   kernel ui web electron geoengine qgis gee osm
//   changed  the suites the working tree's changes against HEAD call for
//   all      every suite
//   --list   prints the suites and why each is run, and runs none
// Exits 1 when a suite failed, 3 when none failed but one was not run, and 2 on a usage error.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const at = (...parts) => path.join(top, ...parts)
const run = (where, command, ...args) => ({ cwd: at(where), command, args })

// In a kernel package's test folder: GeoCode's own files and the upstream ones
// holding GeoCode cases.
const OWN = /(^|\/)(geocode-[^/]*\.test\.tsx?|geocode\/.*\.test\.tsx?)$/
const CASES = /\b(?:test|it|describe)(?:\.\w+)?\(\s*["'`]GeoCode: /

const walk = (root, found = []) => {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

// Each package's GeoCode tests: its own files whole, and the GeoCode cases of upstream files.
const kernelRuns = () =>
  fs.readdirSync(at('kernel', 'packages')).flatMap((name) => {
    const where = `kernel/packages/${name}`
    if (!fs.existsSync(at(where, 'test'))) return []
    const files = walk(at(where, 'test')).map((file) => path.relative(at(where), file).split(path.sep).join('/'))
    const own = files.filter((file) => OWN.test(file))
    const cases = files.filter((file) => !OWN.test(file) && CASES.test(fs.readFileSync(at(where, file), 'utf8')))
    return [
      ...(own.length ? [run(where, 'bun', 'run', 'test', ...own)] : []),
      ...(cases.length ? [run(where, 'bun', 'run', 'test', ...cases, '-t', 'GeoCode:')] : []),
    ].map((each) => ({ ...each, home: true }))
  })

const electronRuns = () => {
  const files = fs
    .readdirSync(at('desktop', 'packages', 'electron', 'geocode'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `geocode/${name}`)
  // Given no file, node --test would run the package's upstream tests. The time limit turns a wait the test forgot into
  // a failure, not a hang.
  return files.length ? [run('desktop/packages/electron', 'node', '--test', '--test-timeout=10000', ...files)] : []
}

// A script of GeoEngine's package, run as written there but for the report `tally` adds (below).
const geoengineRuns = (script) => () => {
  const line = JSON.parse(fs.readFileSync(at('geoengine', 'package.json'), 'utf8')).scripts?.[script]
  if (!line) throw new Error(`geoengine/package.json has no script "${script}"`)
  const [command, ...args] = line.match(/"[^"]*"|\S+/g).map((word) => word.replace(/^"(.*)"$/, '$1'))
  return [{ ...run('geoengine', command, ...args), tally: command === 'node' }]
}

// What each suite runs. `home` gives the runs a home of their own: the packages' test scripts do not all swap it.
const SUITES = {
  kernel: kernelRuns,
  ui: () => [run('desktop/packages/ui', 'node', '../../scripts/run-isolated-tests.mjs', 'src/geocode')],
  web: () => [run('desktop/packages/web', 'bun', 'run', 'test', '--', 'server/geocode/')],
  electron: electronRuns,
  geoengine: geoengineRuns('test'),
  qgis: geoengineRuns('test:qgis'),
  gee: geoengineRuns('test:gee'),
  osm: geoengineRuns('test:osm'),
}

// The gee tests use the user's credentials and quota, and need to know the project.
const WITHHELD = { gee: process.env.GEOENGINE_GEE_PROJECT ? null : 'set GEOENGINE_GEE_PROJECT=<project ID> to run it' }

const REAL = ['qgis', 'gee', 'osm']
// Whose scripts run in the bundled Python environment.
const ENVIRONMENT = ['gee', 'osm']

// Several tests of the kernel and the desktop read or import another part's sources, so a change anywhere but in
// GeoEngine's tests runs them all; they are quick. GeoEngine's own tests touch GeoEngine alone.
const EVERY = ['kernel', 'ui', 'web', 'electron']

const calledFor = (file) => {
  // Markdown under src/ or test/ can be source or a fixture, as the kernel's skills are.
  if (file.endsWith('.md') && !/(^|\/)(src|test)\//.test(file)) return []
  if (file === 'scripts/test.mjs') return Object.keys(SUITES)
  if (!file.startsWith('geoengine/')) return EVERY
  const inside = file.slice('geoengine/'.length)
  // A test file touches only its own layer; a support file, the layers of the domain it serves.
  if (inside.startsWith('test/unit/')) return ['geoengine']
  const real = /^test\/real\/([^/.]+)\./.exec(inside)
  if (real) return [real[1]]
  const support = /^test\/support\/([^/.]+)\.ts$/.exec(inside)?.[1]
  if (support) return ['geoengine', ...(support === 'common' ? REAL : REAL.filter((domain) => domain === support))]
  const domain = /^src\/([^/]+)\//.exec(inside)?.[1]
  if (REAL.includes(domain)) return [...EVERY, 'geoengine', domain]
  // The geocode package, the environment's manifest and lock, and how its interpreters start.
  if (/^(python|environment|src\/python)\//.test(inside) || inside === 'src/bundled.ts') {
    return [...EVERY, 'geoengine', ...ENVIRONMENT]
  }
  // What every domain stands on: the engine, its runtime and configuration.
  return [...EVERY, 'geoengine', ...REAL]
}

const changes = () => {
  // Paths as they are: quoted, a Chinese one would match no part.
  const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: top, encoding: 'utf8' })
  const listed = (...args) => git(...args).split('\n').filter(Boolean)
  // Both sides of a rename: what moved away can break the tests where it was.
  const tracked = listed('diff', '--name-only', '--no-renames', 'HEAD')
  const untracked = listed('ls-files', '--others', '--exclude-standard')
  return [...new Set([...tracked, ...untracked])]
}

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const named = args.filter((arg) => arg !== '--list')
if (!named.length) {
  console.error('usage: node scripts/test.mjs [--list] <suite|changed|all>...')
  process.exit(2)
}

// Suite name to the reasons it is run.
const chosen = new Map()
const choose = (suite, reason) => chosen.set(suite, [...(chosen.get(suite) ?? []), reason])
for (const name of named) {
  if (name === 'all') for (const suite of Object.keys(SUITES)) choose(suite, 'all')
  else if (name === 'changed') {
    for (const file of changes()) {
      for (const suite of calledFor(file)) {
        // A real test of a domain not yet registered here would otherwise be skipped without a word.
        if (!(suite in SUITES)) {
          console.error(`${file} calls for a suite "${suite}" that scripts/test.mjs does not have: register it there.`)
          process.exit(2)
        }
        choose(suite, file)
      }
    }
  } else if (name in SUITES) choose(name, 'named')
  else {
    console.error(`unknown suite: ${name}`)
    process.exit(2)
  }
}
const order = Object.keys(SUITES).filter((suite) => chosen.has(suite))
if (!order.length) console.log('nothing to run: no change calls for a suite.')

const withheld = (suite) => WITHHELD[suite] ?? (SUITES[suite]().length ? null : 'it has no tests')

if (listOnly) {
  for (const suite of order) {
    const reasons = chosen.get(suite)
    const shown = reasons.length > 3 ? [...reasons.slice(0, 3), `${reasons.length - 3} more`] : reasons
    console.log(`${suite.padEnd(10)}${withheld(suite) ? `not run: ${withheld(suite)}` : shown.join(', ')}`)
  }
  process.exit(0)
}

const isolated = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-test-home-'))
  // Windows finds the home in USERPROFILE.
  const env = { ...process.env, HOME: home, ...(process.platform === 'win32' ? { USERPROFILE: home } : {}) }
  // Removed, not emptied: Bun writes its transpiler cache in the current directory when they are empty.
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete env[name]
  return { home, env }
}

// A TAP report beside the screen's, for how many tests ran: node --test passes a file whose tests were all skipped.
const tallied = (args) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-test-report-'))
  const report = path.join(folder, 'report.tap')
  const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap']
  const count = (text, name) => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(text)?.[1] ?? 0)
  const read = () => {
    const text = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : ''
    fs.rmSync(folder, { recursive: true, force: true })
    return { tests: count(text, 'tests'), skipped: count(text, 'skipped') }
  }
  // Before the files: given after them, node takes the options for none.
  return { args: [...reporters, `--test-reporter-destination=${report}`, ...args], read }
}

const results = []
for (const suite of order) {
  if (withheld(suite)) {
    results.push({ suite, failed: false, unrun: true, outcome: `NOT RUN: ${withheld(suite)}` })
    continue
  }
  console.log(`\n=== ${suite}`)
  const begun = Date.now()
  let failed = false
  let counted = null
  for (const step of SUITES[suite]()) {
    const isolation = step.home ? isolated() : null
    const tally = step.tally ? tallied(step.args) : null
    const args = tally?.args ?? step.args
    console.log(`--- ${path.relative(top, step.cwd)}: ${step.command} ${args.join(' ')}`)
    const env = isolation?.env ?? process.env
    const ran = spawnSync(step.command, args, { cwd: step.cwd, env, stdio: 'inherit' })
    if (isolation) fs.rmSync(isolation.home, { recursive: true, force: true })
    if (tally) {
      const { tests, skipped } = tally.read()
      counted = { tests: (counted?.tests ?? 0) + tests, skipped: (counted?.skipped ?? 0) + skipped }
    }
    if (ran.error) console.log(`--- could not run ${step.command}: ${ran.error.message}`)
    else if (ran.signal) console.log(`--- ended by ${ran.signal}`)
    if (ran.status !== 0) failed = true
  }
  const seconds = Math.round((Date.now() - begun) / 1000)
  const unrun = !failed && counted !== null && counted.tests === counted.skipped
  const skips = counted?.skipped ? `, ${counted.skipped} of ${counted.tests} skipped` : ''
  const outcome = unrun
    ? `NOT RUN: ${counted.tests ? `all ${counted.tests} skipped` : 'no tests'}`
    : `${failed ? 'FAILED' : 'passed'} in ${seconds} s${skips}`
  results.push({ suite, failed, unrun, outcome })
}

console.log('')
for (const { suite, outcome } of results) console.log(`${suite.padEnd(10)}${outcome}`)
process.exit(results.some((result) => result.failed) ? 1 : results.some((result) => result.unrun) ? 3 : 0)
