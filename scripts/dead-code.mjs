// Symbols a file defines and nothing in it calls, after comments are removed, so
// a shielded block no longer counts as a use. Reads within one file only: an
// export used elsewhere reads as dead, which is a cheap second look rather than
// an error. Meant for the residue of an edit, not for upstream code a shield
// left unreferenced.
import fs from 'node:fs'

// Module specifiers are blanked first, or `import os from 'os'` counts its own
// specifier as a use. Only specifiers: blanking every string ate the code after
// any regex literal containing a quote.
const countable = (source) => source.replace(/^(\s*import\s[^'"]*)['"][^'"]*['"]/gm, "$1")

const references = (source, name) => (source.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length

const scan = (file) => {
  const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const live = countable(source)
  const dead = []
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    if (references(live, match[1]) <= 1) dead.push(`function ${match[1]}`)
  }
  for (const match of source.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|<)/gm)) {
    if (references(live, match[1]) <= 1) dead.push(`const ${match[1]}`)
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
