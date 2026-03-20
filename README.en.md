# Semibot

[中文](./README.zh-CN.md) | [English](./README.en.md) | [日本語](./README.ja.md)

Semibot is a local-first general agent product, including:

- `apps/web`: Next.js Web UI
- `apps/api`: Node.js API
- `runtime`: Python runtime, CLI, built-in supervisor
- `packages/*`: shared config and types

This repository contains the Semibot core codebase used to build the release installer package and the local-first product runtime.

## Product Entry Path

Recommended install and run flow:

```bash
curl -fsSL https://releases.semibot.ai/install.sh | bash
semibot init
semibot ui
```

Default update endpoints:

- Install script: `https://releases.semibot.ai/install.sh`
- Update manifest: `https://releases.semibot.ai/stable/latest.json`
- Release base URL: `https://releases.semibot.ai/stable`

## Local Development

Prerequisites:

- Node.js `20+`
- `pnpm 9+`
- Python `3.11+`

Install dependencies:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
pnpm install
python3 -m venv runtime/.venv
runtime/.venv/bin/pip install -r runtime/requirements.txt
```

Development mode:

```bash
pnpm dev
```

Start services individually:

```bash
pnpm --dir apps/api dev
pnpm --dir apps/web dev
cd runtime && .venv/bin/python -m src.main serve start
```

Product commands:

```bash
cd runtime
python -m src.main init
python -m src.main up
python -m src.main status
python -m src.main ui --no-open
```

## Release Build

Standard build:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
./scripts/build_release.sh
```

Common build flags:

```bash
SKIP_BUILD=1 ./scripts/build_release.sh
INCLUDE_NODE_MODULES=1 ./scripts/build_release.sh
INCLUDE_RUNTIME_VENV=1 ./scripts/build_release.sh
```

Artifacts are generated under:

- `.release/<version>/`
- `.release/current`
- `.release/semibot-<version>.tar.gz`
- `.release/latest.json`

## Public Core Export

Public Core boundary and allowlist are documented in:

- `docs/design/V2/public-core-directory-boundary-v1.md`
- `docs/design/V2/open-core-and-licensing-strategy-v1.md`

Export command:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
FORCE=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

Export with minimal validation:

```bash
FORCE=1 RUN_VALIDATION=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

Notes:

- The export script preserves `.git` in the public repository
- Public Core validation allows `INCLUDE_RUNTIME_VENV=0`
- On Node 22 hosts, the transitive `canvas` dependency may require system packages such as `pkg-config` and `pixman`
- `website` and `docs/design/V2` stay private and are not part of Public Core
- `runtime/workspaces` and `runtime/.semibot` are internal state directories and are not exported

## Public vs Private Boundary

The following stay private:

- `website`
- `docs/design/V2`
- `runtime/workspaces`
- `runtime/.semibot`
- Internal experiments, customer material, internal scripts, and private connectors

Public Core includes only the allowlisted content required to build the release installer package.

## License and Brand

Current policy:

- Public repository uses a source-available license
- External contributions require `CLA`
- The `Semibot` name, logo, domains, and website content remain protected by trademark/brand policy

Relevant files:

- `LICENSE`
- `TRADEMARKS.md`
- `CLA.md`
- `CONTRIBUTING.md`

## Common Validation

```bash
pnpm --dir apps/api type-check
python3 -m pytest runtime/tests/test_cli.py -q
python3 -m compileall runtime/src
```

For the full maintainer guide, see:

- `docs/design/V2/build-release-install-update-development-guide.md`
