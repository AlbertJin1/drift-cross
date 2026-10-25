#!/usr/bin/env bash
# Drift (cross-platform Electron build) for macOS and Linux. Requires Node.js 20+.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "ERROR: install Node.js LTS from https://nodejs.org"; exit 1; }
npm install --no-audit --no-fund
npm run css:build
rm -rf dist
case "$(uname -s)" in
  Darwin) npx electron-builder --mac ;;
  Linux)  npx electron-builder --linux ;;
  *) echo "Use build_publish.bat on Windows"; exit 1 ;;
esac
echo "Done. Output is in ./dist"
