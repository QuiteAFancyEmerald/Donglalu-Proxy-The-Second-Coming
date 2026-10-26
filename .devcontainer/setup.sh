#!/usr/bin/env bash
# Runs once when the Codespace is created: the wrapper, a relay for this
# machine, and the demo's dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci
DLPCC_TARGETS="linux-$(node -p process.arch)" npm run build:bins
npm run build
cd demo
npm ci
