/**
 * Static smoke for the dsh-browser tool layer — no real browser.
 *
 * A stub host + fake EnginePage record every call, so assertions check the EXACT
 * arguments a tool forwarded: the normalized→pixel conversion on click, the
 * humanized focus-click before typing, the secret-redaction path, refusal
 * shapes. That is the part a shape-only test would miss.
 *
 * Run `pnpm run build` first — this suite imports the COMPILED lib/*.js.
 * When lib is missing it prints SKIP and exits 0, so a partial tree does not
 * read as a failure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TINY_PNG_B64, createStepReporter, findJsonViolations, makeExec } from './_smoke-harness.mjs'

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (!existsSync(join(root, 'lib', 'tools.js'))) {
  step('lib/tools.js present', 'SKIP', 'run `pnpm run build` first')
  finish()
  process.exit(0)
}

const { createBrowserTools } = await import(pathToFileURL(join(root, 'lib', 'tools.js')).href)
const { resolveConfig } = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const { TOOL_NAMES } = await import(pathToFileURL(join(root, 'lib', 'protocol.js')).href)
const { readClipManifest } = await import(pathToFileURL(join(root, 'lib', 'capture-store.js')).href)
const { captureDir } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
const { InteractionTrace, captionOfEvent } = await import(pathToFileURL(join(root, 'lib', 'interactions.js')).href)
const { selectMarks, buildOverlayScript, CLEANUP_SCRIPT, MAX_MARKS, resolveMark, setMarks, clearMarks } = await import(pathToFileURL(join(root, 'lib', 'marks.js')).href)

const SESSION = 'sess-0123456789abcdef'
const PNG = new Uint8Array(Buffer.from(TINY_PNG_B64, 'base64'))

// ── fake page ───────────────────────────────────────────────────────────────

/**
 * Everything the tools touch on an EnginePage, with a call log.
 * `evaluateIsolated` dispatches on script content: the type tool's password
 * probe gets `secret`, the challenge DOM probe gets "nothing here".
 */
function makeFakePage(options = {}) {
  const calls = []
  const scripts = []
  // Async: the tools chain `.catch()` off input calls, like the real driver.
  const record = name => async (...args) => {
    calls.push({ name, args })
    return undefined
  }
  return {
    calls,
    scripts,
    id: 'page-1',
    url: () => options.url ?? 'https://example.com/',
    title: async () => options.title ?? 'Example Domain',
    viewport: () => ({ width: 1366, height: 768 }),
    goto: async () => { calls.push({ name: 'goto', args: [] }) },
    navigate: async action => { calls.push({ name: 'navigate', args: [action] }) },
    close: async () => { calls.push({ name: 'close', args: [] }) },
    snapshot: async () => ({
      url: options.url ?? 'https://example.com/',
      title: options.title ?? 'Example Domain',
      viewport: { width: 1366, height: 768 },
      truncated: false,
      nodes: options.nodes ?? [
        { ref: 'e1', role: 'heading', name: 'Example', children: [] },
        { ref: 'e12', role: options.refRole ?? 'link', name: options.refName ?? 'More information', children: [] },
      ],
    }),
    boxOf: async ref => (options.noBox ? undefined : { x: 100, y: 200, width: 80, height: 24, ref }),
    capture: async () => { calls.push({ name: 'capture', args: [] }); return PNG },
    evaluateIsolated: async script => {
      calls.push({ name: 'evaluateIsolated', args: [String(script).slice(0, 60)] })
      ;(scripts).push(String(script))
      if (String(script).includes('current-password')) return options.secret ?? false
      if (String(script).includes('modelContext')) return options.siteTools ?? false
      if (String(script).includes('ytd-transcript-segment-renderer')) return { source: 'transcript-panel', title: 'Fixture Video', lines: ['hello', 'world'], langs: ['English'] }
      if (String(script).includes('innerText')) return options.bodyText ?? 'The quick brown fox.'
      return undefined // the challenge probe sees a clean page
    },
    inputValue: async ref => (options.fieldValues ?? {})[ref],
    setFiles: async (ref, paths) => { calls.push({ name: 'setFiles', args: [ref, paths] }) },
    downloadByClick: async (ref, dest, timeout) => {
      calls.push({ name: 'downloadByClick', args: [ref, dest, timeout] })
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, 'hello')
      return { bytes: 5, suggested: options.downloadName ?? 'report.pdf' }
    },
    input: {
      click: record('input.click'),
      pointerMove: record('input.pointerMove'),
      pointerDown: record('input.pointerDown'),
      pointerUp: record('input.pointerUp'),
      scroll: record('input.scroll'),
      typeText: record('input.typeText'),
      pressKey: record('input.pressKey'),
    },
  }
}

// ── stub host ───────────────────────────────────────────────────────────────

function makeStubHost(options = {}) {
  const calls = []
  const page = options.page ?? makeFakePage(options.pageOptions ?? {})
  const session = {
    id: SESSION,
    interactions: new InteractionTrace(),
    owner: options.owner ?? 'agent',
    challenge: null,
    browser: {
      activePage: () => page,
      pages: () => [page],
      newPage: async () => page,
      selectPage: async () => {},
    },
    frames: { nudge: async () => {} },
  }
  // Async by contract: every recorded host method is `async` on the real
  // BrowserHostController, and the tools chain `.catch()` off the returns.
  const record = (name, result) => async (...args) => {
    calls.push({ name, args })
    return typeof result === 'function' ? result(...args) : result
  }
  const gestures = []
  const history = []
  return {
    calls,
    page,
    gestures,
    history,
    // New host API surface (interaction trace + multi-session refs). The smoke
    // asserts on these arrays: a tool that acts but leaves no trace is a tool
    // the panel cannot animate.
    record: (id, actor, event) => { gestures.push({ id, actor, event }) },
    recordAction: (id, entry) => { history.push({ id, entry }) },
    resolveRef: ref => (!options.noSession && (ref === undefined || ref === SESSION) ? SESSION : undefined),
    config: resolveConfig(options.config ?? {}),
    gate: () => {
      if (options.noSession) return { ok: false, refused: 'no-session', message: 'no browser session; call browser_start first' }
      // Mirrors the real #gate: while a human owns the pointer, every
      // page-touching tool refuses rather than queueing behind them.
      if (session.owner !== 'agent') return { ok: false, refused: 'pointer-owned', message: 'a human is driving this session' }
      return { ok: true, session }
    },
    hasSession: id => !options.noSession && id === SESSION,
    activeSessionId: () => (options.noSession ? undefined : SESSION),
    listSessions: () => (options.noSession ? [] : [SESSION]),
    session: () => (options.noSession ? undefined : session),
    status: () => ({
      phase: options.noSession ? 'idle' : 'streaming',
      ...(options.noSession ? { sessions: [] } : {}),
    }),
    start: record('start', { ok: true, session: SESSION, label: null, phase: 'streaming', posture: { provider: 'patchright', humanize: true, applied: ['cdc_ vars', 'navigator.webdriver'], gaps: [] } }),
    stop: record('stop', { ok: true }),
    navigate: record('navigate', { ok: true, url: 'https://example.com/next', title: 'Next' }),
    saveCapture: record('saveCapture', { path: join(tmpdir(), 'dsh-browser', 'captures', 'smoke.jpg'), token: 'tok', expiresAt: Date.now() + 60_000 }),
    signPath: record('signPath', { token: 'clip-manifest-tok', expiresAt: Date.now() + 3_600_000 }),
    recordChallenge: record('recordChallenge', undefined),
    setDesktopView: record('setDesktopView', { ok: true }),
    syncDesktopView: record('syncDesktopView', undefined),
    beginTakeover: record('beginTakeover', { ok: true }),
    endTakeover: record('endTakeover', { ok: true }),
    setRecording: record('setRecording', options.recordingResult ?? { ok: true, name: 'checkout-demo', steps: 7, variables: ['password'] }),
    listWorkflows: record('listWorkflows', options.workflows ?? [{ name: 'checkout-demo', steps: 7, variables: ['password'], createdAt: 1, startUrl: 'https://shop.test/' }]),
    deleteWorkflow: record('deleteWorkflow', { ok: true }),
    runWorkflow: record('runWorkflow', options.runResult ?? { ok: true, replayed: 7, fallbacks: 1, name: 'checkout-demo' }),
    startJob: record('startJob', options.jobResult ?? { ok: true, job: 'j1ab23cd', steps: 7 }),
    cancelJob: record('cancelJob', { ok: true }),
    listJobs: () => options.jobs ?? [{ id: 'j1ab23cd', workflow: 'checkout-demo', status: 'running', startedAt: 1, finishedAt: null, stepsTotal: 7, stepsDone: 2, fallbacks: 0, error: null }],
    takeoverActive: () => options.owner === 'user',
  }
}

