# Semibot

Semibot 是一个本地优先的通用 Agent 产品，包含：

- `apps/web`: Next.js Web UI
- `apps/api`: Node.js API
- `runtime`: Python runtime、CLI、内建 supervisor
- `packages/*`: 共享配置和类型

这个仓库是 **Public Core**。  
它可以独立构建 release 安装包，但不包含内部工作目录、私有文档、官网仓库和其他私有资产。

## 安装

推荐安装方式：

```bash
curl -fsSL https://releases.semibot.ai/install.sh | bash
semibot init
semibot ui
```

默认更新源：

- 安装脚本：`https://releases.semibot.ai/install.sh`
- 更新清单：`https://releases.semibot.ai/stable/latest.json`
- Release 包基址：`https://releases.semibot.ai/stable`

常用命令：

```bash
semibot init
semibot up
semibot down
semibot status
semibot doctor
semibot ui
semibot logs
semibot upgrade
```

## 本地开发

前置依赖：

- Node.js `20+`
- `pnpm 9+`
- Python `3.11+`

安装依赖：

```bash
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

Public Core 构建前提：

- Public Core 验收允许 `INCLUDE_RUNTIME_VENV=0`
- 若导出树未复用已有依赖缓存，`pnpm install` 需要联网
- Node 22 下，传递依赖 `canvas` 可能尝试本地编译
- 若没有预编译二进制，宿主机可能需要 `pkg-config` 和 `pixman` 开发库

## 仓库结构

```text
semibot/
├── apps/
│   ├── api/
│   └── web/
├── packages/
│   ├── shared-config/
│   └── shared-types/
├── runtime/
├── scripts/
└── tests/
```

Public Core 明确不包含：

- 官网仓库
- 私有设计文档
- 内部工作目录
- 本地状态目录
- 构建产物和本地缓存

## 许可、商标、贡献

本仓库不是 MIT / Apache 这类宽松开源协议。当前采用 **source-available** 模型。

你可以：

- 查看源码
- 下载源码
- 进行评估、研究、测试和非商业内部开发

你不能在未获得授权的情况下：

- 商业托管
- 商业再分发
- 以实质相同的产品或服务形式商业化 Semibot
- 使用 `Semibot` 品牌暗示官方关系

详情见：

- `LICENSE`
- `TRADEMARKS.md`
- `CLA.md`
- `CONTRIBUTING.md`

所有外部贡献都要求接受 CLA。

## 常用验证

```bash
pnpm --dir apps/api type-check
python3 -m pytest runtime/tests/test_cli.py -q
python3 -m compileall runtime/src
```
