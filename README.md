<img src="docs/assets/icon.svg" width="112" alt="Orderzx custom Chrome icon" align="right">

# Orderzx

![Orderzx — our custom Chrome: live frames, ghost cursor, stealth shield, one wordmark](docs/assets/banner.svg)

**A live, stealth-capable, autonomous Chrome inside your DeepSeek Harness conversation** — the `dsh-browser` plugin.

[![ci](https://img.shields.io/github/actions/workflow/status/canelaslorenzoenego-ai/Orderzx/ci.yml?branch=main&style=flat-square&label=build)](https://github.com/canelaslorenzoenego-ai/Orderzx/actions)
[![smoke tests](https://img.shields.io/badge/smoke_tests-615%2F615_%E2%9C%93-238636?style=flat-square)](#verified-end-to-end)
[![release](https://img.shields.io/github/v/release/canelaslorenzoenego-ai/Orderzx?include_prereleases&style=flat-square)](https://github.com/canelaslorenzoenego-ai/Orderzx/releases)
[![license](https://img.shields.io/badge/license-MIT-57606a?style=flat-square)](#license)

The agent drives a real browser with humanized input. You watch every click,
scroll and keystroke live in a docked dashboard — and you can grab the mouse
anytime. CAPTCHAs pause the agent and hand the widget to **you**, in-session,
with your own fingerprint and IP: the one solve that always works.

**Zero cloud. Zero accounts.** Everything runs on `127.0.0.1`.

**Ready to install — one command:**

```bash
curl -fsSL https://github.com/canelaslorenzoenego-ai/Orderzx/releases/download/v0.2.0-rc.24/install.sh | bash
```

It clones to `~/.orderzx/dsh-browser`, installs, builds, and prints the exact
line to add `dsh-browser` to your harness plugin list. Details: [Install](#install).

![The boot sequence: capsule pops on the chatbar, the dashboard extends, the live stream paints, and the agent's gestures animate over the frames](docs/assets/boot-sequence.svg)

```
you:  "book me a table at X"
   chatbar   🖥 ▸ starting browser…            ← capsule monitor animation
   dashboard extends ────────────────────────────────────────┐
   │ Home │ shopper │ researcher      [screenshot ▾] [×]     │ ← tab per sub-agent
   │  ◀ ▶ ⟳  https://restaurant.example                      │
   │     live frames + the agent's ghost cursor clicking      │
   │  ▸ timeline (every action, newest first)                 │
   │  [ Take over ]   1366×768 · humanized                    │ ← your mouse, on request
   └──────────────────────────────────────────────────────────┘
```

---

## See it think

- **Live stream you can grab** — on-demand screenshots by default, CDP
  screencast by flag, DOM fallback when capture is blocked. Takeover swaps the
  ghost cursor for an amber "you" hand; gestures stay actor-tagged forever.
- **Gesture captions** — a chip on the stream narrates intent in words:
  `click "Sign in"`, `scroll down 480px`, `you · type 12 chars`.
- **Ask for the video, get the video** — `browser_clip` samples real frames and
  delivers them to the session *and* hands the model a `chatLine` it pastes
  verbatim into chat. Replays draw the model's hand back over the frames.
- **`browser_reel`** — one call → one standalone HTML artifact: frames +
  gesture track + scrubber, zero dependencies, signed URL, sandbox CSP.
- **Video-aware boost** — a playing `<video>` tightens the stream to ~3 fps so
  motion reads as motion; `browser_transcript` reads what a video *says*.
- **Extend-only dashboard, hardened** — the dock lease now pushes the
  DEEPEST viewport-covering shell (fixed/100vw harness layouts included)
  with an `!important` sheet plus a MutationObserver watchdog that heals
  harness re-render wipes; the Android harness dashboard lost its modal
  overlay fallback entirely (phone split at every width).
- **See the model act** — every gesture repaints the stream immediately and
  opens a 4 s burst window at the 200 ms poll floor; sub-agent activity
  counts as activity, so auto-follow no longer folds mid-search;
  a vendor challenge auto-focuses its session the moment it is detected.
- **Every browser at once** — when sub-agents spawn their own sessions the side
  dashboard becomes a tile grid: one live tile per browser (stream, fps, url,
  challenge dot), tap a tile to focus it with the full control card, ▦ returns
  to the grid. The whole surface wears the DeepSeek harness design tokens —
  frosted glass cards, mist gradient, slate type, `#4d6bfe` accent.

## `/start` — one command to launch

Type **`/start`** (optionally `/start https://example.com`) in the composer.
The command starts the browser immediately: the chatbar capsule pops its
monitor boot animation, the dashboard extends to the right, and the live view
connects — the whole boot sequence plays by itself, with no clarifying
questions and no model-side peeks at the page (the panel is already showing
it). Refusals come back as one quoted line.

**Sub-agents each get their own browser.** Every `browser_start` opens an
independent session (up to 4 concurrent, LRU-evicted when idle). A session
sees, drives and closes only its OWN tabs: on an attached CDP browser your
personal tabs — and other agents' tabs — are never hijacked, listed, or
closable, and popups stay owned by the session that opened them. Stopping one
agent's session never disturbs another's.

## What it does

- **27 tools** — observe/act/type/press/scroll/navigate/tabs/extract, forms,
  evaluations behind a policy gate, workflows (record a human demo → replay),
  background jobs with live progress, cookies (metadata only), fenced files.
- **Stealth that reports honestly** — Patchright by default (suppressed CDP
  tells), CloakBrowser fork optional, humanized input, per-session fingerprints.
  The posture endpoint says what the engine *actually* does.
- **CAPTCHA = handoff, not solving** — challenge detected → agent pauses →
  widget renders in your session → you solve → agent resumes with context.
- **Self-heal** — refs killed by a reload re-resolve from element identity;
  coordinates are the last resort, never the first.
- **Workflows & jobs** — record your mouse, replay it humanized; password-shaped
  fields become required `{{variables}}`, so secrets never touch disk.

## Android phone

`dsh-android` ships the same dashboard over ADB/WireGuard: the phone renders
frames and gestures from your desktop session. Watch-only by design.

## Compatibility contract

Built to survive any dsh-web / Cordis generation, past or future:

- **Structural, not nominal** — type-checks against both `cordis` and
  `@deepseek-ai/cordis`; optional services (approval, vision) are feature-detected
  via `ctx.inject([...])`, never required.
- **Additive-only wire changes** — fields appear, never disappear or retype.
  Readers ignore unknown fields, so old payloads always parse in new builds.
- **Versioned protocol** — `status.compat` carries `{protocol, plugin, guarantees}`.
  A newer harness degrades the panel to a visible banner, never a blank screen.
- **Three surfaces only** — `mountRoutes`, `ctx.effect` tool registration and the
  signed-route fence: the contract the harness has never had to change.
- **Node ≥ 20**, no native deps, no pinned harness version.

Enforced by smoke steps that feed the suites yesterday's manifests, tomorrow's
unknown fields and mismatched protocol numbers.

## DeepSeek Harness — native extend track

On the real [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
dashboard the panel doesn't lease margins at all: it extends the layout as a
first-class grid track.

- `harness/deepseek-harness-dashboard.patch` modifies the harness's own
  `packages/client/ui-layout` (AppFrame + columns): a 4th **external** track
  the plugin feeds via the `--dsh-external-side-track` CSS variable +
  `dsh-external-side-track` window event, clamped to the viewport (narrow
  floors keep phones honest: a real ≥140 px track, never an overlay), with the
  granted width published back (`--dsh-external-side-track-granted`) so the
  panel sizes to exactly what the frame reserved.
- `node scripts/patch-harness-dashboard.mjs --web-target <checkout>` applies it
  (idempotent; also patches a dsh-android checkout when one is found).
- The client feature-detects the patched frame (`data-dsh-external-track`) and
  uses the native channel; unpatched harnesses fall back to the rc.20 margin
  lease — same extend guarantee, two mechanisms.

## Verified end-to-end

**706 checks, all runnable from this checkout:**

| suite | checks | proves |
|---|---|---|
| tools | 207 | every tool against an emulated engine, refusals, scoring |
| routes | 85 | fence-before-capability, token scopes, capture containment, compat, mid-stream teardown |
| frames | 72 | transports, tiers, suppression, boost cadence |
| panel | 246 | the real client bundle SSR'd: capsule, overlay, drawers, players |
| mcp | 18 | the bridge over a real spawned child's stdio, hostile JSON-RPC |
| mount | 8 | the REAL harness path: cordis loader + include + cordis.yml entry mounts us, tools and both skills (`/browser-automation`, `/start`) land, dispose unregisters |
| live | 31 | real Chromium over CDP: start → stream → click → heal → clips → reels |
| dock-hostile | 24 | hostile harness shell (fixed + 100vw) with a 700 ms lease wiper: extend at 1280/390, heal, × release, plus a patched-harness native external track (granted-width sizing, no margin lease) |
| e2e | 15 | real host + real routes + real bundle, end to end |
| dispatch | 123 | every tool through the real dispatch path: schemas honest, refusals typed |
| workflow | 23 | record → secrets → replay → background jobs on a real browser |
| tools-live | 20 | files fence + upload/download, tabs, desktop_view, transcript, screencast — real browser |
| challenge-live | 13 | live DOM detection, adapter solve with page-effect proof, handoff, domain gates |
| stream-teardown | 10 | an open frame stream terminates cleanly when its session dies |
| subagent-live | 9 | concurrent sessions isolated: own tabs only, popup ownership, independent stop |

```bash
pnpm test                    # 573 static assertions, no browser needed
node scripts/dev-host-mount-smoke.mjs   # 8: real cordis loader mount
pnpm run test:live           # 31 against a real Chrome (opt-in)
pnpm run test:e2e            # 15: host + routes + client bundle + Chrome
pnpm run test:dispatch       # 123 dispatch-path schema/refusal checks
pnpm run test:workflow       # 23 record/replay/job steps
pnpm run test:tools-live     # 20 files/tabs/desktop_view/transcript/screencast
pnpm run test:challenge-live # 13 challenge pipeline steps
pnpm run test:stream-teardown # 10 mid-stream teardown steps
pnpm run test:subagent-live  # 9 multi-session isolation steps
```

## Install

```bash
curl -fsSL https://github.com/canelaslorenzoenego-ai/Orderzx/releases/download/v0.2.0-rc.24/install.sh | bash
```

Prefer source? Clone and `pnpm install && pnpm run build`, then wire the built
entry into your harness. The script above does exactly this into
`~/.orderzx/dsh-browser` and prints the exact YAML for you.
Release assets: `install.sh` + a sample replay reel.

**Wire it in** — the harness loader (`@deepseek-ai/cordis-plugin-loader` +
`cordis-plugin-include`) reads `cordis.yml` as a **bare list of entries**; each
entry imports its `name` as a module specifier. Mount **both sides** — the node
plugin (tools, engine, routes) and the client bundle (capsule, cards,
dashboard):

```yaml
# node profile
- id: dsh-browser
  name: file:///home/you/.orderzx/dsh-browser/lib/index.js
  config:
    engine:
      provider: patchright

# web/client profile — the dsh.client.inject manifest in package.json lists
# the host packages dsh-web injects alongside the bundle (react, dsh-client-*)
- id: dsh-browser-client
  name: '@dsh-community/dsh-browser/client'
```

Not `plugins: [- path: …]` — the loader has no `path` key and no wrapper; a
wrong-shaped entry silently never mounts. `playwright-core` is a runtime
dependency (every provider needs it, CDP attach included); `patchright` — the
default stealth engine — is an optional dependency, and the posture endpoint
reports which driver is actually live. Config keys:
[Configuration](#configuration).

| Symptom | Cause | Fix |
|---|---|---|
| No capsule at all | client bundle not mounted | mount the `dsh-browser-client` entry above; check the DSH devtools console for `dsh-browser-client` and that the `dsh.client.inject` packages resolved |
| Capsule sits at `spinning-up` | no engine available | `npm i patchright` **in the profile directory**, or set `engine.provider: cdp` + `engine.cdpEndpoint` and launch Chrome yourself with `--remote-debugging-port=9222` |
| Capsule fine, panel never opens | another plugin owns the dock | the panel auto-falls back to an overlay — if even that is missing, check `browser_status` in the conversation for the phase it is stuck on |
| `/panel` route answers 501 | standalone bundle not built | run `npm run build:standalone` in the checkout (works on Node ≥ 20) |

## Configuration

Everything is YAML with defaults; nothing security-relevant is a tool argument.

| key | default | meaning |
|---|---|---|
| `engine.provider` | `patchright` | `patchright` · `cloakbrowser` · `cdp` (attach your own) |
| `engine.humanize` | `true` | bezier pointers, jittered keys, honest posture |
| `frames.source` | `screenshot` | `screenshot` · `screencast` · `dom` |
| `frames.maxFps` | `5` | capture cadence = detection surface; boost tightens only for playing video |
| `policy.approvalForSensitiveActions` | `true` | harness approval prompts for sensitive verbs |
| `policy.allowEvaluate` | `false` | arbitrary page JS is a config gate, not a model right |

## Security posture

- Loopback-only routes, origin-fenced, capability tokens with TTLs and scopes.
- Captures and reels are `0o600`; cookie **values** never leave the browser;
  typed text never reaches the timeline; reels serve behind `default-src 'none'`.
- Takeover is monotonic-guarded; tools refuse with `pointer-owned` while you drive.
- No telemetry, no phone-home, no accounts — audit the whole surface in `src/routes.ts`.

## Demo & development

```bash
pnpm run demo          # standalone HTML dashboard, no Chrome required
pnpm run build         # server + client + standalone artifact
pnpm test              # static suites
```

Smoke suites import the compiled `lib/` — build first. Live suites need a
`--remote-debugging-port=9222` Chrome or use the bundled fixture.

## Credits & license

Patterns borrowed with gratitude from `dsh-android`, browser-use, Stagehand and
Patchright research. MIT — see [LICENSE](LICENSE).

## Dual use — read this

Autonomous browsing can violate site terms and local law. This plugin defaults
to handoff-over-solving, metadata-over-values and honesty-over-stealth for a
reason: run it on systems you own, against sites that allow automation.
