# ROADMAP

Honest list, ordered by value-per-effort. Anything not here is undecided, not rejected.
Status marks: ✓ shipped · ◐ in progress · ○ planned · ◌ watching (spec/market not ready).

## ○ Record → replay workflows (`browser_workflow`)
Ui.Vision / LivePilot's compounding feature. A takeover already produces a full human
gesture trace; serialize the demonstrated clicks/types/scrolls into a named, replayable
workflow with `{{variables}}` for typed secrets, stored under the profile root
(local-only, same trust boundary as the cookie jar). Replay is deterministic:
identity-first targeting (role + accessible name, the same match rule as self-healing
refs) with normalized-coordinate fallback, humanized input either way.
**Design constraint:** the interaction trace never records typed text (secret safety),
so the recorder captures text only from the control channel during an explicit
`recording` session, and anything typed into a password-shaped field becomes a
required `{{variable}}` at replay time.

## ○ MCP bridge
Wrap the tool layer in a Model Context Protocol server (stdio JSON-RPC:
`initialize`, `tools/list`, `tools/call`) so any MCP client — Claude Desktop, Cursor,
anything — can drive Orderzx without DSH. The tools already speak canonical JSON in
and out; this is mostly transport plus a standalone host bootstrap. Entry point:
`bin/dsh-browser-mcp`.

## ◐ Schema-validated extract
`browser_extract` gains an optional JSON `schema`; results are validated before they
are returned, and a mismatch retries once with a deeper pass before failing typed
(`ok:false, violations:[…]`) instead of returning prose that breaks a pipeline.
Stagehand's "dial between code and AI", without the Zod dependency.

## ◐ Upload / download (`browser_files`)
The last e-commerce gap (browser-use has it, we don't). `upload` sets input files
through the engine with a path fence (`policy.uploadRoots`, default: the profile
dir only — a model-named path must never reach `setInputFiles` unchecked).
`download` arms a download listener, clicks the ref, streams to the profile
downloads dir and answers with a signed capture-style token.

## ◐ Form-strategy fill
`browser_fill_form` fills in one transaction and then READS BACK every field
(isolated-world value probe), returning a per-field `{ref, expected, actual, ok}`
verification summary plus an overall verdict — Skyvern's form reliability without
copying a line of its AGPL code.

## ○ Console + network drawer
Cloudflare Browser Run's Live View shows DOM/console/network; we show frames +
timeline. Add an opt-in debug tap (`page.on('console'|'request'|'response')` —
opt-in because listeners are a detectable surface; while armed, `posture().gaps`
says so plainly) feeding a ring buffer that a third panel drawer tab renders.

## ○ CI that earns the badge
GitHub Actions runs the four static suites on every push (Node 22, `npm ci`,
full build). The README's `494/494` shield becomes a live `build passing` shield;
live/e2e stay local because they need a real Chromium and we will not phone a
third-party site from CI.

## ○ WebMCP watcher ◌
When sites start declaring tools for agents (`navigator.modelContext`), preferring
the site's own tools over vision is the right call. The spec is still moving, so
today we only DETECT and report (`status.session.capabilities.webmcp`, observed
per page) and keep the integration parked here.

## ○ `browser_task` job integration
The stub stays honest until the harness injects `ctx.jobs`: a background loop needs
job lifecycle (start/cancel/status) that this build cannot fabricate. When cordis
provides it, `browser_task` becomes observe → plan → act → verify over the job
service, with the panel streaming either way.

## ○ Act → deterministic cache
Ui.Vision's other half: when `browser_act` succeeds with high confidence, cache the
resolved ref sequence keyed by (url pattern, action text) and replay it
deterministically next time — LLM cost drops toward zero on repeated flows.
Depends on record→replay primitives.

## ◌ Android companion parity
dsh-android proves the whole stack can live on-device; the panel already ships a
narrow sheet via `adb reverse`. A native companion that embeds the harness (like
dsh-android embeds Linux) is the long game — watch, don't fork.

---

*Version ritual (borrowed from dsh-android): every tag ships with its suite count in
the badges and release notes. A badge that cannot fail is a badge that lies.*