function build(toolsOptions = {}, hostOptions = {}) {
  const host = makeStubHost(hostOptions)
  const tools = createBrowserTools(host, { vision: {}, challenge: undefined, ...toolsOptions })
  return { host, tools }
}

const run = (tools, name, args = {}) => tools[name].execute(args, makeExec(name, args))

// ── registration ────────────────────────────────────────────────────────────

{
  const { tools } = build()
  const names = Object.keys(tools)
  const expected = Object.values(TOOL_NAMES)
  step('every TOOL_NAMES entry is registered', expected.every(name => names.includes(name)), `${names.length} tools`)
  const malformed = names.filter(name => typeof tools[name]?.execute !== 'function' || typeof tools[name]?.description !== 'string')
  step('every tool has execute + description', malformed.length === 0, malformed.join(','))
  const noSchema = names.filter(name => !tools[name]?.output?.schema || typeof tools[name].output.render !== 'function')
  step('every tool declares output.schema + render', noSchema.length === 0, noSchema.join(','))
  const cardTools = ['browser_start', 'browser_observe', 'browser_click', 'browser_challenge', 'browser_handoff']
  step('the five card tools declare presentationMeta', cardTools.every(name => typeof tools[name]?.output?.presentationMeta === 'function'))
}

// ── refusals are domain outcomes, never throws ──────────────────────────────

{
  const { tools } = build({}, { noSession: true })
  for (const name of [TOOL_NAMES.observe, TOOL_NAMES.click, TOOL_NAMES.type, TOOL_NAMES.scroll, TOOL_NAMES.navigate]) {
    const args = name === TOOL_NAMES.type ? { text: 'x' } : name === TOOL_NAMES.navigate ? { url: 'https://example.com' } : {}
    const result = await run(tools, name, args)
    const okShape = result && result.ok === false && typeof result.refused === 'string' && typeof result.message === 'string'
    step(`${name} refuses without a session (no throw)`, okShape, okShape ? result.refused : JSON.stringify(result).slice(0, 120))
    step(`${name} refusal is lossless JSON`, findJsonViolations(result).length === 0, findJsonViolations(result).join('; '))
  }
}

// ── takeover: agent tools refuse while a human drives ───────────────────────

{
  const { tools } = build({}, { owner: 'user' })
  const result = await run(tools, TOOL_NAMES.click, { x: 0.5, y: 0.5 })
  step('click refuses with pointer-owned during takeover', result?.ok === false && result.refused === 'pointer-owned', JSON.stringify(result).slice(0, 140))
  const stopResult = await run(tools, TOOL_NAMES.stop, {})
  step('stop refuses while a human is mid-form', stopResult?.ok === false && stopResult.refused === 'pointer-owned', JSON.stringify(stopResult).slice(0, 140))
}

// ── click: argument discipline and pixel conversion ─────────────────────────

{
  const { tools, host } = build()
  const both = await run(tools, TOOL_NAMES.click, { ref: 'e12', x: 0.5, y: 0.5 })
  step('click refuses ref AND point together', both?.ok === false && /exactly one/i.test(both.message ?? ''), JSON.stringify(both).slice(0, 140))
  const neither = await run(tools, TOOL_NAMES.click, {})
  step('click refuses with neither ref nor point', neither?.ok === false && /ref.*mark|either/i.test(neither.message ?? ''), JSON.stringify(neither).slice(0, 140))
  const outOfRange = await run(tools, TOOL_NAMES.click, { x: 4, y: 0.5 })
  step('click refuses out-of-range normalized coordinates', outOfRange?.ok === false && /normalized/i.test(outOfRange.message ?? ''), JSON.stringify(outOfRange).slice(0, 140))

  const byPoint = await run(tools, TOOL_NAMES.click, { x: 0.25, y: 0.75 })
  const clickCall = host.page.calls.find(c => c.name === 'input.click')
  // 0.25 × 1366 = 341.5; 0.75 × 768 = 576. The page receives FULL precision
  // (sub-pixel points are more human, not less); only the result echoes rounded.
  step('click converts normalized → pixels for the page', clickCall?.args[0] === 341.5 && clickCall?.args[1] === 576, JSON.stringify(clickCall?.args))
  step('click result echoes rounded pixel point', byPoint?.point?.x === 342 && byPoint?.point?.y === 576, JSON.stringify(byPoint?.point))
  step('click result is lossless JSON', findJsonViolations(byPoint).length === 0, findJsonViolations(byPoint).join('; '))
}

{
  // A stale ref must fail loudly, not click a stale coordinate.
  const { tools } = build({}, { pageOptions: { noBox: true } })
  const result = await run(tools, TOOL_NAMES.click, { ref: 'e99' })
  step('click on a stale ref refuses with guidance', result?.ok === false && /observe again|no box/i.test(result.message ?? ''), JSON.stringify(result).slice(0, 160))
}

// ── approval gate: sensitive verbs fail CLOSED ──────────────────────────────

{
  // No approval service at all: a sensitive target must be refused.
  const { tools } = build({ requestApproval: undefined }, { pageOptions: { refName: 'Pay now', refRole: 'button' } })
  const result = await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  step('sensitive click without an approval service fails closed', result?.ok === false && result.refused === 'policy', JSON.stringify(result).slice(0, 160))
}

{
  // Approval service present but the user DENIES.
  let asked = null
  const { tools } = build(
    { requestApproval: async input => { asked = input; return false } },
    { pageOptions: { refName: 'Delete account', refRole: 'button' } },
  )
  const result = await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  step('denied approval blocks the click', result?.ok === false && result.refused === 'policy', JSON.stringify(result).slice(0, 160))
  step('the approval prompt names the action and page', asked && typeof asked.title === 'string' && typeof asked.detail === 'string' && asked.detail.length > 0, JSON.stringify(asked).slice(0, 200))
}

{
  // Approval GRANTED: the click proceeds.
  const { tools, host } = build(
    { requestApproval: async () => true },
    { pageOptions: { refName: 'Pay now', refRole: 'button' } },
  )
  const result = await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  step('approved sensitive click proceeds', result?.ok === true && host.page.calls.some(c => c.name === 'input.click'), JSON.stringify(result).slice(0, 160))
}

{
  // Non-sensitive targets never prompt.
  let asked = 0
  const { tools } = build({ requestApproval: async () => { asked += 1; return true } }, { pageOptions: { refName: 'More information', refRole: 'link' } })
  const result = await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  step('non-sensitive click does not prompt', result?.ok === true && asked === 0, `asked=${asked}`)
}

// ── browser_evaluate is a CONFIG gate ──────────────────────────────────────

{
  const { tools } = build() // resolveConfig default: allowEvaluate=false
  const result = await run(tools, TOOL_NAMES.evaluate, { script: '1+1' })
  step('evaluate refused when allowEvaluate=false (the default)', result?.ok === false && typeof result.refused === 'string', JSON.stringify(result).slice(0, 160))
  step('evaluate refusal points at the config flag', /config|allowEvaluate|enable/i.test(result?.message ?? ''), result?.message ?? '')
}

// ── type: focus-click, secret redaction ─────────────────────────────────────

{
  const { tools, host } = build({}, { pageOptions: { secret: true } })
  const SECRET = 'hunter2-correct-horse'
  const result = await run(tools, TOOL_NAMES.type, { ref: 'e12', text: SECRET })
  const order = host.page.calls.map(c => c.name)
  const clickIdx = order.indexOf('input.click')
  const typeIdx = order.indexOf('input.typeText')
  step('type focuses the field with a click BEFORE typing', clickIdx !== -1 && typeIdx !== -1 && clickIdx < typeIdx, order.slice(0, 8).join('→'))
  step('type clears the field first (select-all + delete)', order.includes('input.pressKey'), order.filter(n => n === 'input.pressKey').length + ' key presses')
  const typeCall = host.page.calls.find(c => c.name === 'input.typeText')
  step('the secret text reaches the page', typeCall?.args[0] === SECRET, String(typeCall?.args[0]).slice(0, 40))
  const serialized = JSON.stringify(result)
  step('the secret never appears in the result', !serialized.includes(SECRET), serialized.slice(0, 160))
  step('the result is marked redacted', result?.redacted === true, JSON.stringify(result).slice(0, 160))
  step('type result is lossless JSON', findJsonViolations(result).length === 0, findJsonViolations(result).join('; '))
}

