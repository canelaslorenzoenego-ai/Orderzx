#!/usr/bin/env node
/**
 * MCP stdio bridge — the same tool layer the DSH plugin exposes, spoken over
 * newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 * This is a THIN bridge on purpose: it adds no tools, no policies and no
 * state of its own. `createBrowserTools` is the single source of truth, so
 * an MCP client sees exactly what the plugin's agent sees — including the
 * approval gate, the origin fence and the "detect and report, never solve
 * silently" challenge posture. Zero cloud, zero accounts: the bridge talks
 * to a local browser only.
 *
 * Run: `node lib/mcp.js` (or `dsh-browser-mcp` once linked) and speak MCP.
 *
 * @module @dsh-community/dsh-browser/mcp
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BrowserHostController } from './host.js'
import { resolveConfig } from './config.js'
import { AccessController } from './access.js'
import { createBrowserTools } from './tools.js'
import { ChallengePipeline } from './challenge/pipeline.js'
import './engine/index.js' // registers the builtin providers

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const SERVER_INFO = { name: 'dsh-browser', version: '0.0.0' }
try {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { name?: string; version?: string }
  SERVER_INFO.name = pkg.name ?? SERVER_INFO.name
  SERVER_INFO.version = pkg.version ?? SERVER_INFO.version
} catch {
  // A missing package.json must not brick the bridge; the defaults stand.
}

/** Lazily built so `tools/list` never pays for engine config it may not use. */
let toolsSingleton: ReturnType<typeof createBrowserTools> | undefined
let hostSingleton: BrowserHostController | undefined

function tools(): ReturnType<typeof createBrowserTools> {
  if (!toolsSingleton) {
    const config = resolveConfig(undefined)
    const host = new BrowserHostController({ config, access: new AccessController() })
    hostSingleton = host
    // No vision services in the bridge: `vision: {}` degrades see/act to
    // snapshot-only. The challenge pipeline keeps its config (so detection +
    // reporting behave exactly like the plugin) but with zero solver adapters
    // and a fail-closed domain approval — on stdio there is no panel to hand
    // off to, so a blocking challenge is REPORTED, never silently solved.
    const pipeline = new ChallengePipeline({
      config: {
        autoSolver: config.challenge.autoSolver,
        adapter: config.challenge.adapter,
        allowedDomains: config.challenge.allowedDomains as string[],
        handoffByDefault: config.challenge.handoffByDefault,
        handoffTimeoutMs: config.challenge.handoffTimeoutMs,
      },
      adapters: new Map(),
      handoff: async () => 'abandoned',
      approveDomain: async () => false,
      audit: () => undefined,
    })
    // Approvals have no UI to prompt on stdio, so the tool layer's
    // fail-closed guard stands in (sensitive verbs refuse without one).
    toolsSingleton = createBrowserTools(host, { vision: {}, challenge: pipeline })
  }
  return toolsSingleton
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id: number | string | null | undefined, result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result })
}

function replyError(id: number | string | null | undefined, code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize': {
      const protocolVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05'
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Local-first browser automation. Start with browser_start, then browser_observe to see the page as an aria snapshot with clickable refs. Zero cloud, zero accounts.',
      })
      return
    }
    case 'ping': {
      reply(id, {})
      return
    }
    case 'tools/list': {
      const list = Object.values(tools()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as Record<string, unknown>,
      }))
      reply(id, { tools: list })
      return
    }
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : ''
      const tool = tools()[name]
      if (!tool) {
        replyError(id, -32602, `unknown tool: ${name || '(none)'}`)
        return
      }
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      try {
        const value = await tool.execute(args, {
          callId: `mcp-${String(id ?? 'notify')}`,
          rootCallId: `mcp-${String(id ?? 'notify')}`,
          name,
          arguments: args,
          signal: new AbortController().signal,
          deferContext: () => undefined,
        } as never)
        // The canonical value IS the contract — { ok: false, ... } results are
        // successful tool calls that report a refusal, not protocol errors.
        reply(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })
      } catch (error) {
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }) }],
          isError: true,
        })
      }
      return
    }
    default: {
      if (method.startsWith('notifications/')) return // never answered
      if (!isNotification) replyError(id, -32601, `method not found: ${method}`)
    }
  }
}

async function shutdown(): Promise<void> {
  if (hostSingleton) {
    for (const session of hostSingleton.listSessions()) {
      await hostSingleton.stop(session.id, 'mcp bridge stdin closed').catch(() => undefined)
    }
  }
  process.exit(0)
}

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', line => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      replyError(null, -32700, 'parse error')
      return
    }
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      replyError(request.id, -32600, 'invalid request')
      return
    }
    handle(request).catch(error => {
      replyError(request.id, -32603, error instanceof Error ? error.message : 'internal error')
    })
  })
  rl.on('close', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main()
