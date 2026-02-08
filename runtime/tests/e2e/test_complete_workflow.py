"""
端到端测试：完整工作流

测试从 RuntimeSessionContext 创建到 action 执行、审计日志记录的完整流程。
"""

import pytest
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    RuntimePolicy,
)
from src.orchestrator.capability import CapabilityGraph
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.orchestrator.state import PlanStep
from src.skills.registry import SkillRegistry, SkillMetadata
from src.skills.base import BaseSkill, ToolResult
from src.audit.logger import AuditLogger
from src.audit.storage import InMemoryAuditStorage
from src.audit.models import AuditQuery, AuditEventType


# 测试用 skills
class E2ESearchSkill(BaseSkill):
    """测试搜索 skill"""

    name = "test_search"
    description = "Test search skill"

    def __init__(self):
        super().__init__(config={})

    async def execute(self, query: str, **kwargs) -> ToolResult:
        return ToolResult(
            result=f"Search results for: {query}",
            success=True,
        )


class E2EAnalyzeSkill(BaseSkill):
    """测试分析 skill"""

    name = "test_analyze"
    description = "Test analyze skill"

    def __init__(self):
        super().__init__(config={})

    async def execute(self, data: str, **kwargs) -> ToolResult:
        return ToolResult(
            result=f"Analysis of: {data}",
            success=True,
        )


class E2EFailingSkill(BaseSkill):
    """测试失败的 skill"""

    name = "test_failing"
    description = "Test failing skill"

    def __init__(self):
        super().__init__(config={})

    async def execute(self, **kwargs) -> ToolResult:
        raise Exception("Intentional failure")


@pytest.fixture
def skill_registry():
    """创建 skill registry"""
    registry = SkillRegistry()
    registry.register_skill(
        E2ESearchSkill(),
        metadata=SkillMetadata(version="1.0.0", source="test"),
    )
    registry.register_skill(
        E2EAnalyzeSkill(),
        metadata=SkillMetadata(version="1.0.0", source="test"),
    )
    registry.register_skill(
        E2EFailingSkill(),
        metadata=SkillMetadata(version="1.0.0", source="test"),
    )
    return registry


@pytest.fixture
def audit_logger():
    """创建 audit logger"""
    storage = InMemoryAuditStorage()
    logger = AuditLogger(storage=storage, batch_size=10, flush_interval=5.0)
    return logger


@pytest.fixture
def runtime_context():
    """创建 runtime context"""
    return RuntimeSessionContext(
        org_id="test_org",
        user_id="test_user",
        agent_id="test_agent",
        session_id="test_session",
        agent_config=AgentConfig(
            id="test_agent",
            name="Test Agent",
        ),
        available_skills=[
            SkillDefinition(
                id="skill_1",
                name="test_search",
                description="Test search skill",
                version="1.0.0",
            ),
            SkillDefinition(
                id="skill_2",
                name="test_analyze",
                description="Test analyze skill",
                version="1.0.0",
            ),
            SkillDefinition(
                id="skill_3",
                name="test_failing",
                description="Test failing skill",
                version="1.0.0",
            ),
        ],
        runtime_policy=RuntimePolicy(
            max_iterations=10,
            require_approval_for_high_risk=True,
            high_risk_tools=["test_analyze"],
        ),
    )


@pytest.mark.asyncio
async def test_complete_workflow_success(
    runtime_context, skill_registry, audit_logger
):
    """测试成功的完整工作流"""
    # 启动 audit logger
    await audit_logger.start()

    try:
        # 1. 构建能力图
        capability_graph = CapabilityGraph(runtime_context)
        capability_graph.build()

        # 验证能力图
        assert len(capability_graph.list_capabilities()) == 3
        assert capability_graph.validate_action("test_search")
        assert capability_graph.validate_action("test_analyze")

        # 2. 创建执行器
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            audit_logger=audit_logger,
        )

        # 3. 执行 action
        action = PlanStep(
            id="step_1",
            title="Test search",
            tool="test_search",
            params={"query": "Python"},
        )

        result = await executor.execute(action)

        # 4. 验证结果
        assert result.success is True
        assert "Search results for: Python" in result.result
        assert result.metadata is not None
        assert result.metadata["capability_type"] == "skill"
        assert result.metadata["source"] == "test"
        assert result.metadata["version"] == "1.0.0"

        # 5. 刷新审计日志
        await audit_logger.flush()

        # 6. 验证审计日志
        events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )

        # 应该有 ACTION_STARTED 和 ACTION_COMPLETED
        assert len(events) == 2

        started_events = [
            e for e in events if e.event_type == AuditEventType.ACTION_STARTED
        ]
        completed_events = [
            e for e in events if e.event_type == AuditEventType.ACTION_COMPLETED
        ]

        assert len(started_events) == 1
        assert len(completed_events) == 1

        # 验证事件内容
        started = started_events[0]
        assert started.action_name == "test_search"
        assert started.action_params == {"query": "Python"}
        assert started.capability_type == "skill"

        completed = completed_events[0]
        assert completed.action_name == "test_search"
        assert completed.success is True
        assert completed.duration_ms > 0

    finally:
        await audit_logger.stop()


