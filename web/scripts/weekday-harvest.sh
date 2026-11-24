#!/bin/bash
set -eu
umask 077

cd "$(dirname "$0")/.."
if [ "$(/usr/bin/git branch --show-current)" != codex/daily-consensus-polish ] ||
   [ -n "$(/usr/bin/git status --porcelain)" ] ||
   [ "$(/usr/bin/git rev-parse HEAD)" != "$(/usr/bin/git rev-parse '@{upstream}')" ]; then
  printf '%s\n' 'Daily Consensus capture skipped because the publishing checkout is dirty, is on another branch or differs from its upstream.' >&2
  exit 2
fi

node_bin=/opt/homebrew/opt/node@24/bin/node
if ! "$node_bin" --experimental-strip-types scripts/research-occ-volume.ts; then
  printf '%s\n' 'Private OCC capture did not complete. Continuing with official collection.' >&2
fi
if ! "$node_bin" --experimental-strip-types scripts/collect-sentisense-options-private.ts; then
  printf '%s\n' 'Private options capture did not complete. Continuing with official collection.' >&2
fi
exec "$node_bin" --experimental-strip-types scripts/prepare-daily-data.ts --weekday
