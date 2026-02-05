## Task: API 错误处理标准化

**ID:** app-api-error-standardization
**Label:** Semibot: 统一 API 错误抛出方式
**Description:** 将所有 throw { code } 改为使用 createError()，替换 console.log 为 logger
**Type:** Refactor
**Status:** Pending
**Priority:** P2 - Medium
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** N/A

---

### Checklist

#### 错误抛出标准化

- [ ] 修改 `api-keys.service.ts` 第 161, 169 行
- [ ] 修改 `auth.service.ts` 第 159, 237, 251, 299, 310, 323 行
- [ ] 修改 `organization.service.ts` 第 58, 97 行
- [ ] 检查并修改其他服务中的不规范抛出

#### 日志标准化

- [ ] 创建 `lib/logger.ts` 日志工具
- [ ] 替换 36 处 console.log/warn/error
- [ ] 配置日志级别 (dev/prod)
- [ ] 配置日志格式

### 相关文件

- `apps/api/src/services/api-keys.service.ts`
- `apps/api/src/services/auth.service.ts`
- `apps/api/src/services/organization.service.ts`
- `apps/api/src/lib/logger.ts` (新建)
