# Skills Metadata 与安装设计（V2）

## 1. 目标

为 Semibot 提供统一的技能索引能力，解决三件事：

1. 技能很多时，会话启动不做全量重载。
2. 前端/CLI/Tool 安装技能后可立即被 runtime 发现。
3. LLM 在能力不足时可走“搜索技能 → 下载 → 安装 → 继续执行”闭环。

---

## 2. Metadata（轻索引）定义

`skills metadata` 采用单一索引文件保存，建议路径：

- `~/.semibot/skills/.index.json`

每条记录字段：

- `skill_id`: 技能唯一 ID（slug）
- `name`: 展示名
- `description`: 简介（用于 planner 注入）
- `version`: 版本（默认 `0.0.0-local`）
- `source`: `local | zip | url | manual`
- `installed_path`: 本地目录（`~/.semibot/skills/<skill_id>`）
- `entry_script`: 默认 `scripts/main.py`
- `skill_md_path`: 默认 `SKILL.md`
- `tags`: 标签数组
- `requires`: 依赖声明（`binaries/env_vars/python`）
- `enabled`: 是否启用
- `status`: `active | disabled | invalid`
- `hash`: 内容 hash（目录签名）
- `mtime`: 最近扫描时间
- `created_at`
- `updated_at`

---

## 3. 如何生成

索引生成入口统一由 `skill_installer`/索引器负责：

1. 校验技能包结构（至少 `scripts/main.py`，建议含 `SKILL.md`）。
2. 解析描述与依赖。
3. 计算目录 hash。
4. 写入/更新 `.index.json`。

兜底：若索引文件不存在或损坏，runtime 启动时可执行一次全量重建。

---

## 4. 如何更新

更新触发源：

1. `skill_installer` 安装/覆盖/删除
2. `skill_installer(refresh_only=true)`
3. 手动 `reindex`（CLI/API）
4. 启动时轻量校验（发现漂移则修复）

更新策略：

1. 默认增量（按 `mtime/hash` 判断变更）
2. 周期性全量校验（低频）
3. 失败条目标记 `status=invalid`，保留错误信息，便于排障

---

## 5. 如何使用

### 5.1 Planner 注入

注入“轻索引”字段（`id/name/description/tags/requires/enabled/source`），不注入全文 `SKILL.md`。

### 5.2 执行时懒加载

实际调用技能时才读取 `scripts/main.py`/`SKILL.md`，降低会话启动耗时。

### 5.3 前端技能页

技能列表以 metadata 为主数据源；无须逐目录深度扫描。

---

## 6. Web 安装：Zip + 目录

Web 端同时支持两种来源：

1. 上传 Zip（主流程）
2. 上传目录（前端 `webkitdirectory` 选择目录后，在浏览器端打包为 zip，再复用同一上传接口）

说明：后端仅需维护一个“zip 安装协议”，目录上传由前端适配成 zip，减少服务端复杂度。

---

## 7. API 设计（已实现）

### 7.1 安装技能（已实现）

`POST /v1/skills/install`

请求（multipart 或 JSON 二选一）：

- `source_path`（本地路径）
- `source_url`（远程 zip URL）
- `archive`（上传 zip）
- `skill_name`（可选）
- `force`（可选）

响应：

- `ok`
- `skill_id`
- `installed_path`
- `index_updated`
- `registered_in_runtime`（当前会话是否已刷新）

### 7.2 仅刷新索引（已实现）

`POST /v1/skills/reindex`

请求：

- `scope`: `incremental | full`（默认 incremental）

响应：

- `updated`
- `added`
- `removed`
- `invalid`

### 7.3 刷新会话 runtime 索引（已实现）

`POST /v1/skills/refresh-runtime`

请求：

- `session_id`（可选，不传则当前会话）

响应：

- `reloaded`
- `new_tools`
- `skipped`

---

## 8. 与当前实现对齐（完成）

1. Runtime 内建 `skill_installer` 支持本地目录/zip/URL 安装与 `refresh_only`。
2. `~/.semibot/skills/.index.json` 已落地，支持增量/全量重建。
3. Runtime API 已提供：
  - `POST /v1/skills/install`
  - `POST /v1/skills/reindex`
  - `POST /v1/skills/refresh-runtime`
4. API 层已提供对应代理：
  - `/api/v1/runtime/skills/install`
  - `/api/v1/runtime/skills/install/upload`
  - `/api/v1/runtime/skills/reindex`
  - `/api/v1/runtime/skills/refresh-runtime`
5. Web 技能页支持 zip 上传和目录上传（目录前端打包 zip）。
