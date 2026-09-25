#!/usr/bin/env bash
#
# scripts/verify.sh — local pre-PR verification for Dinify Admin.
#
# Runs the same checks as CI (.github/workflows/ci.yml), in the same order. This
# script is the single committed source of truth for these checks; if a command
# changes, change it here AND in CI.
#
#   1. type-check          (tsc --noEmit)
#   2. lint                (eslint .)
#   3. design-token gate   (--self-test, then the real scan — fail fast)
#   4. claim-code gate     (--self-test, then the real scan — a raw owner claim code
#                           reaches no storage, log, URL, store or fabricated link)
#   5. dependency-audit evaluator tests (OFFLINE — fixtures only; proves the policy
#                           can pass and refuse; scans nothing)
#   6. guard qualification tests (OFFLINE — proves the mock-isolation gate fires, incl.
#                           real optimized builds of deliberately broken workspace copies)
#   7. test                (ng test, headless single run)
#   8. build:prod          (ng build --configuration=production)
#   9. mock-isolation gate (--self-test, then scans the build output from step 8)
#  10. dependency audit    (NETWORK — scans the inventory snapshotted before step 1
#                           against the public advisory database and enforces the
#                           policy; a scan that cannot complete FAILS, it is never
#                           skipped. See dependency-audit/README.md)
#
# There is no `/dinify-check` for this repo — that command is backend-only. CI is the
# gate; this is the local mirror of it.
#
#   ./scripts/verify.sh
#
# Every step runs even if an earlier one fails, so you see all problems at once; the
# script exits non-zero if any step failed. Assumes dependencies are installed
# (`npm ci` — no --legacy-peer-deps, see CLAUDE.md).

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failures=()

run_step() {
  local label="$1"; shift
  echo
  echo "=================================================================="
  echo ">>> ${label}"
  echo "=================================================================="
  if "$@"; then
    echo "--- ${label}: PASS"
  else
    echo "--- ${label}: FAIL"
    failures+=("${label}")
  fi
}

# The inventory snapshot is taken first, exactly as in CI, so the scan in the last step
# is bound to the tree that everything in between validated.
run_step "dependency-audit inventory snapshot (offline)" npm run audit:snapshot
run_step "type-check"          npm run type-check
run_step "lint"                npm run lint
run_step "design-token gate"   npm run check:tokens
run_step "claim-code gate"     npm run check:claim-code
run_step "dependency-audit evaluator tests (offline)" npm run test:audit
run_step "guard qualification tests (offline)" npm run test:guards
run_step "test"                npm run test:ci
run_step "build:prod"          npm run build:prod
# Deliberately last: it reads dist/, which the step above produces.
run_step "mock-isolation gate" npm run check:mock-isolation
# NETWORK. Required: an unreachable advisory service fails this run; it does not pass.
run_step "dependency audit (network: public advisory database)" npm run audit:deps

echo
echo "=================================================================="
if [ ${#failures[@]} -eq 0 ]; then
  echo ">>> ALL CHECKS PASSED"
  exit 0
fi
echo ">>> FAILED: ${failures[*]}"
exit 1
