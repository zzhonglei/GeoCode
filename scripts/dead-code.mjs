// Symbols a file defines and nothing in it calls, after block and line comments are removed —
// which is the part `grep` gets wrong, since a shielded block still matches every pattern in it.
//
// Reads WITHIN one file only, so anything exported and used elsewhere reads as dead. That is on
// purpose: it keeps the check to one file's worth of certainty, and the export list is a cheap
// second look. What it is for is the residue of an edit — an import whose last use was replaced,
// a helper whose only caller moved into a shield. Upstream functions left unreferenced BY a
// shield are expected and are not what this is hunting; deleting those would raise the patch
// surface rather than lower it (docs/CONVENTIONS.md §5).
import fs from 'node:fs'

// String bodies go first, or `import os from 'os'` counts its own module specifier as a use and
// the check reports clean on the one shape it was written for. Measured: it did.
const countable = (source) =>
  source.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")

const references = (source, name) => (source.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length

const scan = (file) => {
  const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const live = countable(source)
  const dead = []
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    if (references(live, match[1]) <= 1) dead.push(`function ${match[1]}`)
  }
  for (const match of source.matchAll(/^import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from/gm)) {
    if (references(live, match[1]) <= 1) dead.push(`import ${match[1]}`)
  }
  return dead
}

let found = 0
for (const file of process.argv.slice(2)) {
  const dead = scan(file)
  found += dead.length
  console.log(dead.length ? `  DEAD  ${file}: ${dead.join(', ')}` : `  ok    ${file}`)
}
process.exit(found ? 1 : 0)
