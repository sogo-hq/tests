#!/usr/bin/env bash
# Every VITALS v1 endpoint, as a runnable example.
#
#   API=https://api.checkvitals.xyz KEY=your-key ./examples/curl.sh
#
# KEY is optional: every call below works without one at the keyless rate of
# 1 rps, which is there so the contract can be evaluated before anyone is
# onboarded.
set -euo pipefail

API="${API:-https://api.checkvitals.xyz}"
KEY="${KEY:-}"
AUTH=()
[ -n "$KEY" ] && AUTH=(-H "Authorization: Bearer $KEY")

# A real pons v2 launch: $CHIPPER.
TOKEN=0xd384722f6adfe7d79e8e6623896df199afd31b76
# A real launch that is not the one above, for the batch.
OTHER=0x5a05ff9c0d10e89701bae5b35d64adf99903073b

say() { printf '\n=== %s\n' "$1"; }

say "GET /v1/health"
curl -sS "$API/v1/health" "${AUTH[@]}"

say "GET /v1/stats"
curl -sS "$API/v1/stats" "${AUTH[@]}"

say "GET /v1/launch/{address}"
curl -sS "$API/v1/launch/$TOKEN" "${AUTH[@]}"

say "POST /v1/launches"
curl -sS "$API/v1/launches" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"addresses\":[\"$TOKEN\",\"$OTHER\"]}"

say "GET /v1/openapi.json"
curl -sS "$API/v1/openapi.json" | head -c 400; echo

say "404, with what the address turned out to be"
# A deployer address rather than a token: the error says so.
curl -sS -w '\nHTTP %{http_code}\n' "$API/v1/launch/0xaf0df21629b8f9bc60c5504fda4a330220f0dc71" "${AUTH[@]}"

say "400, a malformed address"
curl -sS -w '\nHTTP %{http_code}\n' "$API/v1/launch/0xnope" "${AUTH[@]}"

say "429, the keyless rate, with Retry-After"
for _ in 1 2 3 4 5; do
  curl -sS -o /dev/null -D - "$API/v1/stats" | grep -iE '^(HTTP|retry-after|x-ratelimit)' || true
done
