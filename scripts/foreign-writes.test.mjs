// The write check's own test: a check that finds nothing is worth something only if it finds what is there.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const SCRIPT = path.join(import.meta.dirname, 'foreign-writes.sh')

test(
  'the write check finds a file added, changed, removed or made executable where it watches, and nothing otherwise',
  { skip: process.platform !== 'darwin' && 'the check reads file details as macOS stat gives them' },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-foreign-writes-'))
    try {
      // ~/.agents: OpenChamber running on this machine leaves a finding there no less certain.
      const watched = path.join(home, '.agents')
      fs.mkdirSync(watched)
      fs.writeFileSync(path.join(watched, 'kept'), 'one')
      const env = { ...process.env, HOME: home, TMPDIR: home, FOREIGN_WRITES_SNAPSHOT: path.join(home, 'snapshot') }
      const check = (step) => spawnSync('sh', [SCRIPT, step], { env, encoding: 'utf8' })
      const around = (change) => {
        assert.equal(check('before').status, 0)
        change()
        return check('after')
      }

      fs.writeFileSync(path.join(home, 'elsewhere'), '')
      assert.equal(around(() => fs.writeFileSync(path.join(home, 'outside'), '')).status, 0)
      const added = around(() => fs.writeFileSync(path.join(watched, 'added'), ''))
      assert.equal(added.status, 1)
      assert.match(added.stdout, /\.agents\/added/)
      assert.equal(around(() => fs.appendFileSync(path.join(watched, 'kept'), ' and two')).status, 1)
      assert.equal(around(() => fs.chmodSync(path.join(watched, 'kept'), 0o755)).status, 1)
      assert.equal(around(() => fs.rmSync(path.join(watched, 'added'))).status, 1)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  },
)
