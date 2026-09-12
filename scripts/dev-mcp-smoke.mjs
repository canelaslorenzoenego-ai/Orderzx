#!/usr/bin/env node
/**
 * MCP bridge smoke — speaks real newline-delimited JSON-RPC to a spawned
 * `node lib/mcp.js` child, the way an MCP client would.
 *
 * Static on purpose: nothing here launches a browser. `tools/list` proves the
 * bridge exposes the same registry as the plugin, `browser_status` proves a
 * call round-trips through the real tool layer, and the shutdown path proves
 * stdin-close exits cleanly.
 *
 * Run: `node scripts/dev-mcp-smoke.mjs` (after `tsc -p tsconfig.json`).
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStepReporter } from './_smoke-harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { step, finish } = createStepReporter('mcp')

const child = spawn(process.execPath, [join(root, 'lib', 'mcp.js')], { stdio: ['pipe', 'pipe', 'pipe'] })

let stdoutBuffer = ''
const pending = new Map()
child.stdout.on('data', chunk => {
  stdoutBuffer += String(chunk)
  let newline
  while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.slice(0, newline).trim()
    stdoutBuffer = stdoutBuffer.slice(newline + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { step(`bridge emitted non-JSON: ${line.slice(0, 80)}`, false); continue }
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter(message)
    }
  }
})
let stderrText = ''
child.stderr.on('data', chunk => { stderrText += String(chunk) })

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000)
    pending.set(id, message => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
  })
}
function notify(method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  step('initialize answers with the requested protocol version', init.result?.protocolVersion === '2024-11-05', JSON.stringify(init.result?.protocolVersion))
  step('initialize advertises tools capability + server info', init.result?.capabilities?.tools !== undefined && init.result?.serverInfo?.name?.includes('dsh-browser') === true, JSON.stringify(init.result?.serverInfo))
  notify('notifications/initialized')

  const ping = await rpc('ping')
  step('ping round-trips', ping.result !== undefined && ping.error === undefined)

  const list = await rpc('tools/list')
  const names = (list.result?.tools ?? []).map(t => t.name)
  step('tools/list exposes the full registry (same count as the plugin)', names.length === 24, `got ${names.length}`)
  step('every tool carries name + description + inputSchema', (list.result?.tools ?? []).every(t => typeof t.name === 'string' && typeof t.description === 'string' && t.inputSchema?.type === 'object'), '')
  step('the bridge adds no tools of its own', names.includes('browser_start') && names.includes('browser_files') && names.includes('browser_workflow') && names.includes('browser_act') && !names.some(n => !n.startsWith('browser_')), names.filter(n => !n.startsWith('browser_')).join(','))

  const status = await rpc('tools/call', { name: 'browser_status', arguments: {} })
  const statusValue = JSON.parse(status.result?.content?.[0]?.text ?? 'null')
  step('tools/call round-trips through the real tool layer', status.result?.isError === false && statusValue?.phase === 'idle' && statusValue?.engine?.configured === 'patchright', JSON.stringify(statusValue).slice(0, 160))

  const unknown = await rpc('tools/call', { name: 'browser_nope', arguments: {} })
  step('an unknown tool is a JSON-RPC error, not a crash', unknown.error?.code === -32602, JSON.stringify(unknown.error))

  const refusal = await rpc('tools/call', { name: 'browser_click', arguments: { ref: 'e1' } })
  const refusalValue = JSON.parse(refusal.result?.content?.[0]?.text ?? 'null')
  step('a refusal is a successful call reporting ok:false (MCP semantics preserved)', refusal.result?.isError === false && refusalValue?.ok === false, JSON.stringify(refusalValue).slice(0, 120))

  const bogus = await rpc('mystery/method')
  step('an unknown method is -32601', bogus.error?.code === -32601, JSON.stringify(bogus.error))

  child.stdin.write('not json at all\n')
  const parseErr = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 3000)
    pending.set(null, message => { clearTimeout(timer); resolve(message) })
  })
  step('garbage input gets a parse error, not a dead bridge', parseErr?.error?.code === -32700, JSON.stringify(parseErr?.error))
  const afterGarbage = await rpc('ping')
  step('the bridge still answers after garbage', afterGarbage.result !== undefined)
} catch (error) {
  step(`bridge conversation failed: ${error.message} ${stderrText.slice(0, 200)}`, false)
}

const exited = await new Promise(resolve => {
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false) }, 8000)
  child.on('exit', code => { clearTimeout(timer); resolve(code === 0) })
  child.stdin.end()
})
step('closing stdin shuts the bridge down with exit 0', exited === true, `stderr: ${stderrText.slice(0, 160)}`)

finish()
