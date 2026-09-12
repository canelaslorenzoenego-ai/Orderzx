/**
 * Standalone panel entry — the dashboard OUTSIDE the DSH web client.
 *
 * The plugin's primary surface is the chat-embedded capsule + docked panel, but
 * the browser itself lives in the HOST process and speaks plain HTTP/SSE on the
 * loopback-fenced routes. That means any browser that can reach those routes can
 * render the full panel: a second desktop profile, a kiosk screen, or — the case
 * this file exists for — an Android phone pointed at the machine through
 * `adb reverse tcp:PORT tcp:PORT`, which makes the host's loopback the phone's
 * loopback without ever exposing the routes to the LAN.
 *
 * This entry mounts the SAME PanelHost the chat uses, opens it immediately, and
 * nothing else. React is bundled IN (unlike lib/client.js, which must share the
 * host's single React realm) because there is no host module loader here — this
 * page is the whole app. scripts/build-standalone.mjs wraps the compiled output
 * into lib/standalone.html, which GET /panel serves.
 *
 * @module @dsh-community/dsh-browser/client/standalone
 */

import { mountBrowserPanelHost } from './panel-host.js'
import type { FetchLike } from './wire.js'

/** The page's own fetch: same-origin relative URLs, exactly like the chat client. */
const fetcher: FetchLike = (url, init) => fetch(url, init as RequestInit)

function boot(): void {
  const host = mountBrowserPanelHost({ fetcher })
  // 'manual' origin: nothing booted this panel except the user opening the URL.
  // sessionId scopes panel-store requests in the chat client; standalone has no
  // conversation, so a fixed scope is honest and stable.
  host.open({ sessionId: 'standalone', origin: 'manual' })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
}
