#!/usr/bin/env sh
# Orderzx one-command install — clone, build, print the cordis patch line.
# Zero cloud, zero accounts: everything stays on this machine.
set -eu

REPO="${ORDERZX_REPO:-https://github.com/canelaslorenzoenego-ai/Orderzx.git}"
DEST="${ORDERZX_DEST:-$HOME/.orderzx/dsh-browser}"

if [ -d "$DEST/.git" ]; then
  echo "→ updating existing checkout at $DEST"
  git -C "$DEST" pull --ff-only
else
  echo "→ cloning $REPO → $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 "$REPO" "$DEST"
fi

cd "$DEST"
echo "→ installing dependencies (playwright-core runtime driver, patchright optional stealth engine)"
npm ci --no-audit --no-fund
echo "→ building server entry (lib/)"
npx tsc -p tsconfig.json

# Client + standalone panel bundles. tsdown's own engines field says Node >= 22,
# but its only Node-22 dependency is Promise.withResolvers, which the tracked
# scripts/node20-polyfill.cjs (imported by both tsdown configs) supplies — so
# the bundles build on the plugin's documented floor, Node >= 20. A build
# failure warns instead of dying: the plugin and its loopback panel API still
# work without the rich bundle, but you lose the capsule/dashboard, so re-run
# after fixing.
echo "→ building client bundle + standalone panel"
if npm run build:client && npm run build:standalone; then
  echo "  ✓ lib/client.js + lib/standalone.html built"
else
  echo "⚠ client/standalone bundle build FAILED (node $(node -p process.versions.node))."
  echo "  The plugin and its loopback panel API still work; the in-chat capsule,"
  echo "  cards and dashboard bundle do not. Fix the error above and re-run."
fi

echo
echo "✓ Orderzx built at $DEST"
echo
echo "Wire it into your harness — cordis.yml is a BARE LIST of loader entries;"
echo "the loader imports \`name\` as a module specifier (there is no \`path\` key"
echo "and no \`plugins:\` wrapper). Mount BOTH sides:"
echo
echo "  # node profile — tools, engine, routes:"
echo "  - id: dsh-browser"
echo "    name: file://$DEST/lib/index.js"
echo "    config:"
echo "      engine:"
echo "        provider: patchright"
echo
echo "  # web/client profile — capsule, cards, dashboard (the dsh.client.inject"
echo "  # manifest in package.json lists the host packages dsh-web provides):"
echo "  - id: dsh-browser-client"
echo "    name: '@dsh-community/dsh-browser/client'"
echo "    # or by path when the package is not resolvable from the profile:"
echo "    # name: file://$DEST/lib/client.js"
echo
echo "→ extending the harness dashboard (rc.21: extend-only dashboard + stream poll fallback)"
node scripts/patch-harness-dashboard.mjs || echo "  (no dsh-android checkout found — web/client profile unaffected)"
echo
echo "Then start a session — type /start in the composer, or call:"
echo "browser_start({ url: \"https://example.com\" })"
echo "Panel: GET /_dsh/dsh-browser/panel on the loopback fence."
