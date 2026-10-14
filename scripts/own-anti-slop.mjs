// The desktop anti-slop errors in GeoCode's own files, those chamber-upstream does
// not have. Patches to upstream files are left to review. Reads the working tree,
// untracked files included.
//
// Usage:  node scripts/own-anti-slop.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Errors kept on purpose, each with its reason. An entry must match exactly `count` errors.
const ACCEPTED = [
  // The stubs make a broken guard fail the test instead of reading this machine's Keychain.
  { file: 'packages/web/server/geocode/closed-quota.test.js', rule: 'no-module-mocking', count: 1 },
]

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const desktop = path.join(top, 'desktop')
const oxlint = path.join(desktop, 'node_modules/.bin/oxlint')
const refuse = (message) => {
  console.error(`refuse: ${message}`)
  process.exit(2)
}
if (!fs.existsSync(oxlint)) refuse('no oxlint, run bun install in desktop/ first.')
if (spawnSync('git', ['rev-parse', '--verify', '-q', 'chamber-upstream'], { cwd: desktop }).status !== 0) {
  refuse("no branch 'chamber-upstream', the pristine side of desktop/ is missing.")
}
const list = (args) => execFileSync('git', args, { cwd: desktop, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)

const upstream = new Set(list(['ls-tree', '-r', '-z', '--full-tree', '--name-only', 'chamber-upstream']))
const own = list(['ls-files', '-z', '--deduplicate', '--cached', '--others', '--exclude-standard'])
  .filter((file) => !upstream.has(file) && /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(file) && fs.existsSync(path.join(desktop, file)))

const diagnostics = []
for (let i = 0; i < own.length; i += 200) {
  let out
  try {
    const args = ['-c', 'oxlint.anti-slop.config.ts', '-f', 'json', '--no-error-on-unmatched-pattern', ...own.slice(i, i + 200)]
    out = execFileSync(oxlint, args, { cwd: desktop, encoding: 'utf8', maxBuffer: 1 << 28 })
  } catch (error) {
    if (error.status !== 1) throw error
    out = error.stdout
  }
  try {
    diagnostics.push(...JSON.parse(out).diagnostics)
  } catch {
    refuse(`oxlint did not report JSON:\n${out}`)
  }
}

// Parse errors and plugin crashes carry no anti-slop code and are reported too.
const matches = (a, d) => d.filename === a.file && d.code === `anti-slop(${a.rule})`
const kept = ACCEPTED.filter((a) => diagnostics.filter((d) => matches(a, d)).length === a.count)
const reported = diagnostics.filter((d) => !kept.some((a) => matches(a, d)))
for (const d of reported) {
  const span = d.labels[0]?.span
  console.log(`desktop/${d.filename}${span ? `:${span.line}:${span.column}` : ''}: ${d.message} [${d.code ?? 'not linted'}]`)
}
for (const a of ACCEPTED.filter((a) => !kept.includes(a))) console.log(`exception desktop/${a.file} ${a.rule}: expects ${a.count}`)
console.log(`${own.length} own files. Errors: ${reported.length}; accepted: ${diagnostics.length - reported.length}`)
process.exit(reported.length || kept.length < ACCEPTED.length ? 1 : 0)
