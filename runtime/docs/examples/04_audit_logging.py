"""
示例 4: 审计日志

展示如何使用 AuditLogger 记录和查询审计事件。
"""

import asyncio
from datetime import datetime, timedelta, timezone
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
)
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.orchestrator.state import PlanStep
from src.skills.registry import SkillRegistry
from src.skills.base import BaseSkill, ToolResult
from src.audit.logger import AuditLogger
from src.audit.storage import InMemoryAuditStorage
from src.audit.models import AuditQuery, AuditEventType


# 定义一个简单的 skill
class EchoSkill(BaseSkill):
    """回显 skill"""

    name = "echo"
    description = "Echo back the input"

    async def execute(self, message: str, **kwargs) -> ToolResult:
        """回显消息"""
        return ToolResult(
            result=f"Echo: {message}",
            success=True,
        )


async def main():
    """主函数"""
    print("=" * 60)
    print("示例 4: 审计日志")
    print("=" * 60)

    # 1. 创建审计存储和 logger
    print("\n1. 创建审计 logger...")
    storage = InMemoryAuditStorage()
    audit_logger = AuditLogger(
        storage=storage,
        batch_size=10,
        flush_interval=5.0,
    )

    # 启动 logger
    await audit_logger.start()
    print(f"   审计 logger 已启动")

    try:
        # 2. 注册 skill
        print("\n2. 注册 skill...")
        skill_registry = SkillRegistry()
        skill_registry.register_skill(EchoSkill())

        # 3. 创建 context
        print("\n3. 创建 RuntimeSessionContext...")
        context = RuntimeSessionContext(
            org_id="org_demo",
            user_id="user_demo",
            agent_id="agent_demo",
            session_id="session_demo",
            agent_config=AgentConfig(
                id="agent_demo",
                name="Demo Agent",
            ),
            available_skills=[
                SkillDefinition(
                    id="skill_echo",
                    name="echo",
                    description="Echo back the input",
                    version="1.0.0",
                ),
            ],
        )

        # 4. 创建执行器（带审计 logger）
        print("\n4. 创建统一执行器（带审计）...")
        executor = UnifiedActionExecutor(
            runtime_context=context,
            skill_registry=skill_registry,
            audit_logger=audit_logger,  # 传入审计 logger
        )

        # 5. 执行多个 actions
        print("\n5. 执行 actions（会自动记录审计日志）:")

        actions = [
            PlanStep(
                id="step_1",
                title="Echo message 1",
                tool="echo",
                params={"message": "Hello"},
            ),
            PlanStep(
                id="step_2",
                title="Echo message 2",
                tool="echo",
                params={"message": "World"},
            ),
            PlanStep(
                id="step_3",
                title="Echo message 3",
                tool="echo",
                params={"message": "Python"},
            ),
        ]

        for action in actions:
            print(f"\n   执行: {action.title}")
            result = await executor.execute(action)
            if result.success:
                print(f"   ✅ {result.result}")
            else:
                print(f"   ❌ {result.error}")

        # 6. 刷新审计日志
        print("\n6. 刷新审计日志...")
        await audit_logger.flush()
        print(f"   审计日志已刷新")

        # 7. 查询审计事件
        print("\n7. 查询审计事件:")

        # 查询所有事件
        all_events = await audit_logger.query_events(
            AuditQuery(session_id="session_demo")
        )
        print(f"\n   总共 {len(all_events)} 个事件")

        # 按事件类型分组
        started_events = [
            e for e in all_events if e.event_type == AuditEventType.ACTION_STARTED
        ]
        completed_events = [
            e for e in all_events if e.event_type == AuditEventType.ACTION_COMPLETED
        ]

        print(f"   - ACTION_STARTED: {len(started_events)}")
        print(f"   - ACTION_COMPLETED: {len(completed_events)}")

        # 8. 显示详细事件
        print("\n8. 事件详情:")
        for event in all_events[:6]:  # 只显示前 6 个
            print(f"\n   事件 ID: {event.event_id}")
            print(f"   类型: {event.event_type}")
            print(f"   Action: {event.action_name}")
            print(f"   时间: {event.timestamp}")
            if event.success is not None:
                print(f"   成功: {event.success}")
            if event.duration_ms > 0:
                print(f"   耗时: {event.duration_ms}ms")

        # 9. 查询特定类型的事件
        print("\n9. 查询 ACTION_COMPLETED 事件:")
        completed = await audit_logger.query_events(
            AuditQuery(
                session_id="session_demo",
                event_types=[AuditEventType.ACTION_COMPLETED],
            )
        )
        for event in completed:
            print(f"   - {event.action_name}: {event.duration_ms}ms")

        # 10. 统计事件数量
        print("\n10. 统计事件:")
        count = await audit_logger.count_events(
            AuditQuery(session_id="session_demo")
        )
        print(f"   总事件数: {count}")

        success_count = await audit_logger.count_events(
            AuditQuery(session_id="session_demo", success=True)
        )
        print(f"   成功事件数: {success_count}")

    finally:
        # 11. 停止 logger
        print("\n11. 停止审计 logger...")
        await audit_logger.stop()
        print(f"   审计 logger 已停止")

    print("\n" + "=" * 60)
    print("示例完成！")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
