# Branch Protection 配置手册（实操）

> 目标：把 V2 CI 门禁真正绑定到 `main` 分支，避免“测试存在但可绕过”。

## 1. 配置入口

1. 打开 GitHub 仓库页面
2. 进入 `Settings`
3. 左侧选择 `Branches`
4. 在 `Branch protection rules` 点击 `Add rule`
5. `Branch name pattern` 填：`main`

## 2. 必开选项（建议）

- `Require a pull request before merging`
- `Require approvals`：`1`（至少）
- `Dismiss stale pull request approvals when new commits are pushed`
- `Require status checks to pass before merging`
- `Require branches to be up to date before merging`
- `Do not allow bypassing the above settings`

## 3. Required status checks（精确名称）

把以下检查项加入 Required checks：

```text
Node.js Tests
Python Core Tests
Python E2E (collab)
Python E2E (approval)
Python E2E (scheduler)
Python E2E (dashboard)
Python E2E (research)
```

说明：
- 名称来自 `.github/workflows/test.yml` 的 job 名
- 如果你修改了 workflow job name，这里也要同步更新

## 4. 首次启用后的验证

1. 新建一个测试 PR（哪怕只改文档）
2. 确认上述 7 个检查都出现且全部通过
3. 尝试在检查未通过时合并，确认被阻止
4. 再恢复改动，确保流程正常

## 5. 维护规则

- 新增 E2E 分组时：
  - 先在 `runtime/pytest.ini` 增加 marker
  - 再在 `.github/workflows/test.yml` 增加 job/matrix
  - 最后把新检查名加入本文件与 `ci-gates.md`
