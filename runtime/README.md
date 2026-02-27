# Semibot Runtime

Single-process local runtime for Semibot V2.

## Overview

Semibot Runtime is a Python-based local execution engine for AI agents. It provides:

- **Agent Orchestration**: LangGraph-based workflow execution
- **Local CLI + HTTP API**: single-process operation on one machine
- **Local Memory + Checkpoint**: session-local storage with snapshot sync
- **MCP Integration**: Model Context Protocol client for tool servers
- **Multi-LLM Support**: OpenAI, Anthropic, and custom providers
- **Audit Logging**: Comprehensive execution tracking

## Installation

### Prerequisites

- Python 3.11 or higher
- pip 26.0+

### Setup

#### Quick Install (Recommended)

```bash
cd /Users/yanghuaiyuan/Documents/AI/semibot-z1/runtime
./scripts/install.sh
```

The installer will:

1. Create `.venv`
2. Try `pip install -e .`
3. Fall back to linking `scripts/semibot` into `~/.local/bin` if offline build deps are unavailable
4. Auto-add Semibot path to your shell profile (`~/.zshrc` / `~/.bashrc` / `~/.profile`)

Disable auto profile update if needed:

```bash
AUTO_UPDATE_PROFILE=0 ./scripts/install.sh
```

#### Manual Setup

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
- `src/ws/` - Legacy control-plane bridge (compatibility)
- `src/session/` - Session manager and runtime adapters
- `src/memory/` - Local memory + control-plane proxy
- `src/checkpoint/` - Local checkpoint persistence
- `src/llm/` - LLM provider integrations
- `src/mcp/` - MCP client implementation
- `src/audit/` - Audit logging system
- `src/skills/` - Built-in skills (code execution, web search)

## Run

```bash
# Initialize local runtime home (~/.semibot by default)
semibot init

# Interactive chat
semibot chat

# CLI
semibot run "研究阿里巴巴股票并生成PDF报告"

# List built-in skills/tools
semibot skill list

# Search local memory/events
semibot memory search "Alibaba"

# Start local runtime service in background (pm2 managed)
semibot serve start --host 127.0.0.1 --port 8765

# Restart / stop runtime service
semibot serve restart
semibot serve stop

# Alternative entrypoint for API only
semibot-api

# Python module entry
python -m semibot run "写一份周报"

# Run task via HTTP API
curl -X POST http://127.0.0.1:8765/v1/tasks/run \
  -H "Content-Type: application/json" \
  -d '{"task":"研究阿里巴巴股票并生成PDF报告"}'

# Chat API (non-stream)
curl -X POST http://127.0.0.1:8765/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我做一个本周计划"}'

# Skills API
curl http://127.0.0.1:8765/v1/skills

# Sessions / agents / memory APIs
curl http://127.0.0.1:8765/v1/sessions
curl http://127.0.0.1:8765/v1/agents
curl "http://127.0.0.1:8765/v1/memories/search?query=plan"
```

## Configuration

Set environment variables:

```bash
OPENAI_API_KEY=your_key
ANTHROPIC_API_KEY=your_key
SEMIBOT_EVENTS_DB_PATH=~/.semibot/semibot.db
SEMIBOT_RULES_PATH=~/.semibot/rules
SEMIBOT_FEISHU_VERIFY_TOKEN=your_verify_token
SEMIBOT_FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

## Testing

```bash
# Run V2 CI-equivalent local gates (recommended)
./scripts/run_v2_ci_local.sh

# Run only core suites
pytest tests/events tests/server \
  tests/session/test_semigraph_adapter_ws.py \
  tests/agents/test_base.py \
  tests/orchestrator/test_unified_executor.py \
  tests/session/test_session_manager_requirements.py -q

# Run grouped E2E
pytest tests/e2e -m "e2e and e2e_collab" -q
pytest tests/e2e -m "e2e and e2e_approval" -q
pytest tests/e2e -m "e2e and e2e_scheduler" -q
pytest tests/e2e -m "e2e and e2e_dashboard" -q
pytest tests/e2e -m "e2e and e2e_research" -q
```

## License

MIT
