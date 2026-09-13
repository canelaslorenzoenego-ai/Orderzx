#!/usr/bin/env node
// Dispatch smoke: drives EVERY dsh-browser tool through the REAL ToolRuntime
// dispatch pipeline (ctx.tools.execute) — argument validation, guard chain,
// OUTPUT-SCHEMA ENFORCEMENT and content rendering — instead of calling
// tool.execute() directly like the other suites do.
//
// Why this suite exists: output-schema violations and non-lossless JSON in a
// tool value are invisible to direct execute() calls but make the runtime
// reject the result of a real model call ("returned invalid output"). That is
// a plugin that passes all its own tests and still does not work in the
// harness. Any error matching /invalid output/ is counted as a BUG here.
// Needs: DSH_BROWSER_LIVE=1 and a CDP Chrome (default http://127.0.0.1:9222).
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

if (process.env.DSH_BROWSER_LIVE !== '1') {
  console.log('dispatch smoke skipped: set DSH_BROWSER_LIVE=1')
  process.exit(0)
}
const CDP = process.env.DSH_BROWSER_LIVE_CDP ?? 'http://127.0.0.1:9222'

let pass = 0
const failures = []
function ok(cond, label, extra = '') {
  if (cond) { pass += 1; console.log('  ok ' + label) } else { failures.push(label + (extra ? ' — ' + extra : '')); console.error('FAIL ' + label + (extra ? ' — ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatch-'))
writeFileSync(join(dir, 'cordis.yml'), [
  '- id: dsh-browser',
  `  name: ${pathToFileURL(resolve('lib/index.js')).href}`,
  '  config:',
  '    engine:',
  '      provider: cdp',
  `      cdpEndpoint: ${CDP}`,
  '    policy:',
  '      approvalForSensitiveActions: false',
].join('\n'))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(dir + '/').href
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(Loader)
await ctx.plugin(Include, { path: './cordis.yml' })
await ctx.loader.await()

let callSeq = 0
const results = new Map()
async function dispatch(name, args = {}) {
  callSeq += 1
  const result = await ctx.tools.execute({
    callId: `dispatch-${callSeq}`,
    name,
    arguments: args,
    signal: AbortSignal.timeout(45000),
  }).catch(error => ({ isError: true, error: { kind: 'threw', message: String(error?.message ?? error) }, content: [] }))
  results.set(name, result)
  const err = result.isError ? String(result.error?.message ?? result.error?.kind ?? JSON.stringify(result.error)).slice(0, 300) : ''
  const schemaBug = result.isError && /invalid output|not lossless|not a declared property/i.test(err)
  ok(!schemaBug, `schema-clean: ${name}`, schemaBug ? err : '')
  return result
}
const valueOf = r => (r.isError ? null : r.value)
const errOf = r => (r.isError ? String(r.error?.message ?? r.error?.kind ?? '').slice(0, 200) : null)

// ── lifecycle + navigation ───────────────────────────────────────────────────
const start = await dispatch('browser_start', { label: 'dispatch-probe' })
ok(!start.isError, 'browser_start dispatches clean', errOf(start) ?? '')
const session = valueOf(start)?.session
ok(typeof session === 'string' && session.length > 0, 'browser_start value carries a session id')
const nav = await dispatch('browser_navigate', { session, url: 'https://example.com' })
ok(!nav.isError, 'browser_navigate dispatches clean', errOf(nav) ?? '')

// ── the full 27-tool sweep ───────────────────────────────────────────────────
await dispatch('browser_status', { session })
await dispatch('browser_observe', { session })
await dispatch('browser_see', { session })
await dispatch('browser_click', { session, x: 0.5, y: 0.5 })
await dispatch('browser_type', { session, text: 'probe' })
await dispatch('browser_press', { session, key: 'Tab' })
await dispatch('browser_scroll', { session, direction: 'down', amount: 1 })
await dispatch('browser_tabs', { session, action: 'list' })
await dispatch('browser_fill_form', { session, fields: [{ ref: 'noop-ref', value: 'x' }] })
await dispatch('browser_extract', { session, instruction: 'the page title' })
await dispatch('browser_act', { session, instruction: 'scroll down a little' })
await dispatch('browser_wait', { session, ms: 200 })
await dispatch('browser_evaluate', { session, expression: '1+1' })
await dispatch('browser_challenge', { session })
await dispatch('browser_cookies', { session, action: 'list' })
await dispatch('browser_files', { session, action: 'list' })
await dispatch('browser_workflow', { session, action: 'list' })
await dispatch('browser_task', { session, action: 'list' })
await dispatch('browser_desktop_view', { session })
await dispatch('browser_transcript', { session })
const clip = await dispatch('browser_clip', { session, seconds: 1 })
const reel = await dispatch('browser_reel', { session, seconds: 2 })
// ownership round-trip: hand the pointer to the human, take it back
await dispatch('browser_handoff', { session, note: 'dispatch probe handoff' })
await dispatch('browser_takeover', { session, reason: 'resume dispatch probe' })
await dispatch('browser_stop', { session })
await dispatch('browser_status', {})

// ── behavioural contracts on top of schema-cleanliness ──────────────────────
ok(!results.get('browser_status').isError && valueOf(results.get('browser_status'))?.phase, 'browser_status value carries a phase', errOf(results.get('browser_status')) ?? '')
ok(!results.get('browser_observe').isError, 'browser_observe succeeds on a live page', errOf(results.get('browser_observe')) ?? '')
ok(!results.get('browser_see').isError, 'browser_see succeeds on a live page', errOf(results.get('browser_see')) ?? '')
ok(!results.get('browser_click').isError, 'browser_click succeeds on a live page', errOf(results.get('browser_click')) ?? '')
ok(!results.get('browser_scroll').isError, 'browser_scroll succeeds on a live page', errOf(results.get('browser_scroll')) ?? '')
ok(!results.get('browser_type').isError, 'browser_type returns success (focused-element path)', errOf(results.get('browser_type')) ?? '')
ok(!clip.isError && typeof valueOf(clip)?.chatLine === 'string' && valueOf(clip).chatLine.length > 0, 'browser_clip value carries the verbatim chatLine (C9)', errOf(clip) ?? '')
ok(!reel.isError, 'browser_reel succeeds', errOf(reel) ?? '')
const ev = results.get('browser_evaluate')
ok(ev.isError || valueOf(ev)?.refused, 'browser_evaluate is policy-fenced by default (structured refusal)', errOf(ev) ?? JSON.stringify(valueOf(ev))?.slice(0, 100))
const noArgs = results.get('browser_click') // already dispatched with args; do a bare one
const bare = await dispatch('browser_click', {})
ok(!bare.isError && valueOf(bare)?.ok === false && typeof valueOf(bare)?.refused === 'string', 'no-session click → structured refusal VALUE (ok:false + refused), schema-clean', errOf(bare) ?? JSON.stringify(valueOf(bare))?.slice(0, 120))
const badArgs = await dispatch('browser_press', {})
ok(badArgs.isError && /argument/i.test(String(errOf(badArgs))), 'missing required key on press → clean args-validation failure', errOf(badArgs) ?? '')

// content-block contract for the vision path
for (const label of ['browser_see', 'browser_clip', 'browser_reel']) {
  const r = results.get(label)
  if (r.isError) continue
  ok(Array.isArray(r.content) && r.content.length > 0 && r.content.every(b => b && (b.type === 'text' || b.type === 'image')), `content blocks well-formed for ${label}`)
}

rmSync(dir, { recursive: true, force: true })
const schemaBugs = failures.filter(f => f.startsWith('schema-clean:'))
console.log(`\ndsh-browser dispatch smoke: ${pass} passed, ${failures.length} failed (${schemaBugs.length} output-schema bugs)`)
// ── teardown contract: unload must release every session resource ──────────
// Regression guard for the silent-teardown bug: cordis detects "class
// plugins" via `func.prototype`, so a `function apply` is constructed with
// `new` and its returned teardown is DROPPED — tools unregister (effect
// scope) while CDP sockets, frame timers and sessions leak. apply must stay
// an arrow function. Here we dispose the plugin fiber the way the harness
// does on unload/reload and assert the process is left clean.
{
  const plugin = (await import('../lib/index.js')).default
  const runtime = ctx.registry?.delete?.(plugin)
  ok(!!runtime, 'teardown: plugin runtime found in registry')
  // Give the async teardown (frames.stop, browser.close, prune) time to land.
  const leftover = () => process.getActiveResourcesInfo().filter(r => r !== 'PipeWrap' && r !== 'TTYWrap')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && leftover().some(r => r === 'TCPSocketWrap' || r === 'Timeout')) {
    await new Promise(r => setTimeout(r, 250))
  }
  const remaining = leftover()
  ok(!remaining.includes('TCPSocketWrap'), `teardown: no CDP socket left after unload (${remaining.join(',') || 'clean'})`)
  ok(!remaining.includes('Timeout'), `teardown: no live timers left after unload (${remaining.join(',') || 'clean'})`)
}

if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('ALL GREEN')
