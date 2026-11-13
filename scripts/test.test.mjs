// The runner's own tests: agents take its report as the word on whether their work is checked, so how it picks
// suites, reads the runners' reports and judges them is tested here.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { SUITES, calledFor, cases, fileStep, judge, parse, sandboxed, top, unrun } from './test.mjs'

test('a change calls for the suites of what it touches, and for the real suites of the domain it is in', () => {
  const desktop = ['kernel', 'ui', 'web', 'electron']
  assert.deepEqual(calledFor('docs/DESIGN.md'), [])
  assert.deepEqual(calledFor('docs/PATHS.md'), ['scripts'])
  assert.deepEqual(calledFor('scripts/app/paths.mjs'), ['scripts'])
  assert.deepEqual(calledFor('scripts/app/network.test.mjs'), ['scripts'])
  assert.deepEqual(calledFor('scripts/app/smoke.mjs'), [])
  // A script's new test, and a script with a test beside it.
  assert.deepEqual(calledFor('scripts/app/lib.test.mjs'), ['scripts'])
  assert.deepEqual(calledFor('scripts/stage-python.test.mjs'), ['scripts'])
  assert.deepEqual(calledFor('scripts/foreign-writes.sh'), ['scripts'])
  assert.deepEqual(calledFor('desktop/packages/ui/src/geocode/osm.ts'), desktop)
  // GeoEngine's unit tests of the domain alone, and the domain's real ones.
  assert.deepEqual(calledFor('geoengine/src/osm/index.ts'), [...desktop, 'geoengine/osm', 'osm'])
  assert.deepEqual(calledFor('geoengine/python/geocodekit/gee/_outputs.py'), [...desktop, 'geoengine/gee', 'gee'])
  assert.deepEqual(calledFor('geoengine/test/unit/osm/search.test.ts'), ['geoengine/osm'])
  assert.deepEqual(calledFor('geoengine/test/unit/runtime.test.ts'), ['geoengine/engine'])
  assert.deepEqual(calledFor('geoengine/test/support/qgis.ts'), ['geoengine/qgis', 'qgis'])
  assert.deepEqual(calledFor('geoengine/test/real/qgis.test.ts'), ['qgis'])
  // What the domains' Python runs on, and what every domain stands on.
  assert.deepEqual(calledFor('geoengine/src/bundled.ts'), [
    ...desktop,
    'geoengine/python',
    'geoengine/gee',
    'geoengine/osm',
    'geoengine/preview',
    'gee',
    'osm',
    'preview',
  ])
  assert.deepEqual(calledFor('geoengine/src/runtime.ts'), [...desktop, 'geoengine', 'qgis', 'gee', 'osm', 'preview'])
  assert.deepEqual(calledFor('geoengine/test/support/engine.ts'), ['geoengine', 'qgis', 'gee', 'osm', 'preview'])
  // geocodekit is installed at the app's version.
  assert.ok(calledFor('desktop/packages/electron/package.json').includes('geoengine/python'))
  assert.deepEqual(calledFor('scripts/test.mjs'), Object.keys(SUITES))
})

test('every test file in GeoCode’s test folders is run by a suite, and a file runs as its suite runs it', () => {
  assert.deepEqual(unrun(), [])
  const kernel = fileStep('kernel/packages/core/test/config/skill.test.ts')
  assert.equal(kernel.suite, 'kernel')
  // An upstream file runs only its GeoCode cases.
  assert.deepEqual(kernel.step.args, ['run', 'test', '-t', 'GeoCode:', './test/config/skill.test.ts'])
  assert.ok(kernel.step.only.test('GeoCode › GeoCode: loads skills'))
  assert.equal(fileStep('geoengine/test/real/gee.test.ts').suite, 'gee')
  assert.equal(fileStep('desktop/packages/web/server/geocode/loopback-host.test.js').suite, 'web')
  assert.equal(fileStep('README.md'), null)
})

