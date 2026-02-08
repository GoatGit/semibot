"""
示例 7: 完整工作流

展示从创建 context 到执行 actions 并记录审计日志的完整工作流。
"""

import asyncio
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


# 定义 skills
class SearchSkill(BaseSkill):
    """搜索 skill"""

    name = "search"
    description = "Search for information"

    async def execute(self, query: str, **kwargs) -> ToolResult:
        """执行搜索"""
        # 模拟搜索
        results = [
            f"Result 1 for '{query}'",
            f"Result 2 for '{query}'",
            f"Result 3 for '{query}'",
        ]
        return ToolResult(
            result=results,
            success=True,
        )


class AnalyzeSkill(BaseSkill):
    """分析 skill"""

    name = "analyze"
    description = "Analyze data"

    async def execute(self, data: list, **kwargs) -> ToolResult:
        """执行分析"""
        # 模拟分析
        analysis = {
            "count": len(data),
            "summary": f"Analyzed {len(data)} items",
        }
        return ToolResult(
            result=analysis,
            success=True,
        )


class ReportSkill(BaseSkill):
    """报告 skill（高风险）"""

    name = "report"
    description = "Generate report"

    async def execute(self, content: dict, **kwargs) -> ToolResult:
        """生成报告"""
        # 模拟生成报告
        report = f"Report: {content.get('summary', 'No summary')}"
        return ToolResult(
            result=report,
            success=True,
        )


# 审批钩子
async def approval_hook(tool_name: str, params: dict) -> bool:
    """审批钩子"""
    print(f"\n   ⚠️  审批请求: {tool_name}")
    # 自动批准（实际应用中应该等待用户确认）
    print(f"   ✅ 自动批准")
    return True


