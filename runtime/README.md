# Semibot Runtime

AI Agent Execution Engine powered by LangGraph.

## Overview

Semibot Runtime is a Python-based execution engine for AI agents. It provides:

- **Agent Orchestration**: LangGraph-based workflow execution
- **Memory Management**: Short-term (Redis) and long-term (PostgreSQL) memory
- **Task Queue**: Redis-based distributed task queue
- **MCP Integration**: Model Context Protocol client for tool servers
- **Multi-LLM Support**: OpenAI, Anthropic, and custom providers
- **Audit Logging**: Comprehensive execution tracking

## Installation

```bash
# Install dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html
```

## Architecture

- `src/orchestrator/` - Agent workflow orchestration
- `src/memory/` - Memory management (short-term & long-term)
- `src/queue/` - Task queue system
- `src/llm/` - LLM provider integrations
- `src/mcp/` - MCP client implementation
- `src/audit/` - Audit logging system
- `src/skills/` - Built-in skills (code execution, web search)

## Configuration

Set environment variables:

```bash
OPENAI_API_KEY=your_key
ANTHROPIC_API_KEY=your_key
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://user:pass@localhost/db
```

## Testing

```bash
# Run all tests
pytest

# Run specific test file
pytest tests/orchestrator/test_nodes.py

# Run with coverage
pytest --cov=src --cov-report=term-missing
```

## License

MIT
