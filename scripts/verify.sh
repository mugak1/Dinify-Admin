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
#   4. test                (ng test, headless single run)
#   5. build:prod          (ng build --configuration=production)
#   6. mock-isolation gate (scans the build output from step 5)
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

run_step "type-check"          npm run type-check
run_step "lint"                npm run lint
run_step "design-token gate"   npm run check:tokens
run_step "test"                npm run test:ci
run_step "build:prod"          npm run build:prod
# Deliberately last: it reads dist/, which the step above produces.
run_step "mock-isolation gate" npm run check:mock-isolation

echo
echo "=================================================================="
if [ ${#failures[@]} -eq 0 ]; then
  echo ">>> ALL CHECKS PASSED"
  exit 0
fi
echo ">>> FAILED: ${failures[*]}"
exit 1
