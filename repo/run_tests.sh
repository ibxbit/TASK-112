#!/usr/bin/env sh
# WOGC — Docker-contained test runner.
#
# This script does NOT install or run anything on the host toolchain.
# Every test runs inside the `wogc-tests` container defined by
# `Dockerfile.test` and orchestrated by `docker-compose.test.yml`.
#
# Usage:
#   ./run_tests.sh           # unit_tests/ + API_tests/ (all)
#   ./run_tests.sh --unit    # only unit_tests/
#   ./run_tests.sh --api     # only API_tests/
#
# Requirements on the host: Docker 20+ with `docker compose` available.
# Nothing else.

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

SUITE="all"
for arg in "$@"; do
  case "$arg" in
    --unit) SUITE="unit" ;;
    --api)  SUITE="api"  ;;
    --all)  SUITE="all"  ;;
    -h|--help)
      echo "Usage: $0 [--unit|--api|--all]"
      echo ""
      echo "All tests execute inside a Docker container — no host toolchain required."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--unit|--api|--all]" >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' is required but was not found on PATH." >&2
  exit 1
fi

# Pick the right compose invocation (v2 plugin first, fall back to legacy v1).
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "ERROR: neither 'docker compose' (v2) nor 'docker-compose' (v1) is available." >&2
  exit 1
fi

echo "=========================================================="
echo " WOGC test runner (Docker-contained)"
echo " suite:   $SUITE"
echo " docker:  $(docker --version 2>/dev/null | head -n1)"
echo " compose: $($COMPOSE version 2>/dev/null | head -n1)"
echo "=========================================================="

# SUITE is picked up inside the test container as an env var and routed to
# the appropriate Vitest entry point (see Dockerfile.test CMD).
SUITE="$SUITE" $COMPOSE -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from wogc-tests
STATUS=$?

# Tear the stack down cleanly regardless of outcome.
$COMPOSE -f docker-compose.test.yml down --remove-orphans >/dev/null 2>&1 || true

echo ""
echo "=========================================================="
if [ "$STATUS" -eq 0 ]; then
  echo " RESULT: PASS"
else
  echo " RESULT: FAIL (exit $STATUS)"
fi
echo "=========================================================="

exit "$STATUS"
