#!/bin/bash
# deploy.sh — Deploy the Live Canon to Cloudflare Workers
#
# Prerequisites:
#   - CLOUDFLARE_TOKEN must be set in the environment (CF API token with
#     Workers Scripts:Edit + Durable Objects:Edit permissions)
#   - ACCT_ID: 049ff5e84ecf636b53b162cbb580aae6
#
# Usage:
#   export CLOUDFLARE_TOKEN="…"
#   bash deploy.sh
#
# The script does two things:
#   1) PUT worker.js to the CF Workers Scripts API (updates the worker code)
#   2) `npx wrangler deploy` to apply the wrangler.toml (which declares the
#      Room Durable Object binding + migration)
#
# Step 2 is needed because the scripts API alone cannot add DO bindings —
# wrangler (or the durable-objects PUT API) is required.

set -e

WORKER_NAME="${WORKER_NAME:-live-canon}"
ACCT_ID="${ACCT_ID:-049ff5e84ecf636b53b162cbb580aae6}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$CLOUDFLARE_TOKEN" ]; then
  echo "ERROR: CLOUDFLARE_TOKEN is not set in the environment." >&2
  echo "  export CLOUDFLARE_TOKEN=…your-cf-api-token…" >&2
  exit 1
fi

echo "=== Step 1/2 — PUT worker.js via the CF Workers Scripts API ==="
curl -sS -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @"$HERE/worker.js" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT_ID/workers/scripts/$WORKER_NAME" \
  | python3 -m json.tool || { echo "PUT failed"; exit 1; }

echo ""
echo "=== Step 2/2 — wrangler deploy to apply the DO binding + migration ==="
echo "(this is the only way to add a Durable Object binding)"
cd "$HERE"
npx --yes wrangler@4 deploy

echo ""
echo "=== Step 3/2 — smoke test ==="
sleep 2
echo "/api/canon/hash:"
curl -sS "https://$WORKER_NAME.superinstance.dev/api/canon/hash" | python3 -m json.tool
echo ""
echo "/playground (first 200 bytes):"
curl -sS "https://$WORKER_NAME.superinstance.dev/playground" | head -c 200
echo ""
echo ""
echo "Deploy complete."
