// What the checks of the packaged app share: a sandbox home, a model that answers as a check scripts it, the app
// started in the sandbox and spoken to through its window's API, and the write and network checks around it. macOS
// only, as the packaged app the checks start is.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { networkCheck } from './network.mjs'
import { pathsCheck } from './paths.mjs'

export const top = path.resolve(import.meta.dirname, '..', '..')
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A GeoEngine domain's status once it has settled, or the last one seen after ten minutes. A first start installs the
// Python environment, and the other domains wait for it.
export const settled = async (api, domain) => {
  let state
  for (let waited = 0; waited < 600000; waited += 3000) {
    state = (await api('/api/geocode/geo-status')).body?.statuses?.[domain]
    if (state && !['checking', 'preparing'].includes(state.status)) break
    await sleep(3000)
  }
  return state
}

/** The options every check takes, with its own; `--app` defaults to the one `bun run package -- --dir` builds. */
export const options = (own = {}) => {
  const { values } = parseArgs({ options: { app: { type: 'string' }, keep: { type: 'boolean' }, ...own } })
  const built = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
  const app = values.app ?? path.join(top, 'desktop/packages/electron/dist', built, 'GeoCode.app')
  if (process.platform !== 'darwin') stop(3, 'NOT RUN: the checks start the packaged macOS app')
  if (!fs.existsSync(path.join(app, 'Contents/MacOS/GeoCode'))) stop(3, `NOT RUN: no packaged app at ${app}`)
  return { ...values, app }
}

export const stop = (code, message) => {
  console.log(message)
  process.exit(code)
}

/**
 * A sandbox outside the repository: a home with a demo git project and a .zshrc that adds Homebrew to PATH, as a
 * typical user's has.
 */
export const sandbox = () => {
  // By its real path: macOS's temporary folder is under a link (/var), and a project opened through one loses its
  // diff and undo.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'geocode-app-')))
  const home = path.join(root, 'home')
  const project = path.join(home, 'projects', 'demo')
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(project, 'data'), { recursive: true })
  fs.mkdirSync(path.join(home, '.config', 'geocode'), { recursive: true })
  fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="/opt/homebrew/bin:$PATH"\n')
  fs.writeFileSync(path.join(project, 'notes.txt'), 'GeoCode smoke line one\nsecond line\n')
  fs.writeFileSync(path.join(project, 'data', 'points.csv'), 'id,name\n1,needle\n2,hay\n')
  fs.writeFileSync(path.join(project, 'README.md'), '# Demo\n')
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.invalid', ...args], {
      cwd: project,
      // Without the variables that would point git at another repository or the user's own configuration.
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|XDG_)/.test(name))),
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { root, home, project, config: path.join(home, '.config', 'geocode') }
}

/**
 * A local OpenAI-compatible endpoint that plays the model: for each request carrying tools, `next` gives the tool call
 * to make or the text to answer with; requests without tools (titles, compaction) get a short answer. Every request
 * is kept, so a check can read what each tool gave back.
 */
export const fakeModel = async (next) => {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        answer(req, res, body)
      } catch (error) {
        // An answer the app reads as the model failing, rather than the check ending with the app still running.
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(String(error?.stack ?? error))
      }
    })
  })
  const answer = (req, res, body) => {
    const request = body ? JSON.parse(body) : null
    requests.push({ url: req.url, body: request })
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake', object: 'model' }] }))
    }
    const step = request.tools?.length ? next(request) : { answer: 'Check session' }
    const base = {
      id: 'chatcmpl-check',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'fake',
    }
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    if (!request.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const message = { role: 'assistant', content: step.answer ?? '' }
      return res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage,
        }),
      )
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (chunk) => res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`)
    if (step.call) {
      const call = {
        index: 0,
        id: `call_${requests.length}`,
        type: 'function',
        function: { name: step.call.name, arguments: JSON.stringify(step.call.arguments) },
      }
      send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: step.answer }, finish_reason: null }] })
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    }
    res.end('data: [DONE]\n\n')
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** The text of a message's content, however the request carries it. */
export const textOf = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n')

/** The sandbox's global config, with the fake model as the `fake` provider and, unless told otherwise, the default. */
export const useFakeModel = (box, model, { asDefault = true } = {}) => {
  const provider = {
    name: 'Fake',
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'fake' },
    models: { fake: { name: 'Fake' } },
  }
  const config = { ...(asDefault ? { model: 'fake/fake' } : {}), providers: { fake: provider } }
  fs.writeFileSync(path.join(box.config, 'geocode.json'), JSON.stringify(config, null, 2))
}

/**
 * Starts the app in the sandbox as a user's login would: an environment of the sandbox's home and the system's PATH
 * alone, Electron's own folder in the sandbox, and the DevTools protocol on a port the system picks. Resolves once the
 * window's API answers.
 */
export const launch = async (app, box, ms = 300000, spawned = () => {}) => {
  const userData = path.join(box.home, 'electron-user-data')
  const environment = {
    HOME: box.home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/zsh',
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    TMPDIR: path.join(box.home, 'tmp'),
  }
  const log = fs.openSync(path.join(box.root, 'app.log'), 'w')
  const child = spawn(
    path.join(app, 'Contents/MacOS/GeoCode'),
    [`--user-data-dir=${userData}`, '--remote-debugging-port=0'],
    { env: environment, stdio: ['ignore', log, log] },
  )
  // Told at once, so that whoever started it can stop it however the start ends.
  spawned(child)
  const portFile = path.join(userData, 'DevToolsActivePort')
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (ended(child))
      throw new Error(`the app ended (${child.exitCode ?? child.signalCode}); see ${path.join(box.root, 'app.log')}`)
    const port = fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) : 0
    const api = port ? await connect(port).catch(() => null) : null
    if (api && (await api('/api/session')).status === 200) return { child, api }
    await sleep(2000)
  }
  throw new Error(`the app's window did not answer within ${ms / 1000} s`)
}

