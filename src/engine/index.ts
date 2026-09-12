/**
 * Engine registry.
 *
 * Registration happens at module load (not inside `apply`) so that the host
 * entry, the smoke scripts and any third-party provider can all resolve the
 * same table. Providers are lazy: the dynamic import of an optional driver
 * happens on first `browser_start`, never at plugin mount.
 *
 * Adding a provider from outside this package:
 *
 *     import { registerEngineProvider } from '@dsh-community/dsh-browser'
 *     registerEngineProvider('cdp', async () => myCdpAdapter)
 *
 * @module @dsh-community/dsh-browser/engine
 */

import { registerEngineProvider } from './types.js'
import { patchrightProvider } from './patchright.js'
import { cloakbrowserProvider } from './cloakbrowser.js'
import { cdpProvider } from './cdp.js'

export * from './types.js'
export * from './humanize.js'
export { patchrightProvider, baseLaunchArgs, hardenedArgs, parseAriaSnapshot } from './patchright.js'
export { cloakbrowserProvider } from './cloakbrowser.js'
export { cdpProvider } from './cdp.js'

/**
 * `patchright` is registered for BOTH the `patchright` and `playwright-core`
 * provider names: the same adapter tries the patched driver first and falls
 * back to unpatched playwright-core, reporting which one it got in
 * `posture().applied`. Selecting `playwright-core` explicitly just documents
 * intent — it does not skip the probe.
 */
export function registerBuiltinProviders(): void {
  registerEngineProvider('patchright', async () => patchrightProvider)
  registerEngineProvider('playwright-core', async () => patchrightProvider)
  registerEngineProvider('cloakbrowser', async () => cloakbrowserProvider)
  registerEngineProvider('cdp', async () => cdpProvider)
}

registerBuiltinProviders()
