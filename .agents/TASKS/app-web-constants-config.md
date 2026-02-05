## Task: 前端常量配置提取

**ID:** app-web-constants-config
**Label:** Semibot: 提取前端硬编码值到配置文件
**Description:** 创建 constants/config.ts 并提取所有硬编码值
**Type:** Refactor
**Status:** Pending
**Priority:** P0 - Critical
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/app-web-constants-config.md)

---

### Checklist

- [ ] 创建 `constants/config.ts` 文件
- [ ] 定义 `API_CONFIG` (超时、重试等)
- [ ] 定义 `UI_CONFIG` (尺寸、延迟等)
- [ ] 定义 `LAYOUT_CONFIG` (路径、宽度等)
- [ ] 定义 `STORAGE_KEYS` (存储键名)
- [ ] 定义 `ANIMATION_CONFIG` (动画参数)
- [ ] 定义 `PAGINATION_CONFIG` (分页参数)
- [ ] 更新 `chat/[sessionId]/page.tsx` - 移除 1500ms, 0.2s, 0.4s
- [ ] 更新 `stores/layoutStore.ts` - 移除路径数组
- [ ] 更新 `settings/page.tsx` - 移除示例密钥
- [ ] 更新 `mcp/page.tsx` - 移除硬编码占位符
- [ ] 更新 `Sidebar.tsx` - 处理演示数据
- [ ] 添加边界日志打印
- [ ] 配置 ESLint 规则禁止新硬编码

### 相关文件

- `apps/web/src/constants/config.ts` (新建)
- `apps/web/src/app/(dashboard)/chat/[sessionId]/page.tsx`
- `apps/web/src/stores/layoutStore.ts`
- `apps/web/src/app/(dashboard)/settings/page.tsx`
- `apps/web/src/app/(dashboard)/mcp/page.tsx`
- `apps/web/src/components/layout/Sidebar.tsx`