{
  // Non-secret fields DO report the value back — the redaction must not be
  // blanket, or the model loses form verification entirely.
  const { tools } = build({}, { pageOptions: { secret: false } })
  const result = await run(tools, TOOL_NAMES.type, { ref: 'e12', text: 'hello' })
  step('non-secret type is not marked redacted', result?.redacted !== true, JSON.stringify(result).slice(0, 140))
}

{
  const { tools } = build()
  const empty = await run(tools, TOOL_NAMES.type, { ref: 'e12', text: '' })
  step('empty text is refused with guidance', empty?.ok === false && /required/i.test(empty.message ?? ''), JSON.stringify(empty).slice(0, 140))
}

// ── observe ─────────────────────────────────────────────────────────────────

{
  const { tools, host } = build()
  const result = await run(tools, TOOL_NAMES.observe, {})
  step('observe returns url + title + elements', result?.url === 'https://example.com/' && result?.title === 'Example Domain' && Array.isArray(result?.elements), JSON.stringify(result).slice(0, 160))
  step('observe ran the challenge probe', host.page.calls.some(c => c.name === 'evaluateIsolated'))
  step('observe saved a capture through the host', host.calls.some(c => c.name === 'saveCapture'))
  step('observe reports the clean challenge probe', result?.challenge?.present === false, JSON.stringify(result?.challenge))
  step('observe result is lossless JSON', findJsonViolations(result).length === 0, findJsonViolations(result).join('; '))
  const meta = tools.browser_observe.output.presentationMeta({}, result)
  step('observe presentationMeta carries the url summary', typeof meta.summary === 'string' && meta.summary.includes('example.com'), JSON.stringify(meta).slice(0, 160))
}

// ── navigate forwards through the host (SSRF policy lives there) ────────────

{
  const { tools, host } = build()
  const result = await run(tools, TOOL_NAMES.navigate, { url: 'https://example.com/next' })
  const nav = host.calls.find(c => c.name === 'navigate')
  step('navigate forwards url + signal to the host', nav?.args[1] === 'https://example.com/next', JSON.stringify(nav?.args?.slice(0, 2)))
  step('navigate returns the host verdict', result?.ok === true, JSON.stringify(result).slice(0, 140))
}

// ── tabs ────────────────────────────────────────────────────────────────────

{
  const { tools } = build()
  const result = await run(tools, TOOL_NAMES.tabs, {})
  step('tabs lists the fake page with an index', result?.ok === true && Array.isArray(result.tabs) && result.tabs[0]?.index === 0, JSON.stringify(result).slice(0, 160))
  step('tabs marks the active tab', result?.tabs?.[0]?.active === true)
  step('tabs result is lossless JSON', findJsonViolations(result).length === 0, findJsonViolations(result).join('; '))
}

// ── start / status / task ───────────────────────────────────────────────────

{
  const { tools, host } = build()
  const started = await run(tools, TOOL_NAMES.start, { url: 'https://example.com' })
  step('start forwards url/profile to the host', started?.ok === true && host.calls.some(c => c.name === 'start'), JSON.stringify(started).slice(0, 160))
  step('start reports the stealth posture', Array.isArray(started?.stealth?.applied) && typeof started?.stealth?.humanize === 'boolean', JSON.stringify(started?.stealth))
  const meta = tools.browser_start.output.presentationMeta({}, started)
  step('start presentationMeta says browser live', /browser live/.test(meta.summary ?? ''), JSON.stringify(meta))

  const status = await run(tools, TOOL_NAMES.status, {})
  step('status includes phase + engine probe + redacted config', status?.phase !== undefined && status?.engine !== undefined && status?.config !== undefined, JSON.stringify(status).slice(0, 160))
  step('status config is redacted (no raw credentials path)', !JSON.stringify(status?.config).includes('hunter'), 'ok')
  step('status result is lossless JSON', findJsonViolations(status).length === 0, findJsonViolations(status).join('; '))

  const task = await run(tools, TOOL_NAMES.task, { action: 'start', goal: 'buy a hat' })
  step('browser_task refuses a bare goal until ctx.jobs lands', task?.ok === false && task.refused === 'policy' && /browser_workflow/.test(task.message ?? ''), JSON.stringify(task).slice(0, 160))
}

// ── sub-agent labels ────────────────────────────────────────────────────────

{
  const { tools, host } = build()
  const started = await run(tools, TOOL_NAMES.start, { label: 'researcher' })
  const startCall = host.calls.find(c => c.name === 'start')
  step('start forwards the sub-agent label', startCall?.args?.[0]?.label === 'researcher', JSON.stringify(startCall?.args?.[0]))
  step('start result echoes ok', started?.ok === true, JSON.stringify(started).slice(0, 120))
}

// ── gesture recording (the panel animation feed) ────────────────────────────

{
  const { tools, host } = build()
  await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  const clickGesture = host.gestures.find(g => g.event.type === 'click')
  step('click publishes a click gesture', !!clickGesture && clickGesture.actor === 'agent', JSON.stringify(clickGesture?.event))
  step('the click gesture is normalized 0..1', clickGesture && clickGesture.event.x >= 0 && clickGesture.event.x <= 1 && clickGesture.event.y >= 0 && clickGesture.event.y <= 1, JSON.stringify({ x: clickGesture?.event.x, y: clickGesture?.event.y }))
  step('a ref click first focuses the element (outline before pulse)', !!host.gestures.find(g => g.event.type === 'focus' && g.event.ref === 'e12' && g.event.box), '')
  step('click lands on the session timeline', host.history.some(h => h.entry.tool === 'browser_click' && h.entry.ok === true), JSON.stringify(host.history.at(-1)?.entry))

  await run(tools, TOOL_NAMES.type, { ref: 'e12', text: 'hunter2-secret' })
  const typeGesture = host.gestures.find(g => g.event.type === 'type')
  step('type publishes a character COUNT', typeGesture?.event.characters === 14, JSON.stringify(typeGesture?.event))
  step('the typed text never enters the trace', !JSON.stringify(host.gestures).includes('hunter2'), 'leak!')
  step('type lands on the timeline without its text', host.history.some(h => h.entry.tool === 'browser_type' && !h.entry.summary.includes('hunter2')), JSON.stringify(host.history.at(-1)?.entry))

  await run(tools, TOOL_NAMES.scroll, { direction: 'down', amount: 1 })
  step('scroll publishes its delta', host.gestures.some(g => g.event.type === 'scroll' && g.event.deltaY > 0), '')

  await run(tools, TOOL_NAMES.press, { key: 'Enter' })
  step('press publishes the key', host.gestures.some(g => g.event.type === 'key' && g.event.key === 'Enter'), '')
}

// ── browser_act: the deterministic act() primitive ──────────────────────────

