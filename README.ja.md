# Semibot - 半分の汎用エージェント

[中文](./README.zh-CN.md) | [English](./README.en.md) | [日本語](./README.ja.md)

仕事をこなし、知らせ、協調し、自分で強くなっていくカニ。

Semibot は、ローカルファーストで、インストール可能で、協調的かつ自己進化する汎用エージェント製品で、以下を含みます。

- `apps/web`: Next.js Web UI
- `apps/api`: Node.js API
- `runtime`: Python runtime、CLI、内蔵 supervisor
- `packages/*`: 共通設定と型

このリポジトリには、release インストーラパッケージとローカルファースト実行環境を構築するための Semibot Core コードベースが含まれます。

## プロダクトの起動導線

推奨インストールと起動手順:

```bash
curl -fsSL https://releases.semibot.ai/install.sh | bash
semibot init
semibot ui
```

デフォルトの更新エンドポイント:

- インストールスクリプト: `https://releases.semibot.ai/install.sh`
- 更新マニフェスト: `https://releases.semibot.ai/stable/latest.json`
- Release ベース URL: `https://releases.semibot.ai/stable`

## ローカル開発

前提条件:

- Node.js `20+`
- `pnpm 9+`
- Python `3.11+`

依存関係のインストール:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
pnpm install
python3 -m venv runtime/.venv
runtime/.venv/bin/pip install -r runtime/requirements.txt
```

開発モード:

```bash
pnpm dev
```

個別起動:

```bash
pnpm --dir apps/api dev
pnpm --dir apps/web dev
cd runtime && .venv/bin/python -m src.main serve start
```

プロダクトコマンド:

```bash
cd runtime
python -m src.main init
python -m src.main up
python -m src.main status
python -m src.main ui --no-open
```

## Release ビルド

標準ビルド:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
./scripts/build_release.sh
```

よく使うビルドオプション:

```bash
SKIP_BUILD=1 ./scripts/build_release.sh
INCLUDE_NODE_MODULES=1 ./scripts/build_release.sh
INCLUDE_RUNTIME_VENV=1 ./scripts/build_release.sh
```

生成物:

- `.release/<version>/`
- `.release/current`
- `.release/semibot-<version>.tar.gz`
- `.release/latest.json`

## Public Core のエクスポート

Public Core の境界と allowlist は以下にあります:

- `docs/design/V2/public-core-directory-boundary-v1.md`
- `docs/design/V2/open-core-and-licensing-strategy-v1.md`

エクスポートコマンド:

```bash
cd /Users/yanghuaiyuan/AI/semibot-internal
FORCE=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

最小検証つきエクスポート:

```bash
FORCE=1 RUN_VALIDATION=1 bash scripts/export_public_core.sh /Users/yanghuaiyuan/AI/semibot
```

補足:

- エクスポートスクリプトは公開リポジトリの `.git` を保持する
- Public Core 検証では `INCLUDE_RUNTIME_VENV=0` を許可する
- Node 22 環境では、推移的依存 `canvas` により `pkg-config` や `pixman` のようなシステムパッケージが必要になる場合がある
- `website` と `docs/design/V2` は非公開のままで、Public Core には含めない
- `runtime/workspaces` と `runtime/.semibot` は内部状態ディレクトリのため、エクスポートしない

## 公開/非公開の境界

以下は非公開のまま保持する:

- `website`
- `docs/design/V2`
- `runtime/workspaces`
- `runtime/.semibot`
- 内部実験、顧客向け資料、内部スクリプト、私有 connector

Public Core には、release インストーラパッケージをビルドするために必要な allowlist 済みの内容だけを含める。

## License とブランド

現在の方針:

- 公開リポジトリは source-available
- 外部コントリビューションには `CLA` が必要
- `Semibot` 名称、ロゴ、ドメイン、Website コンテンツは商標/ブランドポリシーで保護する

関連ファイル:

- `LICENSE`
- `TRADEMARKS.md`
- `CLA.md`
- `CONTRIBUTING.md`

## よく使う検証

```bash
pnpm --dir apps/api type-check
python3 -m pytest runtime/tests/test_cli.py -q
python3 -m compileall runtime/src
```

より詳しいメンテナ向けガイド:

- `docs/design/V2/build-release-install-update-development-guide.md`
