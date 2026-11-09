// The packaged app's everyday features in a fresh sandbox, once its Python environment is ready: the API and that it
// refuses a request without the window's token, the agent's file, shell, search, web and subagent tools, the diff, git
// status, undo and redo, attachments, an MCP server, session operations and compaction; then that it quits leaving
// nothing running and wrote in no other product's folders. The model is a local fake that makes each item's tool calls
// and answers only with what the tools gave back, so an item whose tools fail still fails. The web item fetches
// https://example.com.
//
// Usage:  node scripts/app/smoke.mjs [--app <GeoCode.app>] [--keep]
// Exits 0 when every item passed, 1 when one failed, and 3 when it could not run here.
import fs from 'node:fs'
import path from 'node:path'
import { check, fakeModel, options, runTurn, sandbox, settled, sleep, textOf, textsOf, toolsOf, useFakeModel } from './lib.mjs'

const { app, keep } = options()
const MCP_SERVER = path.join(import.meta.dirname, 'mcp-server.mjs')

const find = (results, pattern) => results.join('\n').match(pattern)?.[0]

// For each item's prompt: the calls to make in order (a function of the request when it needs the tool listing), and
// the answer, from what the calls gave back.
const SCRIPTS = [
  {
    when: /Read the file notes\.txt/,
    calls: [{ name: 'read', arguments: { path: 'notes.txt' } }],
    answer: (results) => find(results, /GeoCode smoke line one/) ?? 'not found',
  },
  {
    when: /Create a new file named created\.txt/,
    calls: [{ name: 'write', arguments: { path: 'created.txt', content: 'GEOCODE-SMOKE' } }],
    answer: () => 'done',
  },
  {
    when: /change the word second to edited/,
    calls: [{ name: 'edit', arguments: { path: 'notes.txt', oldString: 'second', newString: 'edited' } }],
    answer: () => 'done',
  },
  {
    when: /Run this shell command/,
    calls: [{ name: 'shell', arguments: { command: 'echo smoke-$((6*7))' } }],
    answer: (results) => find(results, /smoke-42/) ?? 'not found',
  },
  {
    when: /contains the word needle/,
    calls: [{ name: 'grep', arguments: { pattern: 'needle' } }],
    answer: (results) => find(results, /[\w./-]*points\.csv/) ?? 'not found',
  },
  {
    when: /Fetch https:\/\/example\.com/,
    // The markdown conversion keeps the body text only; the title is in the HTML.
    calls: [{ name: 'webfetch', arguments: { url: 'https://example.com', format: 'html' } }],
    answer: (results) => find(results, /Example Domain/) ?? 'not found',
  },
  {
    when: /Delegate this to a subagent/,
    calls: [
      {
        name: 'subagent',
        arguments: {
          agent: 'general',
          description: 'Count README lines',
          prompt: 'Count the lines in README.md and reply as LINES-<the number>.',
        },
      },
    ],
    answer: (results) => find(results, /LINES-\d+/) ?? 'not found',
  },
  {
    // The subagent's own session.
    when: /Count the lines in README\.md and reply as LINES/,
    calls: [{ name: 'read', arguments: { path: 'README.md' } }],
    answer: (results) => (find(results, /# Demo/) ? 'LINES-1' : 'not found'),
  },
  {
    when: /Use the smoke_echo tool/,
    calls: [
      (request) => {
        // The Code Mode catalog that names MCP tools is in the instructions, not in the execute tool's description.
        const listing = [
          ...(request.messages ?? []).map((message) => textOf(message.content)),
          ...(request.tools ?? []).map((tool) => tool.function?.description ?? ''),
        ].join('\n')
        const expression = listing.match(
          /tools(?:\.[A-Za-z_$][\w$]*|\["[^"]*"\])*(?:\.smoke_echo|\["smoke_echo"\])/,
        )?.[0]
        return expression
          ? { name: 'execute', arguments: { code: `return await ${expression}({ text: "hello-mcp" })` } }
          : { name: 'smoke_echo', arguments: { text: 'hello-mcp' } }
      },
    ],
    answer: (results) => find(results, /HELLO-MCP/) ?? 'not found',
  },
  {
    when: /secret word in the attached file/,
    calls: [],
    answer: (results, request) => find([JSON.stringify(request.messages)], /PAPAYA/) ?? 'not found',
  },
]

const next = (request) => {
  const messages = request.messages ?? []
  const lastUser = messages.findLastIndex((message) => message.role === 'user')
  const prompt = textOf(messages[lastUser]?.content)
  const results = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message.content))
  const script = SCRIPTS.find((candidate) => candidate.when.test(prompt))
  if (!script) return { answer: 'ok' }
  const planned = script.calls[results.length]
  if (planned) return { call: typeof planned === 'function' ? planned(request) : planned }
  return { answer: script.answer(results, request) }
}

const box = sandbox()
const model = await fakeModel(next)
useFakeModel(box, model)
const dir = box.project
const q = `location[directory]=${encodeURIComponent(dir)}`
const tools = (turn) => toolsOf(turn).map((part) => `${part.name}:${part.state?.status}`)
const summary = (turn) =>
  turn.error ?? `${turn.seconds}s tools=[${tools(turn).join(',')}] reply=${JSON.stringify(textsOf(turn).slice(0, 120))}`

await check({ app, box, model, keep, reaches: ['example.com'] }, async ({ api, record, item }) => {
  // First: a first start installs the Python environment, and an app quit before it is done leaves its temporary
  // files, which the paths check reports.
  await item('python: found ready', async () => {
    const state = await settled(api, 'python')
    record('python: found ready', state?.status === 'ready', JSON.stringify(state).slice(0, 200))
  })

  await item('api: read-only endpoints', async () => {
    const routes = [
      '/api/info',
      '/api/config',
      '/api/agent',
      '/api/provider',
      '/api/model',
      '/api/model/default',
      '/api/skill',
      '/api/command',
      '/api/mcp',
      '/api/plugin',
      '/api/session',
      '/api/vcs/status',
      '/api/permission/saved',
    ]
    const failing = []
    for (const route of routes) {
      const { status } = await api(`${route}?${q}`)
      if (status !== 200) failing.push(`${route}=${status}`)
    }
    record('api: read-only endpoints', !failing.length, failing.join(' ') || `${routes.length} answered 200`)
  })
  await item('api: refuses a request without the token', async () => {
    // The shell server falls back to no authentication when it does not receive the password under the option name
    // main.mjs passes it as.
    const { status } = await api(`/api/config?${q}`, { headers: { Authorization: '' } })
    record('api: refuses a request without the token', status === 401, `${status}`)
  })

  const created = await api('/api/session', { method: 'POST', body: JSON.stringify({ location: { directory: dir } }) })
  const session = created.body?.data?.id
  record('session: created in the project', Boolean(session), `${created.status} ${session}`)
  const userIds = {}
  const turn = (label, text, check, extra) =>
    item(label, async () => {
      const done = await runTurn(api, session, text, extra)
      if (done.messages) userIds[label] = done.messages.find((message) => message.type === 'user')?.id
      record(label, !done.error && check(done), summary(done))
    })
  const file = (name) => path.join(dir, name)

  await turn(
    'tool: read',
    'Read the file notes.txt in the current folder and reply with its first line only.',
    (done) => /GeoCode smoke line one/.test(textsOf(done)),
  )
  await turn(
    'tool: write',
    'Create a new file named created.txt in the current folder whose entire content is the text GEOCODE-SMOKE. Then reply with the word done.',
    () => fs.existsSync(file('created.txt')) && fs.readFileSync(file('created.txt'), 'utf8').includes('GEOCODE-SMOKE'),
  )
  await turn(
    'tool: edit',
    'In notes.txt, change the word second to edited. Keep everything else unchanged. Then reply with the word done.',
    () => fs.readFileSync(file('notes.txt'), 'utf8').includes('edited line'),
  )
  await item('session: diff', async () => {
    const diff = await api(`/api/session/${session}/diff`)
    record('session: diff', diff.status === 200 && JSON.stringify(diff.body).includes('notes.txt'), `${diff.status}`)
  })
  await turn('tool: shell', 'Run this shell command and reply with exactly its output: echo smoke-$((6*7))', (done) =>
    /smoke-42/.test(textsOf(done)),
  )
  await turn(
    'tool: search',
    'Which file under the current folder contains the word needle? Use your search tools, then reply with its relative path only.',
    (done) => /points\.csv/.test(textsOf(done)),
  )
  await turn('tool: webfetch', 'Fetch https://example.com and reply with the page title only.', (done) =>
    /Example Domain/i.test(textsOf(done)),
  )
  await turn(
    'tool: subagent',
    'Delegate this to a subagent with your task tool: count the lines in README.md. Then reply with the number only.',
    (done) => tools(done).includes('subagent:completed') && /\bLINES-1\b/.test(textsOf(done)),
  )

  await item('vcs: status', async () => {
    const status = await api(`/api/vcs/status?${q}`)
    record(
      'vcs: status',
      status.status === 200 && JSON.stringify(status.body).includes('notes.txt'),
      `${status.status}`,
    )
  })

  let undone = false
  await item('undo: revert the write and the edit', async () => {
    const staged = await api(`/api/session/${session}/revert/stage`, {
      method: 'POST',
      body: JSON.stringify({ messageID: userIds['tool: write'], files: true }),
    })
    await sleep(1500)
    const gone = !fs.existsSync(file('created.txt'))
    const restored = fs.readFileSync(file('notes.txt'), 'utf8').includes('second line')
    undone = staged.status === 200 && gone && restored
    record(
      'undo: revert the write and the edit',
      undone,
      `${staged.status} created.txt gone=${gone} notes restored=${restored}`,
    )
  })
  await item('undo: redo', async () => {
    const cleared = await api(`/api/session/${session}/revert`, { method: 'DELETE' })
    await sleep(1500)
    const back = fs.existsSync(file('created.txt'))
    // Only once the undo took the file away.
    record('undo: redo', undone && cleared.status < 300 && back, `${cleared.status} created.txt back=${back}`)
  })

  await item('attachment: a text file', async () => {
    const uri = 'data:text/plain;base64,' + Buffer.from('The secret word is PAPAYA.\n').toString('base64')
    const done = await runTurn(
      api,
      session,
      'What is the secret word in the attached file? Reply with the word only.',
      {
        extra: { files: [{ uri, name: 'secret.txt' }] },
      },
    )
    const stored = !done.error && done.messages.some((message) => message.type === 'user' && message.files?.[0]?.data)
    record('attachment: a text file', stored && /PAPAYA/.test(textsOf(done)), `${summary(done)} stored=${stored}`)
  })

  await item('mcp: add a local server', async () => {
    const config = { type: 'local', command: [process.execPath, MCP_SERVER] }
    const added = await api(`/api/experimental/mcp/smoke?${q}`, { method: 'PUT', body: JSON.stringify({ config }) })
    await sleep(3000)
    const list = await api(`/api/mcp?${q}`)
    record(
      'mcp: add a local server',
      added.status < 300 && JSON.stringify(list.body).includes('smoke'),
      `${added.status}`,
    )
  })
  await turn(
    'mcp: call its tool',
    'Use the smoke_echo tool with the text hello-mcp and reply with exactly what it returns.',
    (done) => /HELLO-MCP/.test(textsOf(done)),
  )

  await item('session: rename, fork, list, delete the fork', async () => {
    const renamed = await api(`/api/session/${session}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Smoke session' }),
    })
    const forked = await api(`/api/session/${session}/fork`, { method: 'POST', body: JSON.stringify({}) })
    const fork = forked.body?.data?.id
    const listed = JSON.stringify((await api(`/api/session?${q}`)).body).includes('Smoke session')
    const removed = fork ? await api(`/api/session/${fork}`, { method: 'DELETE' }) : { status: 0 }
    record(
      'session: rename, fork, list, delete the fork',
      renamed.status < 300 && Boolean(fork) && listed && removed.status < 300,
      `rename=${renamed.status} fork=${forked.status} listed=${listed} delete=${removed.status}`,
    )
  })
  await item('session: compact', async () => {
    const compacted = await api(`/api/session/${session}/compact`, { method: 'POST', body: JSON.stringify({}) })
    let types = []
    for (let waited = 0; waited < 60000 && !types.some((type) => /compact/i.test(type)); waited += 2000) {
      await sleep(2000)
      types = ((await api(`/api/session/${session}/message`)).body?.data ?? []).map((message) => message.type)
    }
    record(
      'session: compact',
      compacted.status < 300 && types.some((type) => /compact/i.test(type)),
      `${compacted.status} ${types.slice(-4).join(',')}`,
    )
  })
})