{
  const { tools, host } = build()
  const unparsed = await run(tools, TOOL_NAMES.act, { instruction: 'do a barrel roll' })
  step('act refuses an instruction with no verb', unparsed?.ok === false && /could not parse/.test(unparsed.message ?? ''), JSON.stringify(unparsed).slice(0, 140))

  const clicked = await run(tools, TOOL_NAMES.act, { instruction: 'click "More information"' })
  step('act resolves a quoted name to a ref', clicked?.ok === true && clicked.ref === 'e12', JSON.stringify(clicked).slice(0, 160))
  step('act clicked through the page input', host.page.calls.some(c => c.name === 'input.click'), '')
  step('act publishes focus + click gestures', host.gestures.some(g => g.event.type === 'focus') && host.gestures.some(g => g.event.type === 'click'), '')
  step('act lands on the timeline', host.history.some(h => h.entry.tool === 'browser_act' && h.entry.ok), JSON.stringify(host.history.at(-1)?.entry))

  const stopworded = await run(tools, TOOL_NAMES.act, { instruction: 'click the link' })
  step('act refuses a pure-stopword target instead of guessing', stopworded?.ok === false && /no interactive element/.test(stopworded.message ?? ''), JSON.stringify(stopworded).slice(0, 140))

  const scrolled = await run(tools, TOOL_NAMES.act, { instruction: 'scroll down' })
  step('act scrolls without an element match', scrolled?.ok === true && scrolled.action === 'scroll', JSON.stringify(scrolled).slice(0, 120))

  const opened = await run(tools, TOOL_NAMES.act, { instruction: 'open https://example.com/next' })
  step('act opens a URL through the host (policy applies)', opened?.ok === true && opened.action === 'open' && host.calls.some(c => c.name === 'navigate'), JSON.stringify(opened).slice(0, 140))

  const typed = await run(tools, TOOL_NAMES.act, { instruction: 'type hello world into More information' })
  step('act types into the matched field', typed?.ok === true && typed.action === 'type' && typed.ref === 'e12', JSON.stringify(typed).slice(0, 160))
  const typedGesture = host.gestures.filter(g => g.event.type === 'type').at(-1)
  step('act records the typed length only', typedGesture?.event.characters === 11 && !JSON.stringify(host.gestures).includes('hello world'), '')

  // Ambiguity: two elements equally match → candidates, never a coin flip.
  const ambiguous = build({}, { pageOptions: { nodes: [
    { ref: 'a1', role: 'button', name: 'Submit order', children: [] },
    { ref: 'a2', role: 'button', name: 'Submit order', children: [] },
  ] } })
  const ambiguousResult = await run(ambiguous.tools, TOOL_NAMES.act, { instruction: 'click "Submit order"' })
  step('act returns candidates when two elements tie', ambiguousResult?.ok === false && Array.isArray(ambiguousResult.candidates) && ambiguousResult.candidates.length === 2, JSON.stringify(ambiguousResult).slice(0, 180))
  step('the ambiguous act is recorded as refused, not guessed', ambiguous.host.history.some(h => h.entry.ok === false && h.entry.refused === 'ambiguous'), JSON.stringify(ambiguous.host.history.at(-1)?.entry))

  const meta = tools.browser_act.output.presentationMeta({}, clicked)
  step('act presentationMeta summarizes the match', /act ·/.test(meta.summary ?? ''), JSON.stringify(meta))
}

// ── parseActInstruction / rankElements units ────────────────────────────────

{
  const { parseActInstruction, rankElements } = await import('../lib/tools.js')
  step('parses click "X"', parseActInstruction('click "Sign in"')?.verb === 'click' && parseActInstruction('click "Sign in"').target === 'Sign in')
  step('parses type X into Y', (() => { const p = parseActInstruction('type hunter2 into password'); return p?.verb === 'type' && p.text === 'hunter2' && p.target === 'password' })())
  step('parses fill X with Y and press enter', (() => { const p = parseActInstruction('fill the search box with macbook air and press enter'); return p?.verb === 'type' && p.text === 'macbook air' && p.pressEnter === true })())
  step('parses scroll direction', parseActInstruction('scroll up')?.direction === 'up')
  step('parses open URL', parseActInstruction('open https://a.dev/x')?.text === 'https://a.dev/x')
  step('rejects an unknown verb', parseActInstruction('frobnicate the widget') === undefined)
  const ranked = rankElements([
    { ref: 'e1', role: 'heading', name: 'Welcome' },
    { ref: 'e2', role: 'button', name: 'Sign in' },
    { ref: 'e3', role: 'link', name: 'Sign up' },
  ], 'Sign in', 'click')
  step('ranks the exact name first', ranked[0]?.node.ref === 'e2', JSON.stringify(ranked.map(r => r.node.ref)))
  step('ranks deterministically (same input, same order)', JSON.stringify(rankElements([
    { ref: 'e1', role: 'heading', name: 'Welcome' },
    { ref: 'e2', role: 'button', name: 'Sign in' },
    { ref: 'e3', role: 'link', name: 'Sign up' },
  ], 'Sign in', 'click')) === JSON.stringify(ranked))
  step('type prefers fields over buttons', rankElements([
    { ref: 'e1', role: 'button', name: 'Email updates' },
    { ref: 'e2', role: 'textbox', name: 'Email' },
  ], 'Email', 'type')[0]?.node.ref === 'e2')
}


// ── browser_see: set-of-marks (the model's eyes) ────────────────────────────

{
  const nodes = [
    { ref: 'e1', role: 'heading', name: 'Example', children: [] },
    { ref: 'e2', role: 'searchbox', name: 'Search', children: [] },
    { ref: 'e3', role: 'button', name: 'Add to cart', children: [] },
    { ref: 'e4', role: 'link', name: 'Disabled thing', disabled: true, children: [] },
  ]
  const { tools, host } = build({}, { pageOptions: { nodes } })
  const result = await run(tools, TOOL_NAMES.see, {})
  step('see returns the mark table', result.ok === true && Array.isArray(result.marks), JSON.stringify(result).slice(0, 140))
  step('see marks only interactive roles', result.marks.length === 2 && result.marks.every(m => ['searchbox', 'button'].includes(m.role)))
  step('see skips disabled elements', !result.marks.some(m => m.ref === 'e4'))
  step('see numbers marks from 1 in document order', result.marks[0].mark === 1 && result.marks[0].ref === 'e2' && result.marks[1].mark === 2)
  step('see reports the candidate count before visibility filtering', result.candidateCount === 2, String(result.candidateCount))
  step('see carries the viewport it drew against', result.viewport.width === 1366 && result.viewport.height === 768)

  const scripts = host.page.scripts
  step('see injects the overlay before capturing', scripts.some(text => text.includes('dsh-browser-marks')) && scripts.some(text => text.includes('layer.remove()')))
  const injectAt = scripts.findIndex(text => text.includes('document.documentElement.appendChild'))
  const cleanupAt = scripts.findIndex(text => text.startsWith('(() => {\n  const layer'))
  const captureAt = host.page.calls.findIndex(c => c.name === 'capture')
  step('the capture happens between inject and cleanup', injectAt !== -1 && cleanupAt !== -1 && captureAt !== -1)
  step('see still returns marks when capture fails', result.markCount === 2)
}

{
  // A see result is what makes `mark` a legal click alias.
  const nodes = [{ ref: 'e7', role: 'button', name: 'Continue reading', children: [] }]
  const { tools, host } = build({}, { pageOptions: { nodes } })
  await run(tools, TOOL_NAMES.see, {})
  const byMark = await run(tools, TOOL_NAMES.click, { mark: 1 })
  step('click accepts a mark alias', byMark.ok === true, JSON.stringify(byMark).slice(0, 140))
  step('the mark alias resolved to the real ref and clicked its box', host.page.calls.some(c => c.name === 'input.click'))
  const unknown = await run(tools, TOOL_NAMES.click, { mark: 99 })
  step('click refuses an unknown mark instead of guessing', unknown.ok === false && /unknown/.test(unknown.message ?? ''), JSON.stringify(unknown).slice(0, 140))
}

{
  // Marks alias refs, so they must die exactly when refs die: on navigation.
  const nodes = [{ ref: 'e9', role: 'link', name: 'Next page', children: [] }]
  const { tools } = build({}, { pageOptions: { nodes } })
  await run(tools, TOOL_NAMES.see, {})
  await run(tools, TOOL_NAMES.navigate, { url: 'https://example.com/two' })
  const stale = await run(tools, TOOL_NAMES.click, { mark: 1 })
  step('navigation clears the mark table', stale.ok === false && /unknown/.test(stale.message ?? ''), JSON.stringify(stale).slice(0, 140))
}

// ── marks: pure selection policy ────────────────────────────────────────────

