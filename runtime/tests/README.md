# Runtime Tests

This directory contains comprehensive tests for the Semibot Runtime.

## Test Structure

```
tests/
├── agents/          # Agent base class tests
├── audit/           # Audit logging tests
├── e2e/             # End-to-end workflow tests
├── llm/             # LLM provider tests
├── memory/          # Memory module tests (unit + integration)
├── orchestrator/    # Orchestrator and nodes tests
├── queue/           # Queue producer/consumer tests
├── skills/          # Skill registry tests
└── utils/           # Utility function tests
```

## Running Tests

### Prerequisites

1. Install development dependencies:
```bash
pip install -e ".[dev]"
```

2. For integration tests, ensure services are running:
```bash
# Start Redis and PostgreSQL
docker-compose up -d redis postgres
```

### Run All Tests

```bash
# Run all unit tests
pytest

# Run with coverage report
pytest --cov=src --cov-report=html

# Run specific test file
pytest tests/orchestrator/test_nodes.py

# Run specific test
pytest tests/orchestrator/test_nodes.py::test_plan_node_creates_execution_plan
```

### Run Integration Tests

Integration tests require actual Redis and PostgreSQL instances:

```bash
# Set environment variable to enable integration tests
export RUN_INTEGRATION_TESTS=true
export REDIS_URL=redis://localhost:6379
export DATABASE_URL=postgresql://user:pass@localhost:5432/semibot_test

# Run only integration tests
pytest -m integration

# Run all tests including integration
pytest
```

### Run E2E Tests

End-to-end tests verify complete workflows:

```bash
# Run E2E tests
pytest tests/e2e/

# Run specific E2E test
pytest tests/e2e/test_full_agent_workflow.py::test_complete_agent_execution_flow
```

## Test Categories

### Unit Tests
- Fast, isolated tests with mocked dependencies
- No external services required
- Located in: `agents/`, `llm/`, `orchestrator/`, `skills/`, `utils/`

### Integration Tests
- Test interactions with real services (Redis, PostgreSQL)
- Require `RUN_INTEGRATION_TESTS=true` environment variable
- Located in: `memory/test_integration.py`, `queue/test_integration.py`

### Edge Case Tests
- Test boundary conditions and error handling
- Located in: `queue/test_edge_cases.py`

### End-to-End Tests
- Test complete Agent execution workflows
- Mock external dependencies but test full pipeline
- Located in: `e2e/`

## Coverage Goals

Target coverage by module:
- **Orchestrator**: 80%+ (nodes, executor, capability)
- **Memory**: 75%+ (short-term, long-term, embedding)
- **Queue**: 80%+ (producer, consumer, edge cases)
- **LLM**: 70%+ (providers, router)
- **Agents**: 70%+ (base, planner, executor)

## Writing New Tests

### Test Naming Convention
- Test files: `test_<module>.py`
- Test functions: `test_<functionality>_<scenario>`
- Use descriptive names that explain what is being tested

### Example Test Structure

```python
import pytest
from unittest.mock import AsyncMock

@pytest.fixture
def mock_dependency():
    """Create mock dependency."""
    return AsyncMock()

@pytest.mark.asyncio
async def test_feature_success_case(mock_dependency):
    """Test feature works correctly in success case."""
    # Arrange
    mock_dependency.method.return_value = "expected"

    # Act
    result = await function_under_test(mock_dependency)

    # Assert
    assert result == "expected"
    mock_dependency.method.assert_called_once()
```

### Async Tests
All async functions must use `@pytest.mark.asyncio` decorator:

```python
@pytest.mark.asyncio
async def test_async_function():
    result = await async_function()
    assert result is not None
```

### Integration Test Markers
Mark integration tests to allow selective execution:

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_redis_integration():
    # Test with real Redis
    pass
```

## Continuous Integration

Tests run automatically on:
- Pull requests
- Commits to main branch
- Nightly builds (including integration tests)

CI configuration:
- Unit tests: Always run
- Integration tests: Run on main branch and nightly
- E2E tests: Run on main branch

## Troubleshooting

### Tests Fail with "Connection Refused"
- Ensure Redis/PostgreSQL are running for integration tests
- Check service URLs in environment variables

### Tests Timeout
- Increase timeout in pytest.ini: `timeout = 30`
- Check for deadlocks in async code

### Import Errors
- Ensure package is installed: `pip install -e .`
- Check PYTHONPATH includes project root

### Flaky Tests
- Use `pytest-rerunfailures`: `pytest --reruns 3`
- Investigate race conditions in async code
- Add explicit waits or synchronization

## Test Fixtures

Common fixtures are defined in `conftest.py` files:
- `tests/conftest.py`: Global fixtures
- `tests/memory/conftest.py`: Memory-specific fixtures
- `tests/queue/conftest.py`: Queue-specific fixtures

## Performance Testing

For performance tests:
```bash
# Run with profiling
pytest --profile

# Run with timing
pytest --durations=10
```

## Contributing

When adding new features:
1. Write tests first (TDD approach)
2. Ensure coverage doesn't decrease
3. Add integration tests for external dependencies
4. Update this README if adding new test categories
