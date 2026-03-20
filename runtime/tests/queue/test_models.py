"""Tests for TaskPayload and TaskMessage models."""

import uuid

import pytest


class TestTaskPayload:
    """Tests for TaskPayload dataclass."""

    def test_to_dict_basic(self):
        """Test basic serialization."""
        # Import here to avoid module loading issues
        from tests.queue.conftest import TaskPayload

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[{"role": "user", "content": "Hello"}],
            task_id="task_001",
        )

        result = payload.to_dict()

        assert result["task_id"] == "task_001"
        assert result["session_id"] == "sess_123"
        assert result["agent_id"] == "agent_456"
        assert result["org_id"] == "org_789"
        assert result["messages"] == [{"role": "user", "content": "Hello"}]
        assert result["config"] == {}
        assert result["metadata"] == {}

    def test_to_dict_with_config_and_metadata(self):
        """Test serialization with config and metadata."""
        from tests.queue.conftest import TaskPayload

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[],
            config={"temperature": 0.7},
            metadata={"source": "api"},
            task_id="task_002",
        )

        result = payload.to_dict()

        assert result["config"] == {"temperature": 0.7}
        assert result["metadata"] == {"source": "api"}

    def test_auto_generated_task_id(self):
        """Test that task_id is auto-generated if not provided."""
        from tests.queue.conftest import TaskPayload

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[],
        )

        # Should be a valid UUID
        assert payload.task_id is not None
        uuid.UUID(payload.task_id)  # Will raise if invalid

    def test_multiple_messages(self):
        """Test with multiple messages."""
        from tests.queue.conftest import TaskPayload

        messages = [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=messages,
        )

        result = payload.to_dict()
        assert len(result["messages"]) == 3
        assert result["messages"][0]["role"] == "system"
        assert result["messages"][1]["role"] == "user"
        assert result["messages"][2]["role"] == "assistant"


class TestTaskMessage:
    """Tests for TaskMessage dataclass."""

    def test_from_dict_basic(self):
        """Test basic deserialization."""
        from tests.queue.conftest import TaskMessage

        data = {
            "task_id": "task_001",
            "session_id": "sess_123",
            "agent_id": "agent_456",
            "org_id": "org_789",
            "messages": [{"role": "user", "content": "Hello"}],
            "config": {},
            "metadata": {},
        }

        task = TaskMessage.from_dict(data)

        assert task.task_id == "task_001"
        assert task.session_id == "sess_123"
        assert task.agent_id == "agent_456"
        assert task.org_id == "org_789"
        assert task.messages == [{"role": "user", "content": "Hello"}]

    def test_from_dict_with_defaults(self):
        """Test deserialization with missing optional fields."""
        from tests.queue.conftest import TaskMessage

        data = {
            "task_id": "task_001",
            "session_id": "sess_123",
            "agent_id": "agent_456",
            "org_id": "org_789",
        }

        task = TaskMessage.from_dict(data)

        assert task.messages == []
        assert task.config == {}
        assert task.metadata == {}

    def test_from_dict_empty_data(self):
        """Test deserialization with empty data."""
        from tests.queue.conftest import TaskMessage

        task = TaskMessage.from_dict({})

        assert task.task_id == ""
        assert task.session_id == ""
        assert task.agent_id == ""
        assert task.org_id == ""
        assert task.messages == []

    def test_to_dict(self):
        """Test serialization."""
        from tests.queue.conftest import TaskMessage

        task = TaskMessage(
            task_id="task_001",
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[{"role": "user", "content": "Hello"}],
            config={"key": "value"},
            metadata={"retry_count": 1},
        )

        result = task.to_dict()

        assert result["task_id"] == "task_001"
        assert result["session_id"] == "sess_123"
        assert result["config"] == {"key": "value"}
        assert result["metadata"] == {"retry_count": 1}

    def test_roundtrip(self):
        """Test serialization/deserialization roundtrip."""
        from tests.queue.conftest import TaskMessage, TaskPayload

        original = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[{"role": "user", "content": "Hello"}],
            config={"temperature": 0.7},
            metadata={"source": "test"},
            task_id="task_001",
        )

        # Serialize TaskPayload
        data = original.to_dict()

        # Deserialize to TaskMessage
        task = TaskMessage.from_dict(data)

        assert task.task_id == original.task_id
        assert task.session_id == original.session_id
        assert task.agent_id == original.agent_id
        assert task.org_id == original.org_id
        assert task.messages == original.messages
        assert task.config == original.config
        assert task.metadata == original.metadata

        # Serialize TaskMessage back
        data2 = task.to_dict()
        assert data == data2
