# Semibot

[中文](./README.zh-CN.md) | [English](./README.en.md) | [日本語](./README.ja.md)

Semibot 是一个本地优先的通用 Agent 产品，包含：

- `apps/web`: Next.js Web UI
- `apps/api`: Node.js API
- `runtime`: Python runtime、CLI、内建 supervisor
- `packages/*`: 共享配置和类型

这个仓库包含 Semibot Core 代码，可用于构建 release 安装包以及本地优先产品运行时。

## 当前产品主路径

推荐的安装和运行方式：

```bash
curl -fsSL https://releases.semibot.ai/install.sh | bash
semibot init
semibot ui
```

当前默认更新源：

- 安装脚本：`https://releases.semibot.ai/install.sh`
- 更新清单：`https://releases.semibot.ai/stable/latest.json`
- Release 包基址：`https://releases.semibot.ai/stable`

## 本地开发

前置依赖：

- Node.js `20+`
- `pnpm 9+`
- Python `3.11+`

安装依赖：

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
pnpm install
python3 -m venv runtime/.venv
runtime/.venv/bin/pip install -r runtime/requirements.txt
```

开发模式：

```bash
pnpm dev
```

分别启动：

```bash
pnpm --dir apps/api dev
pnpm --dir apps/web dev
cd runtime && .venv/bin/python -m src.main serve start
```

产品态命令：

```bash
cd runtime
python -m src.main init
python -m src.main up
python -m src.main status
python -m src.main ui --no-open
```

## Release 构建

标准构建：

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
./scripts/build_release.sh
```

常用构建参数：

```bash
SKIP_BUILD=1 ./scripts/build_release.sh
INCLUDE_NODE_MODULES=1 ./scripts/build_release.sh
INCLUDE_RUNTIME_VENV=1 ./scripts/build_release.sh
```

产物位于：

- `.release/<version>/`
- `.release/current`
- `.release/semibot-<version>.tar.gz`
- `.release/latest.json`

## Public Core 导出

Public Core 白名单和边界见：

- `docs/design/V2/public-core-directory-boundary-v1.md`
- `docs/design/V2/open-core-and-licensing-strategy-v1.md`

导出命令：

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
FORCE=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

导出后最小验收：

```bash
FORCE=1 RUN_VALIDATION=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

说明：

- 导出脚本会保留公开仓库的 `.git`
- Public Core 验收允许 `INCLUDE_RUNTIME_VENV=0`
- 若宿主机使用 Node 22，传递依赖 `canvas` 可能需要系统级 `pkg-config` / `pixman`
- `website` 与 `docs/design/V2` 保持私有，不在 Public Core 中
- `runtime/workspaces` 与 `runtime/.semibot` 属于内部状态目录，不导出

## 公开/私有边界

明确保持私有：

- `website`
- `docs/design/V2`
- `runtime/workspaces`
- `runtime/.semibot`
- 内部实验目录、客户资料、内部脚本、私有 connector

Public Core 只包含可构建安装包所需的白名单内容。

## License 和品牌

当前策略：

- 公开仓库采用 source-available
- 外部贡献走 `CLA`
- `Semibot` 名称、Logo、域名、官网内容保留品牌权

相关文件：

- `LICENSE`
- `TRADEMARKS.md`
- `CLA.md`
- `CONTRIBUTING.md`

## 常用验证

```bash
pnpm --dir apps/api type-check
python3 -m pytest runtime/tests/test_cli.py -q
python3 -m compileall runtime/src
```

更完整的维护者教程见：

- `docs/design/V2/build-release-install-update-development-guide.md`
