# CI 门禁与分组策略（V2）

> 目标：把“能跑的测试”变成“持续可守的发布门槛”。

> 分支保护实操见：`branch-protection.md`

## 1. GitHub Actions Job 分组

文件：`.github/workflows/test.yml`

- `Python Core Tests`
- `Python E2E (collab)`
- `Python E2E (approval)`
- `Python E2E (scheduler)`
- `Python E2E (dashboard)`
- `Python E2E (research)`

说明：
- Core 负责稳定主干能力（events/server/session/orchestrator 关键路径）
- E2E 按业务链路切分，减少单个超长 job，定位失败更快

## 2. Branch Protection 建议 Required Checks

在 GitHub 仓库 `Settings -> Branches -> Branch protection rules` 中，建议至少勾选：

1. `Node.js Tests`
2. `Python Core Tests`
3. `Python E2E (collab)`
4. `Python E2E (approval)`
5. `Python E2E (scheduler)`
6. `Python E2E (dashboard)`
7. `Python E2E (research)`

> 上述名称与 `.github/workflows/test.yml` 的 job 名字保持一致，建议直接按此字符串配置。

## 2.1 可复制配置清单

```text
Node.js Tests
Python Core Tests
Python E2E (collab)
Python E2E (approval)
Python E2E (scheduler)
Python E2E (dashboard)
Python E2E (research)
```

## 2.2 建议保护项

- Require a pull request before merging
- Require approvals: 1+
- Dismiss stale pull request approvals when new commits are pushed
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Do not allow bypassing the above settings

## 3. 本地对齐 CI 的命令

```bash
cd runtime
./scripts/run_v2_ci_local.sh
```

脚本会依次执行 Core + 5 组 E2E，作为提交前自检。

## 4. E2E Marker 约定

在 `runtime/pytest.ini` 注册：

- `e2e`
- `e2e_collab`
- `e2e_approval`
- `e2e_scheduler`
- `e2e_dashboard`
- `e2e_research`

所有新增 E2E 必须带 `e2e` + 至少一个子分组 marker。

## 5. PR 自检模板

仓库已提供：`.github/pull_request_template.md`

- 要求提交者勾选 Core + 5 组 E2E 自检结果
- 用于在 Code Review 前明确质量状态
