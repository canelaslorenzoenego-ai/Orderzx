/**
 * The plugin's bundled playbook, contributed through `ctx.skills.register()`.
 *
 * Why a skill and not longer tool descriptions: a description answers "what does
 * this argument mean", one tool at a time. What an agent re-derives every session
 * is the WORKFLOW between the tools — and this plugin has three workflow traps
 * that no individual description can carry:
 *
 *   1. Observe cost. A screenshot is ~200–400 ms and a CDP call; an a11y snapshot
 *      is ~150 ms and no capture at all. Agents that reach for pixels first
 *      triple their step count and their detection surface at the same time.
 *   2. Refs go stale. Element refs are per-snapshot. An agent that reuses `e12`
 *      after a navigation gets a typed error and often responds by retrying the
 *      same ref. Saying "observe again" once, here, fixes a whole failure class.
 *   3. What to do at a challenge. The wrong instinct is to retry the blocked
 *      action harder. The right one is to hand it to the human and WAIT. That
 *      needs to be stated as policy, not discovered.
 *
 * Registration is DEFENSIVE: a profile without the skill service still loads the
 * plugin, it just does not advertise the playbook.
 *
 * @module @dsh-community/dsh-browser/skill
 */

import type { Context } from '@deepseek-ai/cordis'

/** Kebab-case skill id, addressable as `/browser-automation`. */
export const BROWSER_SKILL_NAME = 'browser-automation'

export const BROWSER_SKILL_DESCRIPTION =
  'Drive a live Chrome inside the conversation: read the page, click, type, extract, and hand a CAPTCHA '
  + 'to the human. Read this before the first browser_* call of a web task.'

export const BROWSER_SKILL_WHEN_TO_USE =
  'Any task that operates a website through the browser_* tools — opening pages, filling forms, clicking '
  + 'through a flow, extracting structured data, or handling a bot-detection challenge.'

/**
 * The playbook body.
 *
 * Model-facing, so English like the tool descriptions, and it states costs in
 * milliseconds because the point is helping the model choose the cheap path
 * first. It also states the POLICY on challenges plainly: the model should not
 * have to infer that retrying a blocked page is useless.
 */
