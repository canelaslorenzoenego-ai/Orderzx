#!/usr/bin/env node
// Host-mount smoke: mounts dsh-browser EXACTLY the way the real DeepSeek
// Harness stack does — SystemPrompt + ToolRuntime services, then the official
// @deepseek-ai/cordis-plugin-loader and cordis-plugin-include reading a
// cordis.yml entry list — and asserts the plugin's tools land in the registry.
// This is the path that broke when the module's default export stopped being
// the plugin (the loader unwraps `default` first). Run: node scripts/dev-host-mount-smoke.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

let pass = 0
const failures = []
function ok(cond, label) {
  if (cond) { pass += 1; console.log('  ok ' + label) } else { failures.push(label); console.error('FAIL ' + label) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-mount-'))
const pluginEntry = pathToFileURL(resolve('lib/index.js')).href
writeFileSync(join(dir, 'cordis.yml'), [
  '- id: dsh-browser',
  `  name: ${pluginEntry}`,
  '  config:',
  '    engine:',
  '      provider: playwright-core',
].join('\n'))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(dir + '/').href

let mountError = null
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Loader)
  await ctx.plugin(Include, { path: './cordis.yml' })
  await ctx.loader.await()
} catch (error) {
  mountError = error
}

ok(mountError === null, `harness mount completes without throwing (${mountError ? mountError.message : 'clean'})`)
if (mountError) console.error(mountError.stack?.split('\n').slice(0, 6).join('\n'))

const registered = ['browser_start', 'browser_stop', 'browser_status', 'browser_see', 'browser_click', 'browser_type', 'browser_scroll', 'browser_press']
  .map(name => ({ name, found: Boolean(ctx.tools?.get(name)) }))
ok(registered.every(r => r.found), `core tools registered in the harness ToolRuntime (${registered.filter(r => r.found).length}/${registered.length})`)
for (const r of registered.filter(r => !r.found)) console.error('  missing tool: ' + r.name)

// the include-managed tree must stay settled: a second await() must not flap
await ctx.loader.await()
ok(registered.every(r => Boolean(ctx.tools?.get(r.name))), 'entries stay mounted across a second loader await (no flapping)')

// teardown contract: disposing the plugin fiber unregisters every tool it added
const ctx2 = new Context()
await ctx2.plugin(SystemPrompt)
await ctx2.plugin(ToolRuntime)
const plugin = (await import('../lib/index.js')).default
const fiber = await ctx2.plugin(plugin, { engine: { provider: 'playwright-core' } })
await new Promise(r => setTimeout(r, 150))
const before = registered.filter(r => Boolean(ctx2.tools?.get(r.name))).length
ok(before === registered.length, `direct ctx.plugin mount registers all spot-check tools (${before}/${registered.length})`)
await fiber.dispose()
const left = registered.filter(r => Boolean(ctx2.tools?.get(r.name)))
ok(left.length === 0, `fiber dispose unregisters the tools (${left.length} left)`)

// skill service: the full harness surfaces registered skills as slash candidates.
// The plugin must register BOTH the playbook (/browser-automation) and the
// imperative /start command — and unregister both on dispose.
const ctx3 = new Context()
await ctx3.plugin(SystemPrompt)
await ctx3.plugin(ToolRuntime)
const skillState = new Map()
ctx3.provide('skills', {
  register: skill => {
    skillState.set(skill.name, { skill, live: true })
    return () => { const entry = skillState.get(skill.name); if (entry) entry.live = false }
  },
})
const fiber3 = await ctx3.plugin(plugin, { engine: { provider: 'playwright-core' } })
await new Promise(r => setTimeout(r, 200))
const skillNames = [...skillState.values()].map(e => e.skill.name)
ok(skillNames.includes('browser-automation') && skillNames.includes('start'), `playbook + /start command skills register with the skills service (${skillNames.join(', ') || 'none'})`)
const startEntry = skillState.get('start')
ok(Boolean(startEntry && /COMMAND/.test(startEntry.skill.content) && /browser_start/.test(startEntry.skill.content) && typeof startEntry.skill.description === 'string'), '/start skill content is an imperative browser_start command')
await fiber3.dispose()
await new Promise(r => setTimeout(r, 100))
ok([...skillState.values()].every(e => !e.live), 'fiber dispose unregisters both skills')

rmSync(dir, { recursive: true, force: true })
console.log(`\ndsh-browser host-mount smoke: ${pass} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
console.log('ALL GREEN')