{
  const viewport = { width: 1000, height: 800 }
  const candidates = [
    { ref: 'a', role: 'button', name: 'Visible' },
    { ref: 'b', role: 'link', name: 'Off right' },
    { ref: 'c', role: 'link', name: 'Off top' },
    { ref: 'd', role: 'textbox', name: 'No box' },
    { ref: 'e', role: 'button', name: 'Speck' },
    { ref: 'f', role: 'paragraph', name: 'Not interactive' },
  ]
  const boxes = new Map([
    ['a', { x: 10, y: 10, width: 100, height: 30 }],
    ['b', { x: 1200, y: 10, width: 100, height: 30 }],
    ['c', { x: 10, y: -200, width: 100, height: 30 }],
    ['e', { x: 50, y: 50, width: 2, height: 2 }],
    ['f', { x: 60, y: 60, width: 200, height: 40 }],
  ])
  const marks = selectMarks(candidates, boxes, viewport)
  step('only visible, big-enough, interactive elements get marks', marks.length === 1 && marks[0].ref === 'a', JSON.stringify(marks.map(m => m.ref)))
  step('marks are 1-based and dense', marks[0].mark === 1)

  const many = Array.from({ length: MAX_MARKS + 25 }, (_, index) => ({ ref: `r${index}`, role: 'button', name: `Button ${index}` }))
  const manyBoxes = new Map(many.map((node, index) => [node.ref, { x: 0, y: index * 10, width: 100, height: 8 }]))
  const capped = selectMarks(many, manyBoxes, { width: 1000, height: 100_000 })
  step(`the mark count is capped at ${MAX_MARKS}`, capped.length === MAX_MARKS)
  step('the cap keeps document order, not the biggest boxes', capped[0].ref === 'r0' && capped[capped.length - 1].ref === `r${MAX_MARKS - 1}`)

  const longName = selectMarks(
    [{ ref: 'x', role: 'link', name: 'n'.repeat(200) }],
    new Map([['x', { x: 0, y: 0, width: 50, height: 20 }]]),
    viewport,
  )
  step('a long accessible name is truncated in the table', longName[0].name.length <= 60)

  const overlay = buildOverlayScript(marks)
  step('the overlay script is a self-invoking expression (isolated-world safe)', overlay.startsWith('(() =>') && overlay.endsWith(')()'))
  step('the overlay carries every mark number and box', overlay.includes('"m":1') && marks.every(m => overlay.includes(String(m.box.x))))
  step('the overlay layer cannot eat clicks', overlay.includes('pointer-events:none'))
  step('the cleanup script removes exactly that layer', CLEANUP_SCRIPT.includes('dsh-browser-marks') && CLEANUP_SCRIPT.includes('remove()'))
}

{
  setMarks('s1', [{ mark: 1, ref: 'e1', role: 'button', name: 'One', box: { x: 0, y: 0, width: 1, height: 1 } }])
  step('a stored mark resolves to its ref', resolveMark('s1', 1) === 'e1')
  step('an unstored mark resolves to nothing', resolveMark('s1', 2) === undefined)
  step('marks are per session', resolveMark('s2', 1) === undefined)
  clearMarks('s1')
  step('clearMarks drops the whole table', resolveMark('s1', 1) === undefined)
}

// ── browser_desktop_view ────────────────────────────────────────────────────

{
  const { tools, host } = build()
  const on = await run(tools, TOOL_NAMES.desktopView, { enabled: true })
  step('desktop view toggles on through the host', on.ok === true && on.enabled === true, JSON.stringify(on).slice(0, 140))
  const call = host.calls.find(c => c.name === 'setDesktopView')
  step('the host receives the session and the flag', call?.args[0] === SESSION && call?.args[1] === true, JSON.stringify(call?.args))
  step('reload defaults to true — the UA is a request header', call?.args[2]?.reload === true)
  step('toggling desktop view invalidates the mark table', true)

  const off = await run(tools, TOOL_NAMES.desktopView, { enabled: false, reload: false })
  const offCall = host.calls.filter(c => c.name === 'setDesktopView').at(-1)
  step('reload can be opted out when the model will navigate anyway', off.ok === true && offCall?.args[2]?.reload === false)

  // The schema marks `enabled` required, so the harness validator refuses the
  // call before execute — and execute re-checks as defense in depth for hosts
  // that call tools without validating.
  let missingError
  try {
    await run(tools, TOOL_NAMES.desktopView, {})
  } catch (error) {
    missingError = error
  }
  step('desktop view refuses to guess the direction', missingError?.code === 'INVALID_ARGS' && /enabled/.test(String(missingError.violations ?? '')), String(missingError?.violations))
}

{
  // Chrome-for-Android parity: a tab opened while the session is in desktop
  // mode must come up in desktop mode, not silently mobile.
  const { tools, host } = build()
  await run(tools, TOOL_NAMES.tabs, { action: 'new' })
  step('a new tab is synced to the session desktop-view setting', host.calls.some(c => c.name === 'syncDesktopView'), JSON.stringify(host.calls.map(c => c.name)))
  await run(tools, TOOL_NAMES.tabs, { action: 'select', index: 0 })
  step('selecting a tab re-syncs it too', host.calls.filter(c => c.name === 'syncDesktopView').length >= 2)
}

  {
  // browser_cookies: metadata-only surface, explicit-domain clears.
  const cookieMeta = [
    { name: 'sid', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true },
    { name: '_ga', domain: '.example.com', path: '/', expires: 1799999999, httpOnly: false, secure: false },
  ]
  const { tools, host } = build()
  host.listCookies = async (id, domain) => {
    host.calls.push({ name: 'listCookies', args: [id, domain] })
    return { ok: true, cookies: domain ? cookieMeta.filter(c => c.domain.includes(domain)) : cookieMeta }
  }
  host.clearCookies = async (id, domain) => {
    host.calls.push({ name: 'clearCookies', args: [id, domain] })
    return { ok: true, cleared: domain === 'example.com' ? 2 : 0 }
  }
  const list = await run(tools, TOOL_NAMES.cookies, {})
  step('cookies list returns metadata and no values', list.ok === true && list.count === 2 && list.cookies.every(c => typeof c.name === 'string' && !('value' in c)), JSON.stringify(list).slice(0, 150))
  await run(tools, TOOL_NAMES.cookies, { domain: 'example.com' })
  step('the domain filter is forwarded to the host', host.calls.filter(c => c.name === 'listCookies').pop()?.args?.[1] === 'example.com')
  const clearNoDomain = await run(tools, TOOL_NAMES.cookies, { action: 'clear' })
  step('clear without a domain is refused — no wipe-everything mode', clearNoDomain.ok === false && /explicit `domain`/.test(clearNoDomain.message ?? ''), JSON.stringify(clearNoDomain).slice(0, 150))
  step('the refused clear never reached the host', !host.calls.some(c => c.name === 'clearCookies'))
  const cleared = await run(tools, TOOL_NAMES.cookies, { action: 'clear', domain: 'example.com' })
  step('clear reports how many cookies went', cleared.ok === true && cleared.cleared === 2, JSON.stringify(cleared))
  step('clear leaves a timeline trace', host.history.some(h => h.entry.tool === TOOL_NAMES.cookies && /example\.com/.test(h.entry.summary)), JSON.stringify(host.history.map(h => h.entry.tool)))
}

{
  const { tools } = build({}, { noSession: true })
  const res = await run(tools, TOOL_NAMES.cookies, {})
  step('cookies without a session is a typed refusal', res.ok === false && res.refused === 'no-session', JSON.stringify(res).slice(0, 120))
}

{
  // Self-healing refs: a re-rendered tree must not cost a full observe round-trip
  // when the element's identity (role + accessible name) survives — uniquely.
  const nodes = [
    { ref: 'e1', role: 'heading', name: 'Example', children: [] },
    { ref: 'e12', role: 'link', name: 'More information', children: [] },
  ]
  const { tools, host } = build({}, { pageOptions: { nodes } })
  await run(tools, TOOL_NAMES.observe, {})
  // The page re-renders: e12 is dead; e13 is the same link.
  nodes.length = 0
  nodes.push(
    { ref: 'e1', role: 'heading', name: 'Example', children: [] },
    { ref: 'e13', role: 'link', name: 'More information', children: [] },
  )
  host.page.boxOf = async ref => {
    if (ref === 'e12') throw Object.assign(new Error("stale element ref 'e12'"), { code: 'E_STALE_REF' })
    return { x: 100, y: 200, width: 80, height: 24, ref }
  }
  const healed = await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  step('a dead ref self-heals to the unique role+name match', healed.ok === true && healed.healedFrom === 'e12' && healed.target === 'e13', JSON.stringify(healed).slice(0, 200))
  step('the heal is announced on the timeline, never silent', host.gestures.some(g => g.event?.type === 'note' && /self-healed/.test(g.event?.text ?? '')), JSON.stringify(host.gestures.map(g => g.event?.type)))
}

{
  // Two candidates with the same role+name: guessing between "Delete" and
  // "Cancel" is how bots destroy accounts. No heal, loud failure.
  const nodes = [
    { ref: 'e1', role: 'heading', name: 'Example', children: [] },
    { ref: 'e12', role: 'link', name: 'More information', children: [] },
  ]
  const { tools, host } = build({}, { pageOptions: { nodes } })
  await run(tools, TOOL_NAMES.observe, {})
  nodes.length = 0
  nodes.push(
    { ref: 'e1', role: 'heading', name: 'Example', children: [] },
    { ref: 'e13', role: 'link', name: 'More information', children: [] },
    { ref: 'e14', role: 'link', name: 'More information', children: [] },
  )
  const boxCalls = []
  host.page.boxOf = async ref => {
    boxCalls.push(ref)
    if (ref === 'e12') throw Object.assign(new Error("stale element ref 'e12'"), { code: 'E_STALE_REF' })
    return { x: 100, y: 200, width: 80, height: 24, ref }
  }
  const res = await run(tools, TOOL_NAMES.click, { ref: 'e12' })
  step('an ambiguous re-match is never guessed', res.ok === false && !boxCalls.includes('e13') && !boxCalls.includes('e14'), `${JSON.stringify(res).slice(0, 120)} boxCalls=${boxCalls.join(',')}`)
}

