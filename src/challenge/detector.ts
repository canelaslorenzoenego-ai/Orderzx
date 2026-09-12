/**
 * Tier 1: detect and classify.
 *
 * Why this is a separate tier from "the model looks at a screenshot":
 *
 *  - A screenshot tells the model *something* is on the page. It does not tell
 *    it the vendor, whether the widget is blocking, or whether a token field
 *    already has a value. Those three facts decide the next action.
 *  - Detection is cheap and deterministic. Running it after every navigation and
 *    every action costs one isolated-world evaluation and catches a challenge
 *    the moment it appears, instead of three steps later when the agent notices
 *    its clicks stopped working.
 *  - An unclassified widget must still pause the agent. `vendor: 'unknown'` is a
 *    real outcome, not a failure of this module.
 *
 * Detection signals, in order of reliability:
 *   1. Response/URL shape — a Cloudflare interstitial has a distinctive URL and
 *      status, and is unambiguous.
 *   2. DOM markers — widget containers and hidden response fields. These are
 *      what every solver service reads, so they are stable across vendors.
 *   3. Frame inventory — challenges almost always live in a cross-origin iframe.
 *
 * We do NOT do visual/OCR detection here. That belongs in the model's own loop,
 * where it has the screenshot anyway.
 *
 * @module @dsh-community/dsh-browser/challenge/detector
 */

import type { ChallengeVendor } from '../protocol.js'

/** What the detector found. `present: false` short-circuits everything else. */
export interface Detection {
  present: boolean
  vendor: ChallengeVendor
  /** Is navigation actually blocked, or is the widget merely present? */
  blocking: boolean
  /** The sitekey, when the widget exposes one. Needed by tier 3. */
  sitekey?: string
  /** The hidden response field, when one exists. */
  responseField?: string
  /** Whether that field already holds a value (i.e. something already solved it). */
  solved?: boolean
  /** Which signal fired, for the audit log. */
  signal: 'url' | 'dom' | 'frame' | 'none'
  /** Raw evidence, truncated. Goes into the session log, not the model prompt. */
  evidence?: string
}

export const NO_CHALLENGE: Detection = { present: false, vendor: 'unknown', blocking: false, signal: 'none' }

// ── URL / response shape ────────────────────────────────────────────────────

/**
 * Interstitial URLs. These are the highest-confidence signal available: the
 * server told us, in the address bar, that it is challenging this client.
 */
