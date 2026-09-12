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
echo "→ building (server + client bundle + standalone panel)"
npx tsc -p tsconfig.json
npx tsc -p tsconfig.client.json
npx tsdown src/client/index.tsx --config tsdown.config.mjs --format cjs --platform browser --target es2022 --tsconfig tsconfig.client.json --out-dir .client-build --clean --sourcemap --logLevel warn
node scripts/build-client.mjs
npx tsdown --config tsdown.standalone.config.mjs
node scripts/build-standalone.mjs

echo
echo "✓ Orderzx built at $DEST"
echo
echo "Wire it into your harness (cordis.patch.yml):"
echo
echo "  plugins:"
echo "    - path: $DEST"
echo
echo "Then start a session: browser_start({ url: \"https://example.com\" })"
echo "Panel: GET /_dsh/dsh-browser/panel on the loopback fence."
