// Where the app may write, as docs/PATHS.md says: the paths its file trees name, and a few it names only in its text.
// A check lists the sandbox before the app starts and after it quits, and asks of each new path whether the document
// accounts for it. The trees name the first levels only, so whatever lies under a named entry is accounted for.
import fs from 'node:fs'
import path from 'node:path'

export const DOCUMENT = path.resolve(import.meta.dirname, '..', '..', 'docs', 'PATHS.md')

// Where each tree's root lies: under the home, or in the project.
const ROOTS = { '~/': 'home', '<项目>/': 'project' }

// Named in the text rather than in a tree. A folder here accounts for all that lies under it; the patterns match
// a name directly in the folder. Section 7's leftovers are not here: a run that ends well leaves none.
const TEXT = {
  home: {
    folders: [
      '.local/state/geocode', // locks, and when Nominatim was last asked
      '.local/state/gh', // gh's device ID, written whenever gh runs
      'Library/Caches/bun', // Bun's transpiled plugins, shared with other Bun programs
      'Library/Logs/GeoCode',
      'Library/Application Support/GeoCode',
      'tmp/geocode', // where the agent is told to keep its temporary files
    ],
    patterns: {
      // GeoCode's short-lived files, Bun's native libraries and modules, the window's lock, spoken text.
      tmp: [/^geocode-/, /^\.bun-.*\.(dylib|node)$/, /^scoped_dir/, /^say-.*\.m4a$/],
    },
  },
  project: { folders: [], patterns: {} },
}

// In the project, what the agent writes is the task's: only GeoCode's own folders there are asked about.
const OWN_IN_PROJECT = /^\.(git|geocode)(\/|$)/

/** The entries of each file tree in the document, as paths under the home or the project. */
export const trees = (text) => {
  const named = { home: [], project: [] }
  for (const [, block] of text.matchAll(/^```\n([\s\S]*?)^```/gm)) {
    const [first, ...lines] = block.split('\n')
    const prefix = Object.keys(ROOTS).find((each) => first.startsWith(each))
    if (!prefix) continue
    const where = ROOTS[prefix]
    const base = first.slice(prefix.length).split(/\s/)[0].replace(/\/$/, '')
    // The entry each depth is in, as `├──` and `└──` lines nest four columns a level.
    const within = []
    for (const line of lines) {
      const at = line.search(/[├└]── /)
      if (at < 0) continue
      const depth = at / 4
      // The names before the description, which follows two spaces and may open with an English word (`agent 执行`).
      // Several may share a line: folders two spaces apart (`agents/  commands/  skills/`), or names after a comma
      // (`a.json, bin/b`); a bare `-shm` is a suffix, accounted for below.
      const groups = line
        .slice(at + 4)
        .split(/[\u3000-\u9fff(]/)[0]
        .split(/\s{2,}/)
      const kept = groups.filter((group, index) => groups.slice(0, index + 1).every((each) => each.endsWith('/')))
      const names = (kept.length ? kept : groups.slice(0, 1))
        .join(' ')
        .split(/[,\s]+/)
        .filter((name) => name && !name.startsWith('-'))
        .map((name) => name.replace(/\/$/, ''))
      within.length = depth
      within[depth] = names[0]
      for (const name of names) named[where].push([base, ...within.slice(0, depth), name].filter(Boolean).join('/'))
    }
  }
  return named
}

// The entries of each place and those among them that hold no other, worked out once: a fresh sandbox has tens of
// thousands of paths to ask about.
const prepared = new WeakMap()
const prepare = (documented, where) => {
  const entries = [...documented[where], ...TEXT[where].folders]
  const leaves = entries.filter((entry) => !entries.some((other) => other.startsWith(`${entry}/`)))
  return { entries, leaves }
}

/** Whether a new path, relative to the home or the project, is one the document accounts for. */
export const accounted = (documented, where, file) => {
  // SQLite's files that come and go with a database.
  const name = file.replace(/-(wal|shm|journal)$/, '')
  const named = documented[where]
  if (!prepared.has(named)) prepared.set(named, prepare(documented, where))
  const { entries, leaves } = prepared.get(named)
  // A folder that holds a documented path, such as `.local` for `.local/share/geocode`, or `.git/refs` for the refs
  // the tree names in it: the folder only, not whatever else is put in it.
  const holds = (entry) => entry.startsWith(`${name}/`)
  const under = (leaf) => name === leaf || name.startsWith(`${leaf}/`)
  if (entries.includes(name) || entries.some(holds) || leaves.some(under)) return true
  const folder = path.posix.dirname(name)
  return (TEXT[where].patterns[folder] ?? []).some((pattern) => pattern.test(path.posix.basename(name)))
}

/** Every path under a folder, relative to it, but for those under `skip`. */
export const list = (root, skip = []) => {
  const found = []
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const inside = relative ? `${relative}/${entry.name}` : entry.name
      if (skip.includes(inside)) continue
      found.push(inside)
      if (entry.isDirectory()) walk(inside)
    }
  }
  walk('')
  return found
}

/**
 * The sandbox's listing now, to be compared once the app has quit: `after` answers the new paths the document does
 * not account for, under the home and in the project. Electron's folder is where the check put it, not where the
 * app keeps it, so it is not listed.
 */
export const pathsCheck = (box) => {
  const skip = ['electron-user-data']
  const before = new Set(list(box.home, skip))
  const project = `${path.relative(box.home, box.project)}/`
  return {
    after: () => {
      const documented = trees(fs.readFileSync(DOCUMENT, 'utf8'))
      const found = list(box.home, skip)
        .filter((file) => !before.has(file))
        .filter((file) => {
          if (!file.startsWith(project)) return !accounted(documented, 'home', file)
          const inside = file.slice(project.length)
          return OWN_IN_PROJECT.test(inside) && !accounted(documented, 'project', inside)
        })
      // A folder stands for what is in it.
      const set = new Set(found)
      return found.filter((file) => !set.has(path.posix.dirname(file)))
    },
  }
}
