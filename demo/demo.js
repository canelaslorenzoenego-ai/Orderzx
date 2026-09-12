/* global React, ReactDOM, DSHBrowserClient */
/**
 * Demo harness for the dsh-browser panel UX.
 *
 * The transport is scripted (no Chrome in this environment), but every piece of
 * UI you see is the REAL shipped component from lib/client.js:
 *
 *   StatusCapsule        the chatbar monitor, with the real pop-in animation,
 *                        real 2.5s status polling, and the real autoOpenDecision
 *   SessionTabStrip      the custom tabs (Home + one per browser)
 *   HomeTab              the first-open start page (launch field, recents, cards)
 *   TimelineDrawer       the action history chips
 *   InteractionOverlay   the gesture layer: cursor, ripples, focus outlines,
 *                        scroll arrows, swipe trails, typing badge, banners
 *   dockedSurfaceStyles  the real dock geometry + slide-in transform
 *
 * Press "Run agent task" and watch: capsule pops → dashboard extends → home tab
 * → session tab → the agent's pointer moves, clicks, types, scrolls, swipes,
 * and a challenge handoff banner asks you to solve. "Phone" switches to the
 * 390px sheet layout; "Desktop view" flips the mock site's UA layout.
 */
(function () {
  'use strict'
  const C = window.DSHBrowserClient
  const h = React.createElement
  const { useState, useEffect, useRef, useCallback } = React

  // Real exports used by the demo. `dockedSurfaceStyles` is optional here (not
  // re-exported from the client entry) — the demo falls back to an inline copy
  // that matches the shipped geometry, and the missing export is reported loudly
  // rather than rendering `undefined` into a style attribute.
  const {
    StatusCapsule, SessionTabStrip, HomeTab, TimelineDrawer, InteractionOverlay,
    applyInteraction, pruneOverlay, resetOverlay, installCapsuleKeyframes,
    overlaySurfaceStyles, AUTO_OPEN_DELAY_MS, PANEL_NARROW_PX, MonitorGlyph,
  } = C

  const dockedSurfaceStyles = C.dockedSurfaceStyles ?? function dockedSurfaceStylesFallback(width, extending) {
    return {
      position: 'fixed', top: 0, right: 0, bottom: 0, width: `${width}px`,
      transform: extending ? 'translateX(100%)' : 'translateX(0)',
      transition: 'transform 180ms cubic-bezier(0.22, 0.61, 0.36, 1), width 180ms cubic-bezier(0.22, 0.61, 0.36, 1)',
      display: 'flex', flexDirection: 'column', zIndex: 60, pointerEvents: 'auto',
    }
  }

  const REQUIRED = {
    StatusCapsule, SessionTabStrip, HomeTab, TimelineDrawer, InteractionOverlay,
    applyInteraction, pruneOverlay, resetOverlay, installCapsuleKeyframes,
    overlaySurfaceStyles, MonitorGlyph,
  }
  const missingExports = Object.keys(REQUIRED).filter(name => REQUIRED[name] === undefined)

  installCapsuleKeyframes(document)

  const PANEL_WIDTH = 460
  const NARROW_PX = PANEL_NARROW_PX ?? 760
  const SESSION_A = 'demobrowser0001'
  const SESSION_B = 'demobrowser0002'

  // ── the scripted world ────────────────────────────────────────────────────

  const world = {
    run: 0,               // increments per "Run agent task" (remounts the capsule)
    startedAt: 0,         // scenario clock
    secondBrowserAt: 0,   // when the sub-agent browser appears
    events: [],           // scheduled {t, kind, ...}
    fired: 0,
    recent: [],           // ActionEntry timeline
    lastPointer: null,
    challenge: null,      // {vendor, state}
    desktopView: false,
    done: false,
  }

  function phaseAt(elapsed) {
    if (elapsed < 700) return 'launching'
    if (elapsed < 1400) return 'warming-profile'
    if (elapsed < 2100) return 'applying-stealth'
    if (elapsed < 2800) return 'ready'
    if (elapsed < 3400) return 'navigating'
    return 'streaming'
  }

  function sessions() {
    if (!world.startedAt) return []
    const elapsed = Date.now() - world.startedAt
    const phase = phaseAt(elapsed)
    const list = [{
      id: SESSION_A, label: null, phase, owner: world.challenge?.state === 'awaiting-user' ? 'user' : 'agent',
      url: elapsed > 3400 ? 'https://shop.example/deals' : 'about:blank',
      challengeVendor: world.challenge?.state === 'awaiting-user' ? world.challenge.vendor : null,
      desktopView: world.desktopView,
    }]
    if (world.secondBrowserAt && Date.now() >= world.secondBrowserAt) {
      list.push({
        id: SESSION_B, label: 'researcher', phase: 'streaming', owner: 'agent',
        url: 'https://news.example/ai-agents', challengeVendor: null, desktopView: false,
      })
    }
    return list
  }

  function statusFor(sessionId) {
    const list = sessions()
    const own = list.find(x => x.id === sessionId) ?? list[0]
    if (!own) return { phase: 'idle', sessions: [] }
    return {
      phase: own.phase,
      sessions: list,
      recent: world.recent,
      lastPointer: world.lastPointer,
      interactionSeq: world.fired,
      session: {
        id: own.id, label: own.label, desktopView: own.desktopView,
        provider: 'patchright', channel: 'chrome', headless: false,
        viewport: { width: 1366, height: 768 },
        tabs: [{ index: 0, title: '', url: own.url, active: true }],
        activeTab: 0,
      },
      frames: { source: 'screenshot', fps: 5, lastSequence: 42, lastAt: Date.now(), bytes: 24000, lastCapturePath: null },
      ...(own.owner === 'user' ? { takeover: { since: Date.now(), by: world.challenge ? 'agent-handoff' : 'user' } } : {}),
      ...(world.challenge && own.id === SESSION_A ? { challenge: { id: 'ch-1', vendor: world.challenge.vendor, blocking: true, state: world.challenge.state, signal: 'dom', url: own.url } } : {}),
      stealth: { humanize: true, fingerprintProfile: null, proxy: null, frameSuppression: { active: !!world.challenge && world.challenge.state === 'awaiting-user', reason: world.challenge?.state === 'awaiting-user' ? 'turnstile challenge present' : null } },
    }
  }

  // The capsule's fake wire: grant + status only.
  const fakeFetcher = async url => {
    const json = body => ({ ok: true, status: 200, json: async () => body })
    if (String(url).includes('/grant')) {
      const list = sessions()
      if (list.length === 0) return { ok: false, status: 404, json: async () => ({ error: 'no session' }) }
      return json({
        kind: 'session', session: list[0].id, scope: 'view',
        stream: { token: 'demo-stream-token', expiresAt: Date.now() + 3600_000 },
        control: { token: 'demo-control-token', expiresAt: Date.now() + 3600_000 },
      })
    }
    if (String(url).includes('/status')) {
      const token = new URL(String(url), 'http://x').searchParams.get('token')
      const sid = token === 'demo-stream-token' ? (world.viewSession || SESSION_A) : SESSION_A
      return json(statusFor(sid))
    }
    return json({ ok: true })
  }

  // ── gesture script ────────────────────────────────────────────────────────
  // Coordinates match the mock page's CSS layout (normalized 0..1).

  const SEARCH_BOX = { x: 0.305, y: 0.045, width: 0.31, height: 0.05 }
  const SEARCH_C = { x: 0.46, y: 0.07 }
  const CART_BOX = { x: 0.085, y: 0.815, width: 0.19, height: 0.05 }
  const CART_C = { x: 0.18, y: 0.84 }

  function curve(from, to, lift) {
    const pts = []
    for (let i = 0; i <= 10; i++) {
      const t = i / 10
      const x = from.x + (to.x - from.x) * t + Math.sin(t * Math.PI) * lift
      const y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * lift * 0.6
      pts.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })
    }
    return pts
  }

  function scriptEvents() {
    const T = 3600 // gestures start once "streaming"
    return [
      { t: T, rec: { type: 'note', text: 'browser live · navigating to shop.example' } },
      { t: T + 400, rec: { type: 'navigate', url: 'https://shop.example/deals' }, act: ['browser_navigate', 'navigate → https://shop.example/deals', true] },
      { t: T + 1500, rec: { type: 'move', points: curve({ x: 0.85, y: 0.9 }, SEARCH_C, 0.08) } },
      { t: T + 2100, rec: { type: 'focus', ref: 'e5', label: 'searchbox "Search products"', box: SEARCH_BOX } },
      { t: T + 2350, rec: { type: 'click', x: SEARCH_C.x, y: SEARCH_C.y, button: 'left', ref: 'e5', label: 'e5 · searchbox' }, act: ['browser_act', 'act click e5 "Search products"', true] },
      { t: T + 2700, rec: { type: 'type', characters: 14, secret: false, ref: 'e5', label: 'Search products' }, act: ['browser_type', 'typed 14 chars into e5', true] },
      { t: T + 4200, rec: { type: 'key', key: 'Enter' }, act: ['browser_press', 'key Enter', true] },
      { t: T + 5200, rec: { type: 'scroll', deltaX: 0, deltaY: 720 }, act: ['browser_scroll', 'scroll down 720px', true] },
      { t: T + 6800, rec: { type: 'move', points: curve(SEARCH_C, CART_C, -0.1) } },
      { t: T + 7400, rec: { type: 'focus', ref: 'e21', label: 'button "Add to cart"', box: CART_BOX } },
      { t: T + 7700, rec: { type: 'click', x: CART_C.x, y: CART_C.y, button: 'left', ref: 'e21', label: 'e21 · button "Add to cart"' }, act: ['browser_click', 'click e21 · button "Add to cart"', true] },
      { t: T + 9000, rec: { type: 'swipe', from: { x: 0.5, y: 0.78 }, to: { x: 0.5, y: 0.34 }, points: [{ x: 0.5, y: 0.78 }, { x: 0.49, y: 0.62 }, { x: 0.5, y: 0.48 }, { x: 0.5, y: 0.34 }] } },
      { t: T + 10_400, challenge: { vendor: 'turnstile', state: 'awaiting-user' }, rec: { type: 'challenge', vendor: 'turnstile', state: 'awaiting-user' }, act: ['browser_handoff', 'handoff — turnstile needs a human', true], bubble: 'agent' },
      { t: T + 10_600, rec: { type: 'note', text: 'handoff — you are driving' } },
      { t: T + 14_500, challenge: { vendor: 'turnstile', state: 'resolved' }, rec: { type: 'challenge', vendor: 'turnstile', state: 'resolved' }, act: ['browser_handoff', 'challenge resolved by user', true] },
      { t: T + 14_900, rec: { type: 'note', text: 'agent resumed' } },
      { t: T + 16_000, secondBrowser: true, bubble2: true },
    ]
  }

  // ── app ───────────────────────────────────────────────────────────────────

  function Demo() {
    const [runId, setRunId] = useState(0)
    const [panelOpen, setPanelOpen] = useState(false)
    const [extending, setExtending] = useState(false)
    const [view, setView] = useState('home')            // 'home' | sessionId
    const [worldTick, setWorldTick] = useState(0)       // re-render clock
    const [overlay, setOverlay] = useState(() => resetOverlay())
    const [timelineOpen, setTimelineOpen] = useState(true)
    const [phone, setPhone] = useState(false)
    const [bubbles, setBubbles] = useState([])
    const [launching, setLaunching] = useState(false)
    const openedOnce = useRef(false)
    const autoSwitched = useRef(false)

    world.viewSession = view !== 'home' ? view : undefined

    // World clock: schedule events, prune overlay, re-render.
    useEffect(() => {
      const timer = setInterval(() => {
        if (world.startedAt) {
          const elapsed = Date.now() - world.startedAt
          while (world.fired < world.events.length && world.events[world.fired].t <= elapsed) {
            const ev = world.events[world.fired]
            world.fired += 1
            if (ev.rec) {
              const record = { seq: world.fired, at: Date.now(), actor: 'agent', event: ev.rec }
              setOverlay(cur => applyInteraction(cur, record))
              if (ev.rec.type === 'click' || ev.rec.type === 'move') {
                const pts = ev.rec.type === 'click' ? [ev.rec] : ev.rec.points
                const last = pts[pts.length - 1]
                if (last) world.lastPointer = { x: last.x, y: last.y }
              }
            }
            if (ev.act) {
              world.recent = [...world.recent, { ts: Date.now(), tool: ev.act[0], summary: ev.act[1], ok: ev.act[2] }].slice(-60)
            }
            if (ev.challenge !== undefined) world.challenge = ev.challenge
            if (ev.secondBrowser) world.secondBrowserAt = Date.now()
            if (ev.bubble) setBubbles(b => [...b, { kind: 'agent', text: 'A turnstile challenge appeared — the agent paused and handed you the pointer. Solve it in the panel, or press “solved” in the demo banner.' }])
            if (ev.bubble2) setBubbles(b => [...b, { kind: 'agent', text: 'Sub-agent “researcher” opened its own browser (second custom tab) — two agents, two pointers, zero fighting.' }])
          }
        }
        setOverlay(cur => pruneOverlay(cur, Date.now()))
        setWorldTick(t => t + 1)
      }, 120)
      return () => clearInterval(timer)
    }, [])

    // Panel mount slide-in: paint off-screen, rAF clears → the real 180ms transition.
    useEffect(() => {
      if (!panelOpen || !extending) return
      const raf = requestAnimationFrame(() => setExtending(false))
      return () => cancelAnimationFrame(raf)
    }, [panelOpen, extending])

    // Auto-follow: when a browser appears, leave Home (mimics the product's auto resolve).
    const list = sessions()
    useEffect(() => {
      if (view === 'home' && !autoSwitched.current && list.length > 0 && Date.now() - world.startedAt > 2900) {
        autoSwitched.current = true
        setView(SESSION_A)
      }
    }, [worldTick]) // eslint-disable-line

    const startScenario = useCallback(() => {
      world.run += 1
      world.startedAt = Date.now()
      world.secondBrowserAt = 0
      world.events = scriptEvents()
      world.fired = 0
      world.recent = []
      world.lastPointer = null
      world.challenge = null
      world.desktopView = false
      autoSwitched.current = false
      openedOnce.current = false
      setOverlay(resetOverlay())
      setBubbles([
        { kind: 'user', text: 'Find me the cheapest mechanical keyboard under $80 and add it to the cart. Meanwhile research the 2026 switch trends.' },
        { kind: 'agent', text: 'Starting a browser (label: default) and a second one for the research sub-agent…' },
      ])
      setView('home')
      setRunId(r => r + 1) // remounts the capsule → fresh grant → immediate poll → pop
    }, [])

    const openPanel = useCallback(() => {
      if (openedOnce.current) return
      openedOnce.current = true
      setPanelOpen(true)
      setExtending(true)
    }, [])

    const onAutoOpen = useCallback(() => {
      // The real product entry does exactly this: pop first, extend after the
      // pop animation finishes (AUTO_OPEN_DELAY_MS), openIfIdle semantics.
      setTimeout(openPanel, AUTO_OPEN_DELAY_MS ?? 420)
    }, [openPanel])

    const narrow = phone || (typeof window !== 'undefined' && window.innerWidth < NARROW_PX)
    const status = list.length ? statusFor(view !== 'home' ? view : SESSION_A) : { phase: 'idle', sessions: [] }
    const selectedSession = list.find(x => x.id === view)
    const showing = panelOpen && (view === 'home' || !selectedSession ? 'home' : selectedSession.id)
    const docked = panelOpen && !narrow

    // The dock lease, demo-style: push the conversation + chatbar left.
    useEffect(() => {
      document.querySelectorAll('.conversation, .chatbar').forEach(node => {
        node.style.marginRight = docked ? `${PANEL_WIDTH}px` : '0px'
      })
    }, [docked, worldTick])

    const capsule = h(StatusCapsule, {
      key: `capsule-${runId}`,
      sessionId: 'demo-conversation',
      panelOpen,
      fetcher: fakeFetcher,
      onOpen: () => { setPanelOpen(true); setExtending(true) },
      onAutoOpen,
    })

    const panel = panelOpen ? h('div', {
      style: narrow
        ? overlaySurfaceStyles(PANEL_WIDTH, true)
        : dockedSurfaceStyles(PANEL_WIDTH, extending),
    }, h('div', {
      style: narrow
        ? { width: '100%', maxWidth: '100vw', height: '100dvh', display: 'flex', flexDirection: 'column', minHeight: 0, borderRadius: 0, overflow: 'hidden', background: 'var(--dsw-bg-primary)', color: 'var(--dsw-text-primary)' }
        : { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--dsw-bg-primary)', borderLeft: '1px solid var(--dsw-border-color)', color: 'var(--dsw-text-primary)' },
    },
      h(SessionTabStrip, { sessions: list, selected: showing, onSelect: id => setView(id), narrow }),
      h('div', { className: 'panelheader' },
        h('div', { className: 't' },
          h('b', null, selectedSession?.label ? `Live browser · ${selectedSession.label}` : 'Live browser'),
          h('span', null, phaseLabel(status.phase), status.session?.desktopView ? ' · desktop view' : ''),
        ),
        h('button', {
          className: 'iconbtn' + (world.desktopView ? ' on' : ''),
          title: 'desktop UA + 1366×768 viewport (drive-scoped in the product)',
          onClick: () => { world.desktopView = !world.desktopView; setWorldTick(t => t + 1) },
        }, '🖥'),
        h('button', { className: 'iconbtn', title: 'close', onClick: () => setPanelOpen(false) }, '×'),
      ),
      h(TimelineDrawer, { entries: status.recent ?? [], open: timelineOpen, onToggle: () => setTimelineOpen(v => !v) }),
      h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' } },
        showing === 'home'
          ? h(HomeTab, {
              sessions: list,
              launching,
              onLaunch: (url, label) => {
                setLaunching(true)
                setTimeout(() => {
                  setLaunching(false)
                  if (!world.startedAt) startScenario()
                  else setView(SESSION_A)
                }, 900)
              },
              onOpenSession: id => setView(id),
            })
          : h('div', { className: 'streamwrap' },
              status.phase === 'streaming' || status.phase === 'navigating'
                ? h(MockPage, { session: showing, desktop: world.desktopView, mobileSite: !world.desktopView })
                : h('div', { className: 'placeholder' }, h(MonitorGlyph, { step: 'connecting', tone: 'busy' }), h('span', null, phaseLabel(status.phase) + '…')),
              // Real semantics: the agent's ghost pointer is hidden while the user is
              // driving (live-viewport passes hideAgentPointer={canDrive}); in the
              // demo the user drives during the challenge handoff → status.takeover.
              h(InteractionOverlay, { state: showing === SESSION_A ? overlay : resetOverlay(), hideAgentPointer: !!status.takeover }),
            ),
      ),
      world.challenge?.state === 'awaiting-user' && showing === SESSION_A
        ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', borderTop: '1px solid rgba(210,153,34,0.4)', background: 'rgba(210,153,34,0.12)', fontSize: 11.5 } },
            h('span', { style: { flex: '1 1 auto' } }, h('b', null, 'turnstile'), ' needs a human — the agent is paused.'),
            h('button', { className: 'iconbtn', style: { borderColor: 'rgba(63,185,80,0.6)' }, onClick: () => { world.challenge = { vendor: 'turnstile', state: 'resolved' }; world.recent = [...world.recent, { ts: Date.now(), tool: 'browser_handoff', summary: 'challenge resolved by user', ok: true }] } }, 'solved'),
          )
        : null,
      h('div', { className: 'panelfooter' },
        h('span', null, selectedSession ? `${selectedSession.owner === 'user' ? 'you drive' : 'agent drives'} · 1366×768 · patchright · humanized` : 'no browsers yet — launch one or let the agent do it'),
      ),
    )) : null

    return h('div', { className: 'page' },
      h('div', { className: 'conversation' },
        bubbles.map((b, i) => b.kind === 'tool'
          ? h('div', { key: i, className: 'toolcard' }, b.text)
          : h('div', { key: i, className: `bubble ${b.kind}` }, b.text)),
        world.startedAt && world.fired >= world.events.length
          ? h('div', { className: 'bubble agent' }, h('span', { className: 'dim' }, 'Demo complete — every animation you just saw is the real shipped overlay: pointer path, focus outline before the click, ripple, typing count (never text), scroll delta, swipe trail, challenge banner. Toggle Phone + Desktop view, click the researcher tab, or Run again.'))
          : null,
      ),
      h('div', { className: 'chatbar' },
        h('div', { className: 'input-mock' }, 'Message DeepSeek…'),
        capsule,
        h('button', { className: 'runbtn', onClick: startScenario, disabled: !!world.startedAt && world.fired < world.events.length }, world.startedAt ? 'Running…' : '▶ Run agent task'),
        h('button', { className: 'phonebtn' + (phone ? ' on' : ''), onClick: () => { setPhone(p => !p); document.body.classList.toggle('phone', !phone) } }, phone ? '📱 Phone ✓' : '📱 Phone'),
        h('button', { className: 'resetbtn', onClick: () => { world.startedAt = 0; world.fired = 0; world.events = []; world.recent = []; world.challenge = null; world.secondBrowserAt = 0; setPanelOpen(false); setView('home'); setBubbles([]); setOverlay(resetOverlay()); setRunId(r => r + 1) } }, 'Reset'),
      ),
      panel,
    )
  }

  function phaseLabel(phase) {
    return ({
      idle: 'idle', launching: 'launching browser', 'warming-profile': 'warming profile',
      'applying-stealth': 'applying stealth patches', ready: 'ready', navigating: 'navigating',
      streaming: 'live · 5 fps', paused: 'paused', handoff: 'handoff', takeover: 'takeover',
      closing: 'closing', error: 'error',
    })[phase] ?? phase
  }

  // The fake "streamed page". Layout coordinates match the gesture script.
  function MockPage({ session, mobileSite }) {
    if (session === SESSION_B) {
      return h('div', { className: 'mockpage' },
        h('div', { className: 'research' },
          h('h2', null, 'news.example — “browser agents 2026”'),
          h('div', { className: 'rrow' }, h('b', null, 'Cloudflare ships Live View + HITL for agent browsers'), 'Agents get observable sessions; humans resolve challenges in-place…'),
          h('div', { className: 'rrow' }, h('b', null, 'browser-use crosses 50k stars with parallel agents'), 'Multi-tab, memory and parallel agents are now table stakes…'),
          h('div', { className: 'rrow' }, h('b', null, 'Stagehand act/extract/observe becomes the primitive trio'), 'Deterministic-first AI actions win on cost and repeatability…'),
          h('div', { className: 'rrow' }, h('b', null, 'Anti-detect benchmark: Patchright 25/3, CloakBrowser 26/2'), 'On 31 Cloudflare targets, prevention beats solving…'),
        ),
      )
    }
    return h('div', { className: 'mockpage' + (mobileSite ? ' mobile-site' : '') },
      h('div', { className: 'mhead' }, h('span', { className: 'logo' }, 'SHOP.EXAMPLE'),
        h('div', { style: { flex: 1 } }),
        h('span', { style: { color: '#98a2b3', fontSize: 11 } }, mobileSite ? '⚠ mobile site' : 'desktop site'),
      ),
      h('div', { className: 'search' }, 'Search products'),
      h('div', { className: 'hero' }, 'Weekly deals — mechanical keyboards up to 40% off'),
      h('div', { className: 'grid' },
        ['Keychron K8 · $69', 'Redragon K552 · $42', 'Royal Kludge RK61 · $55'].map((name, i) =>
          h('div', { className: 'prod', key: i },
            h('div', { className: 'thumb' }),
            h('div', { className: 'pname' }, name.split(' · ')[0]),
            h('div', { className: 'price' }, name.split(' · ')[1]),
            h('div', { className: 'cartbtn' }, 'Add to cart'),
          )),
      ),
      mobileSite ? h('div', { className: 'interstitial' }, '📲 Get the SHOP app for a better experience! (mobile UA detected — flip “Desktop view” in the panel header)') : null,
    )
  }

  const root = ReactDOM.createRoot(document.getElementById('root'))
  if (missingExports.length > 0) {
    root.render(h('div', { style: { padding: 24, color: '#f85149', font: '13px ui-monospace, monospace' } },
      `lib/client.js is missing exports the demo needs: ${missingExports.join(', ')}. Run \`pnpm run build\`.`))
  } else {
    root.render(h(Demo))
  }
})()