const URL_PATTERNS: Array<{ pattern: RegExp; vendor: ChallengeVendor }> = [
  { pattern: /\/cdn-cgi\/challenge-platform/i, vendor: 'cloudflare-turnstile' },
  { pattern: /\/cdn-cgi\/(turnstile|bmcvart)/i, vendor: 'cloudflare-turnstile' },
  { pattern: /__cf_chl_(jsch|rt|captcha|optjs)/i, vendor: 'cloudflare-managed' },
  { pattern: /challenges\.cloudflare\.com/i, vendor: 'cloudflare-turnstile' },
  { pattern: /\/geo\/captcha\//i, vendor: 'amazon-waf' },
  { pattern: /captcha\.awswaf\.com/i, vendor: 'amazon-waf' },
  { pattern: /\/_Incapsula_Resource/i, vendor: 'imperva' },
  { pattern: /incapsula\.com|\/_Incapsula_/i, vendor: 'imperva' },
  { pattern: /datadome\.co\/captcha/i, vendor: 'datadome' },
  { pattern: /geo\.captcha-delivery\.com/i, vendor: 'datadome' },
  { pattern: /captcha\.px-cdn\.net|captcha\.px-cloud\.net/i, vendor: 'perimeterx' },
  { pattern: /\/init\.js\b.*_px/i, vendor: 'perimeterx' },
  { pattern: /cas\.kasada\.io|\/tl\//i, vendor: 'kasada' },
  { pattern: /arkoselabs|funcaptcha\.com/i, vendor: 'funcaptcha' },
  { pattern: /\/api\.arkoselabs\.com/i, vendor: 'funcaptcha' },
  { pattern: /geetest\.com|gcaptcha4/i, vendor: 'geetest' },
  { pattern: /recaptcha\/api2?\/(anchor|bframe)/i, vendor: 'recaptcha-v2' },
  { pattern: /hcaptcha\.com\/[0-9]+\/captcha/i, vendor: 'hcaptcha' },
]

export function detectFromUrl(url: string): Detection | undefined {
  for (const { pattern, vendor } of URL_PATTERNS) {
    if (pattern.test(url)) {
      return { present: true, vendor, blocking: true, signal: 'url', evidence: url.slice(0, 200) }
    }
  }
  return undefined
}

/**
 * HTTP status + server header shape.
 *
 * 403/429/503 with a `cf-ray`, `x-datadome`, `x-px` or `x-iinfo` header is a
 * challenge even when the URL looks normal — that is the managed/invisible case.
 */
export function detectFromResponse(info: {
  status: number
  headers: Record<string, string | undefined>
  url: string
}): Detection | undefined {
  const challenged = info.status === 403 || info.status === 429 || info.status === 503
  if (!challenged) return undefined
  const header = (name: string): string | undefined => info.headers[name.toLowerCase()]

  if (header('cf-ray') || header('cf-mitigated')) {
    // `cf-mitigated: challenge` is Cloudflare saying so explicitly.
    const explicit = header('cf-mitigated') === 'challenge'
    return {
      present: true,
      vendor: explicit ? 'cloudflare-managed' : 'cloudflare-turnstile',
      blocking: true,
      signal: 'url',
      evidence: `status=${info.status} cf-mitigated=${header('cf-mitigated') ?? '-'}`,
    }
  }
  if (header('x-datadome') || header('x-datadome-cid')) {
    return { present: true, vendor: 'datadome', blocking: true, signal: 'url', evidence: `status=${info.status} x-datadome` }
  }
  if (header('x-px') || header('x-pxhd')) {
    return { present: true, vendor: 'perimeterx', blocking: true, signal: 'url', evidence: `status=${info.status} x-px` }
  }
  if (header('x-iinfo') || header('x-cdn')) {
    return { present: true, vendor: 'imperva', blocking: true, signal: 'url', evidence: `status=${info.status} x-iinfo` }
  }
  if (header('server')?.includes('akamaighost') || header('server')?.includes('AkamaiGHost')) {
    return { present: true, vendor: 'akamai', blocking: true, signal: 'url', evidence: `status=${info.status} akamaighost` }
  }
  return undefined
}

// ── DOM markers ─────────────────────────────────────────────────────────────

/**
 * The DOM probe.
 *
 * Serialised to a string because it must cross into the page. It runs in an
 * ISOLATED world (see `EnginePage.evaluateIsolated`) so it does not touch the
 * page's own JS context and does not add a main-world execution-context tell.
 *
 * Every selector here is a vendor's own published integration point. We read
 * attributes and field values; we never mutate anything.
 */
export const DOM_PROBE = `(() => {
  const out = { present: false, vendor: 'unknown', blocking: false, signal: 'dom', items: [] };
  const push = (vendor, detail, blocking, sitekey, responseField, solved) => {
    out.items.push({ vendor, detail, blocking: !!blocking, sitekey: sitekey || undefined, responseField: responseField || undefined, solved: !!solved });
  };
  const attr = (el, names) => {
    if (!el) return undefined;
    for (const n of names) { const v = el.getAttribute(n); if (v) return v; }
    return undefined;
  };
  const value = sel => { const el = document.querySelector(sel); return el && typeof el.value === 'string' ? el.value : undefined; };

  // ── Cloudflare Turnstile ────────────────────────────────────────────────
  for (const el of document.querySelectorAll('[data-sitekey], .cf-turnstile, #cf-turnstile, [id*="turnstile"]')) {
    const sk = attr(el, ['data-sitekey', 'data-cf-turnstile-sitekey']);
    const resp = value('[name="cf-turnstile-response"]');
    push('cloudflare-turnstile', el.tagName + '.' + (el.className || '').toString().slice(0, 40), !resp, sk, 'cf-turnstile-response', !!resp);
  }
  // Managed challenge / interstitial: the whole document is the challenge.
  if (document.querySelector('#challenge-form, #challenge-running-text, .cf-browser-verification, #cf_chl_opt')) {
    push('cloudflare-managed', 'challenge document', true, undefined, undefined, false);
  }

  // ── reCAPTCHA ───────────────────────────────────────────────────────────
  for (const el of document.querySelectorAll('.g-recaptcha, [data-sitekey][data-callback], #g-recaptcha')) {
    const sk = attr(el, ['data-sitekey']);
    const resp = value('#g-recaptcha-response') || value('[name="g-recaptcha-response"]');
    const v3 = (el.getAttribute('data-size') === 'invisible') || !!el.getAttribute('data-action');
    push(v3 ? 'recaptcha-v3' : 'recaptcha-v2', 'g-recaptcha' + (v3 ? ' (invisible/action)' : ''), !resp, sk, 'g-recaptcha-response', !!resp);
  }
  if (typeof window !== 'undefined' && window.grecaptcha && window.grecaptcha.enterprise) {
    push('recaptcha-enterprise', 'grecaptcha.enterprise present', false, undefined, undefined, false);
  }

  // ── hCaptcha ────────────────────────────────────────────────────────────
  for (const el of document.querySelectorAll('.h-captcha, [data-hcaptcha-widget-id]')) {
    const sk = attr(el, ['data-sitekey']);
    const resp = value('[name="h-captcha-response"]');
    push('hcaptcha', 'h-captcha widget', !resp, sk, 'h-captcha-response', !!resp);
  }

  // ── DataDome / PerimeterX / Kasada / Imperva / Amazon WAF ───────────────
  if (document.querySelector('#datadome-captcha, [id*="datadome"], .datadome-captcha-container')) push('datadome', 'datadome widget', true);
  if (document.querySelector('#px-captcha, [id^="_px"], .px-captcha')) push('perimeterx', 'px-captcha', true);
  if (document.querySelector('#kasada-client, [id*="kasada"], #kpsa')) push('kasada', 'kasada', true);
  if (document.querySelector('#IncapsulaFrame, [id*="incapsula"], #_Incapsula_Resource')) push('imperva', 'incapsula frame', true);
  if (document.querySelector('#awswaf-widget, [data-sitekey][id*="awswaf"], .awswaf-challenge')) push('amazon-waf', 'awswaf widget', true);

  // ── Proof-of-work vendors (no human interaction; solvable locally) ──────
  if (document.querySelector('.altcha, [id*="altcha"], input[name="altcha"]')) push('altcha', 'altcha proof-of-work', false);
  if (document.querySelector('.friendly-captcha, [id*="friendly-captcha"]')) push('friendly-captcha', 'friendly proof-of-work', false);

  // ── GeeTest / FunCaptcha ────────────────────────────────────────────────
  if (document.querySelector('.geetest_holder, [class*="geetest"], #gcaptcha4')) push('geetest', 'geetest', true);
  if (document.querySelector('[id*="funcaptcha"], [class*="arkose"]')) push('funcaptcha', 'arkose/funaptcha', true);

  // ── Cross-origin iframes: the generic last resort ───────────────────────
  if (!out.items.length) {
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.getAttribute('src') || '';
      const vendor = /recaptcha/.test(src) ? 'recaptcha-v2'
        : /hcaptcha/.test(src) ? 'hcaptcha'
        : /turnstile|challenges\\.cloudflare/.test(src) ? 'cloudflare-turnstile'
        : /arkoselabs|funcaptcha/.test(src) ? 'funcaptcha'
        : /geetest/.test(src) ? 'geetest'
        : /datadome/.test(src) ? 'datadome'
        : /px-cdn|px-cloud|perimeterx/.test(src) ? 'perimeterx'
        : /awswaf/.test(src) ? 'amazon-waf'
        : null;
      if (vendor) { out.signal = 'frame'; push(vendor, 'iframe ' + src.slice(0, 120), true); }
    }
  }

  if (!out.items.length) return out;
  // Rank: blocking first, then the most specific vendor. A page can carry a
  // passive reCAPTCHA v3 AND a blocking Turnstile; the blocking one wins.
  out.items.sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const top = out.items[0];
  out.present = true;
  out.vendor = top.vendor;
  out.blocking = top.blocking;
  out.sitekey = top.sitekey;
  out.responseField = top.responseField;
  out.solved = top.solved;
  out.evidence = JSON.stringify(out.items.slice(0, 4));
  delete out.items;
  return out;
})()`

/** Shape returned by `DOM_PROBE`. */
interface ProbeResult {
  present: boolean
  vendor: ChallengeVendor | string
  blocking: boolean
  signal: 'dom' | 'frame'
  sitekey?: string
  responseField?: string
  solved?: boolean
  evidence?: string
}

const KNOWN_VENDORS = new Set<string>([
  'cloudflare-turnstile', 'cloudflare-managed', 'recaptcha-v2', 'recaptcha-v3', 'recaptcha-enterprise',
  'hcaptcha', 'datadome', 'perimeterx', 'kasada', 'akamai', 'imperva', 'amazon-waf', 'funcaptcha',
  'geetest', 'altcha', 'friendly-captcha',
])

export function normalizeProbe(result: unknown): Detection {
  if (typeof result !== 'object' || result === null) return NO_CHALLENGE
  const probe = result as Partial<ProbeResult>
  if (!probe.present) return NO_CHALLENGE
  const vendor = typeof probe.vendor === 'string' && KNOWN_VENDORS.has(probe.vendor)
    ? (probe.vendor as ChallengeVendor)
    : 'unknown' // an unrecognised widget is still a challenge
  return {
    present: true,
    vendor,
    blocking: probe.blocking === true,
    sitekey: typeof probe.sitekey === 'string' ? probe.sitekey.slice(0, 128) : undefined,
    responseField: typeof probe.responseField === 'string' ? probe.responseField.slice(0, 64) : undefined,
    solved: probe.solved === true,
    signal: probe.signal === 'frame' ? 'frame' : 'dom',
    evidence: typeof probe.evidence === 'string' ? probe.evidence.slice(0, 500) : undefined,
  }
}

/**
 * Vendors whose challenge is a local proof-of-work rather than a human test.
 *
 * These are worth calling out because they change the ethics AND the tactics:
 * solving a PoW is exactly what the vendor intends a client to do (that is the
 * protocol), so automating it is not circumvention. Tier 2 can handle them
 * locally with no human and no third party.
 */
export const PROOF_OF_WORK_VENDORS: ReadonlySet<ChallengeVendor> = new Set<ChallengeVendor>(['altcha', 'friendly-captcha'])

/** Vendors where a token minted elsewhere is likely to be REJECTED (strict scoring). */
export const SESSION_BOUND_VENDORS: ReadonlySet<ChallengeVendor> = new Set<ChallengeVendor>([
  'cloudflare-turnstile',
  'cloudflare-managed',
  'recaptcha-v3',
  'recaptcha-enterprise',
  'datadome',
  'perimeterx',
  'kasada',
  'akamai',
])