@pytest.mark.asyncio
async def test_complete_workflow_with_approval(
    runtime_context, skill_registry, audit_logger
):
    """测试带审批的完整工作流"""
    # 审批钩子
    approval_granted = True

    async def approval_hook(tool_name: str, params: dict) -> bool:
        return approval_granted

    await audit_logger.start()

    try:
        # 创建执行器（带审批钩子）
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            approval_hook=approval_hook,
            audit_logger=audit_logger,
        )

        # 执行高风险 action
        action = PlanStep(
            id="step_1",
            title="Test analyze",
            tool="test_analyze",
            params={"data": "test data"},
        )

        result = await executor.execute(action)

        # 验证结果
        assert result.success is True
        assert result.metadata["requires_approval"] is True

        # 刷新审计日志
        await audit_logger.flush()

        # 验证审计日志包含审批事件
        events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )

        # 应该有: ACTION_STARTED, APPROVAL_REQUESTED, APPROVAL_GRANTED, ACTION_COMPLETED
        assert len(events) == 4

        approval_requested = [
            e for e in events if e.event_type == AuditEventType.APPROVAL_REQUESTED
        ]
        approval_granted_events = [
            e for e in events if e.event_type == AuditEventType.APPROVAL_GRANTED
        ]

        assert len(approval_requested) == 1
        assert len(approval_granted_events) == 1

    finally:
        await audit_logger.stop()


@pytest.mark.asyncio
async def test_complete_workflow_approval_denied(
    runtime_context, skill_registry, audit_logger
):
    """测试审批被拒绝的工作流"""
    # 审批钩子（拒绝）
    async def approval_hook(tool_name: str, params: dict) -> bool:
        return False

    await audit_logger.start()

    try:
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            approval_hook=approval_hook,
            audit_logger=audit_logger,
        )

        # 执行高风险 action
        action = PlanStep(
            id="step_1",
            title="Test analyze",
            tool="test_analyze",
            params={"data": "test data"},
        )

        result = await executor.execute(action)

        # 验证结果
        assert result.success is False
        assert "denied" in result.error.lower()

        # 刷新审计日志
        await audit_logger.flush()

        # 验证审计日志
        events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )

        # 应该有: ACTION_STARTED, APPROVAL_REQUESTED, APPROVAL_DENIED, ACTION_REJECTED
        assert len(events) == 4

        approval_denied = [
            e for e in events if e.event_type == AuditEventType.APPROVAL_DENIED
        ]
        action_rejected = [
            e for e in events if e.event_type == AuditEventType.ACTION_REJECTED
        ]

        assert len(approval_denied) == 1
        assert len(action_rejected) == 1

    finally:
        await audit_logger.stop()


@pytest.mark.asyncio
async def test_complete_workflow_action_failure(
    runtime_context, skill_registry, audit_logger
):
    """测试 action 执行失败的工作流"""
    await audit_logger.start()

    try:
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            audit_logger=audit_logger,
        )

        # 执行会失败的 action
        action = PlanStep(
            id="step_1",
            title="Test failing",
            tool="test_failing",
            params={},
        )

        result = await executor.execute(action)

        # 验证结果
        assert result.success is False
        assert "Intentional failure" in result.error

        # 刷新审计日志
        await audit_logger.flush()

        # 验证审计日志
        events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )

        # 应该有: ACTION_STARTED, ACTION_FAILED
        assert len(events) == 2

        failed_events = [
            e for e in events if e.event_type == AuditEventType.ACTION_FAILED
        ]

        assert len(failed_events) == 1
        assert failed_events[0].success is False
        assert "Intentional failure" in failed_events[0].error_message

    finally:
        await audit_logger.stop()


