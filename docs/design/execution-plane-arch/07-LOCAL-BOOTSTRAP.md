# 07 - Local Bootstrap Runbook

This runbook describes how to wire local VM bootstrap for execution-plane refactor.

## 1. API scheduler trigger

`apps/api/src/scheduler/vm-scheduler.ts` supports:

- `VM_BOOTSTRAP_CMD`:
  - when set, scheduler will execute this command after creating/recovering VM instance
  - injected env vars:
    - `VM_USER_ID`
    - `VM_ORG_ID`
    - `VM_INSTANCE_ID`
    - `VM_MODE`
- default command in non-production:
  - if `VM_BOOTSTRAP_CMD` is empty and `scripts/vm/bootstrap-local.sh` exists, scheduler uses this script automatically
- `VM_BOOTSTRAP_COOLDOWN_MS`:
  - bootstrap retry cooldown window (default `30000`)
  - disconnected VM inside cooldown will not be re-triggered
- `VM_BOOTSTRAP_MAX_ATTEMPTS`:
  - max bootstrap attempts before marking VM as `failed` (default `5`)

## 2. Local bootstrap script

Use:

`scripts/vm/bootstrap-local.sh`
`scripts/vm/status-local.sh`
`scripts/vm/stop-local.sh`
`scripts/vm/rebootstrap-local.sh`

Required env for script:

- `VM_USER_ID`
- `VM_ORG_ID`
- `VM_INSTANCE_ID`
- `VM_TOKEN` (scheduler auto-signs and injects)

Optional env:

- `CONTROL_PLANE_WS` (default `ws://127.0.0.1:3101/ws/vm`)
- `RUNTIME_WORKDIR` (default `runtime`)
- `RUNTIME_LOG_DIR` (default `/tmp`)
- `VM_TICKET` (optional)

## 3. Suggested local wiring

Set in API env:

```bash
VM_BOOTSTRAP_CMD='scripts/vm/bootstrap-local.sh'
```

Scheduler now signs VM token automatically using `JWT_SECRET`, so no external token injector is required for local bootstrap.

## 4. Expected behavior

1. User sends chat, VM not ready.
2. API creates `user_vm_instances` record (`starting`).
3. Scheduler triggers `VM_BOOTSTRAP_CMD`.
4. Runtime process starts and connects `/ws/vm`.
5. WS server marks instance `ready`.
6. Chat retries and succeeds.

## 5. VM status/control API

- `GET /api/v1/vm/status`
  - returns current VM state for current user
  - includes: `status`, `instanceId`, `bootstrapAttempts`, `lastError`, `retryAfterMs`
- `POST /api/v1/vm/rebootstrap`
  - force triggers bootstrap (bypasses cooldown) and sets state to `provisioning` when triggered
