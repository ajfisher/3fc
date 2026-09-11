#!/usr/bin/env bash
set -euo pipefail

# No cookies, bearer proofs, fixture writes, or response bodies enter evidence.
ENVIRONMENT="${1:?environment required}"
SURFACE="${2:?api or site required}"
case "$ENVIRONMENT" in
  qa) APP_ORIGIN="https://qa.3fc.football" ;;
  prod) APP_ORIGIN="https://3fc.football" ;;
  *) exit 2 ;;
esac

if [ "$SURFACE" = api ]; then
  API_ID="$(jq -er '.httpApiId' "out/deploy/${ENVIRONMENT}/api-core-deploy-manifest.json")"
  API_ORIGIN="https://${API_ID}.execute-api.ap-southeast-2.amazonaws.com"
  for ROUTE in league-players game-player-registrations player-proofs/league-invitation player-proofs/league-invitation/revoke player-proofs/preview player-proofs/claim player-proofs/invitation player-proofs/invitation/revoke games/smoke-game/players/smoke-player/profile-invitation games/smoke-game/players/smoke-player/profile-invitation/revoke; do
    CODE="$(curl --max-time 20 -sS -o /dev/null -w '%{http_code}' -X POST \
      -H "origin: ${APP_ORIGIN}" -H 'content-type: application/json' \
      -d '{}' "${API_ORIGIN}/v1/${ROUTE}")"
    test "$CODE" = 401
  done
  for ROUTE in league-players player-proofs/league-invitation games/smoke-game/players/smoke-player/profile-invitation; do
    CODE="$(curl --max-time 20 -sS -o /dev/null -w '%{http_code}' \
      -H "origin: ${APP_ORIGIN}" "${API_ORIGIN}/v1/${ROUTE}")"
    test "$CODE" = 401
  done
elif [ "$SURFACE" = site ]; then
  for ROUTE in /link-player /link-player/; do
    PAGE="$(curl --max-time 20 -fsS "${APP_ORIGIN}${ROUTE}")"
    grep -q 'id="player-link-panel"' <<< "$PAGE"
    grep -q 'name="referrer" content="no-referrer"' <<< "$PAGE"
    grep -q '/ui/player-proof.js?v=' <<< "$PAGE"
  done
  ASSET="$(curl --max-time 20 -fsS "${APP_ORIGIN}/ui/player-proof.js")"
  grep -q 'threefc.player-proof.v1' <<< "$ASSET"
else
  exit 2
fi
echo "Profile-proof ${SURFACE} smoke passed (${ENVIRONMENT}); no credentials used."