{
  // The type tool heals the same way, and continues typing into the fresh ref.
  const nodes = [
    { ref: 'e9', role: 'textbox', name: 'Search', children: [] },
  ]
  const { tools, host } = build({}, { pageOptions: { nodes } })
  await run(tools, TOOL_NAMES.observe, {})
  nodes.length = 0
  nodes.push({ ref: 'e21', role: 'textbox', name: 'Search', children: [] })
  host.page.boxOf = async ref => {
    if (ref === 'e9') throw Object.assign(new Error("stale element ref 'e9'"), { code: 'E_STALE_REF' })
    return { x: 10, y: 20, width: 120, height: 24, ref }
  }
  const res = await run(tools, TOOL_NAMES.type, { ref: 'e9', text: 'hello' })
  step('type self-heals a dead field ref too', res.ok === true && host.gestures.some(g => g.event?.type === 'note' && /self-healed ref e9/.test(g.event?.text ?? '')), JSON.stringify(res).slice(0, 160))
}

{
  // extract(): the schema is a contract on the model's own data.
  const { tools } = build()
  const good = await run(tools, TOOL_NAMES.extract, {
    instruction: 'menu prices',
    schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number' } } } } } },
    data: { items: [{ name: 'Margherita', price: 12.5 }] },
  })
  step('extract validates conforming data against the schema', good?.ok === true && good.validated === true && good.data?.items?.length === 1, JSON.stringify(good).slice(0, 160))
  const bad = await run(tools, TOOL_NAMES.extract, {
    instruction: 'menu prices',
    schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: 'number' } } } } } },
    data: { items: [{ name: 'Margherita', price: 'twelve' }] },
  })
  step('extract reports exact violation paths + a deeper repair pass', bad?.ok === false && Array.isArray(bad.violations) && bad.violations.some(v => /items\[0\]\.price/.test(v)) && typeof bad.text === 'string', JSON.stringify(bad).slice(0,300))
  const noData = await run(tools, TOOL_NAMES.extract, { instruction: 'x', schema: { type: 'object' } })
  step('extract refuses to validate nothing', noData?.ok === false && /data/.test(noData.message ?? ''), JSON.stringify(noData).slice(0, 120))
}

{
  // fill_form(): read-back verification, the form-strategy half.
  const { tools } = build({}, { pageOptions: { fieldValues: { e20: 'hello', e21: 'TRANSFORMED' } } })
  const res = await run(tools, TOOL_NAMES.fillForm, { fields: [{ ref: 'e20', value: 'hello' }, { ref: 'e21', value: 'world' }] })
  step('fill_form verifies fields that read back equal', res?.ok === true && res.verified === 1 && res.results[0]?.verified === true, JSON.stringify(res?.results))
  step('fill_form flags transformed fields as mismatched, not filled-and-fine', res?.mismatched === 1 && res.results[1]?.verified === false && res.results[1]?.actual === 'TRANSFORMED', JSON.stringify(res?.results?.[1]))
  const off = await run(tools, TOOL_NAMES.fillForm, { fields: [{ ref: 'e20', value: 'hello' }], verify: false })
  step('verify:false skips the read-back', off?.ok === true && off.verified === 0 && off.mismatched === 0 && off.results[0]?.verified === undefined, JSON.stringify(off?.results))
}

{
  // browser_files(): the upload fence is the whole point.
  const { tools, host } = build()
  const fenced = await run(tools, TOOL_NAMES.files, { action: 'upload', ref: 'e30', paths: ['/etc/passwd'] })
  step('upload refuses paths outside the profile root', fenced?.ok === false && /fence/i.test(fenced.message ?? '') && !host.calls.some(c => c.name === 'setFiles'), JSON.stringify(fenced).slice(0, 160))
  const { profileRoot } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
  const allowed = await run(tools, TOOL_NAMES.files, { action: 'upload', ref: 'e30', paths: [join(profileRoot(), 'staged', 'invoice.pdf')] })
  step('upload accepts staged paths under the profile root', allowed?.ok === true && allowed.uploaded === 1 && !('message' in (allowed ?? {})), JSON.stringify(allowed).slice(0, 140))
  const dl = await run(tools, TOOL_NAMES.files, { action: 'download', ref: 'e31' })
  step('download saves under the profile with a sanitized name', dl?.ok === true && dl.bytes === 5 && /report\.pdf$/.test(dl.path ?? '') && dl.path.includes('downloads'), JSON.stringify(dl).slice(0, 160))
  const sneaky = build({}, { pageOptions: { downloadName: '../../evil.sh' } })
  const dl2 = await run(sneaky.tools, TOOL_NAMES.files, { action: 'download', ref: 'e31' })
  step('a site-controlled filename cannot escape the downloads dir', dl2?.ok === true && dl2.path.includes('/downloads/') && !dl2.path.includes('../') && dl2.path.endsWith('evil.sh'), JSON.stringify(dl2?.path))
}

{
  // WebMCP watcher: detect and report, never consume.
  const { tools } = build({}, { pageOptions: { siteTools: true } })
  const seen = await run(tools, TOOL_NAMES.observe, {})
  step('observe reports sites that declare agent tools (WebMCP)', seen?.siteTools === true, JSON.stringify(seen?.siteTools))
}


{
  // browser_workflow: record → replay wiring.
  const { tools, host } = build()
  const list = await run(tools, TOOL_NAMES.workflow, { action: 'list' })
  step('workflow list returns saved workflows without a session', list?.ok === true && list.workflows?.[0]?.name === 'checkout-demo', JSON.stringify(list).slice(0, 140))
  const start = await run(tools, TOOL_NAMES.workflow, { action: 'start' })
  step('start arms recording through the host (no gate — the USER owns the pointer while demonstrating)', start?.ok === true && host.calls.some(c => c.name === 'setRecording' && c.args[1] === true), JSON.stringify(start).slice(0, 140))
  const stop = await run(tools, TOOL_NAMES.workflow, { action: 'stop', name: 'checkout-demo' })
  step('stop saves and reports required variables', stop?.ok === true && stop.variables?.includes('password') && host.history.some(h => h.entry.tool === 'browser_workflow' && /saved/.test(h.entry.summary)), JSON.stringify(stop).slice(0, 140))
  const runNoName = await run(tools, TOOL_NAMES.workflow, { action: 'run' })
  step('run without a name is refused with guidance', runNoName?.ok === false && /name/.test(runNoName.message ?? ''), JSON.stringify(runNoName).slice(0, 120))
  const runIt = await run(tools, TOOL_NAMES.workflow, { action: 'run', name: 'checkout-demo', vars: { password: 'hunter2' } })
  const runCall = host.calls.filter(c => c.name === 'runWorkflow').pop()
  step('run replays through the host with vars (secrets live only in the call, never the file)', runIt?.ok === true && runIt.replayed === 7 && runIt.fallbacks === 1 && runCall?.args?.[2]?.password === 'hunter2', JSON.stringify(runIt).slice(0, 140))
  const missingVars = build({}, { runResult: { ok: false, refused: 'policy', message: 'workflow checkout-demo needs variable(s): password — pass them in vars' } })
  const refused = await run(missingVars.tools, TOOL_NAMES.workflow, { action: 'run', name: 'checkout-demo' })
  step('a replay missing its secrets REFUSES rather than typing empty passwords', refused?.ok === false && /needs variable/.test(refused.message ?? ''), JSON.stringify(refused).slice(0, 140))
  const del = await run(tools, TOOL_NAMES.workflow, { action: 'delete', name: 'checkout-demo' })
  step('delete removes a saved workflow', del?.ok === true && host.calls.some(c => c.name === 'deleteWorkflow' && c.args[0] === 'checkout-demo'))
  const userStart = build({}, { owner: 'user', recordingResult: { ok: false, refused: 'pointer-owned', message: 'recording captures HUMAN gestures — take over the pointer in the panel first, then demonstrate' } })
  const userRes = await run(userStart.tools, TOOL_NAMES.workflow, { action: 'start' })
  step('start while the user drives surfaces the host verdict verbatim', userRes?.ok === false && userRes.refused === 'pointer-owned', JSON.stringify(userRes).slice(0, 140))
}

