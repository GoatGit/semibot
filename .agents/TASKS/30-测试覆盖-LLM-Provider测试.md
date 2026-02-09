# 任务：LLM Provider 测试

**优先级**: 🟢 P2 - 中优先级
**类型**: 测试覆盖
**预估工时**: 1-2 天
**影响范围**: runtime/src/llm/

---

## 问题描述

LLM Provider 模块是与外部 AI 服务交互的核心组件，但缺少完整的测试覆盖。

---

## 需要测试的组件

| 文件 | 功能 | 测试重点 |
|------|------|----------|
| `base.py` | 基类 | 接口定义 |
| `openai_provider.py` | OpenAI 集成 | API 调用、错误处理 |
| `anthropic_provider.py` | Anthropic 集成 | API 调用、错误处理 |
| `azure_provider.py` | Azure OpenAI 集成 | API 调用、配置 |
| `factory.py` | Provider 工厂 | 创建逻辑 |

---

## 测试用例

### 1. 基类测试

```python
# runtime/tests/llm/test_base.py

import pytest
from abc import ABC
from src.llm.base import BaseLLMProvider, ChatMessage, ChatResponse


class TestBaseLLMProvider:
    """BaseLLMProvider 测试"""

    def test_is_abstract_class(self):
        """应该是抽象类"""
        assert issubclass(BaseLLMProvider, ABC)

    def test_cannot_instantiate_directly(self):
        """不能直接实例化"""
        with pytest.raises(TypeError):
            BaseLLMProvider()

    def test_chat_message_structure(self):
        """ChatMessage 结构正确"""
        msg = ChatMessage(role="user", content="Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"

    def test_chat_response_structure(self):
        """ChatResponse 结构正确"""
        response = ChatResponse(
            content="Hello!",
            tokens_used=10,
            tool_calls=None
        )
        assert response.content == "Hello!"
        assert response.tokens_used == 10
        assert response.tool_calls is None
```

### 2. OpenAI Provider 测试

```python
# runtime/tests/llm/test_openai_provider.py

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from src.llm.openai_provider import OpenAIProvider
from src.llm.base import ChatMessage


class TestOpenAIProvider:
    """OpenAIProvider 测试"""

    @pytest.fixture
    def provider(self):
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            return OpenAIProvider(model="gpt-4")

    @pytest.fixture
    def mock_client(self):
        return MagicMock()

    # ============================================================
    # 初始化测试
    # ============================================================

    def test_init_with_api_key(self):
        """使用 API Key 初始化"""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            provider = OpenAIProvider(model="gpt-4")
            assert provider.model == "gpt-4"

    def test_init_without_api_key_raises(self):
        """没有 API Key 应该报错"""
        with patch.dict('os.environ', {}, clear=True):
            with pytest.raises(ValueError, match="OPENAI_API_KEY"):
                OpenAIProvider(model="gpt-4")

    def test_init_with_custom_config(self):
        """使用自定义配置"""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            provider = OpenAIProvider(
                model="gpt-4",
                temperature=0.7,
                max_tokens=1000
            )
            assert provider.temperature == 0.7
            assert provider.max_tokens == 1000

    # ============================================================
    # Chat 方法测试
    # ============================================================

    @pytest.mark.asyncio
    async def test_chat_success(self, provider, mock_client):
        """成功调用 chat"""
        mock_response = MagicMock()
        mock_response.choices = [
            MagicMock(
                message=MagicMock(
                    content="Hello!",
                    tool_calls=None
                )
            )
        ]
        mock_response.usage.total_tokens = 15

        with patch.object(provider, '_client', mock_client):
            mock_client.chat.completions.create = AsyncMock(
                return_value=mock_response
            )

            messages = [ChatMessage(role="user", content="Hi")]
            response = await provider.chat(messages)

            assert response.content == "Hello!"
            assert response.tokens_used == 15

    @pytest.mark.asyncio
    async def test_chat_with_tools(self, provider, mock_client):
        """带工具的 chat 调用"""
        mock_tool_call = MagicMock()
        mock_tool_call.id = "call_123"
        mock_tool_call.function.name = "get_weather"
        mock_tool_call.function.arguments = '{"city": "Shanghai"}'

        mock_response = MagicMock()
        mock_response.choices = [
            MagicMock(
                message=MagicMock(
                    content=None,
                    tool_calls=[mock_tool_call]
                )
            )
        ]
        mock_response.usage.total_tokens = 20

        with patch.object(provider, '_client', mock_client):
            mock_client.chat.completions.create = AsyncMock(
                return_value=mock_response
            )

            messages = [ChatMessage(role="user", content="What's the weather?")]
            tools = [{"name": "get_weather", "description": "Get weather"}]

            response = await provider.chat(messages, tools=tools)

            assert response.tool_calls is not None
            assert len(response.tool_calls) == 1
            assert response.tool_calls[0]["name"] == "get_weather"

    @pytest.mark.asyncio
    async def test_chat_rate_limit_error(self, provider, mock_client):
        """速率限制错误处理"""
        from openai import RateLimitError

        with patch.object(provider, '_client', mock_client):
            mock_client.chat.completions.create = AsyncMock(
                side_effect=RateLimitError("Rate limit exceeded")
            )

            messages = [ChatMessage(role="user", content="Hi")]

            with pytest.raises(RateLimitError):
                await provider.chat(messages)

    @pytest.mark.asyncio
    async def test_chat_api_error(self, provider, mock_client):
        """API 错误处理"""
        from openai import APIError

        with patch.object(provider, '_client', mock_client):
            mock_client.chat.completions.create = AsyncMock(
                side_effect=APIError("API Error")
            )

            messages = [ChatMessage(role="user", content="Hi")]

            with pytest.raises(APIError):
                await provider.chat(messages)

    # ============================================================
    # 流式响应测试
    # ============================================================

    @pytest.mark.asyncio
    async def test_chat_stream(self, provider, mock_client):
        """流式响应"""
        async def mock_stream():
            chunks = [
                MagicMock(choices=[MagicMock(delta=MagicMock(content="Hello"))]),
                MagicMock(choices=[MagicMock(delta=MagicMock(content=" World"))]),
            ]
            for chunk in chunks:
                yield chunk

        with patch.object(provider, '_client', mock_client):
            mock_client.chat.completions.create = AsyncMock(
                return_value=mock_stream()
            )

            messages = [ChatMessage(role="user", content="Hi")]
            chunks = []

            async for chunk in provider.chat_stream(messages):
                chunks.append(chunk)

            assert len(chunks) == 2
            assert chunks[0] == "Hello"
            assert chunks[1] == " World"
```

