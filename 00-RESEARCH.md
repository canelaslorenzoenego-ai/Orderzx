# Research: what to copy, and from where

Verified against real sources on 2026-09-12. dsh-android cloned to `/home/user/research/dsh-android` (branch `main`, 98 files, ~19.3k LOC).

---

## 1. The DSH plugin contract (verified from dsh-android `package.json` + source)

### `package.json` — three things matter

```jsonc
{
  "name": "@you/dsh-browser",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".":        { "types": "./lib/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },        // ← makes it a profile layer
    "client": {                                          // ← browser-side contribution
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-tool",
        "@deepseek-ai/dsh-client-ui-theme"
      ],
      "platform": "web"
    }
  }
}
```

Notes from dsh-android:
- Host packages are **devDependencies only**, pinned to the exact harness version (`0.1.5-rc.1`). They are deliberately absent from `dependencies`/`peerDependencies` — the host provides them.
- `dshHostRuntime` block is **inert documentation** (declares required/optional services: `tools` required; `skills`, `webServer`, `attachments`, `llm` optional).
- Client build = `tsc` for types + `tsdown` → **CJS**, `platform: browser`, `target: es2022`, then a `scripts/build-client.mjs` step that emits `lib/client.js`.
- `engines.node >= 24.11.0`.

### `cordis.patch.yml` — one row

```yaml
- insert:
    - id: dsh-browser
      name: '@you/dsh-browser'
```

### Host entry (`src/index.ts`)

```ts
export const name = 'dsh-browser'
export const inject = ['tools']

export function apply(ctx: Context): () => Promise<void> {
  // 1. own the long-lived resource
  const host = new BrowserHostController()
  // 2. register every tool through ctx.effect so unload unregisters it
  disposers.push(ctx.effect(() => ctx.tools.register(tools.browserStart), 'dsh-browser:browser_start'))
  // 3. mount signed HTTP routes on the OPTIONAL webServer service
  installStreamRoutes(ctx, host)   // ctx.inject(['webServer'], webCtx => webCtx.effect(...))
  // 4. return the teardown
  return async () => { for (const d of disposers.reverse()) await d(); await host.dispose() }
}
```

Key discipline: **headless profiles have no `webServer`** → routes must be optional-injected, and all tools must still work without a UI.

### Tool shape (`docs/cookbook/adding-a-tool.md`)

```ts
ctx.tools.register(defineTool({
  name: 'browser_click',
  description: '…what the MODEL sees…',
  parameters: { ref: { type: 'string', required: true, description: '…' } },
  output: {
    schema: { type: 'object', … },                 // ONE canonical JSON value
    render: (args, value) => [{ type: 'text', text: … }],
    presentationMeta: (args, value) => ({ … }),     // durable data the UI card replays
  },
  async execute(args, exec) { /* args already validated; honor exec.signal */ },
}))
```

Contract rules worth obeying:
- `execute` returns **only** the canonical value — never content blocks. The registry snapshots → validates → freezes → passes to `render`.
- Throw for infrastructure failure; represent a non-ideal *domain* outcome in the value.
- `exec.agent.inject({ content, source: { kind: 'plugin', plugin: 'dsh-browser' } })` appends durable context for the **next** model request (not a wake-up).
- Long-running work → `ctx.jobs.start({ kind, label, owner: exec.agent, run })`, gated behind `run_in_background`; return `{ kind: 'background', jobId }`.
- Policy is **not** yours to build: use `tools/pre-execute` (allow/deny/ask), `ctx.tools.guard()` (final deny), `tools/post-execute`, `tools/result`.
- PTC mode gets every tool for free as `await tools.browser_click(args)`.

### HTTP routes

```ts
export const PLUGIN_ROUTE_PREFIX = '/_dsh/dsh-browser'
webServer.register({ kind: 'prefix', path: `${PLUGIN_ROUTE_PREFIX}/stream`, handler })
webServer.register({ kind: 'exact',  path: `${PLUGIN_ROUTE_PREFIX}/control`, handler })
```

