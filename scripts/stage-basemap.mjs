// Stages the offline basemap where the desktop app bundles it from: the files of GeoCode's basemap release, downloaded
// once into .cache/basemap and stopped unless they have the checksums below. The desktop's prepare:basemap runs this,
// and so does a launch from source. A new basemap is a new release: change RELEASE and FILES together.
//
// Usage:  node scripts/stage-basemap.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = path.resolve(import.meta.dirname, '..')
const RELEASE = 'https://github.com/zzhonglei/GeoCode/releases/download/basemap-2026-11-15'
// The files geoengine/src/basemap/index.ts reads, by their SHA-256.
const FILES = {
  'openmaptiles-z6.pmtiles': '5ac860a076ae8a3232edae4d0ddd31634a0238d94079652f95d489af842227eb',
  'relief-z6.pmtiles': '14eb0b62d4056807325264d3f1b7a2dee8ee8787b70423c9549b45f921775966',
  'ofm.json': '73e75e58d8c7bb62cc25d9d150660500552f4d04f6eac5efa4e236076773c356',
  'ofm.png': '8996a519d218dc5f98015267709dae272a77bb74ef0ecc5a0992dcf276c1be4c',
  'ofm@2x.json': '82a4aaeed2c5ce6e98553915754dbe394ee66fd9a2aacc4318d25cdd74e8730b',
  'ofm@2x.png': '3793faf7dc47960636e4b6b1039978fa6925e6c90a7cb49ef23b37e153635c9b',
}
const CACHE = path.join(ROOT, '.cache', 'basemap')
const STAGE = path.join(ROOT, 'desktop', 'packages', 'electron', 'resources', 'basemap')

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

fs.mkdirSync(CACHE, { recursive: true })
fs.mkdirSync(STAGE, { recursive: true })
for (const [name, sum] of Object.entries(FILES)) {
  const cached = path.join(CACHE, name)
  if (!fs.existsSync(cached)) {
    console.log(`downloading ${name}`)
    const response = await fetch(`${RELEASE}/${encodeURIComponent(name)}`)
    if (!response.ok || !response.body) throw new Error(`${RELEASE}/${name} answered ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(`${cached}.tmp`))
    fs.renameSync(`${cached}.tmp`, cached)
  }
  const got = digest(cached)
  if (got !== sum) {
    fs.rmSync(cached)
    throw new Error(`${name} has checksum ${got}, expected ${sum}`)
  }
  const staged = path.join(STAGE, name)
  if (fs.existsSync(staged) && digest(staged) === sum) continue
  fs.copyFileSync(cached, staged, fs.constants.COPYFILE_FICLONE)
}
// What an earlier basemap left behind would be bundled too.
for (const name of fs.readdirSync(STAGE)) {
  if (!(name in FILES)) fs.rmSync(path.join(STAGE, name), { recursive: true })
}
console.log(`staged the basemap in ${STAGE}`)
