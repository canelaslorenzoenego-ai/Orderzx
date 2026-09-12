![Orderzx — an autonomous, stealth-first browser for DeepSeek Harness: the wordmark over a dark neon grid beside an animated panel mock with session tabs, a live page stream and the agent's ghost cursor](docs/assets/orderzx-banner.svg)

**Release:** [v0.1.0-rc.1](https://github.com/canelaslorenzoenego-ai/Orderzx/releases/tag/v0.1.0-rc.1) · **Showcase site:** [`site/index.html`](site/index.html) (single self-contained file — open it anywhere)

# Orderzx

**A live, stealth-capable, autonomous Chrome inside your DeepSeek Harness conversation** — the `dsh-browser` plugin.

The agent drives a real browser with humanized input; you watch every click,
swipe and keystroke happen in a docked dashboard panel, and you can grab the
mouse at any moment. When a site throws a CAPTCHA that automation shouldn't
solve, the agent pauses and hands the widget to **you** — in-session, with your
own fingerprint and IP, which is the one solve method that always works.

![The boot sequence: capsule pops on the chatbar, the dashboard extends, the live stream paints, and the agent's gestures animate over the frames](docs/assets/boot-sequence.svg)

*The whole flow, animated: capsule pop → dashboard extend → boot phases → live
stream → ghost-cursor gestures → a CAPTCHA handoff. Timings are the real ones
from the shipped code (320 ms pop, 420 ms `AUTO_OPEN_DELAY_MS`, 180 ms slide-in).*

The boot sequence is one continuous motion: the **capsule pops** on the chatbar
→ the **dashboard extends** → boot phases play inside the panel → the **live
stream** paints → gesture animations (cursor path, click ripples, focus rings,
scroll arrows, swipe trails, typing counters) run over the frames in real time.

```
you:  "book me a table at X"
        ┌──────────── chatbar ────────────┐
        │  🖥 ▸ starting browser…          │   ← capsule: monitor animation
        └─────────────────────────────────┘
        ┌──────────── dashboard extends ─────────────┐
        │  Home │ shopper │ researcher    [screenshot ▾] [×] │  ← one tab per sub-agent browser
        │  ┌──────────────────────────────────────┐  │
        │  │  ◀ ▶ ⟳  https://restaurant.example   │  │  ← real frame stream
        │  │     (the page, live — and you can    │  │
        │  │      see the agent's ghost cursor    │  │
        │  │      move, click, type, swipe)       │  │
        │  └──────────────────────────────────────┘  │
        │  ▸ timeline (every action, newest first)   │
        │  [ Take over ]   1366×768 · humanized      │  ← your mouse, on request
        └────────────────────────────────────────────┘
```

---

## What it is

- **22 model-facing tools** — `browser_start/stop/status`, `browser_observe`,
  **`browser_see`** (set-of-marks screenshots — the model's eyes),
  **`browser_desktop_view`** (Chrome-for-Android "Request desktop site", for the
  agent too), `browser_act` (deterministic natural-language actions with a
  confidence gate), `browser_click/type/press/scroll/navigate/tabs/fill_form/extract/wait`,
  `browser_evaluate` (config-gated), `browser_challenge`, `browser_handoff`,
  **`browser_cookies`**, `browser_takeover`, `browser_task` (stubbed pending `ctx.jobs`).
- **Self-healing refs** — when a page re-renders and a ref dies mid-task,
  `browser_click`/`browser_type` re-snapshot once and look for the element's
  identity (role + accessible name) in the fresh tree. Exactly one match → the
  action continues on the new ref and the result says `healedFrom`; zero or
  several → it fails loudly with "observe again" instead of guessing between
  "Delete" and "Cancel". Every heal is announced on the timeline, never silent.
- **Cookies without the credential leak** — `browser_cookies` lists cookie
  **metadata** (name, domain, flags, expiry) so the model can check whether a
  login persisted or which trackers a site planted; values are stripped at the
  engine boundary and can never reach a transcript. Clearing requires an
  explicit domain — there is no wipe-everything mode.
- **Eyes the model can point at** — `browser_see` returns the screenshot with
  every interactive element **numbered on it** (set-of-marks, the technique
  behind vision-first agents) plus a `mark → ref → box` table. `browser_click`
  and `browser_type` accept `mark: 7` as an alias. Marks die exactly when refs
  die — on navigation — so a stale mark can never silently click something new.
  On a text-only model it degrades to the table alone, which is still a
  visibility-filtered element list.
- **Sub-agent browsers** — label a session at launch
  (`browser_start({ label: "researcher" })`); every tool's `session` param
  accepts the label. One custom tab per browser in the panel — origin-avatar,
  live-phase pulse, desktop-view badge, and an × that closes just that browser
  (`stop-browser`, drive scope) — independent pointer ownership each, parallel
  by design.
- **See the model's hands** — a gesture channel (SSE) animates the agent's
  pointer path, click ripples, target outlines, scroll arrows, swipes and
  keystroke counts over the live frames. When `browser_see` runs, the numbered
  overlay flashes on the stream too: you see precisely what the model saw.
- **Not just the chat panel** — `GET /_dsh/dsh-browser/panel` serves the whole
  dashboard as a **standalone page** for any browser on the loopback fence: a
  second desktop profile, a wall screen, or **your Android phone via
  `adb reverse`** (see below). Same components, same tokens, no DSH web required.
- **Desktop view, done properly** — the panel toggle (and `browser_desktop_view`)
  mirrors Chrome-for-Android's "Desktop site" in all three places sites check:
  UA string, **UA client hints** (`sec-ch-ua-mobile: ?0`, full brand list,
  Windows platform — headers, JS API and UA never contradict each other), and
  touch emulation (dropped on touch-capable devices, restored on clear). It
  applies to **every tab** of the session, syncs tabs opened afterwards, and
  **reloads the active tab** — because the UA is a request header, and without a
  new request the server keeps serving the mobile HTML it already chose.
- **Tiered frame transport** — on-demand JPEG screenshots by default (lowest
  detection surface), CDP screencast behind a flag, DOM-tier synthetic SVG for
  text-only hosts. The panel switches tiers live.
- **Engine seam** — [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-node)
  by default (drop-in Playwright fork, real Chrome via `channel: 'chrome'`),
  [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) as an alternative
  provider, or attach to your own already-running Chrome over CDP (including a
  real Chrome on Android).
- **Four-tier challenge pipeline** — prevention → detection/classification →
  free & local (proof-of-work self-solve, extension adapters) → licensed solver
  API (opt-in, per-domain allowlist + one-shot approval, audited) → **human
  handoff in the panel as the default terminal tier**.
- **Humanized input** — Bézier pointer paths with overshoot-and-correct, dwell
  before press, realistic keystroke timing distributions, decelerating scroll.
  The model's clicks look like clicks.
- **Panel start page + timeline** — first open lands on a home tab (launch a
  browser yourself, jump into running ones); a timeline drawer lists every
  action with its outcome — a session recorder at the honest scale.
- **Capability-tokened routes** — every stream/capture/control request carries
  an HMAC capability scoped to one session and one permission (`view` vs
  `drive`), fenced behind loopback + Fetch-Metadata checks.

## Android phone: the full dashboard in your pocket

Two supported setups, no LAN exposure either way:

1. **DSH web on the phone** — the panel detects narrow viewports and switches
   to a full-screen overlay layout: edge-to-edge stream, bigger tab targets,
   thumb-reachable takeover controls. The **desktop-view toggle** turns the
   phone into a window onto a desktop-class browser (see above for what it
   actually changes under the hood).
2. **Standalone panel via `adb reverse`** — with the host running on your
   machine:

   ```sh
   adb reverse tcp:PORT tcp:PORT     # PORT = whatever your DSH web server listens on
   # then, in Chrome ON THE PHONE:
   #   http://localhost:PORT/_dsh/dsh-browser/panel
   ```

   (Find PORT in the host's startup log; DSH's dev web server prints it. The
   route is mounted under the plugin prefix `/_dsh/dsh-browser`.)

   `adb reverse` makes the host's loopback the phone's loopback, so the
   transport fence (loopback-only, by design) is satisfied without ever
   exposing a port to the network. The page is a single self-contained HTML
   file (`pnpm run build:standalone` → `lib/standalone.html`) that mounts the
   exact same panel components.

![The narrow phone layout: full-screen panel with touch-sized tabs, a desktop-view site streaming inside, tap ripple and focus outline from the agent, and the turnstile handoff banner waiting for a human](docs/assets/panel-phone-narrow.png)

*Narrow layout with desktop view ON: the phone shows a 1366×768 desktop site
while the agent works it — and when a CAPTCHA appears, the amber handoff
banner pauses everything until you tap **solved**.*

## The boot sequence

1. **Capsule** — a small CRT-monitor animation appears above the composer
   (`spinning-up → warming → hardening → connecting`), driven by real host
   phases, never a fake timer.
2. **Extend** — when the browser exists, the dashboard extends: the panel docks
   as a right-hand column and pushes the conversation over (it leases the
   margin and restores exactly what it found; if another plugin owns the dock,
   it falls back to an overlay). On a phone it slides over full-screen.
3. **Live** — the frame stream paints. The capsule hides; the panel shows frame
   tier, fps, suppression state, and who owns the pointer.

## Try it in DSH web — exactly what happens

1. **Install** (DSH ≥ `0.1.5-rc.2`, Node ≥ 24.11):

   ```sh
   dsh install @dsh-community/dsh-browser
   npm i patchright && npx patchright install chrome   # in your profile dir
   ```

2. **Ask the agent for anything browser-shaped** — "open amazon and find…",
   "check my flight status". The model calls `browser_start`.
3. **Watch the chatbar**: a small CRT-monitor capsule **pops** above the
   composer and animates through the real boot phases (`spinning-up →
   warming → hardening → connecting`) — it is driven by host phase events,
   never a fake timer.
4. **~0.4 s after the capsule pops, the dashboard extends**: the panel docks
   as a right-hand column (conversation slides over) or covers the screen on a
   phone. Boot continues inside the panel.
5. **The live browser appears**: real JPEG frames at 3–5 fps. When the model
   acts, you see its ghost cursor travel the Bézier path, the click ripple,
   the focus ring, scroll arrows, swipe trails, and a keystroke counter while
   it types. When it calls `browser_see`, the numbered set-of-marks overlay
   flashes on the stream — you see exactly what the model saw.
6. **Grab the mouse any time**: *Take over* pauses the agent (its tools return
   typed `pointer-owned` refusals — no fighting over one cursor); *Resume*
   hands it back. A CAPTCHA flips this around: the agent pauses and the panel
   asks **you** to solve it.

![The docked dashboard on desktop: one custom tab per sub-agent browser, the action timeline, the live page with the agent's click ripple mid-action, and Take over in the footer](docs/assets/panel-desktop-dark.png)

*Illustrative render of the docked layout — every component in it is real
shipped code; run `node demo/server.mjs` to drive the actual ones.*

If the dashboard does not extend, it is one of three things, in order of
likelihood:

| Symptom | Cause | Fix |
|---|---|---|
| No capsule at all | client bundle not mounted | check the DSH devtools console for `dsh-browser-client`; confirm the plugin's `dsh.client.inject` packages resolved |
| Capsule sits at `spinning-up` | no engine available | `npm i patchright` **in the profile directory**, or set `engine.provider: cdp` + `engine.cdpEndpoint` and launch Chrome yourself with `--remote-debugging-port=9222` |
| Capsule fine, panel never opens | another plugin owns the dock | the panel auto-falls back to an overlay — if even that is missing, check `browser_status` in the conversation for the phase it is stuck on |

## Verified end-to-end

Three layers of evidence, all runnable from this checkout:

- **422 static assertions** (`pnpm test`, no browser): tools, routes over real
  HTTP, frame transport, engine emulation, and the client bundle SSR'd in Node.
- **17 live assertions** (`pnpm run test:live`, real Chrome): start → streaming
  → frames → observe → ref click on a real DOM → signed stream/capture routes →
  takeover refusals → dispose.
- **15 e2e assertions** (`pnpm run test:e2e`, real Chrome): the exact DSH-web
  chain — real host + real signed routes + **the real client bundle's** wire
  functions, capsule poller, `autoOpenDecision` (the dashboard-extend trigger),
  and boot state machine, through to real JPEG frame bytes on the stream and a
  real tool click arriving as a gesture record on the interactions SSE, with
  the real panel components rendered against the real host status.

All three run green against system Chromium over CDP in a headless CI
container — `DSH_BROWSER_LIVE_PROVIDER=cdp DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222`
— so the attach path (including Chrome on Android) is a first-class, tested
engine: real aria-snapshot refs, real `boxOf`, real CDP screencast.

## Takeover & handoff

- **Takeover** (you → agent): click *Take over*; the host pauses agent input,
  re-mints your token with `drive` scope, the agent's ghost pointer hides (that
  cursor is yours now), and every model-facing tool returns a typed
  `pointer-owned` refusal until you resume. No queueing, no fighting over one
  mouse.
- **Handoff** (agent → you): `browser_handoff` blocks the agent, suppresses the
  persistent frame transport, focuses the challenge widget, and waits for you
  to report *solved / failed / skip*. The agent resumes from the exact DOM
  state. This is Cloudflare's "Human in the Loop" pattern, in-conversation.

## How it compares

| | Orderzx / dsh-browser | browser-use | Stagehand | Skyvern | Playwright MCP |
|---|---|---|---|---|---|
| Perception | a11y refs **+ set-of-marks vision** | DOM/a11y | DOM/a11y | vision-first | a11y |
| Live UI for the user | **streamed panel + gesture overlays** | cloud view | — | cloud view | — |
| Human takes the mouse | **yes, in-panel, token-scoped** | HITL prompts | — | — | — |
| CAPTCHA | **4-tier pipeline → human handoff default** | 3rd-party | 3rd-party | solver service | — |
| Anti-detection | **Patchright/CloakBrowser engine seam, honest posture reporting** | — | — | — | — |
| Multi-browser sub-agents | **yes, labelled sessions, per-tab UI** | parallel agents | — | — | — |
| Runs inside | DeepSeek Harness conversations | anywhere (Python) | anywhere (TS/Py) | cloud | MCP clients |

`00-RESEARCH.md` is the full brief behind these choices, including the 2026
stealth-benchmark landscape (and why the benchmarks disagree) and a gap table
vs. the tools above.

## Install

Requires DeepSeek Harness `0.1.5-rc.2`, Node ≥ 24.11, pnpm.

```sh
dsh install @dsh-community/dsh-browser     # or add to your bundle
```

Optional engines (lazy-loaded; nothing downloads until configured):

```sh
npm i patchright            # default engine
npx patchright install chrome
```

## Configuration

Everything ships safe-by-default; see `src/config.ts` for the full Cordis
schema. The parts worth knowing:

```yaml
dsh-browser:
  engine:
    provider: patchright        # patchright | cloakbrowser | cdp
    channel: chrome             # real Chrome, not bundled Chromium
    humanize: true
    proxy: null                 # e.g. http://user:pass@host:port
  frames:
    source: screenshot          # screenshot | screencast | dom
    maxFps: 5
    suppressOnChallenge: true   # stop persistent capture during handoff
  policy:
    allowEvaluate: false        # browser_evaluate is off until you say so
    approvalForSensitiveActions: true   # pay/publish/delete/send → one-shot prompt
  challenge:
    solverApi: null             # tier 3 stays off until you supply a key
    allowDomains: []            # ...and even then, only these domains
```

## Security posture

- Credentials (proxy auth, solver API keys) live in host config and are **never**
  accepted as tool arguments, never echoed in results, never logged.
- `browser_type` with `secret: true` redacts the text from every result.
- Capture paths are contained to the cache directory (symlink-refusing walk +
  realpath check); SSRF policy fences `browser_navigate`.
- Sensitive actions fail **closed** when the host has no approval service.
- Tokens are HMAC-signed, ≤ 10-minute TTL, kind-scoped (a stream token cannot
  drive; a capture token cannot read status). The standalone panel page is
  fence-only HTML with no secrets — its capabilities still come from the
  origin-fenced `/grant` like everything else.
- Desktop view never re-fingerprints mid-challenge: the toggle is refused while
  a handoff is pending, because mutating the environment during a bot probe is
  exactly what the probe scores.

## Demo (no Chrome required)

`demo/` is a self-contained harness that renders the **real shipped components**
from `lib/client.js` against a scripted transport — the full sequence: capsule
pop → dashboard extend → home tab → session tab → ghost-cursor gestures →
typing → scroll → swipe → turnstile handoff (press *solved*) → a second
"researcher" tab. Phone and desktop-view toggles included.

```sh
node demo/server.mjs        # → http://localhost:8123
```

## Development

```sh
pnpm install
pnpm run build              # host (tsc) + client (tsdown → lib/client.js) + standalone (→ lib/standalone.html)
pnpm run build:standalone   # just the standalone panel page
pnpm run typecheck
pnpm test                   # 4 static smoke suites, 422 assertions, no browser needed
pnpm run test:live          # 17 assertions against a real Chrome (opt-in)
pnpm run test:e2e           # 15 assertions: real host + real routes + real client bundle
```

The live and e2e suites accept `DSH_BROWSER_LIVE_PROVIDER=cdp` +
`DSH_BROWSER_LIVE_CDP=http://127.0.0.1:9222` to attach to any running
Chrome/Chromium instead of launching one — that is how CI (and an Android
phone over adb) runs them.

The smoke suites import the **compiled** `lib/*.js` and cover: tool refusals,
JSON losslessness, approval gating, the set-of-marks pipeline and mark-alias
lifecycle (`dev-tools-smoke`); the capability fence, scope separation, path
containment and the standalone panel route over real HTTP
(`dev-routes-static-smoke`); frame tiers/suppression/multipart wiring and the
desktop-view emulation including UA client hints and touch handling
(`dev-frame-static-smoke`); and the client bundle SSR'd in Node — boot state
machine, dock geometry, pointer normalization, wire helpers, cards, and the
host↔client `presentationMeta` twin-sync that keeps Code-mode (PTC) cards
identical to standard ones (`dev-panel-smoke`).

## Credits

Patterns for the boot capsule, docked panel host, capability tokens, and
multipart frame transport follow [dsh-android](https://github.com/ZSeven-W/dsh-android)
by ZSeven-W. Engine work stands on
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-node) and
[CloakBrowser](https://github.com/CloakHQ/CloakBrowser). The set-of-marks
technique follows Yang et al. (2023); the human-in-the-loop and live-view
patterns match what Cloudflare Browser Rendering shipped in 2026.

## License

MIT — see [LICENSE](./LICENSE). Security policy: [SECURITY.md](./SECURITY.md).

## Dual use — read this

Stealth and CAPTCHA tooling is dual-use. This plugin is built for **sites you
own or are authorised to test**, and for the legitimate case the CAPTCHA
industry itself endorses: a real human solving a real challenge in a real
session. The licensed-solver tier ships off, requires your own API key, a
per-domain allowlist, and an interactive approval per domain, and writes an
audit record for every attempt. `browser_evaluate` — the one tool that could
tamper with page security — is config-gated off by default. Don't point this at
sites that don't want you; they'll know, and so will we.