async def main():
    """主函数"""
    print("=" * 60)
    print("示例 7: 完整工作流")
    print("=" * 60)

    # ========== 第 1 步: 初始化 ==========
    print("\n" + "=" * 60)
    print("第 1 步: 初始化")
    print("=" * 60)

    # 1.1 创建审计存储和 logger
    print("\n1.1 创建审计系统...")
    audit_storage = InMemoryAuditStorage()
    audit_logger = AuditLogger(
        storage=audit_storage,
        batch_size=10,
        flush_interval=5.0,
    )
    await audit_logger.start()
    print("   ✅ 审计系统已启动")

    try:
        # 1.2 注册 skills
        print("\n1.2 注册 skills...")
        skill_registry = SkillRegistry()

        skill_registry.register_skill(
            SearchSkill(),
            metadata=SkillMetadata(
                version="1.0.0",
                source="local",
                author="Demo",
            ),
        )
        skill_registry.register_skill(
            AnalyzeSkill(),
            metadata=SkillMetadata(
                version="1.0.0",
                source="local",
                author="Demo",
            ),
        )
        skill_registry.register_skill(
            ReportSkill(),
            metadata=SkillMetadata(
                version="1.0.0",
                source="local",
                author="Demo",
            ),
        )

        print(f"   ✅ 已注册 {len(skill_registry.list_skills())} 个 skills")

        # 1.3 创建 RuntimeSessionContext
        print("\n1.3 创建 RuntimeSessionContext...")
        context = RuntimeSessionContext(
            org_id="org_acme",
            user_id="user_alice",
            agent_id="agent_research",
            session_id="session_20260209_001",
            agent_config=AgentConfig(
                id="agent_research",
                name="Research Agent",
                model="claude-3-5-sonnet-20241022",
                temperature=0.7,
            ),
            available_skills=[
                SkillDefinition(
                    id="skill_search",
                    name="search",
                    description="Search for information",
                    version="1.0.0",
                    source="local",
                ),
                SkillDefinition(
                    id="skill_analyze",
                    name="analyze",
                    description="Analyze data",
                    version="1.0.0",
                    source="local",
                ),
                SkillDefinition(
                    id="skill_report",
                    name="report",
                    description="Generate report",
                    version="1.0.0",
                    source="local",
                ),
            ],
            runtime_policy=RuntimePolicy(
                max_iterations=10,
                timeout_seconds=300,
                require_approval_for_high_risk=True,
                high_risk_tools=["report"],  # 报告生成需要审批
            ),
        )
        print("   ✅ Context 创建成功")

        # ========== 第 2 步: 构建能力图 ==========
        print("\n" + "=" * 60)
        print("第 2 步: 构建能力图")
        print("=" * 60)

        capability_graph = CapabilityGraph(context)
        capability_graph.build()

        capabilities = capability_graph.list_capabilities()
        print(f"\n可用能力 ({len(capabilities)}):")
        for cap_name in capabilities:
            cap = capability_graph.get_capability(cap_name)
            print(f"   - {cap_name} ({cap.capability_type})")

        # ========== 第 3 步: 创建执行器 ==========
        print("\n" + "=" * 60)
        print("第 3 步: 创建统一执行器")
        print("=" * 60)

        executor = UnifiedActionExecutor(
            runtime_context=context,
            skill_registry=skill_registry,
            approval_hook=approval_hook,
            audit_logger=audit_logger,
        )
        print("\n✅ 执行器创建成功（包含审批和审计）")

        # ========== 第 4 步: 执行工作流 ==========
        print("\n" + "=" * 60)
        print("第 4 步: 执行工作流")
        print("=" * 60)

        # 定义工作流
        workflow = [
            PlanStep(
                id="step_1",
                title="Search for Python tutorials",
                tool="search",
                params={"query": "Python tutorials"},
            ),
            PlanStep(
                id="step_2",
                title="Analyze search results",
                tool="analyze",
                params={"data": []},  # 将由前一步的结果填充
            ),
            PlanStep(
                id="step_3",
                title="Generate report",
                tool="report",
                params={"content": {}},  # 将由前一步的结果填充
            ),
        ]

        results = []
        for i, action in enumerate(workflow, 1):
            print(f"\n{'=' * 50}")
            print(f"步骤 {i}/{len(workflow)}: {action.title}")
            print(f"工具: {action.tool}")

            # 使用前一步的结果
            if i == 2 and results:
                action.params["data"] = results[0]
            elif i == 3 and len(results) >= 2:
                action.params["content"] = results[1]

            print(f"参数: {action.params}")

            result = await executor.execute(action)

            if result.success:
                print(f"✅ 成功")
                print(f"结果: {result.result}")
                results.append(result.result)
            else:
                print(f"❌ 失败: {result.error}")
                break

        # ========== 第 5 步: 查询审计日志 ==========
        print("\n" + "=" * 60)
        print("第 5 步: 查询审计日志")
        print("=" * 60)

        # 刷新审计日志
        await audit_logger.flush()

        # 查询所有事件
        all_events = await audit_logger.query_events(
            AuditQuery(session_id="session_20260209_001")
        )
        print(f"\n总共记录了 {len(all_events)} 个审计事件")

        # 按类型统计
        event_types = {}
        for event in all_events:
            event_type = event.event_type
            event_types[event_type] = event_types.get(event_type, 0) + 1

        print("\n事件类型统计:")
        for event_type, count in event_types.items():
            print(f"   - {event_type}: {count}")

        # 查询完成的 actions
        completed_events = await audit_logger.query_events(
            AuditQuery(
                session_id="session_20260209_001",
                event_types=[AuditEventType.ACTION_COMPLETED],
            )
        )

        print(f"\n完成的 actions ({len(completed_events)}):")
        for event in completed_events:
            print(f"   - {event.action_name}: {event.duration_ms}ms")

        # 查询审批事件
        approval_events = await audit_logger.query_events(
            AuditQuery(
                session_id="session_20260209_001",
                event_types=[
                    AuditEventType.APPROVAL_REQUESTED,
                    AuditEventType.APPROVAL_GRANTED,
                ],
            )
        )

        if approval_events:
            print(f"\n审批事件 ({len(approval_events)}):")
            for event in approval_events:
                print(f"   - {event.event_type}: {event.action_name}")

    finally:
        # ========== 第 6 步: 清理 ==========
        print("\n" + "=" * 60)
        print("第 6 步: 清理资源")
        print("=" * 60)

        await audit_logger.stop()
        print("\n✅ 审计系统已停止")

    print("\n" + "=" * 60)
    print("工作流完成！")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
