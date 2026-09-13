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
echo "→ installing dependencies"
npm ci --no-audit --no-fund
echo "→ building server entry (lib/)"
npx tsc -p tsconfig.json

# The client/standalone bundles need the tsdown toolchain, which requires
# Node >= 22. The plugin itself (lib/) builds and runs on Node >= 20, so on
# older nodes we skip the panel bundles with a warning instead of dying
# halfway through the install.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -ge 22 ]; then
  echo "→ building client bundle + standalone panel"
  npx tsc -p tsconfig.client.json
  npx tsdown src/client/index.tsx --config tsdown.config.mjs --format cjs --platform browser --target es2022 --tsconfig tsconfig.client.json --out-dir .client-build --clean --sourcemap --logLevel warn
  node scripts/build-client.mjs
  npx tsdown --config tsdown.standalone.config.mjs
  node scripts/build-standalone.mjs
else
  echo "⚠ Node $NODE_MAJOR: skipping client/standalone bundles (need Node >= 22)."
  echo "  The plugin and its loopback panel API still work; the rich dashboard"
  echo "  bundle needs a newer node. Re-run this script after upgrading to get it."
fi

echo
echo "✓ Orderzx built at $DEST"
echo
echo "Wire it into your harness — cordis.yml is a BARE LIST of loader entries;"
echo "the loader imports \`name\` as a module specifier (there is no \`path\` key"
echo "and no \`plugins:\` wrapper):"
echo
echo "  - id: dsh-browser"
echo "    name: file://$DEST/lib/index.js"
echo "    config:"
echo "      engine:"
echo "        provider: patchright"
echo
echo "Then start a session: browser_start({ url: \"https://example.com\" })"
echo "Panel: GET /_dsh/dsh-browser/panel on the loopback fence."
