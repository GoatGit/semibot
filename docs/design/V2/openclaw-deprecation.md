# OpenClaw Runtime Deprecation Notice

Status: deprecated
Effective date: 2026-03-02

## Decision

Semibot no longer uses the OpenClaw runtime path in active development/testing.
`semigraph` is the only supported runtime engine.

## Enforcement

1. API schema only accepts `runtimeType=semigraph`.
2. Runtime dispatch forces `runtime_type=semigraph`.
3. Historical sessions/agents with `runtimeType=openclaw` are downgraded to `semigraph` at runtime/service layer.
4. OpenClaw-focused E2E scenarios are disabled.

## Migration

No manual migration is required for existing data.
If old records still contain `openclaw`, they are treated as `semigraph` automatically.

## Future rule

Do not add new features, test cases, or operational dependencies based on OpenClaw runtime.
