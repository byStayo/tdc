#!/bin/bash
set -eu
umask 077

cd "$(dirname "$0")/.."
/usr/bin/python3 -B scripts/check-publisher-checkout.py

node_bin=/opt/homebrew/opt/node@24/bin/node
if ! "$node_bin" --experimental-strip-types scripts/verify-live-consensus.ts --scheduled-preopen; then
  printf '%s\n' 'The existing public edition could not be witnessed before the open. Continuing with independently locked collection.' >&2
fi
if ! /usr/bin/python3 -B scripts/collect-sec-etf-flows.py --collect-latest --summary; then
  printf '%s\n' 'Private SEC fund-flow check incomplete. Continuing with the daily collection.' >&2
fi
if ! "$node_bin" --experimental-strip-types scripts/research-occ-volume.ts; then
  printf '%s\n' 'Private OCC capture did not complete. Continuing with official collection.' >&2
fi
if ! "$node_bin" --experimental-strip-types scripts/collect-sentisense-options-private.ts; then
  printf '%s\n' 'Private options capture did not complete. Continuing with official collection.' >&2
fi
exec "$node_bin" --experimental-strip-types scripts/prepare-daily-data.ts --weekday
