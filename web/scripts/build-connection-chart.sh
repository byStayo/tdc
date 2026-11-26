#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
temporary=$(mktemp public/research/.connections.XXXXXXXX)
trap 'rm -f "$temporary"' EXIT
node --experimental-strip-types scripts/report-connections.ts --html > "$temporary"
mv -f "$temporary" public/research/connections.html