test('the arguments name suites, changes and files, and a mistake in them is a usage error', () => {
  assert.match(parse([]).error, /usage/)
  assert.match(parse(['--file']).error, /needs a test file/)
  assert.match(parse(['kernal']).error, /unknown suite/)
  const gee = parse(['changed'], () => ['geoengine/src/gee/run.ts'])
  assert.deepEqual([...gee.chosen.keys()], ['kernel', 'ui', 'web', 'electron', 'geoengine', 'gee'])
  assert.deepEqual(gee.domains.get('geoengine'), ['gee'])
  // A change to what every domain stands on asks for all of GeoEngine's unit tests, whatever else asks for some.
  const both = parse(['changed'], () => ['geoengine/src/gee/run.ts', 'geoengine/src/engine.ts'])
  assert.equal(both.domains.get('geoengine'), null)
  assert.deepEqual(parse(['geoengine/osm', 'geoengine/qgis']).domains.get('geoengine'), ['osm', 'qgis'])
  assert.match(parse(['geoengine/web']).error, /unknown suite/)
  // No change is nothing to run, not a usage error.
  assert.equal(parse(['changed'], () => []).error, undefined)
})

test('a run gets a home and temporary folder of its own, and nothing pointing at the user’s or an upstream app’s', () => {
  const user = {
    PATH: '/usr/bin',
    HOME: '/Users/someone',
    TMPDIR: '/var/folders/x',
    XDG_CONFIG_HOME: '/Users/someone/.config',
    OPENCODE_CONFIG: '/Users/someone/opencode.json',
    openchamber_data_dir: '/Users/someone/.openchamber',
    GEOENGINE_DATA: '/Users/someone/data',
    GEOENGINE_GEE_PROJECT: 'project',
    GOOGLE_APPLICATION_CREDENTIALS: '/Users/someone/key.json',
    OPENAI_API_KEY: 'sk-',
    GH_TOKEN: 'gho_',
    GIT_DIR: '/Users/someone/repo/.git',
    ELECTRON_RUN_AS_NODE: '1',
  }
  // The temporary folder is joined with the separator of the computer the tests run on.
  const temporary = path.join('/tmp/home', 'tmp')
  assert.deepEqual(sandboxed(user, '/tmp/home', 'darwin'), {
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    TMPDIR: temporary,
    GEOENGINE_GEE_PROJECT: 'project',
  })
  const windows = sandboxed({ USERPROFILE: 'C:\\Users\\someone', TEMP: 'C:\\Temp' }, '/tmp/home', 'win32')
  assert.equal(windows.USERPROFILE, '/tmp/home')
  assert.equal(windows.TEMP, temporary)
})

// Reports as the three runners write them, trimmed.
const BUN = `<testsuites><testsuite name="a.test.ts" file="a.test.ts">
  <testcase name="passes" classname="" file="a.test.ts" line="2" />
  <testcase name="fails" classname="" file="a.test.ts" line="3"><failure type="AssertionError" message="m">expected 2
received 1</failure></testcase>
  <testcase name="skipped" classname="" file="a.test.ts" line="4"><skipped /></testcase>
  <testsuite name="GeoCode" file="a.test.ts"><testcase name="GeoCode: x" classname="GeoCode" file="a.test.ts" line="9" /></testsuite>
  <testcase name="deep" classname="GeoCode: inner &gt; outer/x" file="a.test.ts" line="12" />
</testsuite></testsuites>`
const NODE = `<testsuites>
  <testcase name="passes" classname="test" file="/repo/geoengine/test/b.test.ts"/>
  <testcase name="fails" classname="test" file="/repo/geoengine/test/b.test.ts" failure="one line">
    <failure type="testCodeFailure" message="one line">[Error: values differ
  at file:///repo/geoengine/test/b.test.ts:17:5] &lt;x></failure>
  </testcase>
  <testcase name="skipped" classname="test" file="/repo/geoengine/test/b.test.ts"><skipped type="skipped" message="no QGIS here"/></testcase>
  <testcase name="test/empty.test.ts" classname="test" file="/repo/geoengine/test/empty.test.ts"/>
  <testcase name="test/broken.test.ts" classname="test" file="/repo/geoengine/test/broken.test.ts"><failure message="SyntaxError"/></testcase>
  <testcase name="later" classname="test" file="/repo/geoengine/test/b.test.ts"><skipped type="todo" message="later"/><failure message="not yet"/></testcase>
</testsuites>`
const VITEST = `<testsuites><testsuite name="server/c.test.js">
  <testcase classname="server/c.test.js" name="suite &gt; passes" time="0.1"></testcase>
</testsuite></testsuites>`

