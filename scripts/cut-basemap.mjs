// Cuts the vector tiles of GeoCode's offline basemap out of OpenFreeMap's planet: the tiles of zooms 0 to 6 of its
// PMTiles archive, read by ranges, written as an archive of their own. The release's other files do not change with
// the planet: Natural Earth's relief, from naturalearthtiles v1.0 as a PMTiles archive, and OpenFreeMap's icons. For a
// new basemap, cut one, publish it in a new release beside those files, and change stage-basemap.mjs to match.
//
// Usage:  node scripts/cut-basemap.mjs <planet> <output>
//   planet  a version of btrfs.openfreemap.com/files.txt, as 20261115_080022_pt; only the latest few are kept
//   output  the archive to write, as openmaptiles-z6.pmtiles

import fs from 'node:fs'
import zlib from 'node:zlib'

const MAX_ZOOM = 6
const HEADER = 127
// The header and the root directory are read in one request, as PMTiles readers do.
const ROOT_ROOM = 16384
const USER_AGENT = 'GeoCode basemap cutter (https://github.com/zzhonglei/GeoCode)'

const [planet, output] = process.argv.slice(2)
if (!planet || !output) {
  console.error('Usage: node scripts/cut-basemap.mjs <planet version> <output.pmtiles>')
  process.exit(2)
}
const url = `https://btrfs.openfreemap.com/areas/planet/${planet}/tiles.pmtiles`

const read = async (offset, length) => {
  const response = await fetch(url, { headers: { range: `bytes=${offset}-${offset + length - 1}`, 'user-agent': USER_AGENT } })
  if (response.status !== 206) throw new Error(`${url} answered ${response.status} to a range request`)
  return Buffer.from(await response.arrayBuffer())
}

/** The varints of a directory, from `at`, `count` of them. */
const varints = (bytes, at, count) => {
  const values = []
  for (let index = 0; index < count; index++) {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[at++]
      value += (byte & 0x7f) * 2 ** shift
      shift += 7
      if (byte < 0x80) break
    }
    values.push(value)
  }
  return { values, at }
}

/** A directory's entries, each { id, run, length, offset }; a run of 0 points at a leaf directory. */
const parseDirectory = (compressed) => {
  const bytes = zlib.gunzipSync(compressed)
  const count = varints(bytes, 0, 1)
  const ids = varints(bytes, count.at, count.values[0])
  const runs = varints(bytes, ids.at, count.values[0])
  const lengths = varints(bytes, runs.at, count.values[0])
  const offsets = varints(bytes, lengths.at, count.values[0])
  const entries = []
  let id = 0
  for (let index = 0; index < count.values[0]; index++) {
    id += ids.values[index]
    const raw = offsets.values[index]
    const offset = raw === 0 ? entries[index - 1].offset + entries[index - 1].length : raw - 1
    entries.push({ id, run: runs.values[index], length: lengths.values[index], offset })
  }
  return entries
}

const writeVarint = (out, value) => {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
}

const serializeDirectory = (entries) => {
  const out = []
  writeVarint(out, entries.length)
  let last = 0
  for (const entry of entries) {
    writeVarint(out, entry.id - last)
    last = entry.id
  }
  for (const entry of entries) writeVarint(out, entry.run)
  for (const entry of entries) writeVarint(out, entry.length)
  entries.forEach((entry, index) => {
    const before = entries[index - 1]
    writeVarint(out, index > 0 && entry.offset === before.offset + before.length ? 0 : entry.offset + 1)
  })
  return zlib.gzipSync(Buffer.from(out))
}

const header = await read(0, HEADER)
if (header.toString('latin1', 0, 7) !== 'PMTiles' || header[7] !== 3) throw new Error(`${url} is no PMTiles v3 archive`)
const field = (at) => Number(header.readBigUInt64LE(at))
const source = {
  root: [field(8), field(16)],
  metadata: [field(24), field(32)],
  leaves: field(40),
  data: field(56),
}
if (header[97] !== 2) throw new Error('the planet\'s directories are not gzipped, which this cutter reads')

