# 任务：添加 LLM 模块测试

## 任务 ID
`runtime-llm-tests`

## 优先级
P1 - 高优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 1.4

## 问题描述

缺少针对 `llm/base.py`, `llm/router.py`, `llm/openai_provider.py`, `llm/anthropic_provider.py` 的测试文件。

## 需要创建的测试文件

### 1. `tests/llm/__init__.py`
空文件

### 2. `tests/llm/test_base.py`
测试基类:
- LLMResponse 创建和属性
- LLMResponse.tokens_input/output/total
- LLMConfig 创建和默认值
- LLMProvider.generate_plan() 计划生成
- LLMProvider.generate_response() 响应生成
- LLMProvider.reflect() 反思生成
- LLMProvider.health_check() 健康检查

### 3. `tests/llm/test_router.py`
测试路由器:
- LLMRouter 创建
- register_provider() 注册提供者
- get_provider() 获取提供者
- route_for_task() 任务路由
- chat() 基本调用
- chat() 自动回退
- chat() 无可用提供者
- chat_stream() 流式调用
- health_check_all() 批量健康检查
- create_router_from_config() 配置创建

### 4. `tests/llm/test_openai_provider.py`
测试 OpenAI 提供者:
- OpenAIProvider 创建
- chat() 成功响应
- chat() 工具调用
- chat() JSON 格式响应
- chat() 错误处理
- chat() 重试逻辑
- chat_stream() 流式响应
- _convert_tools() 工具格式转换

### 5. `tests/llm/test_anthropic_provider.py`
测试 Anthropic 提供者:
- AnthropicProvider 创建
- chat() 成功响应
- chat() 系统消息处理
- chat() 工具调用
- chat() JSON 格式响应
- chat() 温度范围限制
- chat_stream() 流式响应
- _convert_message() 消息格式转换
- _convert_tools() 工具格式转换

### 6. `tests/llm/conftest.py`
共享 fixtures:
- mock_openai_client
- mock_anthropic_client
- sample_messages
- sample_tools
- sample_llm_response

## 验收标准

- [ ] 所有测试文件已创建
- [ ] 测试覆盖率 >= 80%
- [ ] `pytest tests/llm/ -v` 全部通过
- [ ] API 调用正确 mock

## 实现步骤

1. 创建 `tests/llm/` 目录结构
2. 创建 conftest.py 共享 fixtures
3. 实现 test_base.py
4. 实现 test_router.py
5. 实现 test_openai_provider.py
6. 实现 test_anthropic_provider.py
7. 运行测试验证覆盖率
