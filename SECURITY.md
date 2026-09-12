# Security policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's "Report a
vulnerability" (Security Advisories) tab on this repository, or by email to the
maintainer listed in `package.json`. Do not open a public issue.

We aim to acknowledge within 72 hours and to ship a fix or mitigation within 14
days for confirmed issues in supported versions.

## Supported versions

Only the latest `0.1.x` release against DeepSeek Harness `0.1.5-rc.2` is
supported. Older release candidates are not patched.

## Threat model and design invariants

This plugin runs a real browser with real credentials on a user's machine and
exposes it over HTTP. The invariants below are load-bearing; a change that
breaks one is a security regression, not a refactor.

1. **Fence before capability.** Every route checks `isTrustedRequest`
   (loopback remote address + loopback authority + Fetch-Metadata/Origin)
   *before* any token is read. A leaked token must not be usable from another
   host on the LAN.
2. **Capabilities are kind- and scope-scoped.** `browser-stream`,
   `browser-capture`, and `browser-control` tokens are distinct HMAC payloads;
   `view` cannot POST input; `drive` is only minted while a takeover is active.
   Kind confusion is treated as a bug class and asserted in
   `scripts/dev-routes-static-smoke.mjs`.
3. **TTL ≤ 10 minutes**, enforced by `TOKEN_TTL_MS`; the client refreshes ahead
   of expiry rather than holding long-lived tokens.
4. **Capture path containment.** `classifyCapturePath` walks from the cache
   root with `lstat`, refuses any symlink, rejects `..` segments, and finishes
   with a realpath containment check.
5. **Credentials never traverse the model.** Proxy auth, solver API keys, and
   `userDataDir` are host-config only; tool schemas do not accept them;
   `redactConfig` keeps them out of logs; `secret: true` input is never echoed.
6. **Sensitive actions fail closed.** If the host provides no approval service,
   pay/publish/delete/send/auth verbs are refused rather than allowed.
7. **`browser_evaluate` is config-gated off** and runs in an isolated world
   only when enabled.
8. **Solver-API tier is off by default**, per-domain allowlisted, gated by a
   mandatory one-shot interactive approval, and every attempt writes an audit
   record (`resolvedBy`, adapter name, latency, `inSession` honesty).
9. **Frame suppression during handoff.** While a human solves a challenge, the
   persistent capture transport stops (`suppressOnChallenge`), reducing the
   detection surface exactly when a suspicious site is scrutinising.
10. **Client bundle must not ship a second React.** `scripts/build-client.mjs`
    fails packaging if React internals are found in the bundle.

## Out of scope

- Detection-evasion "arms race" improvements against a specific vendor's
  challenge are features, not vulnerabilities — but a bypass that requires no
  user consent and defeats a *login or payment* protection is in scope.
- Abuse of this tool against third-party sites violates the license intent and
  the dual-use policy in the README; reports of such abuse should go to the
  affected site and, where relevant, to us for possible feature gating.
