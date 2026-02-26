# V2 E2E Test Groups

## Marker groups

- `e2e_collab`: group-chat collaboration flows
- `e2e_approval`: HITL approval flows
- `e2e_scheduler`: heartbeat/cron trigger flows
- `e2e_dashboard`: dashboard streaming/cursor flows
- `e2e_research`: research/report generation flows (e.g. stock PDF report)

## Run by group

```bash
pytest tests/e2e -m "e2e and e2e_collab" -q
pytest tests/e2e -m "e2e and e2e_approval" -q
pytest tests/e2e -m "e2e and e2e_scheduler" -q
pytest tests/e2e -m "e2e and e2e_dashboard" -q
pytest tests/e2e -m "e2e and e2e_research" -q
```

## CI equivalence

Use:

```bash
./scripts/run_v2_ci_local.sh
```

This runs all core suites and all E2E groups in CI order.