const ended = (child) => child.exitCode !== null || child.signalCode !== null

/** The window's API, with the token and origin its page holds. */
const connect = async (port) => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = pages.find((each) => each.type === 'page' && each.url.startsWith('openchamber-ui://'))
  if (!page) throw new Error('no window yet')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const expression = '({ token: window.__OPENCHAMBER_CLIENT_TOKEN__, origin: window.__OPENCHAMBER_LOCAL_ORIGIN__ })'
  // A window that reloads closes the socket without answering.
  const value = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the window did not answer')), 5000)
    socket.addEventListener('close', () => reject(new Error('the window went away')), { once: true })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      resolve(message.result?.result?.value)
    })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  }).finally(() => socket.close())
  if (!value?.token || !value?.origin) throw new Error('the window has no API yet')
  return async (route, init = {}) => {
    const response = await fetch(value.origin + route, {
      ...init,
      headers: { Authorization: `Bearer ${value.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
}

/** Sends one prompt and waits for the turn to end, answering every permission request with `decision`. */
export const runTurn = async (api, session, text, { decision = 'once', ms = 300000, extra = {} } = {}) => {
  const seen = new Set(((await api(`/api/session/${session}/message`)).body?.data ?? []).map((message) => message.id))
  const sent = await api(`/api/session/${session}/prompt`, { method: 'POST', body: JSON.stringify({ text, ...extra }) })
  if (sent.status !== 200) return { error: `prompt ${sent.status} ${JSON.stringify(sent.body).slice(0, 300)}` }
  const permissions = []
  const started = Date.now()
  while (Date.now() - started < ms) {
    await sleep(2000)
    for (const request of (await api(`/api/session/${session}/permission`)).body?.data ?? []) {
      permissions.push(request)
      await api(`/api/session/${session}/permission/${request.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      })
    }
    const messages = (await api(`/api/session/${session}/message`)).body?.data ?? []
    const fresh = messages.filter((message) => !seen.has(message.id))
    if (fresh.some((message) => message.type === 'idle')) {
      return { messages: fresh, permissions, seconds: Math.round((Date.now() - started) / 1000) }
    }
  }
  return { error: 'timeout', permissions }
}

/** The tool parts of a turn's answers, each with its name and state. */
export const toolsOf = (turn) =>
  (turn.messages ?? [])
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.content.filter((part) => part.type === 'tool'))

export const textsOf = (turn) =>
  (turn.messages ?? [])
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.content.filter((part) => part.type === 'text').map((part) => part.text))
    .join(' ')

/**
 * The app's processes: the one started and all it started, through the kernel, which leaves the app's process group,
 * to what the kernel runs; a process its parent left behind is found by the group it kept.
 */
const processesOf = (pid) => {
  const table = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, id, parent, group, command]) => ({
      pid: Number(id),
      parent: Number(parent),
      group: Number(group),
      command,
    }))
  const found = new Set([pid])
  for (let grown = true; grown; ) {
    grown = false
    for (const each of table) {
      if (found.has(each.pid) || !(found.has(each.parent) || found.has(each.group))) continue
      found.add(each.pid)
      grown = true
    }
  }
  return table.filter((each) => found.has(each.pid))
}

const alive = ({ pid, command }) => {
  const now = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return now === command.trim()
}

/** The processes whose working directory is in the sandbox: whatever the agent ran there, its parent gone or not. */
const workingIn = (box) => {
  const listed = spawnSync('lsof', ['-nP', '-a', '-u', os.userInfo().username, '-d', 'cwd', '-Fpn'], {
    encoding: 'utf8',
  })
  const found = []
  let pid
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && (line.slice(1) === box.root || line.startsWith(`n${box.root}/`))) found.push(pid)
  }
  return found.flatMap((each) => processesOf(each).filter((row) => row.pid === each))
}

/**
 * Quits the app and lists what of its processes still run after it: nothing, when it quit as it should. Its own are
 * found as it quits; what it left behind before, as a command the agent sent to the background, by where it runs.
 */
