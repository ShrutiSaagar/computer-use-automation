#!/usr/bin/env bash
# Regenerates evidence/ -- every replay scenario in the README, with stable
# directory names so the results are browsable and diffable in git.
#
# Discovery evidence is NOT regenerated here: those directories are the record of
# real LLM runs that already happened, and rerunning them costs money and would
# produce a different (equally valid) recording. `npm run learn` writes new ones.
set -euo pipefail
cd "$(dirname "$0")/.."
export CUA_EVIDENCE_STABLE=1
[ -f .env ] && set -a && . ./.env && set +a || true
: "${CU_CORE_OPERATOR_USERNAME:=svc.automation}"
: "${CU_CORE_OPERATOR_PASSWORD:=Tr0ubador-Demo-2026}"
export CU_CORE_OPERATOR_USERNAME CU_CORE_OPERATOR_PASSWORD

CAP=member.subaccount.open
A=http://localhost:4310
B=http://localhost:4311

cleanup() { kill %1 %2 2>/dev/null || true; }
trap cleanup EXIT
npx tsx target-app/server.ts --port=4310 >/dev/null 2>&1 &
npx tsx target-app/server.ts --tenant=b --port=4311 >/dev/null 2>&1 &
sleep 3

arm()  { curl -s -X POST -H 'content-type: application/json' -d "{\"mode\":\"$1\",\"times\":${2:-1}}" $A/_chaos/arm >/dev/null; }
clr()  { curl -s -X POST $A/_chaos/clear >/dev/null; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "success"
clr; npx tsx src/cli.ts replay --capability $CAP --label success \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00 || true

step "business outcome: member not found"
clr; npx tsx src/cli.ts replay --capability $CAP --label member-not-found \
  --input memberNumber=999999 --input accountType="Money Market" --input openingDeposit=50.00 || true

step "business outcome: deposit below minimum"
clr; npx tsx src/cli.ts replay --capability $CAP --label deposit-below-minimum \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=5.00 || true

step "recovered: session timeout mid-flow (re-auth, then restart)"
clr; arm session_timeout; npx tsx src/cli.ts replay --capability $CAP --label session-timeout-recovered \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00 || true

step "recovered: unexpected maintenance interstitial"
clr; arm interstitial; npx tsx src/cli.ts replay --capability $CAP --label interstitial-recovered \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00 || true

step "hard failure: unhandled application exception"
clr; arm error500; npx tsx src/cli.ts replay --capability $CAP --label app-error \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00 || true

step "hard failure: an unrecorded screen, with no operator attached"
clr; arm supervisor_override; npx tsx src/cli.ts replay --capability $CAP --label unrecorded-screen-no-operator \
  --input memberNumber=100482 --input accountType="Money Market" --input openingDeposit=50.00 || true

step "caller contract: bad input, refused before the browser opens"
clr; npx tsx src/cli.ts replay --capability $CAP --label invalid-input \
  --input memberNumber=abc --input accountType="Money Market" --input openingDeposit=50.00 || true

step "cross-tenant: the same artifact against a rebranded institution"
clr; npx tsx src/cli.ts replay --capability $CAP --label tenant-northstar \
  --overlay capabilities/$CAP/northstar-fcu.overlay.json \
  --input memberNumber=100483 --input accountType="Holiday Club" --input openingDeposit=75.00 || true

step "read-only capability"
clr; npx tsx src/cli.ts replay --capability member.shareSavings.lookup --label balance-lookup \
  --input memberNumber=100482 || true

printf '\n\033[1mevidence written:\033[0m\n'
ls -1 evidence | sed 's/^/  /'
