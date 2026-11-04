#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/backend"

echo "==> rebase: Ruff"
ruff check .

echo "==> rebase: basedpyright"
basedpyright

echo "==> rebase: pytest"

set +e
uv run pytest -q
TEST_STATUS=$?
set -e

if [[ "$TEST_STATUS" -ne 0 && "$TEST_STATUS" -ne 5 ]]; then
    exit "$TEST_STATUS"
fi

cd "$ROOT/frontend"

echo "==> rebase: TypeScript"
npx tsc --noEmit

echo "==> rebase: Vitest"
npx vitest run --passWithNoTests

echo "==> rebase: All checks passed"
