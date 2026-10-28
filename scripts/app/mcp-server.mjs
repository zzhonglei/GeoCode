// A local MCP server for the smoke check, over standard input and output: one tool, smoke_echo, answering its text
// in upper case.
import readline from 'node:readline'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = request
  if (id === undefined) return
  if (method === 'initialize')
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'smoke', version: '1.0.0' },
      },
    })
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list')
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'smoke_echo',
            description: 'Returns the given text in upper case',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      },
    })
  if (method === 'tools/call')
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: String(params?.arguments?.text ?? '').toUpperCase() }] },
    })
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
})
