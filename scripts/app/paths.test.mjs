// The paths check's own test: it must read docs/PATHS.md's trees as the document means them, and find a path the
// document does not name.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DOCUMENT, accounted, pathsCheck, trees } from './paths.mjs'

const TREE = `
\`\`\`
~/.local/share/demo/
├── data.db             the database, and an English word: data 存在这里
├── log/  cache/        two folders
├── pair.json, bin/tool  两个
└── python/
    └── envs/default/   工作环境
\`\`\`
\`\`\`
<项目>/
└── .git/
    ├── demo            项目标识
    └── refs/
        └── demo/       快照
\`\`\`
`

test('the trees are read as entries under the home and the project, without words of their descriptions', () => {
  assert.deepEqual(trees(TREE), {
    home: [
      '.local/share/demo/data.db',
      '.local/share/demo/log',
      '.local/share/demo/cache',
      '.local/share/demo/pair.json',
      '.local/share/demo/bin/tool',
      '.local/share/demo/python',
      '.local/share/demo/python/envs/default',
    ],
    project: ['.git', '.git/demo', '.git/refs', '.git/refs/demo'],
  })
  const documented = trees(fs.readFileSync(DOCUMENT, 'utf8'))
  assert.ok(documented.home.includes('.local/share/geocode/desktop/settings.json'))
  assert.ok(documented.project.includes('.git/geocode'))
  // `shell/` is described as what an "agent" runs: the word is not a name.
  assert.ok(!documented.home.includes('.local/share/geocode/agent'))
})

test('a path is accounted for under a named entry, as a folder on the way to one, or as the text names it', () => {
  const documented = trees(TREE)
  const home = (file) => accounted(documented, 'home', file)
  assert.ok(home('.local/share/demo/log/today.log'))
  assert.ok(home('.local/share/demo/data.db-wal'))
  assert.ok(home('.local/share/demo/bin'))
  assert.ok(home('.local'))
  assert.ok(home('.local/state/geocode/locks/a.lock'))
  assert.ok(home('tmp/.bun-501-1.dylib'))
  assert.ok(!home('.local/share/demo/other.json'))
  assert.ok(!home('.local/share/demo/python/envs/other'))
  assert.ok(!home('tmp/other'))
  // A folder that holds named entries is accounted for itself, not what else lands in it.
  assert.ok(accounted(documented, 'project', '.git/refs'))
  assert.ok(accounted(documented, 'project', '.git/refs/demo/one'))
  assert.ok(!accounted(documented, 'project', '.git/refs/other'))
})

test('the check reports the new paths the document does not name, a folder for all it holds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-paths-'))
  try {
    const home = path.join(root, 'home')
    const project = path.join(home, 'projects', 'demo')
    const make = (file) => {
      fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true })
      fs.writeFileSync(path.join(home, file), '')
    }
    make('.zshrc')
    make('projects/demo/.git/HEAD')
    const check = pathsCheck({ home, project })
    make('.local/share/geocode/desktop/settings.json')
    make('projects/demo/result.txt')
    make('.local/share/geocode/unnamed/a')
    make('.local/share/geocode/unnamed/b')
    make('projects/demo/.git/unnamed')
    assert.deepEqual(check.after().sort(), ['.local/share/geocode/unnamed', 'projects/demo/.git/unnamed'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