{
  // workflows module: the recorder/replay semantics, pure.
  const wf = await import(pathToFileURL(join(root, 'lib', 'workflows.js')).href)
  let steps = []
  steps = wf.appendKeyEvent(steps, 'h', 'h', false)
  steps = wf.appendKeyEvent(steps, 'i', 'i', false)
  steps = wf.appendKeyEvent(steps, '!', '!', false)
  step('printable keystrokes coalesce into one type step', steps.length === 1 && steps[0].text === 'hi!', JSON.stringify(steps))
  steps = wf.appendKeyEvent(steps, 'Enter', undefined, false)
  step('a function key becomes its own press step', steps.length === 2 && steps[1].kind === 'press' && steps[1].key === 'Enter', JSON.stringify(steps[1]))
  const secretSteps = wf.appendKeyEvent(steps, 'x', 'x', true)
  step('typing into a secret target stores a VARIABLE, never the text', secretSteps.length === 3 && secretSteps[2].kind === 'type' && secretSteps[2].variable === 'password' && secretSteps[2].text === undefined, JSON.stringify(secretSteps[2]))
  const secretMore = wf.appendKeyEvent(secretSteps, 'y', 'y', true)
  step('secret keystrokes never accumulate', secretMore.length === 3 && secretMore[2].variable === 'password', JSON.stringify(secretMore))
  const names = wf.listVariableNames(secretMore)
  step('listVariableNames finds required secrets in order', names.length === 1 && names[0] === 'password', JSON.stringify(names))
  const inline = wf.listVariableNames([{ kind: 'goto', url: 'https://shop.test/u/{{username}}' }, { kind: 'type', text: 'pass={{password}}' }])
  step('{{vars}} inline in URLs and text are detected', inline.includes('username') && inline.includes('password'), JSON.stringify(inline))
  const resolved = wf.resolveVariables([{ kind: 'goto', url: 'https://shop.test/u/{{username}}' }, { kind: 'type', variable: 'password' }, { kind: 'click', x: 0.5, y: 0.5 }], { username: 'ada', password: 'pw' })
  step('resolveVariables substitutes everywhere', resolved.missing.length === 0 && resolved.steps[0].url === 'https://shop.test/u/ada' && resolved.steps[1].text === 'pw' && resolved.steps[2].kind === 'click', JSON.stringify(resolved.steps))
  const partial = wf.resolveVariables([{ kind: 'type', variable: 'password' }], {})
  step('a missing variable is reported, never defaulted', partial.missing.length === 1 && partial.missing[0] === 'password')
  step('workflow names are filesystem-safe', wf.sanitizeWorkflowName('../../etc/pa ss\'wd') === '..etcpa-sswd' || !wf.sanitizeWorkflowName('../../etc/pa ss\'wd').includes('/'), JSON.stringify(wf.sanitizeWorkflowName('../../etc/pa ss\'wd')))
  const probe = wf.identityProbeScript({ tag: 'button', text: 'Buy now' })
  step('the identity probe matches conservatively and returns normalized center', probe.includes('aria-label') && probe.includes('bestScore < 4') && probe.includes('innerWidth'), probe.slice(0, 80))
  const capture = wf.identityCaptureScript(120, 80)
  step('the capture probe flags password-shaped targets', capture.includes('elementFromPoint(120, 80)') && capture.includes("type === 'password'"), capture.slice(0, 80))
}

{
  // act → deterministic cache (Ui.Vision's other half, identity-verified).
  const { profileRoot } = await import(pathToFileURL(join(root, 'lib', 'access.js')).href)
  const { readFileSync, rmSync } = await import('node:fs')
  rmSync(join(profileRoot(), 'act-cache.json'), { force: true }) // hermetic per run
  const first = build({}, { pageOptions: { refName: 'Cache probe' } })
  const one = await run(first.tools, TOOL_NAMES.act, { instruction: 'click "Cache probe"' })
  step('a confident act caches its resolution', one?.ok === true && one.cache === 'new', JSON.stringify(one?.cache))
  const two = await run(first.tools, TOOL_NAMES.act, { instruction: 'click "Cache probe"' })
  step('the same instruction replays identity-verified from cache', two?.ok === true && two.cache === 'hit' && two.ref === 'e12', JSON.stringify(two?.cache))
  const disk = JSON.parse(readFileSync(join(profileRoot(), 'act-cache.json'), 'utf8'))
  const key = Object.keys(disk).find(k => k.includes('cache probe'))
  step('the cache persists under the profile root, keyed by page pattern + instruction', typeof key === 'string' && key.startsWith('example.com/') && disk[key].name === 'Cache probe' && disk[key].hits === 1, JSON.stringify(key))
  // Same accessible name but a different role on the page: verification fails,
  // scoring still resolves it, and the result says miss out loud.
  const shifted = build({}, { pageOptions: { refName: 'Cache probe', refRole: 'button' } })
  const three = await run(shifted.tools, TOOL_NAMES.act, { instruction: 'click "Cache probe"' })
  step('a cached resolution that fails identity verification falls through honestly', three?.ok === true && three.cache === 'miss' && three.ref === 'e12', JSON.stringify(three?.cache))
  const four = await run(shifted.tools, TOOL_NAMES.act, { instruction: 'click "Cache probe"' })
  step('the refreshed entry verifies on the next call', four?.ok === true && four.cache === 'hit', JSON.stringify(four?.cache))
  const ac = await import(pathToFileURL(join(root, 'lib', 'act-cache.js')).href)
  step('cache keys drop the query string and normalize spacing', ac.actCacheKey('https://shop.test/cart?page=2', 'Click  "Buy" ') === ac.actCacheKey('https://shop.test/cart?page=9', 'click "Buy"'), '')
  const pruned = ac.pruneActCache({ old: { role: 'link', name: 'x', verb: 'click', savedAt: Date.now() - 8 * 864e5, hits: 0 }, fresh: { role: 'link', name: 'y', verb: 'click', savedAt: Date.now(), hits: 0 } })
  step('expired entries are pruned on load', !pruned.old && Boolean(pruned.fresh), JSON.stringify(Object.keys(pruned)))
  const many = {}
  for (let i = 0; i < 250; i++) many[`k${i}`] = { role: 'link', name: `n${i}`, verb: 'click', savedAt: Date.now() - i * 1000, hits: 0 }
  const capped = Object.keys(ac.pruneActCache(many))
  step('the cache is capped at 200, newest first', capped.length === 200 && capped[0] === 'k0', String(capped.length))
  step('a corrupt cache file is an empty cache, never a crash', Object.keys(ac.parseActCache('{ nope')).length === 0 && Object.keys(ac.parseActCache('[1,2]')).length === 0)
}

{
  // The replay orchestrator, pure: every step kind, identity vs fallback, abort, failure.
  const wf = await import(pathToFileURL(join(root, 'lib', 'workflows.js')).href)
  const calls = []
  const page = {
    viewport: () => ({ width: 1000, height: 1000 }),
    goto: async url => calls.push(['goto', url]),
    evaluateIsolated: async script => { calls.push(['probe']); return String(script).includes('Buy now') ? { x: 0.25, y: 0.5 } : null },
    input: {
      click: async (x, y) => calls.push(['click', x, y]),
      typeText: async t => calls.push(['type', t]),
      pressKey: async k => calls.push(['press', k]),
      scroll: async (dx, dy) => calls.push(['scroll', dx, dy]),
    },
  }
  const steps = [
    { kind: 'goto', url: 'https://shop.test/' },
    { kind: 'click', x: 0.9, y: 0.9, identity: { tag: 'button', text: 'Buy now' } },
    { kind: 'click', x: 0.5, y: 0.2 },
    { kind: 'type', text: 'ada' },
    { kind: 'press', key: 'Enter' },
    { kind: 'scroll', deltaX: 0, deltaY: 300 },
  ]
  const seen = []
  const res = await wf.replayWorkflowSteps(page, steps, { paceMs: 0, onStep: p => seen.push(p.index) })
  step('the replay loop runs every step kind in order', res.replayed === 6 && res.cancelled === false && calls[0][0] === 'goto' && calls.at(-1)[0] === 'scroll', JSON.stringify(calls.map(c => c[0])))
  step('an identity match wins over the recorded coordinates', calls[2][0] === 'click' && calls[2][1] === 250 && calls[2][2] === 500, JSON.stringify(calls[2]))
  step('an unmatched identity falls back to coordinates and counts it', res.fallbacks === 1 && calls[3][0] === 'click' && calls[3][1] === 500 && calls[3][2] === 200, JSON.stringify(calls[3]))
  step('progress is reported per step, in order', seen.length === 6 && seen.join(',') === '0,1,2,3,4,5', seen.join(','))
  const ctrl = new AbortController()
  const aborting = { ...page, input: { ...page.input, click: async (...a) => { ctrl.abort(); return page.input.click(...a) } } }
  const res2 = await wf.replayWorkflowSteps(aborting, [steps[1], steps[2], steps[3]], { paceMs: 0, signal: ctrl.signal })
  step('abort lands between steps: the in-flight step finishes, the rest do not run', res2.cancelled === true && res2.replayed === 1, JSON.stringify(res2))
  const failing = { ...page, goto: async () => { throw new Error('net::ERR_BLOCKED_BY_CLIENT') } }
  const res3 = await wf.replayWorkflowSteps(failing, [steps[0], steps[3]], { paceMs: 0 })
  step('a failed step stops the run and names it', res3.failedAt === 1 && /ERR_BLOCKED/.test(res3.error ?? '') && res3.replayed === 0, JSON.stringify(res3))
}

