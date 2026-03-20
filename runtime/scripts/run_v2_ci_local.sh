#!/usr/bin/env bash
set -euo pipefail

# Local mirror of V2 CI gates:
# 1) Core tests
# 2) E2E suites by capability group

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/6] Core suites"
python3 -m pytest \
  tests/events \
  tests/server \
  tests/session/test_semigraph_adapter_ws.py \
  tests/agents/test_base.py \
  tests/orchestrator/test_unified_executor.py \
  tests/session/test_session_manager_requirements.py \
  tests/test_bootstrap.py \
  tests/test_main_entry.py \
  tests/test_cli.py -q

echo "[2/6] E2E collab"
python3 -m pytest tests/e2e -m "e2e and e2e_collab" -q

echo "[3/6] E2E approval"
python3 -m pytest tests/e2e -m "e2e and e2e_approval" -q

echo "[4/6] E2E scheduler"
python3 -m pytest tests/e2e -m "e2e and e2e_scheduler" -q

echo "[5/6] E2E dashboard"
python3 -m pytest tests/e2e -m "e2e and e2e_dashboard" -q

echo "[6/6] E2E research"
python3 -m pytest tests/e2e -m "e2e and e2e_research" -q

echo "V2 CI local gates passed."
