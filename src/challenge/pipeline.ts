/**
 * The challenge pipeline.
 *
 * Four tiers, escalating. The ordering is the whole design: each tier exists
 * because the one above it is cheaper, quieter, or more likely to succeed.
 *
 *   0. prevent   The engine itself. Patchright suppresses the Layer-1 tells;
 *                CloakBrowser patches the fingerprint at the source and claims
 *                a 0.9 reCAPTCHA v3 score. This tier is "no challenge appears".
 *                It is a property of `engine.provider`, not of this module.
 *
 *   1. classify  detector.ts. Cheap, deterministic, runs after every navigation
 *                and action. Turns "the page looks stuck" into a vendor, a
 *                blocking flag and a sitekey.
 *
 *   2. handoff   THE DEFAULT TERMINAL TIER. Pause the agent, suppress the
 *                persistent frame transport, hand the pointer to the human, and
 *                wait. They solve it in the panel, in the same browser session,
 *                with the same fingerprint and the same IP that the site is
 *                scoring. This is strictly better than any token-injection
 *                scheme on strict configurations — see the note below.
 *
 *   3. adapter   Opt-in, off by default, per-domain allowlist, approval-gated,
 *                fully audited. Two sub-kinds, and the distinction is the
 *                important part:
 *
 *                  in-session  a solver running INSIDE our browser (the
 *                              CapSolver extension pattern). It inherits the
 *                              real fingerprint, TLS handshake and behavioral
 *                              history, so the token is minted where it is
 *                              consumed. This is the only tier-3 mode worth
 *                              enabling on a scored challenge.
 *
 *                  token       a remote service returns a token minted on THEIR
 *                              browser and THEIR IP, which we inject. On
 *                              lenient configurations this works. On strict
 *                              ones the token encodes the fingerprint that
 *                              generated it and is rejected outright. We ship
 *                              the adapter, we mark every such solve
 *                              `inSession: false` in the audit record, and the
 *                              tool result says plainly that rejection is
 *                              likely.
 *
 * ── WHY HANDOFF IS THE DEFAULT AND NOT THE FALLBACK ──────────────────────────
 * The published 2026 evidence is consistent: Turnstile is not a puzzle with a
 * token answer, it is a multi-signal risk score over IP reputation + JS
 * environment + behavior, evaluated together. You cannot buy your way past it
 * with a token if the session that consumes the token does not itself look
 * trusted. A human solving in the panel produces a token bound to a session
 * that just passed. That is the highest-success path available to us and it
 * costs nothing.
 *
 * It is also the honest one. This plugin is dual-use tooling; making the
 * human-in-the-loop path the default rather than an emergency fallback is what
 * keeps it on the right side of that line, and it happens to also be the path
 * that works best.
 *
 * @module @dsh-community/dsh-browser/challenge
 */

import type { ChallengeRecord, ChallengeTier, ChallengeVendor } from '../protocol.js'
import { randomUUID } from 'node:crypto'
import type { Detection } from './detector.js'
import { PROOF_OF_WORK_VENDORS, SESSION_BOUND_VENDORS } from './detector.js'
import type { EnginePage } from '../engine/types.js'

// ── adapter contract ────────────────────────────────────────────────────────

/**
 * A tier-3 solver.
 *
 * Implementations must be honest about `inSession`. Returning `inSession: true`
 * for a remotely minted token would corrupt the audit trail and hide the exact
 * failure mode that matters most.
 */
export interface SolverAdapter {
  readonly name: string
  /** True when the solve happens inside the driven browser session. */
  readonly inSession: boolean
  /**
   * Can this adapter handle this vendor at all?
   * Checked before spending money or an approval.
   */
  supports(vendor: ChallengeVendor): boolean
  /**
   * Is the adapter configured (key present, extension loaded, domain allowed)?
   * Returns a reason string when not, so the tool result can say what to do.
   */
  ready(): Promise<{ ready: boolean; reason?: string }>
  solve(request: SolveRequest): Promise<SolveResult>
}

export interface SolveRequest {
  detection: Detection
  url: string
  page: EnginePage
  signal?: AbortSignal
  /** Set when the domain has been explicitly approved. Never inferred. */
  approvedDomain: boolean
}

export type SolveResult =
  | { ok: true; latencyMs: number; inSession: boolean; detail?: string }
  | { ok: false; latencyMs: number; reason: string }