@pytest.mark.asyncio
async def test_complete_workflow_invalid_action(
    runtime_context, skill_registry, audit_logger
):
    """测试无效 action 的工作流"""
    await audit_logger.start()

    try:
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            audit_logger=audit_logger,
        )

        # 执行不在能力图中的 action
        action = PlanStep(
            id="step_1",
            title="Invalid action",
            tool="unknown_tool",
            params={},
        )

        result = await executor.execute(action)

        # 验证结果
        assert result.success is False
        assert "not in capability graph" in result.error

        # 刷新审计日志
        await audit_logger.flush()

        # 验证审计日志
        events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )

        # 应该有: ACTION_STARTED, ACTION_FAILED
        assert len(events) == 2

    finally:
        await audit_logger.stop()


@pytest.mark.asyncio
async def test_complete_workflow_multiple_actions(
    runtime_context, skill_registry, audit_logger
):
    """测试多个 actions 的工作流"""
    await audit_logger.start()

    try:
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            audit_logger=audit_logger,
        )

        # 执行多个 actions
        actions = [
            PlanStep(
                id="step_1",
                title="Search",
                tool="test_search",
                params={"query": "Python"},
            ),
            PlanStep(
                id="step_2",
                title="Search again",
                tool="test_search",
                params={"query": "JavaScript"},
            ),
            PlanStep(
                id="step_3",
                title="Search once more",
                tool="test_search",
                params={"query": "Go"},
            ),
        ]

        results = []
        for action in actions:
            result = await executor.execute(action)
            results.append(result)

        # 验证所有结果
        assert all(r.success for r in results)

        # 刷新审计日志
        await audit_logger.flush()

        # 验证审计日志
        events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )

        # 应该有 6 个事件（3 x ACTION_STARTED + 3 x ACTION_COMPLETED）
        assert len(events) == 6

        completed_events = [
            e for e in events if e.event_type == AuditEventType.ACTION_COMPLETED
        ]
        assert len(completed_events) == 3

    finally:
        await audit_logger.stop()


@pytest.mark.asyncio
async def test_complete_workflow_audit_query(
    runtime_context, skill_registry, audit_logger
):
    """测试审计日志查询功能"""
    await audit_logger.start()

    try:
        executor = UnifiedActionExecutor(
            runtime_context=runtime_context,
            skill_registry=skill_registry,
            audit_logger=audit_logger,
        )

        # 执行多个 actions
        actions = [
            PlanStep(
                id="step_1",
                title="Success 1",
                tool="test_search",
                params={"query": "test1"},
            ),
            PlanStep(
                id="step_2",
                title="Success 2",
                tool="test_search",
                params={"query": "test2"},
            ),
            PlanStep(
                id="step_3",
                title="Failure",
                tool="test_failing",
                params={},
            ),
        ]

        for action in actions:
            await executor.execute(action)

        await audit_logger.flush()

        # 查询所有事件
        all_events = await audit_logger.query_events(
            AuditQuery(session_id="test_session")
        )
        assert len(all_events) > 0

        # 查询成功的事件
        success_events = await audit_logger.query_events(
            AuditQuery(session_id="test_session", success=True)
        )
        assert len(success_events) == 2  # 2 个成功的 ACTION_COMPLETED

        # 查询失败的事件
        failed_events = await audit_logger.query_events(
            AuditQuery(session_id="test_session", success=False)
        )
        assert len(failed_events) == 1  # 1 个失败的 ACTION_FAILED

        # 按事件类型查询
        completed_events = await audit_logger.query_events(
            AuditQuery(
                session_id="test_session",
                event_types=[AuditEventType.ACTION_COMPLETED],
            )
        )
        assert len(completed_events) == 2

        # 统计事件数量
        count = await audit_logger.count_events(
            AuditQuery(session_id="test_session")
        )
        assert count == len(all_events)

    finally:
        await audit_logger.stop()