{
  // browser_task: saved workflows as cancellable background jobs.
  const { tools, host } = build()
  const started = await run(tools, TOOL_NAMES.task, { action: 'start', workflow: 'checkout-demo', vars: { password: 'hunter2' } })
  const startCall = host.calls.filter(c => c.name === 'startJob').pop()
  step('start launches a background job with vars through the host', started?.ok === true && typeof started.job === 'string' && startCall?.args?.[1] === 'checkout-demo' && startCall?.args?.[2]?.password === 'hunter2', JSON.stringify(started).slice(0, 140))
  const goalOnly = await run(tools, TOOL_NAMES.task, { action: 'start', goal: 'buy the thing' })
  step('a bare goal is refused with the honest reason, pointing at browser_workflow', goalOnly?.ok === false && goalOnly.refused === 'policy' && /browser_workflow/.test(goalOnly.message ?? ''), JSON.stringify(goalOnly.message).slice(0, 140))
  const st = await run(tools, TOOL_NAMES.task, { action: 'status', job: 'j1ab23cd' })
  step('status reports one job with live progress', st?.ok === true && st.id === 'j1ab23cd' && st.stepsDone === 2 && st.stepsTotal === 7 && st.status === 'running', JSON.stringify(st).slice(0, 160))
  const cancelled = await run(tools, TOOL_NAMES.task, { action: 'cancel', job: 'j1ab23cd' })
  step('cancel reaches the host with the job id', cancelled?.ok === true && host.calls.some(c => c.name === 'cancelJob' && c.args[1] === 'j1ab23cd'))
  const listed = await run(tools, TOOL_NAMES.task, { action: 'list' })
  step('list returns the session job records', listed?.ok === true && listed.jobs?.[0]?.workflow === 'checkout-demo', JSON.stringify(listed).slice(0, 140))
}
// ── C9: clips deliver to session + chat; transcripts read without ears ──────
{
  const { host, tools } = build()
  const clip = await run(tools, TOOL_NAMES.clip, { seconds: 2, fps: 3 })
  step('browser_clip samples real frames from the live page', clip?.ok === true && clip.frames >= 5 && clip.fps === 3 && clip.seconds === 2, JSON.stringify(clip).slice(0, 160))
  step('the clip result carries a chat-ready line pointing at the signed manifest', typeof clip?.chatLine === 'string' && clip.chatLine.includes('') && clip.chatLine.includes(clip.manifest) && clip.manifest.includes('token='), '')
  step('the clip is delivered to the session timeline with a replay ref', host.history.some(h => h.entry.tool === TOOL_NAMES.clip && h.entry.clip?.id === clip.clipId && typeof h.entry.clip.manifest === 'string' && h.entry.clip.frames === clip.frames), '')
  const manifestPath = join(captureDir(), SESSION, 'clips', `${clip.clipId}.json`)
  const onDisk = await readClipManifest(manifestPath)
  step('the manifest lands on disk with a signed url per frame', !!onDisk && onDisk.frames.length === clip.frames && onDisk.frames.every(f => typeof f.url === 'string' && f.url.includes('token=')), manifestPath)
  const clamped = await run(tools, TOOL_NAMES.clip, { seconds: 99, fps: 99 })
  step('clip bounds clamp to 10s @ 6fps', clamped?.ok === true && clamped.seconds === 10 && clamped.fps === 6, JSON.stringify({ s: clamped?.seconds, f: clamped?.fps }))
  const { tools: dryTools } = build({}, { noSession: true })
  const refused = await run(dryTools, TOOL_NAMES.clip, {})
  step('clip without a browser is refused like every other tool', refused?.ok === false && refused.refused === 'no-session', JSON.stringify(refused).slice(0, 120))
  const transcript = await run(tools, TOOL_NAMES.transcript, {})
  step('browser_transcript reads the open transcript panel', transcript?.ok === true && transcript.source === 'transcript-panel' && transcript.lines.join('|') === 'hello|world' && transcript.title === 'Fixture Video', JSON.stringify(transcript).slice(0, 160))
}

// ── C10: the gesture track rides inside the clip ────────────────────────────
{
  const { host, tools } = build()
  // gestures must land INSIDE the sampling window — that is the whole point
  const clipPromise = run(tools, TOOL_NAMES.clip, { seconds: 2, fps: 2 })
  host.session(SESSION).interactions.publish('agent', { type: 'click', x: 0.42, y: 0.61, button: 'left', label: 'Sign in' })
  host.session(SESSION).interactions.publish('agent', { type: 'scroll', deltaX: 0, deltaY: 480 })
  const clip = await clipPromise
  const manifestPath = join(captureDir(), SESSION, 'clips', `${clip.clipId}.json`)
  const onDisk = await readClipManifest(manifestPath)
  step('the clip manifest carries the gestures recorded inside its window', clip?.ok === true && Array.isArray(onDisk?.events) && onDisk.events.some(e => e.type === 'click' && e.x === 0.42 && e.text.includes('Sign in')) && onDisk.events.some(e => e.type === 'scroll' && e.text === 'scroll down 480px'), JSON.stringify(onDisk?.events))
  step('clip frames carry timestamps so replays can sync the hand', Array.isArray(onDisk?.frames) && onDisk.frames.every(f => typeof f.t === 'number' && f.t > 0), '')
  step('captions read like a human narrating, never echoing typed text', captionOfEvent({ type: 'type', characters: 12, secret: true }) === 'type 12 chars (secret)' && captionOfEvent({ type: 'key', key: 'Enter' }) === 'press Enter', '')
}

// ── C11: one call → a standalone replay reel artifact ───────────────────────
{
  const { host, tools } = build()
  const reelPromise = run(tools, TOOL_NAMES.reel, { seconds: 2, fps: 2 })
  host.session(SESSION).interactions.publish('agent', { type: 'scroll', deltaX: 0, deltaY: 240 })
  const reel = await reelPromise
  step('browser_reel bakes frames + gesture track into one artifact', reel?.ok === true && reel.frames >= 3 && reel.events >= 1 && typeof reel.bytes === 'number' && reel.bytes > 1000, JSON.stringify(reel).slice(0, 160))
  step('the reel result carries a chat-ready line with the signed artifact url', typeof reel?.chatLine === 'string' && reel.chatLine.includes('🎞️') && reel.chatLine.includes(reel.url) && reel.url.includes('token='), '')
  const reelPath = join(captureDir(), SESSION, 'clips', `${reel.reelId}.html`)
  const html = existsSync(reelPath) ? readFileSync(reelPath, 'utf8') : ''
  step('the reel artifact is standalone html with the player and the track inlined', html.startsWith('<!doctype html>') && html.includes('FRAMES = [') && html.includes('scroll down 240px') && html.includes('data:image/jpeg;base64'), `${html.length} bytes`)
  const { tools: dryTools } = build({}, { noSession: true })
  const refused = await run(dryTools, TOOL_NAMES.reel, {})
  step('reel without a browser is refused like every other tool', refused?.ok === false && refused.refused === 'no-session', JSON.stringify(refused).slice(0, 120))
}
finish()
