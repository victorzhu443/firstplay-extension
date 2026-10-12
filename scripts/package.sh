#!/usr/bin/env bash
# Build the installable zip: dist/firstplay-autofill-<version>.zip
# Contents: manifest, src/, nothing else (no survey data, no docs, no tests).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
OUT="dist/firstplay-autofill-$VERSION.zip"
rm -f "$OUT"
zip -qr "$OUT" manifest.json src -x "*.DS_Store"
echo "$OUT"