export const BROWSER_SKILL_CONTENT = `# Driving a browser with dsh-browser

The loop is **observe once → act → verify from the action's own result**. Do not observe after every action: \`browser_click\`, \`browser_type\` and \`browser_scroll\` each return the post-action state themselves.

## Seeing the page

| Tool | Cost | Use it for |
| --- | --- | --- |
| \`browser_observe\` | ~150 ms | **The default.** URL, title, a11y tree with element refs, plus the screenshot itself on an image-capable model. |
| \`browser_extract\` | ~200 ms + model | Structured data out of a page, validated against a schema you supply. |
| \`browser_wait\` | as told | A selector, URL, or a settle. Cheaper than re-observing in a loop. |

On an image-capable model, \`browser_observe\` and \`browser_click\` return the screenshot ITSELF as an image block — look at it instead of asking for another capture. On a text-only route the same tools return the JSON tree alone and nothing errors.

**Prefer the a11y tree over pixels.** It is cheaper, it carries element refs you can click directly, and it does not add a capture to the detection surface.

## Element refs

\`browser_observe\` assigns refs (\`e1\`, \`e2\`, …) to interactive elements. Every acting tool takes a ref:

    browser_observe()                 → button "Sign in" [ref=e7]
    browser_click({ ref: "e7" })

**Refs are per-snapshot.** After any navigation, or after a click that changes the page, the old refs are dead. A stale ref returns \`E_STALE_REF\` — do not retry it. Call \`browser_observe\` again and use the new ref. Retrying a stale ref is the single most common way an agent wastes ten steps.

## Acting

\`browser_click\`, \`browser_type\`, \`browser_scroll\` are humanized: the pointer travels a curved path, keystrokes are individually timed, scrolling decelerates. This costs ~200–600 ms per action and is not optional — it is what keeps behavioral detection quiet. Do not try to work around it with \`browser_evaluate\`; that tool is gated off by default precisely because synthetic \`element.click()\` calls are a signature.

Sensitive verbs (pay, purchase, publish, delete, send, install, change account security) trigger a one-shot approval. That is expected — do not rephrase the action to dodge it.

\`browser_act\` collapses observe-then-act into one call: \`browser_act({ instruction: 'click "Sign in"' })\`, \`'type hello into search'\`, \`'scroll down'\`, \`'open https://…'\`. It resolves against the accessibility tree lexically — no second model, no network. When the match is not confident it refuses and returns ranked \`candidates\`; pick a ref from them and call the specific tool. Prefer \`browser_act\` for obvious single gestures and the specific tools when you already hold a ref.

## The live panel and pointer ownership

A human can watch this browser live in the DSH panel, and can **take over the pointer**. While they own it, every model-facing tool returns:

    { ok: false, refused: 'pointer-owned', owner: 'user', … }

That is a normal state, not a failure. **Wait for it to clear** — do not queue actions, do not retry in a loop, do not open a second session to get around it. Ask the user, or call \`browser_status\` to see whether they are still driving.

## CAPTCHAs and bot detection

\`browser_observe\` reports a \`challenge\` field when one is detected. When you see it:

1. **Do not retry the blocked action.** Retrying a challenge page is the wrong move every time; the site has already decided to score this session, and more attempts make the score worse.
2. Call \`browser_challenge\`. It returns the vendor, whether navigation is actually blocked, and the sitekey when there is one.
3. If the verdict is \`handoff\`, call \`browser_handoff\`. That pauses you, hands the pointer to the human in the panel, and **blocks until they resolve it**. This is the intended path and the one most likely to succeed: they solve in this session, with this fingerprint and this IP.
4. Only if tier 3 is configured for this domain will a solver run automatically, and it will have required an explicit approval.

Two facts worth knowing:

- **Cloudflare Turnstile is not a puzzle with a token answer.** It scores IP reputation + JS environment + behavior together. A token minted by a remote service on someone else's browser and IP is frequently rejected even when cryptographically valid. \`browser_handoff\` beats it.
- **Proof-of-work challenges (ALTCHA, Friendly Captcha) solve themselves.** Wait rather than escalating; the pipeline already does this for you.

## Stealth is a posture, not a switch

\`browser_status\` returns \`stealth.applied\` and \`stealth.gaps\` — read them and report them honestly rather than assuming you are invisible. Three things no driver fixes:

- **IP reputation.** A datacenter IP fails challenges that a residential one passes. That is \`engine.proxy\`, a user decision.
- **Navigation pacing.** Handled for you between \`browser_navigate\` calls, but not inside a rapid click loop.
- **The frame transport.** \`screencast\` mode holds a persistent CDP session and reintroduces the tell the driver removes. It is auto-suppressed while a challenge is up. If a task is failing on a hardened site, ask the user to switch to \`frames.source: screenshot\` or \`dom\`.

## Sessions and sub-agents

\`browser_start\` launches and streams. Omit \`url\` to start blank. \`maxSessions\` LRU-evicts idle ones beyond the limit. \`browser_stop\` closes it — the persistent profile keeps cookies, so a later \`browser_start\` is still logged in.

**Several browsers can be live at once — one per sub-agent.** Name yours at launch: \`browser_start({ label: "researcher" })\`. Every tool's \`session\` parameter then accepts that label (\`browser_click({ session: "researcher", ref: "e7" })\`). Rules for multi-browser work:

- Pass \`session\` explicitly on EVERY call once more than one browser exists — the omitted default is the most recently active session, which may belong to another agent.
- A label is unique per live browser; a duplicate gets a numeric suffix (read \`label\` from the start result, do not assume).
- The panel shows one custom tab per browser; the user can watch any of them and take over its pointer independently.

## Delivering a specific video (YouTube / TikTok / Instagram)

When the user asks for a SPECIFIC video ("find <x> on TikTok and send it to me"), the deliverable is the VIDEO ITSELF in the chat — not a description, not a bare link:

1. Search on the platform: YouTube → navigate to \`https://www.youtube.com/results?search_query=<url-encoded query>\`. TikTok → \`https://www.tiktok.com/search?q=<query>\`. Instagram → search needs a logged-in profile; if a login wall or challenge appears, report it honestly and stop (never defeat access controls).
2. \`browser_observe\`, then click the result whose title matches the request. Verify where you landed: a video page is \`youtube.com/watch?v=…\` / \`youtu.be/…\` / \`/shorts/…\`, \`tiktok.com/@user/video/…\`, or \`instagram.com/reel/…\`. When you are on one, the navigate/observe/click result carries a \`videoDelivery\` field — treat it as the delivery contract.
3. Let playback start, then call \`browser_clip\` — it records the playing video and delivers the clip to the session and the chat.
4. Paste the returned \`chatLine\` into your reply VERBATIM. Never claim you sent the video without a successful \`browser_clip\`.

## The user sees everything

Every gesture is streamed to the panel separately from the frames: your pointer path, each click's exact coordinate, the element you targeted (outlined before the click lands), scroll deltas, swipes, and keystroke COUNTS (never text — typed secrets are not recorded anywhere in the trace). Act as if watched, because you are. This is also why refusals and approvals are surfaced verbatim: the timeline drawer shows the user each action, its outcome, and its refusal reason.

## Scope

This plugin is dual-use tooling. Use it on sites you own, sites you are authorised to test, and public data at a polite rate. Do not use it to defeat access controls, rate limits or per-account quotas on services you do not control. When a site blocks the agent and no challenge is present, that is an answer — report it to the user instead of escalating.
`

