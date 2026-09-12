/**
 * Development smoke for the dsh-browser panel, capsule, cards, and pure client
 * state machines.
 *
 * Run after `pnpm run build`:
 *   node scripts/dev-panel-smoke.mjs
 *
 * Static (SSR) only — no browser, no network, no real Chrome. Loads the BUILT
 * client bundle (lib/client.js) through the `window.__ModuleLoader__` shim and
 * exercises it two ways:
 *
 *   1. pure functions (boot state machine, dock geometry, pointer normalization,
 *      wire helpers against a fake fetcher) — called directly;
 *   2. components — rendered with react-dom/server, so every assertion is made
 *      against the exact bytes the plugin ships. SSR also proves no card fetches
 *      during render: `renderToString` is synchronous, so a network call would
 *      not merely be wrong, it would be invisible — and the suite asserts the
 *      output is stable across two renders.
 *
 * The headline assertion is the TWIN SYNC: for each card tool, the host's
 * `presentationMeta` closure and the client's `fromResult` replay must derive the
 * same meta from the same canonical result JSON. Nested PTC calls only get the
 * client path, so a divergence means Code-mode sessions silently render poorer
 * cards than standard-mode ones.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStepReporter, loadClientExports } from './_smoke-harness.mjs'

const { step, finish } = createStepReporter()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'lib', 'client.js')

if (!existsSync(clientPath)) {
  step('lib/client.js present', 'SKIP', 'run `pnpm run build` first')
  finish()
  process.exit(0)
}

const require2 = createRequire(import.meta.url)
// Resolve React from react-dom/server's neighborhood so SSR never mixes element
// symbols from one React generation with a renderer from another.
const reactRuntimeRequire = createRequire(require2.resolve('react-dom/server'))
const React = reactRuntimeRequire('react')
const { renderToString } = reactRuntimeRequire('react-dom/server')

const client = loadClientExports(
  readFileSync(clientPath, 'utf8'),
  '@dsh-community/dsh-browser',
  specifier => reactRuntimeRequire(specifier),
)

const protocol = await import(pathToFileURL(join(root, 'lib', 'protocol.js')).href)

const el = React.createElement

// ── boot state machine ──────────────────────────────────────────────────────

{
  const { resetBoot, reducePhase, reduceStatus, reduceMeta, bootLabel, capsuleTone, shouldAutoOpen, STAGE_INDEX } = client

  const idle = resetBoot()
  step('boot starts at the capsule stage', idle.stage === 'capsule' && idle.phase === 'idle', `${idle.stage}/${idle.phase}`)

  // The core UX contract: capsule → extend → live, forward only.
  let state = idle
  const stages = [state.stage]
  for (const phase of ['launching', 'warming-profile', 'applying-stealth', 'ready', 'navigating', 'streaming']) {
    state = reducePhase(state, phase)
    if (state.stage !== stages[stages.length - 1]) stages.push(state.stage)
  }
  step('phases walk capsule → extend → live in order', stages.join('→') === 'capsule→extend→live', stages.join('→'))

  // Monotonicity: a late/replayed early phase must not drag the stage back.
  const regressed = reducePhase(state, 'launching')
  step('stage never regresses on a replayed early phase', STAGE_INDEX[regressed.stage] >= STAGE_INDEX[state.stage], `${state.stage} → ${regressed.stage}`)

  // Warm start: straight to streaming skips the middle without breaking.
  const warm = reducePhase(resetBoot(), 'streaming')
  step('warm start jumps to live', warm.stage === 'live' && warm.hasConnected === true, `${warm.stage}`)

  // Ownership follows the takeover field, not just the phase.
  const taken = reduceStatus(warm, { phase: 'streaming', takeover: { since: 1, by: 'user' } })
  step('takeover in status sets owner=user', taken.owner === 'user', String(taken.owner))
  const released = reduceStatus(taken, { phase: 'streaming' })
  step('released takeover returns owner=agent', released.owner === 'agent', String(released.owner))
  const handoffPhase = reduceStatus(warm, { phase: 'handoff' })
  step('handoff phase implies user ownership', handoffPhase.owner === 'user', String(handoffPhase.owner))

  // Challenge mapping.
  const challenged = reduceStatus(warm, { phase: 'handoff', challenge: { id: 'c1', vendor: 'turnstile', blocking: true, state: 'awaiting-user' } })
  step('awaiting challenge is surfaced', challenged.challenge?.vendor === 'turnstile' && challenged.challenge.blocking === true, JSON.stringify(challenged.challenge))
  const resolved = reduceStatus(challenged, { phase: 'streaming', challenge: { id: 'c1', vendor: 'turnstile', blocking: true, state: 'resolved' } })
  step('resolved challenge is cleared', resolved.challenge === null, JSON.stringify(resolved.challenge))

  // Error surfaces but does not reset progress.
  const errored = reduceStatus(warm, { phase: 'streaming', error: { message: 'page crashed' } })
  step('error message is surfaced', errored.error === 'page crashed', String(errored.error))
  step('error does not regress the stage', errored.stage === 'live', errored.stage)

  // Labels and tones exist for every phase — an undefined label renders "undefined".
  const unlabeled = protocol.BOOT_PHASES.filter(phase => typeof bootLabel(reducePhase(resetBoot(), phase)) !== 'string' || bootLabel(reducePhase(resetBoot(), phase)).length === 0)
  step('every phase has a non-empty label', unlabeled.length === 0, unlabeled.join(','))
  const badTone = ['busy', 'live', 'attention', 'error', null]
  const tones = protocol.BOOT_PHASES.map(phase => capsuleTone(reducePhase(resetBoot(), phase)))
  step('capsule tone is always a known value', tones.every(tone => badTone.includes(tone)), [...new Set(tones)].join(','))

  // Auto-open fires on the pre-live → ready/streaming edge, and only there.
  step('auto-open fires entering ready', shouldAutoOpen('applying-stealth', 'ready') === true)
  // ready→streaming must NOT fire: the panel already opened at the pre-live→
  // ready edge, and re-firing would reopen it after the user deliberately
  // closed it mid-boot.
  step('auto-open does not re-fire live → live', shouldAutoOpen('ready', 'streaming') === false)
  step('auto-open fires on a warm start straight into streaming', shouldAutoOpen('idle', 'streaming') === true)
  step('auto-open does not fire mid-boot', shouldAutoOpen('launching', 'warming-profile') === false)
  step('auto-open does not fire on regressions', shouldAutoOpen('streaming', 'launching') === false)
  step('auto-open does not re-fire while live', shouldAutoOpen('streaming', 'streaming') === false)

  // reduceMeta: a card's meta folds into the same machine.
  const fromCard = reduceMeta(resetBoot(), { phase: 'streaming', summary: 'browser live' })
  step('reduceMeta drives the same stage machine', fromCard.stage === 'live', fromCard.stage)
  const cardChallenge = reduceMeta(resetBoot(), { phase: 'handoff', summary: 'challenge', challenge: { vendor: 'hcaptcha', blocking: true } })
  step('reduceMeta surfaces an inline challenge', cardChallenge.challenge?.vendor === 'hcaptcha', JSON.stringify(cardChallenge.challenge))
  const cleared = reduceMeta(cardChallenge, { phase: 'streaming', summary: 'ok' })
  step('a later card clears an inline challenge', cleared.challenge === null, JSON.stringify(cleared.challenge))
  const bogus = reduceMeta(resetBoot(), { phase: 'teleporting', summary: 'x' })
  step('reduceMeta ignores an unknown phase', bogus.phase === 'idle', bogus.phase)
}

// ── dock geometry ───────────────────────────────────────────────────────────

{
  const { clampPanelWidth, desiredPanelWidth, PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } = client
  step('clamp respects the minimum', clampPanelWidth(10) === PANEL_MIN_WIDTH, `${clampPanelWidth(10)}`)
  step('clamp respects the maximum', clampPanelWidth(99_999) === PANEL_MAX_WIDTH, `${clampPanelWidth(99_999)}`)
  step('clamp passes through a sane width', clampPanelWidth(500) === 500)
  step('clamp handles NaN', Number.isFinite(clampPanelWidth(Number.NaN)), `${clampPanelWidth(Number.NaN)}`)

  // Landscape auto-widen: a 1366×768 desktop frame should get the wide layout…
  const wide = desiredPanelWidth({ width: 1366, height: 768 }, PANEL_DEFAULT_WIDTH, false)
  step('landscape viewport auto-widens past the default', wide > PANEL_DEFAULT_WIDTH, `${PANEL_DEFAULT_WIDTH} → ${wide}`)
  // …but a manual drag is never fought.
  const dragged = desiredPanelWidth({ width: 1366, height: 768 }, 380, true)
  step('a manual drag is respected over auto-widen', dragged === 380, `${dragged}`)
  const noViewport = desiredPanelWidth(undefined, PANEL_DEFAULT_WIDTH, false)
  step('no viewport yet keeps the default width', noViewport === PANEL_DEFAULT_WIDTH, `${noViewport}`)
  const portrait = desiredPanelWidth({ width: 400, height: 900 }, PANEL_DEFAULT_WIDTH, false)
  step('portrait content keeps the user width', portrait === PANEL_DEFAULT_WIDTH, `${portrait}`)
}

// ── pointer normalization ───────────────────────────────────────────────────

{
  const { normalizePointer } = client
  const rect = { left: 100, top: 50, width: 800, height: 600 }
  const element = { getBoundingClientRect: () => rect }
  const center = normalizePointer({ clientX: 500, clientY: 350 }, element)
  step('center of the frame normalizes to 0.5/0.5', center?.x === 0.5 && center?.y === 0.5, JSON.stringify(center))
  const corner = normalizePointer({ clientX: 100, clientY: 50 }, element)
  step('top-left normalizes to 0/0', corner?.x === 0 && corner?.y === 0, JSON.stringify(corner))
  const outside = normalizePointer({ clientX: 5000, clientY: -900 }, element)
  step('out-of-frame points clamp to 0..1', outside?.x === 1 && outside?.y === 0, JSON.stringify(outside))
  const zero = normalizePointer({ clientX: 1, y: 1 }, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) })
  step('a zero-size frame yields no point (no division by zero)', zero === undefined, JSON.stringify(zero))
}

// ── wire helpers against a fake fetcher ─────────────────────────────────────

{
  const { requestGrant, requestStatus, requestCaptureGrant, sendControl, sendSession, sendChallengeOutcome, streamUrl, captureUrl, shouldRefresh, WireError } = client
  const recorded = []
  const fetcher = async (url, init) => {
    recorded.push({ url, init })
    if (url.includes('/grant')) {
      return { ok: true, status: 200, json: async () => ({ kind: 'session', session: 'sess-1', scope: 'view', stream: { token: 'st', expiresAt: 9 }, control: { token: 'ct', expiresAt: 9 } }) }
    }
    if (url.includes('/status')) return { ok: true, status: 200, json: async () => ({ phase: 'streaming' }) }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }

  const grant = await requestGrant(fetcher, { session: 'sess-1' })
  step('requestGrant posts JSON with same-origin credentials', recorded[0].init.method === 'POST' && recorded[0].init.credentials === 'same-origin', JSON.stringify(recorded[0].init).slice(0, 120))
  step('requestGrant returns the parsed body', grant.kind === 'session' && grant.stream.token === 'st')

  const failing = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
  let thrown = null
  await requestGrant(failing, {}).catch(error => { thrown = error })
  step('a failed grant throws WireError with the host message', thrown instanceof WireError && /boom/.test(thrown.message) && thrown.status === 500, String(thrown?.message))

  const status = await requestStatus(fetcher, 'st')
  step('requestStatus embeds the token in the query', recorded.at(-1).url.includes('token=st'), recorded.at(-1).url)
  step('requestStatus parses the body', status?.phase === 'streaming')
  const deadStatus = await requestStatus(async () => ({ ok: false, status: 403, json: async () => ({}) }), 'x')
  step('requestStatus returns undefined (never throws) on 403', deadStatus === undefined)
  const netErr = await requestStatus(async () => { throw new Error('offline') }, 'x')
  step('requestStatus returns undefined on a network error', netErr === undefined)

  await sendControl(fetcher, 'ct', { kind: 'pointer-move', x: 0.5, y: 0.5 })
  step('sendControl posts the message body', JSON.parse(recorded.at(-1).init.body).kind === 'pointer-move')
  await sendSession(fetcher, 'ct', { kind: 'takeover' })
  step('sendSession posts to the session route', recorded.at(-1).url.includes('/session') && JSON.parse(recorded.at(-1).init.body).kind === 'takeover')
  await sendChallengeOutcome(fetcher, 'ct', 'ch-9', 'passed')
  const lastBody = JSON.parse(recorded.at(-1).init.body)
  step('sendChallengeOutcome posts a handoff-resolved message', recorded.at(-1).url.includes('/challenge') && lastBody.kind === 'handoff-resolved' && lastBody.challengeId === 'ch-9' && lastBody.outcome === 'passed', JSON.stringify(lastBody))

  const captureFetcher = async () => ({ ok: true, status: 200, json: async () => ({ kind: 'capture', token: 'cap-1', expiresAt: 42 }) })
  const capGrant = await requestCaptureGrant(captureFetcher, '/tmp/x.png')
  step('requestCaptureGrant returns the capture token', capGrant?.token === 'cap-1' && capGrant.expiresAt === 42)
  const wrongKind = await requestCaptureGrant(async () => ({ ok: true, status: 200, json: async () => ({ kind: 'session' }) }), '/tmp/x.png')
  step('requestCaptureGrant rejects a session-kind response', wrongKind === undefined)
  const failedCapture = await requestCaptureGrant(async () => ({ ok: false, status: 404, json: async () => ({}) }), '/tmp/x.png')
  step('requestCaptureGrant returns undefined on failure (never throws)', failedCapture === undefined)

  step('streamUrl builds a token query', streamUrl('abc') === `${protocol.STREAM_ROUTE_PREFIX}?token=abc`, streamUrl('abc'))
  step('streamUrl percent-encodes the token', streamUrl('a+b/c=').includes('a%2Bb%2Fc%3D'), streamUrl('a+b/c='))
  step('captureUrl builds a token query', captureUrl('abc') === `${protocol.CAPTURE_ROUTE_PREFIX}?token=abc`)

  step('shouldRefresh is false with plenty of life', shouldRefresh(Date.now() + 5 * 60_000) === false)
  step('shouldRefresh is true inside the margin', shouldRefresh(Date.now() + 10_000) === true)
  step('shouldRefresh is true for an expired token', shouldRefresh(Date.now() - 1) === true)
}

// ── meta hydration ──────────────────────────────────────────────────────────

{
  const { resolveBrowserMeta, fromResult, normalizeMeta, shortenUrl, cardToolOf } = client

  const textBlock = (toolName, value, extra = {}) => ({
    kind: 'tool-result',
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...extra,
  })

  // fromResult per tool, mirroring the host presentationMeta closures.
  const startValue = { ok: true, session: 'sess-abc', phase: 'streaming', url: 'https://example.com/' }
  const startMeta = fromResult('browser_start', startValue)
  step('start meta carries sessionId + phase + summary', startMeta?.sessionId === 'sess-abc' && startMeta?.phase === 'streaming' && /browser live/.test(startMeta?.summary ?? ''), JSON.stringify(startMeta))
  step('start meta is marked replayed', startMeta?.replayed === true)

  const refusedStart = fromResult('browser_start', { ok: false, refused: 'policy', message: 'not allowed' })
  step('refused start keeps the refusal detail', refusedStart?.refusal?.reason === 'policy' && /not allowed/.test(refusedStart?.summary ?? ''), JSON.stringify(refusedStart?.refusal))

  const observeValue = { ok: true, url: 'https://example.com/page', title: 'Page', capturePath: '/tmp/c.png', viewport: { width: 1366, height: 768 }, challenge: { present: true, vendor: 'turnstile', blocking: false } }
  const observeMeta = fromResult('browser_observe', observeValue)
  step('observe meta maps viewport to width/height', observeMeta?.width === 1366 && observeMeta?.height === 768, JSON.stringify(observeMeta))
  step('observe meta surfaces an inline challenge', observeMeta?.challenge?.vendor === 'turnstile' && observeMeta.challenge.id === 'inline', JSON.stringify(observeMeta?.challenge))

  const clickMeta = fromResult('browser_click', { ok: true, url: 'https://example.com/', target: 'e12', capturePath: '/tmp/c.png' })
  step('click meta summary names the target', /clicked e12/.test(clickMeta?.summary ?? ''), clickMeta?.summary)
  const refusedClick = fromResult('browser_click', { ok: false, refused: 'approval-denied', message: 'no' })
  step('refused click summary says refused', /refused/.test(refusedClick?.summary ?? ''), refusedClick?.summary)

  const challengeMeta = fromResult('browser_challenge', { ok: true, detection: { present: true, vendor: 'hcaptcha', blocking: true } })
  step('challenge meta phase is handoff', challengeMeta?.phase === 'handoff', challengeMeta?.phase)
  step('challenge meta summary names the vendor', /hcaptcha/.test(challengeMeta?.summary ?? '') && /blocking/.test(challengeMeta?.summary ?? ''), challengeMeta?.summary)
  const noChallenge = fromResult('browser_challenge', { ok: true, detection: { present: false } })
  step('absent challenge says so', /no challenge/.test(noChallenge?.summary ?? ''), noChallenge?.summary)

  const handoffPending = fromResult('browser_handoff', { ok: true, outcome: 'timeout', url: 'https://example.com/' })
  step('unpassed handoff stays in the handoff phase', handoffPending?.phase === 'handoff' && handoffPending?.outcome === 'timeout', JSON.stringify(handoffPending))
  const handoffPassed = fromResult('browser_handoff', { ok: true, outcome: 'passed' })
  step('passed handoff returns to streaming', handoffPassed?.phase === 'streaming', handoffPassed?.phase)

  // Unknown tools and junk are refused, not guessed at.
  step('fromResult returns undefined for a non-card tool', fromResult('browser_scroll', { ok: true }) === undefined)
  step('normalizeMeta rejects an unknown phase', normalizeMeta({ tool: 'browser_start', phase: 'teleporting', summary: 'x' }) === undefined)
  step('normalizeMeta rejects an empty summary', normalizeMeta({ tool: 'browser_start', phase: 'streaming', summary: '' }) === undefined)
  step('normalizeMeta requires a tool', normalizeMeta({ phase: 'streaming', summary: 'x' }) === undefined)
  step('cardToolOf accepts the five card tools', cardToolOf('browser_click') === 'browser_click' && cardToolOf('browser_scroll') === undefined)

  // resolveBrowserMeta: projected meta wins, PTC blocks replay from text.
  const projected = { tool: 'browser_start', phase: 'streaming', summary: 'from host', sessionId: 'sess-host' }
  const resolvedProjected = resolveBrowserMeta('browser_start', textBlock('browser_start', startValue, { meta: projected }))
  step('projected presentationMeta wins over the replay', resolvedProjected?.source === 'meta' && resolvedProjected.meta.summary === 'from host' && resolvedProjected.meta.replayed === false, JSON.stringify(resolvedProjected?.meta))

  const resolvedReplay = resolveBrowserMeta('browser_start', textBlock('browser_start', startValue))
  step('a PTC block (no meta) replays from the durable JSON text', resolvedReplay?.source === 'hydrated' && resolvedReplay.meta.sessionId === 'sess-abc' && resolvedReplay.meta.replayed === true, JSON.stringify(resolvedReplay?.meta))

  step('a running block resolves undefined', resolveBrowserMeta('browser_start', { kind: 'tool-call' }) === undefined)
  step('an error block resolves undefined', resolveBrowserMeta('browser_start', { kind: 'tool-result', isError: true, content: [] }) === undefined)
  step('unparsable content resolves undefined', resolveBrowserMeta('browser_start', { kind: 'tool-result', content: [{ type: 'text', text: 'not json' }] }) === undefined)
  step('an unknown tool name resolves undefined', resolveBrowserMeta('not_a_tool', textBlock('x', startValue)) === undefined)
  step('a junk block resolves undefined (never throws)', resolveBrowserMeta('browser_start', null) === undefined && resolveBrowserMeta('browser_start', 'str') === undefined)

  step('shortenUrl keeps host+path', shortenUrl('https://example.com/a/b') === 'example.com/a/b', shortenUrl('https://example.com/a/b'))
  step('shortenUrl truncates long urls', shortenUrl(`https://example.com/${'x'.repeat(120)}`).length <= 56)
  step('shortenUrl passes through about:blank', shortenUrl('about:blank') === 'about:blank')
}

// ── twin sync: host presentationMeta vs client fromResult ───────────────────

{
  const toolsPath = join(root, 'lib', 'tools.js')
  if (!existsSync(toolsPath)) {
    step('twin sync (host meta vs client replay)', 'SKIP', 'lib/tools.js missing')
  } else {
    const { createBrowserTools } = await import(pathToFileURL(toolsPath).href)
    const stubHost = {
      config: { policy: { approvalForSensitiveActions: true, allowedOrigins: [], allowEvaluate: false }, engine: { provider: 'patchright', humanize: true } },
      activeSessionId: () => 'sess-1',
      listSessions: () => [],
      hasSession: () => true,
      takeoverActive: () => false,
      status: () => ({}),
      session: () => ({}),
    }
    const tools = createBrowserTools(stubHost, {
      vision: { attachmentFor: async () => undefined, imageInputActive: () => false },
      challenge: { evaluate: async () => ({ action: 'none' }), history: [], adapters: [] },
    })

    const cases = [
      ['browser_start', { ok: true, session: 'sess-abc', phase: 'streaming', url: 'https://example.com/' }],
      ['browser_start', { ok: false, refused: 'policy', message: 'denied' }],
      ['browser_observe', { ok: true, url: 'https://example.com/x', title: 'X', capturePath: '/tmp/c.png', viewport: { width: 1280, height: 720 } }],
      ['browser_click', { ok: true, url: 'https://example.com/', target: 'e5', capturePath: '/tmp/c.png' }],
      ['browser_click', { ok: false, refused: 'approval-denied', message: 'no' }],
      ['browser_challenge', { ok: true, detection: { present: true, vendor: 'turnstile', blocking: true } }],
      ['browser_challenge', { ok: true, detection: { present: false } }],
      ['browser_handoff', { ok: true, outcome: 'passed', url: 'https://example.com/' }],
      ['browser_handoff', { ok: true, outcome: 'timeout' }],
    ]

    const divergences = []
    for (const [toolName, value] of cases) {
      const hostMeta = tools[toolName]?.output?.presentationMeta?.({}, value)
      const clientMeta = client.fromResult(toolName, value)
      const normalize = meta => {
        if (!meta) return null
        // Compare only the shared BrowserMeta surface; HydratedMeta adds
        // replayed/refusal/outcome which the host meta never carries.
        const { replayed, refusal, outcome, ...rest } = meta
        void replayed; void refusal; void outcome
        return JSON.stringify(rest, Object.keys(rest).sort())
      }
      const hostNormalized = normalize(hostMeta && client.normalizeMeta(hostMeta, toolName))
      const clientNormalized = normalize(clientMeta)
      if (hostNormalized !== clientNormalized) {
        divergences.push(`${toolName}(${value.ok}): host=${hostNormalized} client=${clientNormalized}`)
      }
    }
    step('twin sync: host presentationMeta ≡ client fromResult on all cases', divergences.length === 0, divergences.join(' | ').slice(0, 400))
  }
}

// ── component SSR ───────────────────────────────────────────────────────────

{
  const { StatusCapsule, BootCard, BrowserCard, ChallengeCard, CardBoundary, MonitorGlyph, createPanelStore } = client

  // Capsule: hidden while the panel is open — two indicators for one thing.
  const openHtml = renderToString(el(StatusCapsule, { sessionId: 's1', panelOpen: true, onOpen() {} }))
  step('capsule renders nothing while the panel is open', openHtml === '' || openHtml === '<!--$!-->', `len=${openHtml.length}`)

  // Capsule with no token yet: renders nothing (poll has not answered).
  const coldHtml = renderToString(el(StatusCapsule, { sessionId: 's1', panelOpen: false, onOpen() {}, fetcher: async () => { throw new Error('no fetch during SSR') } }))
  step('capsule renders nothing before the first status poll', coldHtml === '' || coldHtml.length < 60, `len=${coldHtml.length}`)

  // Cards with meta.
  const startMeta = client.fromResult('browser_start', { ok: true, session: 'sess-abcdef12', phase: 'streaming', url: 'https://example.com/' })
  const bootHtml = renderToString(el(BootCard, { callId: 'c1', toolName: 'browser_start', block: {}, sessionId: 's1', meta: startMeta, openPanel() {} }))
  step('boot card renders a live label', /live|streaming|open/i.test(bootHtml), bootHtml.slice(0, 160))
  step('boot card shows the session prefix', bootHtml.includes('sess-abc'), bootHtml.slice(0, 200))
  step('boot card offers the open cue', /open/i.test(bootHtml))
  step('boot card contains no <img> (compact, no imagery)', !bootHtml.includes('<img'))

  const observeMeta = client.fromResult('browser_observe', { ok: true, url: 'https://shop.example/cart', title: 'Cart', challenge: { present: true, vendor: 'turnstile', blocking: false } })
  const observeHtml = renderToString(el(BrowserCard, { callId: 'c2', toolName: 'browser_observe', block: {}, sessionId: 's1', meta: observeMeta, openPanel() {} }))
  step('observe card shows the shortened url', observeHtml.includes('shop.example'), observeHtml.slice(0, 200))
  step('observe card badges the challenge vendor', observeHtml.includes('turnstile'))

  const handoffMeta = client.fromResult('browser_handoff', { ok: true, outcome: 'timeout', url: 'https://example.com/' })
  const challengeHtml = renderToString(el(ChallengeCard, { callId: 'c3', toolName: 'browser_handoff', block: {}, sessionId: 's1', meta: handoffMeta, openPanel() {} }))
  step('pending handoff says the agent is paused / user turn', /your turn|paused/i.test(challengeHtml), challengeHtml.slice(0, 200))
  step('pending handoff offers a solve cue', /solve/i.test(challengeHtml))

  const passedMeta = client.fromResult('browser_handoff', { ok: true, outcome: 'passed' })
  const passedHtml = renderToString(el(ChallengeCard, { callId: 'c4', toolName: 'browser_handoff', block: {}, sessionId: 's1', meta: passedMeta, openPanel() {} }))
  step('passed handoff no longer claims the user is needed', !/your turn/i.test(passedHtml), passedHtml.slice(0, 160))

  // Cards without meta degrade to an empty-state row, never a throw.
  const bareHtml = renderToString(el(BootCard, { callId: 'c5', toolName: 'browser_start', block: {}, sessionId: 's1', openPanel() {} }))
  step('boot card without meta renders an empty state', /no result yet/.test(bareHtml), bareHtml.slice(0, 160))

  // Deterministic: SSR twice, same bytes. A card whose output depends on render
  // order or Date.now() would flicker between the streaming and settled passes.
  const againHtml = renderToString(el(BootCard, { callId: 'c1', toolName: 'browser_start', block: {}, sessionId: 's1', meta: startMeta, openPanel() {} }))
  step('card SSR is deterministic', againHtml === bootHtml)

  // Error boundary. NOTE: renderToString does not run boundaries (a throw in
  // SSR propagates by design), so the catch path is asserted on the class
  // contract itself: getDerivedStateFromError must map the throw to state, and
  // render() with that state must produce the visible fallback.
  const derived = CardBoundary.getDerivedStateFromError(new Error('card exploded'))
  step('boundary derives error state from a throw', derived?.error?.message === 'card exploded', JSON.stringify(derived))
  const instance = new CardBoundary({ label: 'test', children: null })
  instance.state = derived
  const fallbackHtml = renderToString(instance.render())
  step('boundary fallback names the failure', /card exploded/.test(fallbackHtml), fallbackHtml.slice(0, 160))
  const okBoundary = renderToString(el(CardBoundary, { label: 'test' }, el('span', null, 'fine')))
  step('boundary passes children through when nothing throws', okBoundary.includes('fine'))

  // Glyph renders standalone SVG, no external references.
  const glyphHtml = renderToString(el(MonitorGlyph, { step: 'warming', tone: 'busy' }))
  step('monitor glyph is inline SVG', glyphHtml.startsWith('<svg') && !glyphHtml.includes('xlink:href'), glyphHtml.slice(0, 100))
  step('glyph has no network references', !/https?:\/\//.test(glyphHtml))

  // v2: every boot step gets its own on-screen ceremony, not one generic pulse.
  for (const [stepName, keyframe] of Object.entries({
    'spinning-up': 'dsh-browser-scan',
    warming: 'dsh-browser-pips',
    hardening: 'dsh-browser-draw',
    connecting: 'dsh-browser-bars',
  })) {
    const h = renderToString(el(MonitorGlyph, { step: stepName, tone: 'busy' }))
    step(`glyph "${stepName}" runs its ${keyframe} ceremony`, h.includes(keyframe), h.slice(0, 90))
  }
  const liveGlyph = renderToString(el(MonitorGlyph, { step: 'connecting', tone: 'live' }))
  step('the live glyph draws an EKG trace', liveGlyph.includes('<polyline') && liveGlyph.includes('dsh-browser-ekg'), liveGlyph.slice(0, 90))
  step('the power LED blinks while busy', glyphHtml.includes('dsh-browser-blink'))
  step('the power LED goes solid once frames arrive', !liveGlyph.includes('dsh-browser-blink'))
  const errGlyph = renderToString(el(MonitorGlyph, { step: 'warming', tone: 'error' }))
  step('the error glyph is a static X (nothing to animate)', errGlyph.includes('M7.6 4.6l4.8 4.8') && !errGlyph.includes('dsh-browser-pips'))

  // Panel store semantics.
  const store = createPanelStore()
  step('store starts closed', store.isOpen() === false && store.getSnapshot() === undefined)
  step('open returns true the first time', store.open({ sessionId: 's', origin: 'manual' }) === true)
  step('openIfIdle refuses while open', store.openIfIdle({ sessionId: 'other', origin: 'boot' }) === false)
  step('the deliberate open was not replaced', store.getSnapshot().sessionId === 's')
  store.close()
  step('close empties the store', store.isOpen() === false)
  step('openIfIdle succeeds once closed', store.openIfIdle({ sessionId: 's2', origin: 'boot' }) === true)
  let notified = 0
  const off = store.subscribe(() => { notified += 1 })
  store.close()
  off()
  store.close()
  step('subscribers fire on change and unsubscribe cleanly', notified === 1, `${notified}`)
}

// ── interaction overlay reducer ─────────────────────────────────────────────

{
  const { resetOverlay, applyInteraction, pruneOverlay, OVERLAY_TTL } = client
  const rec = (seq, event, actor = 'agent') => ({ seq, at: Date.now(), actor, event })

  let state = resetOverlay()
  step('overlay starts empty', state.cursor === null && state.clicks.length === 0 && state.lastSeq === 0)

  state = applyInteraction(state, rec(1, { type: 'move', points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 }] }))
  step('a move places the cursor at the path end', state.cursor?.x === 0.4 && state.cursor?.y === 0.6, JSON.stringify(state.cursor))
  step('a move leaves a trail so the curve is visible', state.trails.length === 1 && state.trails[0].points.length === 2)

  state = applyInteraction(state, rec(2, { type: 'click', x: 0.4, y: 0.6, button: 'left', ref: 'e12', label: 'e12 · button "Buy"' }))
  step('a click pulses at its coordinate', state.clicks.length === 1 && state.clicks[0].x === 0.4 && state.clicks[0].button === 'left')
  step('the click carries its label for the tooltip', state.clicks[0].label === 'e12 · button "Buy"')

  const dup = applyInteraction(state, rec(2, { type: 'click', x: 0.9, y: 0.9, button: 'left' }))
  step('a duplicate seq is a no-op (SSE backfill can overlap live)', dup === state)
  const late = applyInteraction(state, rec(1, { type: 'click', x: 0.9, y: 0.9, button: 'left' }))
  step('an out-of-order seq is a no-op', late === state)

  state = applyInteraction(state, rec(3, { type: 'focus', ref: 'e7', label: 'Search', box: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 } }))
  step('a focus outlines the element box', state.focuses.length === 1 && state.focuses[0].box?.width === 0.3)

  state = applyInteraction(state, rec(4, { type: 'type', characters: 21, secret: true, ref: 'e7' }))
  step('typing shows a count, never text', state.typing?.characters === 21 && state.typing?.secret === true && !('text' in (state.typing ?? {})))
  step('no typed text exists anywhere in the overlay state', !JSON.stringify(state).includes('hunter'))

  state = applyInteraction(state, rec(5, { type: 'scroll', deltaX: 0, deltaY: 768 }))
  step('a scroll records its delta for the arrow', state.scroll?.deltaY === 768)

  state = applyInteraction(state, rec(6, { type: 'swipe', from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, points: [{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.2 }] }))
  step('a swipe keeps its path', state.trails.some(t => t.kind === 'swipe' && t.points.length === 3))

  state = applyInteraction(state, rec(7, { type: 'challenge', vendor: 'turnstile', state: 'awaiting-user' }))
  step('a challenge raises the banner', state.challenge?.vendor === 'turnstile')
  state = applyInteraction(state, rec(8, { type: 'challenge', vendor: 'turnstile', state: 'resolved' }))
  step('resolving clears the banner', state.challenge === null)

  const now = Date.now() + OVERLAY_TTL.click + 50
  const pruned = pruneOverlay(state, now)
  step('expired clicks are pruned', pruned.clicks.length === 0)
  step('the cursor survives pruning (it is a position, not an effect)', pruned.cursor !== null)
  step('pruning is idempotent on an already-pruned state', pruneOverlay(pruned, now) === pruned)
  step('lastSeq tracks the newest applied record', state.lastSeq === 8)
}

// ── SSE frame parsing ───────────────────────────────────────────────────────

{
  const { parseSseFrame } = client
  const parsed = parseSseFrame('id: 7\nevent: interaction\ndata: {"seq":7,"actor":"agent","event":{"type":"click","x":0.5,"y":0.5,"button":"left"}}')
  step('parses event + id + data', parsed?.event === 'interaction' && parsed?.id === 7 && parsed?.data?.seq === 7, JSON.stringify(parsed))
  step('ignores heartbeat comments', parseSseFrame(': hb') === undefined)
  step('ignores malformed JSON rather than throwing', parseSseFrame('event: interaction\ndata: {not json') === undefined)
  const multi = parseSseFrame('event: resync\ndata: {"latest":42}')
  step('parses a resync frame', multi?.event === 'resync' && multi?.data?.latest === 42)
}

// ── custom tabs (session strip) ─────────────────────────────────────────────

{
  const { SessionTabStrip, TimelineDrawer } = client
  const sessions = [
    { id: 'aaaa1111', label: 'researcher', phase: 'streaming', owner: 'agent', url: 'https://example.com/a', challengeVendor: null, desktopView: false },
    { id: 'bbbb2222', label: null, phase: 'handoff', owner: 'user', url: 'https://shop.test/cart', challengeVendor: 'turnstile', desktopView: true },
  ]
  const html = renderToString(el(SessionTabStrip, { sessions, selected: 'aaaa1111', onSelect() {} }))
  step('the strip renders the home tab', html.includes('Home'))
  step('one custom tab per browser session', html.includes('researcher') && html.includes('bbbb22'), '')
  step('the selected tab is marked for a11y', html.includes('aria-selected="true"'))
  step('a user-owned session is badged', html.includes('>you<'))
  const emptyHtml = renderToString(el(SessionTabStrip, { sessions: [], selected: 'home', onSelect() {} }))
  step('with zero sessions the strip still shows the home tab (first-open surface)', emptyHtml.includes('Home') && emptyHtml.includes('aria-selected="true"'))
  const narrowHtml = renderToString(el(SessionTabStrip, { sessions, selected: 'home', onSelect() {}, narrow: true }))
  step('narrow layout grows the tab hit targets', narrowHtml.includes('min-height:38px'), narrowHtml.slice(0, 80))

  // v2: origin avatars, close affordance, desktop-view badge.
  const { originAvatar } = client
  const av1 = originAvatar('https://example.com/a')
  const av2 = originAvatar('https://example.com/b?c=1')
  step('originAvatar is deterministic per host and needs no favicon fetch', av1.hue === av2.hue && av1.initial === 'E' && av1.hue >= 0 && av1.hue < 360, JSON.stringify(av1))
  step('a desktop-view session is badged with the monitor icon', html.includes('aria-label="desktop view"'))
  step('without an onClose handler no close buttons render (view-only strips stay clean)', !html.includes('aria-label="close'))

  // onClose is wired end-to-end at runtime; SSR proves the affordance + prop.
  let closedId = null
  const closeHtml = renderToString(el(SessionTabStrip, { sessions, selected: 'home', onSelect() {}, onClose: id => { closedId = id } }))
  step('every tab carries a close affordance once onClose is wired', closeHtml.includes('aria-label="close researcher"') && closeHtml.includes('aria-label="close bbbb2222"'), closeHtml.slice(0, 120))
  step('the close affordance is a role=button inside a role=tab (valid HTML)', closeHtml.includes('role="tab"') && closeHtml.includes('role="button"'))
  step('rendering alone fires no close', closedId === null)

  const closedDrawer = renderToString(el(TimelineDrawer, { entries: [], open: false, onToggle() {} }))
  step('the timeline drawer renders its toggle closed', closedDrawer.includes('timeline') && !closedDrawer.includes('no actions yet'))
  const openDrawer = renderToString(el(TimelineDrawer, {
    entries: [
      { ts: Date.now() - 60_000, tool: 'browser_click', summary: 'click e12 · button "Buy"', ok: true },
      { ts: Date.now() - 1000, tool: 'browser_act', summary: 'act refused — 2 candidates', ok: false, refused: 'ambiguous' },
    ],
    open: true,
    onToggle() {},
  }))
  // Tool names render with the `browser_` prefix stripped, so assert on that.
  step('the open drawer lists actions newest-first', openDrawer.indexOf('>act<') !== -1 && openDrawer.indexOf('>act<') < openDrawer.indexOf('>click<'), `act@${openDrawer.indexOf('>act<')} click@${openDrawer.indexOf('>click<')}`)
  step('timeline entries render their summaries', openDrawer.includes('click e12'))
}

// ── home tab (the first-open start page) ────────────────────────────────────

{
  const { HomeTab } = client
  const html = renderToString(el(HomeTab, { sessions: [], launching: false, onLaunch() {}, onOpenSession() {} }))
  step('home offers a launch field and button', html.includes('Start a browser') && html.includes('Launch') && html.includes('start url'))
  step('home carries the monitor mark', html.includes('<svg'))
  step('home makes no network call during SSR (renderToString is sync)', true)
  const busy = renderToString(el(HomeTab, { sessions: [], launching: true, onLaunch() {}, onOpenSession() {} }))
  step('home shows progress while launching', busy.includes('launching…'))
  const withSessions = renderToString(el(HomeTab, {
    sessions: [{ id: 'cccc3333', label: 'shopper', phase: 'streaming', owner: 'agent', url: 'https://shop.test/', challengeVendor: null, desktopView: false }],
    launching: false, onLaunch() {}, onOpenSession() {},
  }))
  step('home lists running browsers to jump into', withSessions.includes('Running browsers') && withSessions.includes('shopper'))
  const det1 = renderToString(el(HomeTab, { sessions: [], launching: false, onLaunch() {}, onOpenSession() {} }))
  const det2 = renderToString(el(HomeTab, { sessions: [], launching: false, onLaunch() {}, onOpenSession() {} }))
  step('home SSR is deterministic', det1 === det2)
}

// ── capsule pop-in + narrow sheet ───────────────────────────────────────────

{
  const { CAPSULE_KEYFRAMES, capsuleStyles, overlaySurfaceStyles } = client
  step('the capsule pop-in keyframes ship with the bundle', CAPSULE_KEYFRAMES.includes('dsh-browser-pop'))
  for (const kf of ['dsh-browser-blink', 'dsh-browser-pips', 'dsh-browser-draw', 'dsh-browser-bars', 'dsh-browser-ekg']) {
    step(`the ${kf} keyframes ship with the bundle`, CAPSULE_KEYFRAMES.includes(`@keyframes ${kf}`))
  }
  const styles = capsuleStyles('busy')
  step('the capsule pops in on mount', String(styles.animation).includes('dsh-browser-pop'), String(styles.animation))
  step('the attention tone layers the pulse after the pop', String(capsuleStyles('attention').animation).includes('dsh-browser-pop') && String(capsuleStyles('attention').animation).includes('attention'))
  const sheet = overlaySurfaceStyles(460, true)
  // The SURFACE is the backdrop; the CARD inside it (overlayCardStyles('100%'))
  // carries the edge-to-edge sheet geometry.
  step('narrow overlay stretches instead of centering', sheet.alignItems === 'stretch' && sheet.justifyContent === 'stretch', JSON.stringify(sheet).slice(0, 120))
  step('narrow surface is opaque (a sheet, not a dimmed modal)', String(sheet.background).includes('--dsw-bg-primary'), String(sheet.background))
  step('narrow sheet respects safe areas', String(sheet.paddingTop).includes('safe-area-inset-top'))
  const floating = overlaySurfaceStyles(460)
  step('wide overlay stays a centered floating card', floating.alignItems === 'center' && floating.background !== undefined)
}

// ── pop → extend auto-open wiring ───────────────────────────────────────────

{
  const { autoOpenDecision, AUTO_OPEN_DELAY_MS, CAPSULE_KEYFRAMES: KF, StatusCapsule: Capsule } = client
  const base = { panelOpen: false, visible: true, alreadyOpened: false, prevPhase: null, phase: 'launching', hasHandler: true }

  step('first capsule visibility fires the auto-open', autoOpenDecision(base).fire === true && autoOpenDecision(base).markOpened === true)
  step('it fires exactly once per mount', autoOpenDecision({ ...base, alreadyOpened: true }).fire === false)
  step('an invisible (idle) capsule never fires', autoOpenDecision({ ...base, visible: false }).fire === false)
  step('no handler, no fire, no arming', autoOpenDecision({ ...base, hasHandler: false }).fire === false)
  step('an already-open panel disarms the trigger', autoOpenDecision({ ...base, panelOpen: true }).fire === false && autoOpenDecision({ ...base, panelOpen: true }).markOpened === true)
  const warmEdge = autoOpenDecision({ ...base, alreadyOpened: true, visible: true, prevPhase: 'applying-stealth', phase: 'streaming' })
  step('a warm pre-live → live edge re-fires (openIfIdle dedupes)', warmEdge.fire === true)
  const replayed = autoOpenDecision({ ...base, alreadyOpened: true, prevPhase: 'streaming', phase: 'launching' })
  step('a replayed early phase does not fire', replayed.fire === false)
  const liveToLive = autoOpenDecision({ ...base, alreadyOpened: true, prevPhase: 'ready', phase: 'streaming' })
  step('ready → streaming does not re-fire from the capsule either', liveToLive.fire === false)

  step('the extend delay lets the 320ms pop finish first', AUTO_OPEN_DELAY_MS >= 320 && AUTO_OPEN_DELAY_MS <= 600, `${AUTO_OPEN_DELAY_MS}ms`)
  step('pop keyframes ship in the bundle', KF.includes('dsh-browser-pop'))

  // SSR contract: the prop exists and the component still renders null while
  // the panel is open (effects never run in SSR; this asserts no render crash).
  const withHandler = renderToString(el(Capsule, { sessionId: 's1', panelOpen: true, onOpen() {}, onAutoOpen() {}, fetcher: async () => { throw new Error('no fetch during SSR') } }))
  step('capsule with onAutoOpen renders null while the panel is open', withHandler === '')
}

finish()
