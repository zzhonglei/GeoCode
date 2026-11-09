// The packaged app's geo tools in a fresh sandbox, as GeoAgent would call them in one turn: readgeodata and qgisdoc
// on a small GeoJSON, the QGIS manual through webfetch, and qgisrun writing its centroids, on the QGIS given; with
// --gee, geerun on that Cloud project, at once and in the background, which uses the user's Earth Engine credentials
// (a copy, in the sandbox) and quota. Each call must give back what the tool is for, and the app must quit leaving
// nothing running and write in no other product's folders. The first start installs GeoCode's Python environment in
// the sandbox, which takes minutes. The manual is fetched from docs.qgis.org.
//
// Usage:  node scripts/app/geo.mjs [--qgis <QGIS.app>] [--gee <project ID>] [--app <GeoCode.app>] [--keep]
// Exits 0 when every item passed, 1 when one failed, and 3 when it could not run here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, fakeModel, options, runTurn, sandbox, sleep, textOf, toolsOf, useFakeModel } from './lib.mjs'

const { app, keep, qgis: given, gee } = options({ qgis: { type: 'string' }, gee: { type: 'string' } })
const qgis =
  given ??
  fs
    .readdirSync('/Applications')
    .filter((name) => /^QGIS.*\.app$/.test(name))
    .sort()
    .map((name) => path.join('/Applications', name))[0]
if (!qgis) {
  console.log('NOT RUN: no QGIS in /Applications; name one with --qgis')
  process.exit(3)
}
const CREDENTIALS = path.join('.config', 'earthengine', 'credentials')
if (gee && !fs.existsSync(path.join(os.userInfo().homedir, CREDENTIALS))) {
  console.log(`NOT RUN: no Earth Engine credentials in ~/${CREDENTIALS}`)
  process.exit(3)
}

const CELLS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'equator' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'north60' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 60],
            [1, 60],
            [1, 61],
            [0, 61],
            [0, 60],
          ],
        ],
      },
    },
  ],
}
const TASK = `geo-check-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`

// Each call, and what what it gives back must hold, if that is how it is judged.
const CALLS = [
  { name: 'readgeodata', arguments: { path: 'data/cells.geojson' }, gives: /north60/ },
  { name: 'qgisdoc', arguments: { action: 'help', algorithm: 'native:centroids' }, gives: /ALL_PARTS/ },
  {
    name: 'webfetch',
    arguments: {
      url: 'https://docs.qgis.org/latest/en/docs/user_manual/processing_algs/qgis/vectorgeometry.html#centroids',
      format: 'markdown',
    },
    gives: /Centroids/,
  },
  {
    name: 'qgisrun',
    arguments: {
      algorithm: 'native:centroids',
      parameters: { INPUT: 'data/cells.geojson', OUTPUT: 'data/centroids.geojson' },
    },
    // Judged by how the run ended and the file it wrote, below.
  },
  ...(gee
    ? [
        {
          name: 'geerun',
          arguments: { new_task: TASK, script: 'print(ee.Number(40).add(2).getInfo())', description: 'A query' },
          gives: /\b42\b/,
        },
        {
          name: 'geerun',
          arguments: {
            task: TASK,
            script: 'import time\ntime.sleep(5)\nprint(ee.Number(1).add(1).getInfo())',
            description: 'A query in the background',
            background: true,
          },
          gives: new RegExp(`Task ${TASK} is running in the background`),
        },
      ]
    : []),
]

const box = sandbox()
fs.writeFileSync(path.join(box.project, 'data', 'cells.geojson'), JSON.stringify(CELLS))
fs.writeFileSync(
  path.join(box.config, 'machine.json'),
  JSON.stringify({ qgis: { path: qgis }, ...(gee ? { gee } : {}) }),
)
const credentials = gee ? [path.join(box.home, CREDENTIALS)] : []
for (const file of credentials) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(path.join(os.userInfo().homedir, CREDENTIALS), file)
}
// One call a model request, then an answer: the tool results are the messages after the prompt.
const model = await fakeModel((request) => {
  const answered = (request.messages ?? []).filter((message) => message.role === 'tool').length
  const call = CALLS[answered]
  return call ? { call: { name: call.name, arguments: call.arguments } } : { answer: 'done' }
})
useFakeModel(box, model)