// ── the /start command ──────────────────────────────────────────────────────

/** Kebab-case skill id, addressable as `/start` in the composer. */
export const START_SKILL_NAME = 'start'

export const START_SKILL_DESCRIPTION =
  'Start the dsh browser now: /start [url] launches a live Chrome session — the chatbar capsule pops its boot '
  + 'animation and the dashboard extends into the live view on its own.'

export const START_SKILL_WHEN_TO_USE =
  'When the user types /start (optionally followed by a URL) to launch the browser, or asks for the dsh browser '
  + 'to be started right now.'

/**
 * A COMMAND, not a playbook: short, imperative, zero decisions left to make.
 * The presentation half (capsule pop → dashboard extend → live frames) is
 * wired to the browser_start lifecycle in the client already — the skill must
 * only make the model fire the tool and get out of the way.
 */
export const START_SKILL_CONTENT = `# /start — launch the dsh browser

This is a COMMAND. The user asked to start the browser; act immediately, without clarifying questions.

1. Parse what follows \`/start\`: a URL (\`https://…\`) or a bare domain (\`example.com\`) becomes the \`url\` argument. Anything else — including nothing at all — means call \`browser_start\` with no \`url\`.
2. Call \`browser_start\` NOW. One call. Add \`label\` only when the user named the session.
3. Reply with ONE short line from the result: \`dsh-browser started — session <id>, <phase>.\` and nothing else.
4. Do NOT call browser_see, browser_observe or any capture verb afterwards to "show" the page: the chatbar capsule pops its boot animation and the dashboard extends into the live view by themselves the moment the session starts streaming. The user is already looking at it.
5. If the result has \`ok:false\`, quote its \`message\` in one line and stop. Do not retry.

Sub-agents: every \`browser_start\` creates YOUR OWN independent session (up to 4 concurrent, LRU-evicted when idle). Drive only the session id you created or were explicitly handed — never another agent's.
`


/**
 * Register the playbook when the host provides the skill service.
 *
 * `ctx.inject(['skills'], …)` rather than a `ctx.skills?.` guard: Cordis refuses
 * the mere PROPERTY ACCESS on an undeclared service ("cannot get property
 * \"skills\" without inject") and the throw takes the whole plugin down with it.
 * The optional-service pattern is the scoped inject, exactly like the webServer
 * routes. A profile without the skill service simply never runs the callback.
 */
export function registerBrowserSkill(ctx: Context): () => void {
  // `ctx.inject` returns the scoped FIBER, not a disposer; its own `dispose` is
  // what tears the scope down, so the plugin's teardown list stays uniform.
  const fiber = ctx.inject(['skills'], skillCtx => {
    const skills = (skillCtx as Context & {
      skills: {
        register: (skill: {
          name: string
          description: string
          whenToUse?: string
          content: string
          source: string
        }) => () => void
      }
    }).skills
    skillCtx.effect(
      () => {
        const offPlaybook = skills.register({
          name: BROWSER_SKILL_NAME,
          description: BROWSER_SKILL_DESCRIPTION,
          whenToUse: BROWSER_SKILL_WHEN_TO_USE,
          content: BROWSER_SKILL_CONTENT,
          source: 'bundled',
        })
        // The /start command rides the same service: a second, imperative skill
        // whose invocation means "launch the browser now".
        const offStart = skills.register({
          name: START_SKILL_NAME,
          description: START_SKILL_DESCRIPTION,
          whenToUse: START_SKILL_WHEN_TO_USE,
          content: START_SKILL_CONTENT,
          source: 'bundled',
        })
        return () => {
          offPlaybook()
          offStart()
        }
      },
      'dsh-browser:skill',
    )
  })
  return () => {
    void fiber.dispose()
  }
}
