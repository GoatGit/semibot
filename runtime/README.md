# Semibot Runtime

Execution-plane runtime for Semibot (WS client + per-session adapters).

## Overview

Semibot Runtime is a Python-based execution engine for AI agents. It provides:

- **Agent Orchestration**: LangGraph-based workflow execution
- **Execution Plane WS Client**: one VM connection multiplexing many sessions
- **Local Memory + Checkpoint**: session-local storage with snapshot sync
- **MCP Integration**: Model Context Protocol client for tool servers
- **Multi-LLM Support**: OpenAI, Anthropic, and custom providers
- **Audit Logging**: Comprehensive execution tracking

## Installation

### Prerequisites

- Python 3.11 or higher
- pip 26.0+

### Setup

```bash
# 1. Install Python 3.11+ (if not already installed)
# macOS:
brew install python@3.11

# Ubuntu/Debian:
sudo apt install python3.11 python3.11-venv

# 2. Create virtual environment
python3.11 -m venv .venv

# 3. Activate virtual environment
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 4. Upgrade pip
pip install --upgrade pip

# 5. Install project dependencies
pip install -e .

# 6. Install additional dependencies
pip install "aiohttp>=3.9.0" "docker>=7.0.0" \
    "opentelemetry-exporter-otlp>=1.26.0"

# 7. Install MCP SDK from GitHub
pip install "mcp @ git+https://github.com/modelcontextprotocol/python-sdk.git"

# 8. Install dev dependencies (optional)
pip install -e ".[dev]"
```

### Verify Installation

```bash
# Check Python version
python --version  # Should be 3.11+

# Run tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html
```

## Architecture

- `src/orchestrator/` - Agent workflow orchestration
- `src/ws/` - Control-plane WebSocket client
- `src/session/` - Session manager and runtime adapters
- `src/memory/` - Local memory + control-plane proxy
- `src/checkpoint/` - Local checkpoint persistence
- `src/llm/` - LLM provider integrations
- `src/mcp/` - MCP client implementation
- `src/audit/` - Audit logging system
- `src/skills/` - Built-in skills (code execution, web search)

## Run

```bash
python -m src.main
```

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