test('a report is read case by case, each with its file, line, outcome and why it was skipped or failed', () => {
  const bun = cases(BUN, 'kernel/packages/core', 'bun')
  assert.deepEqual(
    bun.map(({ file, line, name, status }) => [file, line, name, status]),
    [
      ['kernel/packages/core/a.test.ts', 2, 'passes', 'passed'],
      ['kernel/packages/core/a.test.ts', 3, 'fails', 'failed'],
      ['kernel/packages/core/a.test.ts', 4, 'skipped', 'skipped'],
      ['kernel/packages/core/a.test.ts', 9, 'GeoCode › GeoCode: x', 'passed'],
      // Its describe blocks, which `-t GeoCode:` matched, whatever they hold.
      ['kernel/packages/core/a.test.ts', 12, 'GeoCode: inner > outer/x › deep', 'passed'],
    ],
  )
  assert.equal(bun[1].message, 'expected 2\nreceived 1')

  // A file holding no test is no case; one that would not load is a failed one; a todo case that threw is skipped.
  const node = cases(NODE.replaceAll('/repo', top), 'geoengine', 'node')
  assert.deepEqual(
    node.map((each) => each.status),
    ['passed', 'failed', 'skipped', 'failed', 'skipped'],
  )
  assert.equal(node[3].message, 'SyntaxError')
  assert.equal(node[1].line, 17)
  assert.match(node[1].message, /values differ\n/)
  assert.equal(node[2].reason, 'no QGIS here')

  const vitest = cases(VITEST, 'desktop/packages/web', 'vitest')
  assert.deepEqual(
    vitest.map(({ file, name }) => [file, name]),
    [['desktop/packages/web/server/c.test.js', 'suite > passes']],
  )
})

const run = (files, found, ended = { status: 0 }) => ({ files, cases: found, ended, command: 'bun' })
const one = (file, status, reason) => ({ file, status, reason, name: 'a case' })

test('a suite fails on a failed case, a run that broke, or a file that ran no test, and is not run when all skipped', () => {
  assert.equal(judge([run(['a'], [one('a', 'passed'), one('a', 'failed')], { status: 1 })]).status, 'FAIL')
  // A file that would not load: the runner failed, though no case did.
  const broke = judge([run(['a'], [], { status: 1 })])
  assert.equal(broke.status, 'FAIL')
  assert.ok(broke.problems.some((each) => /exited with 1/.test(each.text)))
  assert.equal(judge([run(['a'], [one('a', 'passed')], { timedOut: 30 })]).status, 'FAIL')
  // Given two files, the runner ran the cases of one.
  const missed = judge([run(['a', 'b'], [one('a', 'passed')])])
  assert.deepEqual(
    missed.problems.map((each) => each.text),
    ['b ran no tests'],
  )
  assert.equal(judge([]).status, 'FAIL')
  assert.equal(judge([run([], [])]).status, 'FAIL')
  // Bun runs only a focused case and reports none of the rest.
  assert.equal(judge([{ ...run(['a'], [one('a', 'passed')]), focused: ['a'] }]).status, 'FAIL')

  const skipped = judge([run(['a'], [one('a', 'skipped', 'no QGIS here'), one('a', 'skipped', 'no QGIS here')])])
  assert.equal(skipped.status, 'NOT RUN')
  assert.deepEqual(skipped.reasons, ['no QGIS here'])
  const passed = judge([run(['a'], [one('a', 'passed'), one('a', 'skipped')])])
  assert.equal(passed.status, 'PASS')
  assert.deepEqual(passed.counts, { tests: 2, passed: 1, failed: 0, skipped: 1 })
})
