/**
 * Ambient declarations for the OPTIONAL engine drivers.
 *
 * Both are lazy `await import()` targets resolved at first `browser_start`, and
 * neither is a dependency of this package (installing a proprietary stealth
 * binary as a transitive dep would be rude). The adapters cast the module shape
 * themselves (`as unknown as DriverModule` / `CloakModule`), so `any` here is
 * the honest type: we genuinely do not know at compile time what is installed.
 */

declare module 'patchright'
declare module 'cloakbrowser'
