#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/backend"

echo "==> furl: Ruff"
ruff check .

echo "==> furl: basedpyright"
basedpyright

echo "==> furl: pytest"

set +e
uv run pytest -q
TEST_STATUS=$?
set -e

if [[ "$TEST_STATUS" -ne 0 && "$TEST_STATUS" -ne 5 ]]; then
    exit "$TEST_STATUS"
fi

cd "$ROOT/frontend"

echo "==> furl: TypeScript"
npx tsc --noEmit

echo "==> furl: Vitest"
npx vitest run --passWithNoTests

echo "==> furl: All checks passed"