Security posture (copy verbatim — this is the part that gets plugins flagged):
- HMAC-SHA256 capability tokens `base64url(payload).base64url(mac)`, 32-byte per-DSH-home key at `<DSH_HOME>/cache/<plugin>/stream-access.key`, mode `0600`, created atomically (`wx`), TTL ≤ 10 min, `timingSafeEqual`.
- Transport fence applied **before** any capability check: loopback peer address, loopback `Host` (DNS-rebinding rejected), Fetch-Metadata + Origin.
- File serving: one directory only, `lstat` walk (no symlinks), `realpath` containment check.

### Vision / attachments

dsh-android `src/vision.ts` → when the host mounts the attachment store *and* the routed model declares image input, capture tools attach the screenshot **as an image block** so the model sees pixels. Text-only models get the JSON summary. This is exactly the mechanism you want for `browser_observe`.

### Skills

`registerAndroidSkill(ctx)` — registers a playbook for the *workflow between tools* (things tool descriptions can't say). Optional `skills` service; no-op when absent.

---

## 2. Client UI: the four seats you need

| What you asked for | Actual DSH mechanism | dsh-android file |
|---|---|---|
| "little monitor animation on chatbar with starting" | `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name, id: 'dsh-browser-status', order: 40 }, Capsule))` — a pill above the input box | `src/client/android-status-capsule.tsx` (352 LOC) |
| Tool cards inline | `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key: '<toolName>' }, Card))` — one per tool, each wrapped in an error boundary | `registerCard()` in `src/client/index.tsx` |
| "the deepseek harness dashboard will extend" | **There is no host-provided panel seat.** DSH 0.1.5 has no keyed per-tool details seat, so the plugin mounts its *own* page-owned right panel host into the DOM, plus a click trigger on tool rows | `src/client/android-panel-host.tsx` (756), `android-panel-trigger.ts`, `android-panel-auto-open.ts` |
| "the phone frame" → browser frame | Pure CSS/TS frame styles + size modes; panel adapts aspect from the frame's natural size | `src/client/android-panel-frame.tsx` (292), `android-frame-style.ts` |
| "the live stream" | `<img src={signedStreamUrl}>` where the server replies `multipart/x-mixed-replace`; the `img` **load event is the only liveness signal**. Phases: `granting → live → error/offline` | `src/client/android-live-frame.tsx` (192), `android-stream-session.ts` (363) |
| User taps/drags on the video | Pointer events on the frame → normalized 0..1 coords → POST to `/control` route | `android-panel.tsx` (678), `android-stream-session.ts` |
| Panel auto-opens | A settled START verb (`android_boot`) calls `panelHost.openIfIdle(source)` — `openIfIdle`, not `open`, so it never replaces a panel the user already opened | `src/client/index.tsx` |

Client apply(), distilled:

```ts
export function apply(ctx: ClientContext): void {
  registerCard(ctx, 'browser_start', BrowserStartCard, src => panelHost?.openIfIdle(src))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'dsh-browser-status', order: 40 },
    hostSyncedStatusCapsule(ctx),
  ))
  if (typeof document !== 'undefined') ctx.effect(() => {
    panelHost = mountAndroidPanelHost({ subscribeTheme, getColorScheme, subscribeLocale, getLocale })
    rowTrigger = installPanelRowTrigger(document, src => panelHost?.open(src) ?? false)
    return () => { rowTrigger?.(); panelHost?.dispose() }
  }, 'dsh-browser: panel host')
}
```

Everything is synced to host theme/locale services (`dsh-client-ui-theme`, `dsh-client-locale`) so it doesn't look bolted on.

PTC gotcha: **nested Code-mode calls carry no `presentationMeta`** (harness projects it only for top-level calls). dsh-android reconstructs the meta from the settled result's durable JSON text (`android-meta-hydrate.ts`). Budget for this.

---

## 3. The frame pipeline (why it's fast)

dsh-android's whole performance story: **one persistent child process**, not one per frame.

- One `adb exec-out sh -c 'while :; do screencap -p; done'` child runs for the session.
- Host splits the concatenated PNG stream with a self-describing chunk walker (`PngFrameSplitter`) — no marker scanning, no false positives; on desync it drops bytes to the next signature.
- Latest frame kept in memory; route serves it as `multipart/x-mixed-replace` (PNG parts render in Chromium/Firefox exactly like JPEG).
- **No inner loopback port, no proxy, nothing to adopt after an ungraceful exit.**
- Measured: ~8 fps emulator, first frame ~200 ms, tap round-trip ~130 ms. Per-frame `adb` spawn would cost 50–200 ms and cap at ~5 fps.
- Keep-alive loop restarts the child on crash; an *intentional* stop is never fought.

---

## 4. Existing browser plugins (don't duplicate — differentiate)

| Plugin | What it has | What it lacks |
|---|---|---|
| `yzd6552/dsh-browseruse` | browser-use style; dedicated Chrome + persistent profile via `playwright-core`; 13 tools incl. `browser_task` autonomous loop, `browser_schedule`, dangerous-action confirmation, **captcha → pause + screenshot + human handoff**, per-step screenshots into the conversation | No live stream, no panel, no stealth, no user mouse interaction |
| `anweat/dsh-browser` (`dsh-browser-runtime`) | Self-contained runtime; bundles Playwright **or Patchright** (`browserRuntime: patchright`), OpenCLI; 21 tools; userscript runner with SHA-256 catalog; `browser_recipe_run`; approval modes | No live stream/panel |
| `chenyuheee/dsh-browser-playwright` | **`ctx.browser` seam as a Cordis service** + provider + tool family (3 rows); a11y snapshots with stable element refs; domain allowlist; idle timeout; LRU `maxSessions`; extract via a second model route | No live stream/panel |
| `dsh-builtin-browser` | Visible browser window the human can take over, driven over CDP | — |
| `dsh-computer-use` | Background Chromium via Playwright/CDP + macOS a11y; **actions don't steal the user's pointer** | — |
| `dsh-browser-vision` | Real Chrome over CDP + `browser-use`, reads pages with a vision model, schema-validated JSON out, per-run token cost | — |

**Your gap in the market is real**: nobody has combined (a) a stealth-capable engine, (b) an in-conversation live stream, (c) a panel the *user* can grab the mouse in, and (d) a boot/status capsule. `dsh-browser-playwright`'s `ctx.browser` service seam is the right thing to *implement* so other plugins (web-search-pro etc.) can ride on yours.

---

## 5. Stealth landscape (2026) — and the conflict with your live stream

### Detection is 5 layers, and no single tool covers all of them

| Layer | Examples | Addressed by |
|---|---|---|
| 1. Automation protocol tells | `Runtime.enable`, execution contexts, ChromeDriver `cdc_` markers, CDP input characteristics | Patchright, Clearcote, Camoufox (Juggler, not CDP), SeleniumBase |
| 2. Fingerprinting | `navigator.webdriver`, canvas/WebGL, screen geometry, AudioContext, font enumeration | all of them, at varying depth |
| 3. Behavioural | mouse-motion model, click/keystroke timing, navigation patterns | Botasaurus (Bézier + Gaussian), Camoufox `humanize`, Clearcote. **Navigation patterns are your calling code's problem, not the driver's** |
| 4. Network | TLS JA3/JA4, WebRTC/UDP leak, **IP reputation, DNS leak** | Scrapling (HTTP tier), Obscura (build-gated), Camoufox/Clearcote (WebRTC). **IP reputation and DNS are solved by nobody — that's your proxy layer** |
| 5. Layout/render probes | `getBoundingClientRect`, `getComputedStyle`, canvas pixel output | any real browser; Clearcote can forward canvas to real GPU |

### Benchmarks (two independent 2026 sets — they disagree, which is itself the finding)

31 Cloudflare targets, 651 verdicts, residential IP, N=3:
`nodriver` 28 OK / **0 blocked** · `CloakBrowser` 26/2 · `curl_cffi` 26/2 · `Patchright` 25/3 · `Camoufox` 25/3 · vanilla Playwright 24/5 · rebrowser 24/5.
→ A 21-line `curl_cffi` wrapper tied a Chromium fork with 49 C++ patches. Most "blocking" is IP reputation, not browser shape.

Separate bot-detector bench: `patchright` 18/20, `cloakbrowser` 14+3 partial (only one to clear live Turnstile), `camoufox` 13/20.
Another (bypass-rate): patchright 100%, cloakbrowser/camoufox_headless 90%, nodriver-chrome 80% — but `patchright_headless` 40% and `camoufox` (headed) 30%. **Headless vs headed flips results by more than the tool choice does.**

Takeaway for your README: publish your own numbers per engine, per mode, with dates. Don't inherit anyone's claims.

### ⚠️ The conflict you have to design around

**Live streaming a browser and hiding automation are in direct tension.**

- Every frame-delivery mechanism Chromium offers is CDP: `Page.startScreencast` or repeated `Page.captureScreenshot`. Attaching CDP and calling `Runtime.enable` is *precisely* the Layer-1 tell that Patchright/rebrowser exist to avoid.
- Camoufox/`invisible_playwright` dodge Layer 1 by using Firefox's **Juggler** protocol instead of CDP — but then you have no screencast API at all, and per-frame capture is slow.
- `nodriver` scored best on Cloudflare by talking raw CDP with **no Playwright shim** — so CDP itself isn't automatically fatal; *how* you use it is.

Four ways out (this is the decision to make):

| Option | Stealth cost | Stream quality | Effort | Notes |
|---|---|---|---|---|
| **A. CDP screencast, always on** | Highest — `Page.startScreencast` + persistent CDP session is a loud tell | Best (10–25 fps, low CPU) | Low | Ship it as an explicit `stream: on/off/auto` config, default `auto` = off during challenge pages |
| **B. On-demand `captureScreenshot`** | Lower — no persistent screencast, short-lived sessions, isolated-world eval only | 2–6 fps | Low | Matches dsh-android's ~8fps feel closely enough. **Recommended default** |
| **C. Mirror the real window (no CDP for pixels)** | Zero added tell — capture at OS/compositor level | Native fps | High | Only possible in a desktop shell (Electron/Tauri/`dsh-desktop`), or via a native helper. Real "browser-use" feel. This is the differentiator if you're willing to ship a native binary like `dsh-computer-use` does (signed + notarized) |
| **D. Agent-side reconstitution** | Zero — no capture at all | Synthetic | Medium | Render a fake viewport from the a11y/DOM tree + highlight the element the model is acting on. Honest, cheap, and *not* a live stream. Good as a fallback tier |

Pragmatic answer: **B by default, A behind a flag, D as the text-only-model fallback, C on the roadmap.** And decouple: the *stream* is for the human, the *input* is for the model. Human-visible fps and detection surface are then independently tunable.

### Input simulation (this is where "the model can really interact" gets real)

- Never `element.click()` — dispatch trusted-shaped input: `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` at coordinates.
- Bézier mouse paths with jitter + easing, not linear teleport (Botasaurus's `human_curve_generator.py` is the reference implementation pattern).
- Keystrokes 60–220 ms apart with per-key variance; commit text via `Input.insertText` only for bulk paste-like fills.
- Scroll in variable increments with settle time.
- Navigation pacing and dwell time are **yours** to implement — no driver does it.

---

## 6. CAPTCHA: the honest design

Do not build a general CAPTCHA bypass. Build a **challenge pipeline** with escalating tiers, all auditable. *(Revised after the CloakBrowser / browser-use research the user asked for — findings in §6.1. As implemented in `src/challenge/`.)*

1. **Prevention** (tier 0, passive) — stealth engine + persistent profile + humanized input + optional proxy. CloakBrowser's whole pitch is that a correct fingerprint scores 0.9 on reCAPTCHA v3 and auto-passes non-interactive Turnstile without ever showing a widget. This is the cheapest solve there is: the one that never happens.
2. **Detect & classify** (tier 1, `challenge/detector.ts`) — recognise Turnstile / reCAPTCHA / hCaptcha / DataDome / PerimeterX press-and-hold / image-select, ranked by signal quality (url > headers > dom > frame). Signal it to the model as a first-class tool result (`challenge: { vendor, kind, blocking }`) rather than letting it guess from a screenshot. `vendor: 'unknown'` is a valid classification.
3. **Free / local** (tier 2, `challenge/adapters.ts`) — proof-of-work CAPTCHAs (ALTCHA, Prosopo, FriendlyCaptcha) run *in the page* and self-solve: the pipeline just waits. A browser extension adapter (ClickSolver-style checkbox clicking, or the user's own CapSolver extension) covers interactive-checkbox cases with the user's own tooling, in-session. No keys, no per-solve cost, no third party sees the traffic.
4. **Licensed solver API** (tier 3, opt-in, `token-api` adapter) — pluggable adapter for a paid solving API the user already has an account with (2Captcha/CapSolver/etc.), with hard gates: user's own key, explicit **per-domain allowlist**, a mandatory one-shot DSH approval on top of the allowlist, session-bound vendors (Turnstile/hCaptcha enterprise) excluded from token injection because the research says it fails anyway (§6.1), and an audit record per attempt.
5. **Human handoff in the panel** (tier 4, the DEFAULT TERMINAL tier, and your killer feature) — pause the agent loop (`host.beginHandoff`), suppress the persistent frame transport, highlight the challenge in the live stream, pull the panel forward, notify via the dock capsule, and let the **user solve it with their own mouse in the panel**. Then resume from the exact DOM state. `dsh-browseruse` already does a crude version of this (pause + screenshot + ask); yours is live and interactive.

Tier 3 is the only one with real abuse potential, so it ships **off** and documented as "for sites you own or are authorised to test." Tier 4 needs no such gate — a human solving a CAPTCHA with their own mouse is the legitimate case the whole ecosystem is trying to avoid, and the one Cloudflare et al. cannot argue with.

### 6.1 Findings: CloakBrowser and browser-use (the research the user asked for)

**CloakBrowser** (github.com/CloakHQ/CloakBrowser) — a stealth Chromium fork with 66–73 C++ patches, a `humanize=True` flag (Bézier mouse paths, keystroke timing, natural scroll), persistent-context and proxy support, and `launch()` / `launchContext()` / `launchPersistentContext()` APIs. Benchmarks: 26/31 Cloudflare targets OK (dev.to 2026 set, vs Patchright 25/3, nodriver 28/0, Camoufox 25/3) and a documented live-Turnstile clear (uinstinct gist). reCAPTCHA v3 score 0.9. MIT wrapper, **proprietary binary** — which is why `src/engine/cloakbrowser.ts` gates the binary download behind config instead of vendoring it.

The decisive finding: **CloakBrowser prevents CAPTCHAs; it does not solve them.** And the honest limitation (andrew.ooo review): if a site *always* triggers an interactive Turnstile or hCaptcha, you still need a solver or a human. That validates the pipeline shape — prevention is tier 0, not the answer.

**browser-use's CAPTCHA ecosystem** — browser-use itself has no built-in solver; it's an integration point:

- **CapSolver Chrome extension**: auto-solves in the user's Chrome; browser-use custom-action pattern is detect → extract sitekey → call solver API → inject token → submit.
- **GateSolver MCP** (`solve_captcha` tool): solves in a *separate* browser environment — different IP, different fingerprint.
- **Browserless CaptchaWatchdog** (browser-use ≥ 0.12.0, `integrations=browseruse`): in-session solving; BrowserQL `solve` mutation; `liveURL` as the human fallback.

**The technical finding that shapes tier 3/4** (humanbrowser.cloud, browserless.io, scrapfly.io — independently consistent): Turnstile requires clean residential IP + real fingerprint + behavioral signals **simultaneously**. A token minted by a solver service was generated in *their* environment; injecting it into yours fails on strict configurations. **In-session solving beats token injection.** Consequences, as implemented:

- The token-api adapter injects with the native value setter + input/change events (React-compatible), and must be **honest about `inSession`** in the audit record.
- Session-bound vendors are excluded from token-api default handles — for them the pipeline falls through to handoff, which is the only method that keeps IP + fingerprint + behavior in one place: the user's panel, this session.
- Proof-of-work CAPTCHAs need no service at all — they self-solve locally; the pipeline waits.

**clawdbrunner/captcha-solver** runs the same 3-layer stack (L1 CloakBrowser prevents, L2 ClickSolver clicks the checkbox free, L3 2Captcha/CapSolver ≈ $3/1000 solves, 30+ types). Their stated philosophy — "ALWAYS use fully automated solving, never ask the user" — is the exact opposite of this plugin's: **human handoff is the default terminal tier**, because it's the highest-success method on hard challenges and the only one with zero abuse surface. Automation tiers exist to avoid bothering the user, not to replace them.

**Steel** (docs.steel.dev) confirms the detection taxonomy used in `detector.ts`: DOM + iframe patterns + challenge API endpoints + visual signals, and the same prevention-first philosophy.

### Positioning / policy (put this in the README, it's also just true)

Stealth and CAPTCHA tooling is dual-use. The defensible framing — and the one that survives a security review — is:
- ✅ Testing **your own** sites and anti-bot configuration
- ✅ Authorised security research / red-team with written scope
- ✅ Accessing public data at a polite rate where no auth wall exists
- ✅ Making an agent robust against *false-positive* bot detection that blocks legitimate assistive/automated use
- ❌ Circumventing access controls on third-party services you're not authorised to test
- ❌ Defeating rate limits or per-account quotas
- ❌ Anything that violates a site's ToS in a jurisdiction where that's actionable

Ship a `policy` config: default-deny on Tier 3, mandatory approval on payment/publish/delete/auth-change actions (copy `dsh-mobile-gui-agent`'s semantic approval list), and an audit trail.

---

## 7. Environment reality check

This sandbox: Node **v20.20.2** (dsh-android wants ≥24.11), no `pnpm`, no Chrome. So:
- Cannot install/run DSH or the plugin end-to-end here.
- Can scaffold, and can typecheck if we stub the `@deepseek-ai/*` types (they're devDeps pinned to `0.1.5-rc.1`, not published for public consumption in a way we can rely on offline).
- Real verification has to happen on your machine: `dsh plugin --profile web add "link:$(pwd)"` → iterate → client changes need a page refresh, host changes need a `dsh` restart.

## 8. Gap analysis vs. the 2026 browser-agent field (and what we adopted)

Surveyed: browser-use, Stagehand, Skyvern, Playwright MCP, Cloudflare Browser Run, LivePilot, Ui.Vision, Browser MCP. What they have, what we already had, and what this pass added:

| Their capability | Where it exists | Our answer |
|---|---|---|
| Parallel agents / multiple browsers | browser-use parallel agents; Browserbase sessions at scale | **Adopted**: sub-agent `label` on `browser_start`; every tool's `session` param accepts label/id/prefix; panel renders one custom tab per browser; capsule badges the count. Pointer ownership is per-session, so two agents never share a mouse. |
| Live View — see WHAT the agent is doing, not just the page | Cloudflare Browser Run Live View (DOM/console/network + session) | **Adopted, our way**: the `/interactions` SSE channel streams every gesture (pointer path, click coordinate + target outline, scroll delta, swipe path, keystroke counts) and the panel animates it over the frames — ghost cursor, click ripples, focus outlines, scroll arrows, typing badge. |
| Step history / session recording & replay | Skyvern recordings; LivePilot session recorder + replay | **Adopted at honest scale**: per-session action timeline (bounded 60 entries, summaries only, never typed text) in the panel's timeline drawer + `status.recent`. Video recording stays roadmap — frames are already capped and recording multiplies the storage/privacy surface. |
| `act()` natural-language primitive | Stagehand act/extract/observe | **Adopted**: `browser_act` — deterministic lexical resolution against the a11y tree (verb parse + token/role/substring ranking). Confidence-gated: ties return ranked candidates instead of guessing. No second LLM call, no network. `extract`/`observe` already existed. |
| Self-healing selectors | LivePilot | Already covered differently: refs are per-snapshot and fail loudly; the playbook teaches re-observe. Silent "healing" that clicks a different element is worse than a stale-ref error. |
| Human-in-the-loop confirmations | LivePilot sensitive-action pauses; Browser Run HITL | Already had: approval seam + challenge handoff with pointer ownership. |
| Real-browser / extension approach (no launch) | Browser MCP; Ui.Vision | Already had: `engine.cdp` connects to a running Chrome. |
| File upload/download orchestration | browser-use | **Roadmap**: needs engine-level download events; deferred rather than faked. |
| WebMCP (sites declare agent actions) | Cloudflare | **Watch**: no stable spec to build against yet. |
| Custom actions registry (user-defined tools) | browser-use custom actions | **Not needed**: DSH itself is the tool registry — users add tools as sibling plugins. |

Panel/UX asks from the same pass:
- **First-open surface**: the panel now opens on the HOME custom tab (start page: launch field, recents, running-browser cards) whenever no session is resolved yet; the custom tab strip is always visible above the header.
- **Bootstrap capability**: a panel opened with zero browsers can still start one — `/grant` mints a drive-scoped bootstrap token whose ONLY accepted message is `start-browser` (view-scope allowed: launching hijacks no pointer; the origin fence is the gate).
- **Phone layout**: under 760px the panel is a full-bleed `100dvh` sheet (safe-area padded, no scrim, no resize handle, 38px touch targets); touch input on the stream gets gesture semantics — tap = click, flick = `swipe` control message replayed as a human-shaped drag — instead of raw pointer-event replay.
- **Desktop view toggle**: drive-scoped `set-desktop-view` applies a desktop UA (CDP `Emulation.setUserAgentOverride`) + 1366×768 viewport per page, refused mid-challenge (re-fingerprinting during scoring is exactly what widgets look for). Documented honestly as a fingerprint mismatch trade.
- **Capsule**: pops in (`dsh-browser-pop` scale+fade, 320ms) the moment it has something to say, and badges the live-browser count when >1.


## Sources

- github.com/ZSeven-W/dsh-android (cloned, read in full for the patterns above)
- github.com/deepseek-ai/deepseek-harness — `docs/cookbook/adding-a-tool.md`, `docs/architecture.md`, README
- github.com/kunjinkao-os/dsh-mobile-gui-agent — approval semantics, config shape, `dsh.bundle.patch` + `dsh.client` manifests
- github.com/walkinglabs/awesome-deepseek-harness-plugins · github.com/0xsline/awesome-deepseek-harness
- deepseek-harness.github.io/deepseek-harness/en/reference/
- github.com/pim97/anti-detect-browser-tools-tech-comparison (5-layer detection model, 10-tool lineage graph)
- dev.to/ianlpaterson + ianlpaterson.com — 2026 anti-detect benchmark, 31 Cloudflare targets
- github.com/techinz/browsers-benchmark · gist.github.com/uinstinct (stealth bake-off)
- scrapfly.io/blog/posts/best-stealth-browsers · humanbrowser.cloud (agent-oriented comparison)