export const quit = async (child, box) => {
  // Besides those: any process that names the sandbox, such as one a crash left without a parent.
  const named = () =>
    spawnSync('pgrep', ['-f', '--', box.root], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .flatMap((pid) => processesOf(Number(pid)).filter((each) => each.pid === Number(pid)))
  const watched = [...processesOf(child.pid), ...named(), ...workingIn(box)]
  child.kill('SIGTERM')
  for (let waited = 0; waited < 30000 && watched.some(alive); waited += 500) await sleep(500)
  const left = [...new Map([...watched.filter(alive), ...workingIn(box)].map((each) => [each.pid, each])).values()]
  for (const each of left) spawnSync('kill', ['-KILL', String(each.pid)])
  return left.map((each) => `${each.pid} ${each.command.slice(0, 120)}`)
}

/**
 * The write check (scripts/foreign-writes.sh) of the user's home and of the sandbox's: the app must write in neither
 * OpenCode's, OpenChamber's nor Claude's folders. `after` answers the findings, an empty list when clean.
 */
export const writeCheck = (box) => {
  // Each with the temporary folder the app has there: the user's own, as the account has them whatever this process
  // was given, and the sandbox's.
  const temporary = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim()
  const homes = [
    { home: os.userInfo().homedir, temporary },
    { home: box.home, temporary: path.join(box.home, 'tmp') },
  ]
  const run = (step, { home, temporary }, index) =>
    spawnSync('sh', [path.join(top, 'scripts/foreign-writes.sh'), step], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: temporary,
        FOREIGN_WRITES_SNAPSHOT: path.join(box.root, `writes-${index}`),
      },
    })
  homes.forEach((home, index) => run('before', home, index))
  return {
    after: () =>
      homes.flatMap((each, index) => {
        const ran = run('after', each, index)
        if (ran.status === 0) return []
        // The check reads a finding under OpenChamber's folders as perhaps its own when one runs on this machine:
        // none runs in the sandbox.
        const whose = index && ran.status === 3 ? " (no OpenChamber runs in the sandbox: these are the app's)" : ''
        return [`${index ? 'the sandbox' : 'your'} home${whose}: ${ran.stdout.trim()}`]
      }),
  }
}

// What any run reaches through the proxy: the model catalog the kernel refreshes.
const ALWAYS_REACHED = ['models.dev', 'models.opencode.ai']
const matches = (expected, host) => (expected instanceof RegExp ? expected.test(host) : expected === host)

/**
 * Runs a check of the app: the write check started, the app started in the sandbox, `body` given its API and `record`
 * and `item` to note each result with, then the app quit, what it left running, where it wrote and what it reached
 * noted too; `reaches` names the hosts its own calls reach beyond those of any run, as a name or a pattern. Each item
 * is printed as it is recorded; at the end the sandbox is removed unless an item failed or `keep` asks to keep it, but
 * for a copy of the user's credentials, which goes in any case. An interruption still quits the app.
 */
export const check = async ({ app, box, model, keep, ms, credentials = [], reaches = [] }, body) => {
  const items = []
  const record = (name, pass, detail = '') => {
    items.push({ name, pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  }
  const item = async (name, run) => {
    try {
      await run()
    } catch (error) {
      record(name, false, `threw: ${error.message}`)
    }
  }
  const writes = writeCheck(box)
  const paths = pathsCheck(box)
  const network = await networkCheck(box)
  let child
  const interrupted = (signal) => {
    if (child) for (const each of processesOf(child.pid)) spawnSync('kill', ['-KILL', String(each.pid)])
    for (const file of credentials) fs.rmSync(file, { force: true })
    console.log(`\n${signal}: the app was stopped; sandbox kept: ${box.root}`)
    process.exit(1)
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const started = await launch(app, box, ms, (spawned) => (child = spawned)).catch((error) => {
      record('app: starts and its window answers', false, error.message)
      return null
    })
    if (started) await item('the checks run to their end', () => body({ api: started.api, record, item }))
  } finally {
    if (child) {
      const left = await quit(child, box)
      record('app: quits leaving nothing running', !left.length, left.join('; '))
    }
    const { outside, local } = await network.after()
    record('app: keeps this machine’s addresses off the proxy', !local.length, local.join(' '))
    const unexpected = outside.filter((host) => ![...ALWAYS_REACHED, ...reaches].some((each) => matches(each, host)))
    record(
      'app: reaches only what it is expected to',
      !unexpected.length,
      `${outside.join(' ')}; not expected: ${unexpected.join(' ') || 'none'}`,
    )
    await model.close()
    const found = writes.after()
    record('app: writes in no other product’s folders', !found.length, found.join('\n'))
    const unaccounted = paths.after()
    record('app: writes only where docs/PATHS.md says', !unaccounted.length, unaccounted.join('  '))
  }
  for (const file of credentials) fs.rmSync(file, { force: true })
  const failed = items.filter((each) => !each.pass).length
  console.log(`\n${items.length - failed}/${items.length} passed`)
  if (failed || keep) console.log(`sandbox kept: ${box.root}`)
  else fs.rmSync(box.root, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