// Every entry of the zooms kept, with runs cut at the last tile of the deepest.
const limit = (4 ** (MAX_ZOOM + 1) - 1) / 3
const kept = []
const collect = async (entries) => {
  for (const entry of entries) {
    if (entry.id >= limit) return
    if (entry.run === 0) await collect(parseDirectory(await read(source.leaves + entry.offset, entry.length)))
    else kept.push({ ...entry, run: Math.min(entry.run, limit - entry.id) })
  }
}
await collect(parseDirectory(await read(...source.root)))

// The contents, each once, read in large ranges and laid out again in the order of the tiles.
const contents = [...new Map(kept.map((entry) => [entry.offset, entry.length])).entries()].sort((a, b) => a[0] - b[0])
const chunks = []
for (const [offset, length] of contents) {
  const last = chunks.at(-1)
  if (last && offset - last.end <= 65536 && offset + length - last.start <= 8 << 20) last.end = Math.max(last.end, offset + length)
  else chunks.push({ start: offset, end: offset + length })
}
const bytesOf = new Map()
for (const chunk of chunks) {
  const bytes = await read(source.data + chunk.start, chunk.end - chunk.start)
  for (const [offset, length] of contents) {
    if (offset >= chunk.start && offset + length <= chunk.end) bytesOf.set(offset, bytes.subarray(offset - chunk.start, offset - chunk.start + length))
  }
}
const placed = new Map()
const data = []
let size = 0
const entries = kept.map((entry) => {
  if (!placed.has(entry.offset)) {
    placed.set(entry.offset, size)
    data.push(bytesOf.get(entry.offset))
    size += entry.length
  }
  return { id: entry.id, run: entry.run, length: entry.length, offset: placed.get(entry.offset) }
})

// The root directory alone when it fits beside the header; else leaves of as many entries as make it fit.
let root = serializeDirectory(entries)
let leaves = Buffer.alloc(0)
for (let size = 4096; HEADER + root.length > ROOT_ROOM; size *= 2) {
  const parts = []
  const pointers = []
  let offset = 0
  for (let index = 0; index < entries.length; index += size) {
    const leaf = serializeDirectory(entries.slice(index, index + size))
    pointers.push({ id: entries[index].id, run: 0, length: leaf.length, offset })
    parts.push(leaf)
    offset += leaf.length
  }
  root = serializeDirectory(pointers)
  leaves = Buffer.concat(parts)
}

const planetMetadata = JSON.parse(zlib.gunzipSync(await read(...source.metadata)))
const metadata = zlib.gzipSync(
  JSON.stringify({ ...planetMetadata, maxzoom: String(MAX_ZOOM), description: `Zooms 0 to ${MAX_ZOOM} of the OpenFreeMap planet ${planet}` }),
)

const out = Buffer.alloc(HEADER)
header.copy(out, 0, 0, HEADER)
const layout = [HEADER, root.length, HEADER + root.length, metadata.length]
layout.push(layout[2] + metadata.length, leaves.length, layout[2] + metadata.length + leaves.length, size)
layout.forEach((value, index) => out.writeBigUInt64LE(BigInt(value), 8 + index * 8))
out.writeBigUInt64LE(BigInt(entries.reduce((sum, entry) => sum + entry.run, 0)), 72)
out.writeBigUInt64LE(BigInt(entries.length), 80)
out.writeBigUInt64LE(BigInt(placed.size), 88)
// Clustered: the contents lie in the order of their first tiles. The rest of the header is the planet's, but for the
// deepest zoom and the zoom of its centre.
out[96] = 1
out[101] = MAX_ZOOM
out[118] = Math.min(out[118], MAX_ZOOM)
fs.writeFileSync(output, Buffer.concat([out, root, metadata, leaves, ...data]))
console.log(`wrote ${output}: ${entries.length} entries, ${placed.size} tiles' contents, ${(fs.statSync(output).size / 1e6).toFixed(1)} MB`)