// ── pipeline ────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  /** `off` (default) or `adapter`. */
  autoSolver: 'off' | 'adapter'
  adapter: string | null
  allowedDomains: string[]
  handoffByDefault: boolean
  handoffTimeoutMs: number
}

export interface PipelineDeps {
  config: PipelineConfig
  adapters: Map<string, SolverAdapter>
  /** Ask the human. Resolves with their reported outcome. */
  handoff: (record: ChallengeRecord, detection: Detection) => Promise<'passed' | 'failed' | 'abandoned' | 'timeout'>
  /** Mandatory DSH approval before tier 3 touches a new domain. */
  approveDomain: (domain: string, vendor: ChallengeVendor, adapter: string) => Promise<boolean>
  /** Audit sink — everything tier 3 does goes here, including refusals. */
  audit: (record: ChallengeRecord) => void
}

/** The decision the caller should act on. */
export type Verdict =
  | { action: 'none'; reason: 'no challenge detected' }
  | { action: 'continue'; reason: string; tier: ChallengeTier }
  | { action: 'handoff'; record: ChallengeRecord; detection: Detection; tier: 'handoff' }
  | { action: 'solved'; record: ChallengeRecord; tier: 'adapter'; latencyMs: number; inSession: boolean }
  | { action: 'blocked'; record: ChallengeRecord; reason: string; tier: ChallengeTier }

export class ChallengePipeline {
  #approvedDomains = new Set<string>()
  #history: ChallengeRecord[] = []

  constructor(private readonly deps: PipelineDeps) {}

  get history(): readonly ChallengeRecord[] {
    return this.#history
  }

  /**
   * Evaluate one detection and decide what to do.
   *
   * Never throws. A challenge pipeline that throws turns "the site is testing
   * us" into "the tool failed", which is the wrong signal for the model.
   */
  async evaluate(detection: Detection, url: string, page: EnginePage, signal?: AbortSignal): Promise<Verdict> {
    if (!detection.present) return { action: 'none', reason: 'no challenge detected' }
    if (detection.solved) {
      return { action: 'continue', reason: `${detection.vendor} widget present but already holds a response`, tier: 'classify' }
    }

    const record = this.#record(detection, url)

    // Tier 2a: proof-of-work vendors are meant to be solved by the client.
    // Letting the page's own script finish is not circumvention — it is the
    // protocol working as designed. Just wait for it.
    if (PROOF_OF_WORK_VENDORS.has(detection.vendor)) {
      const waited = await this.#waitForSelfSolve(page, detection, signal)
      if (waited) {
        this.#settle(record, 'prevent', 'passed')
        return { action: 'continue', reason: `${detection.vendor} proof-of-work completed locally`, tier: 'prevent' }
      }
      // It did not finish on its own; fall through to handoff rather than
      // burning an approval on something the page should have done.
    }

    // Tier 3: only if enabled, only for an approved domain, only for a
    // supported vendor.
    if (this.deps.config.autoSolver === 'adapter' && this.deps.config.adapter) {
      const adapter = this.deps.adapters.get(this.deps.config.adapter)
      if (!adapter) {
        this.#settle(record, 'adapter', 'failed')
        return { action: 'blocked', record, reason: `adapter '${this.deps.config.adapter}' is not registered`, tier: 'adapter' }
      }
      if (!adapter.supports(detection.vendor)) {
        // Not an error — fall through to handoff.
      } else {
        const domain = hostnameOf(url)
        const allowed = await this.#domainAllowed(domain, detection.vendor, adapter.name)
        if (!allowed) {
          this.#settle(record, 'adapter', 'abandoned')
          return {
            action: 'blocked',
            record,
            reason: `${domain} is not approved for automated solving. Add it to challenge.allowedDomains and approve the prompt, or let a human solve it in the panel.`,
            tier: 'adapter',
          }
        }
        const ready = await adapter.ready()
        if (!ready.ready) {
          this.#settle(record, 'adapter', 'failed')
          return { action: 'blocked', record, reason: `adapter not ready: ${ready.reason ?? 'unknown'}`, tier: 'adapter' }
        }

        const started = Date.now()
        const result = await adapter.solve({ detection, url, page, signal, approvedDomain: true }).catch(error => ({
          ok: false as const,
          latencyMs: Date.now() - started,
          reason: error instanceof Error ? error.message : String(error),
        }))

        if (result.ok) {
          record.adapter = { name: adapter.name, latencyMs: result.latencyMs, inSession: adapter.inSession && result.inSession }
          this.#settle(record, 'adapter', 'passed')
          return {
            action: 'solved',
            record,
            tier: 'adapter',
            latencyMs: result.latencyMs,
            inSession: record.adapter.inSession,
          }
        }
        // Tier 3 failed → fall through to handoff, which is where we should
        // have been anyway for a session-bound vendor.
        record.adapter = { name: adapter.name, latencyMs: result.latencyMs, inSession: false }
      }
    }

    // Tier 2: hand off to the human.
    if (this.deps.config.handoffByDefault) {
      return { action: 'handoff', record, detection, tier: 'handoff' }
    }

    this.#settle(record, 'classify', 'unresolved' as never)
    return {
      action: 'blocked',
      record,
      reason: `${detection.vendor} is blocking and handoff is disabled (challenge.handoffByDefault: false)`,
      tier: 'classify',
    }
  }