### 3. Anthropic Provider 测试

```python
# runtime/tests/llm/test_anthropic_provider.py

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from src.llm.anthropic_provider import AnthropicProvider
from src.llm.base import ChatMessage


class TestAnthropicProvider:
    """AnthropicProvider 测试"""

    @pytest.fixture
    def provider(self):
        with patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'test-key'}):
            return AnthropicProvider(model="claude-3-sonnet")

    @pytest.mark.asyncio
    async def test_chat_success(self, provider):
        """成功调用 chat"""
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="Hello!")]
        mock_response.usage.input_tokens = 10
        mock_response.usage.output_tokens = 5

        with patch.object(provider, '_client') as mock_client:
            mock_client.messages.create = AsyncMock(return_value=mock_response)

            messages = [ChatMessage(role="user", content="Hi")]
            response = await provider.chat(messages)

            assert response.content == "Hello!"
            assert response.tokens_used == 15

    @pytest.mark.asyncio
    async def test_system_message_handling(self, provider):
        """系统消息处理"""
        # Anthropic 需要单独处理系统消息
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="Response")]
        mock_response.usage.input_tokens = 20
        mock_response.usage.output_tokens = 10

        with patch.object(provider, '_client') as mock_client:
            mock_client.messages.create = AsyncMock(return_value=mock_response)

            messages = [
                ChatMessage(role="system", content="You are helpful"),
                ChatMessage(role="user", content="Hi")
            ]
            await provider.chat(messages)

            # 验证系统消息被正确传递
            call_args = mock_client.messages.create.call_args
            assert "system" in call_args.kwargs
```

### 4. Factory 测试

```python
# runtime/tests/llm/test_factory.py

import pytest
from unittest.mock import patch
from src.llm.factory import create_provider
from src.llm.openai_provider import OpenAIProvider
from src.llm.anthropic_provider import AnthropicProvider


class TestProviderFactory:
    """Provider 工厂测试"""

    def test_create_openai_provider(self):
        """创建 OpenAI Provider"""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            provider = create_provider("openai", model="gpt-4")
            assert isinstance(provider, OpenAIProvider)

    def test_create_anthropic_provider(self):
        """创建 Anthropic Provider"""
        with patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'test-key'}):
            provider = create_provider("anthropic", model="claude-3-sonnet")
            assert isinstance(provider, AnthropicProvider)

    def test_create_unknown_provider_raises(self):
        """未知 Provider 应该报错"""
        with pytest.raises(ValueError, match="Unknown provider"):
            create_provider("unknown", model="test")

    def test_create_with_config(self):
        """使用配置创建 Provider"""
        with patch.dict('os.environ', {'OPENAI_API_KEY': 'test-key'}):
            provider = create_provider(
                "openai",
                model="gpt-4",
                temperature=0.5,
                max_tokens=500
            )
            assert provider.temperature == 0.5
            assert provider.max_tokens == 500
```

---

## 测试目录结构

```
runtime/tests/llm/
├── __init__.py
├── conftest.py              # 共享 fixtures
├── test_base.py             # 基类测试
├── test_openai_provider.py  # OpenAI 测试
├── test_anthropic_provider.py # Anthropic 测试
├── test_azure_provider.py   # Azure 测试
└── test_factory.py          # 工厂测试
```

---

## 修复清单

### 测试文件
- [ ] 创建 `tests/llm/conftest.py`
- [ ] 创建 `tests/llm/test_base.py`
- [ ] 创建 `tests/llm/test_openai_provider.py`
- [ ] 创建 `tests/llm/test_anthropic_provider.py`
- [ ] 创建 `tests/llm/test_azure_provider.py`
- [ ] 创建 `tests/llm/test_factory.py`

### 覆盖目标
- [ ] `base.py` 覆盖率 >= 90%
- [ ] `openai_provider.py` 覆盖率 >= 80%
- [ ] `anthropic_provider.py` 覆盖率 >= 80%
- [ ] `factory.py` 覆盖率 >= 90%

---

## 完成标准

- [ ] 所有 Provider 有测试
- [ ] 测试覆盖率 >= 80%
- [ ] 错误处理测试完整
- [ ] CI 集成通过
- [ ] 代码审查通过

---

## 相关文档

- [测试规范](docs/design/TESTING.md)
- [LLM 集成文档](docs/design/LLM.md)
