# Semibot

[中文](./README.zh-CN.md) | [English](./README.en.md) | [日本語](./README.ja.md)

Semibot is a local-first general agent product.

- `apps/web`: Next.js Web UI
- `apps/api`: Node.js API
- `runtime`: Python runtime, CLI, built-in supervisor
- `packages/*`: shared config and types

This repository contains the Semibot core codebase used to build the release installer package and the local-first product runtime.

## Quick Start

```bash
curl -fsSL https://releases.semibot.ai/install.sh | bash
semibot init
semibot ui
```

## Public Core Export

Public Core is exported by:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
FORCE=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

Notes:

- `website` stays private and is not part of Public Core
- `docs/design/V2` stays private and is not part of Public Core
- `runtime/workspaces` and `runtime/.semibot` are internal state directories and are not exported

## License and Governance

- Source-available public core
- External contributions require `CLA`
- `Semibot`, logo, domains, and website content remain protected by trademark and brand policy

See:

- `LICENSE`
- `TRADEMARKS.md`
- `CLA.md`
- `CONTRIBUTING.md`