  /** Run the handoff and settle the record. Called by the tool after `action: 'handoff'`. */
  async runHandoff(record: ChallengeRecord, detection: Detection): Promise<ChallengeRecord> {
    const outcome = await this.deps.handoff(record, detection)
    this.#settle(record, 'handoff', outcome === 'timeout' ? 'abandoned' : outcome)
    if (outcome === 'timeout') record.resolvedBy = 'unresolved'
    return record
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #record(detection: Detection, url: string): ChallengeRecord {
    const record: ChallengeRecord = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      vendor: detection.vendor,
      blocking: detection.blocking,
      url,
      at: Date.now(),
      resolvedBy: 'unresolved',
      outcome: 'pending',
    }
    this.#history.push(record)
    // Bounded: a long session on a hostile site could otherwise grow this forever.
    if (this.#history.length > 200) this.#history.splice(0, this.#history.length - 200)
    return record
  }

  #settle(record: ChallengeRecord, tier: ChallengeTier, outcome: ChallengeRecord['outcome']): void {
    record.resolvedBy = tier
    record.outcome = outcome
    this.deps.audit({ ...record })
  }

  /**
   * One-shot domain approval, cached for the process lifetime.
   *
   * The cache is per-domain, not global: approving example.com must not silently
   * approve everything the agent navigates to next.
   */
  async #domainAllowed(domain: string, vendor: ChallengeVendor, adapter: string): Promise<boolean> {
    const configured = this.deps.config.allowedDomains.some(pattern => domain === pattern || domain.endsWith(`.${pattern.replace(/^\./, '')}`))
    if (!configured) return false
    if (this.#approvedDomains.has(domain)) return true
    const approved = await this.deps.approveDomain(domain, vendor, adapter)
    if (approved) this.#approvedDomains.add(domain)
    return approved
  }

  /**
   * Wait for a self-solving widget (proof-of-work, non-interactive Turnstile).
   *
   * Polls the response field rather than waiting on a network event: the field
   * being populated is the thing we actually care about, and it is the same
   * signal every solver service uses.
   */
  async #waitForSelfSolve(page: EnginePage, detection: Detection, signal?: AbortSignal): Promise<boolean> {
    const field = detection.responseField
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (signal?.aborted) return false
      if (field) {
        const filled = await page
          .evaluateIsolated<boolean>(
            `(() => { const el = document.querySelector('[name="${field.replace(/"/g, '')}"], #${field.replace(/"/g, '')}'); return !!(el && el.value && el.value.length > 8); })()`,
          )
          .catch(() => false)
        if (filled) return true
      }
      // A managed challenge that clears does so by navigating away.
      const stillThere = await page.evaluateIsolated<boolean>(`(() => !!document.querySelector('#challenge-form, #challenge-running-text, .cf-turnstile'))()`).catch(() => false)
      if (!stillThere && detection.vendor.startsWith('cloudflare')) return true
      await new Promise(resolve => setTimeout(resolve, 700))
    }
    return false
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Explain, to the model, why an injected token may not work.
 *
 * This is not decoration: a model that does not know a token solve is likely to
 * be rejected will retry the same failing strategy forever. One sentence in the
 * tool result turns that loop into a handoff.
 */
export function sessionBoundWarning(vendor: ChallengeVendor): string | null {
  if (!SESSION_BOUND_VENDORS.has(vendor)) return null
  return `${vendor} scores the whole session (IP reputation + JS environment + behavior), not just the token. `
    + 'A token minted elsewhere is frequently rejected even when cryptographically valid. '
    + 'Prefer the human handoff in the panel: it solves in this session, with this fingerprint and this IP.'
}

export type { Detection }