/** The centroids qgisrun wrote: the cells' two, near the middle of each. */
const centroids = () => {
  const file = path.join(box.project, 'data', 'centroids.geojson')
  if (!fs.existsSync(file)) return 'no file'
  const points = JSON.parse(fs.readFileSync(file, 'utf8')).features.map((feature) => feature.geometry)
  const near = (point, x, y) =>
    point?.type === 'Point' && Math.abs(point.coordinates[0] - x) < 0.01 && Math.abs(point.coordinates[1] - y) < 0.01
  return points.length === 2 && near(points[0], 0.5, 0.5) && near(points[1], 0.5, 60.5) ? '' : JSON.stringify(points)
}

// The QGIS manual, and with --gee the Earth Engine and Google sign-in endpoints.
const reaches = ['docs.qgis.org', ...(gee ? [/\.googleapis\.com$/] : [])]
await check({ app, box, model, keep, credentials, reaches, ms: 600000 }, async ({ api, record, item }) => {
  const created = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ location: { directory: box.project } }),
  })
  const session = created.body?.data?.id
  record('session: created in the project', Boolean(session), `${created.status} ${session}`)

  // Checked first, the Python environment before the rest: a first start installs it, and a tool called before it is
  // ready asks to be called again later. QGIS does not wait for it, and an app quit while it installs leaves its
  // temporary files.
  for (const domain of ['python', 'qgis', ...(gee ? ['gee'] : [])]) {
    await item(`${domain}: found ready`, async () => {
      let state
      for (let waited = 0; waited < 600000; waited += 3000) {
        state = (await api('/api/geocode/geo-status')).body?.statuses?.[domain]
        if (state && !['checking', 'preparing'].includes(state.status)) break
        await sleep(3000)
      }
      record(`${domain}: found ready`, state?.status === 'ready', JSON.stringify(state).slice(0, 200))
    })
  }

  let parts = []
  await item('turn: every call reaches its tool', async () => {
    const turn = await runTurn(api, session, 'look it up', { ms: 900000 })
    parts = toolsOf(turn)
    record(
      'turn: every call reaches its tool',
      !turn.error && parts.length === CALLS.length,
      turn.error ?? `${turn.seconds}s ${parts.map((part) => `${part.name}:${part.state?.status}`).join(' ')}`,
    )
  })

  // What each call gave back, as the model was given it in its last request.
  const last = model.requests
    .filter((request) => request.url.endsWith('/chat/completions') && request.body?.tools?.length)
    .at(-1)
  const results = (last?.body?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message.content))
  CALLS.forEach((call, index) => {
    if (!call.gives) return
    const given = results[index] ?? ''
    const label = `${call.name}${call.arguments.background ? ' in the background' : ''}: gives back what it is for`
    record(label, call.gives.test(given), JSON.stringify(given.slice(0, 160)))
  })
  const run = parts.find((part) => part.name === 'qgisrun')
  record('qgisrun: the run finishes', run?.state?.metadata?.outcome === 'finished', `${run?.state?.metadata?.outcome}`)
  const wrong = centroids()
  record('qgisrun: writes the centroids', !wrong, wrong)

  if (!gee) return
  // The background run's notice lands in the session after the turn, as a message of its own.
  await item('geerun in the background: its answer reaches the conversation', async () => {
    // Its text as it stands in a message, however the message holds it: the notice opens with the task and the state
    // and holds what the script printed.
    const inside = (text) => JSON.stringify(text).slice(1, -1)
    const opening = inside(`<geerun task="${TASK}" state="completed"`)
    let notice = ''
    for (let waited = 0; waited < 180000 && !notice; waited += 5000) {
      await sleep(5000)
      const messages = (await api(`/api/session/${session}/message`)).body?.data ?? []
      notice = messages.map((message) => JSON.stringify(message)).find((text) => text.includes(opening)) ?? ''
    }
    record(
      'geerun in the background: its answer reaches the conversation',
      // What the script printed, on a line of its own: the header went with the call's answer.
      notice.includes(inside('\n2\n')),
      notice.slice(0, 200),
    )
  })
})
