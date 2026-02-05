## Task: Add LLM Providers Table

**ID:** db-add-llm-providers-table
**Label:** Semibot: 添加 LLM Providers 多模型支持表
**Description:** 创建 llm_providers、llm_models、llm_fallback_rules 表支持多模型配置和降级策略
**Type:** Feature
**Status:** Completed
**Priority:** High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/db-add-llm-providers-table.md)

---

### Checklist

- [x] 创建迁移脚本 `006_add_llm_providers.sql`
- [x] 创建 `llm_providers` 表
- [x] 创建 `llm_models` 表
- [x] 创建 `llm_fallback_rules` 表
- [x] 创建种子数据文件 `003_sample_llm_providers.sql`
- [x] 添加主流提供商（OpenAI、Anthropic、Google、DeepSeek、Ollama）
- [x] 添加常用模型配置（含定价信息）
- [ ] 创建 Repository 和 Service 层代码 (后续任务)
- [ ] 编写单元测试 (后续任务)
