"""
示例 1: 基本使用

展示如何创建 RuntimeSessionContext 和执行简单的 action。
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
from src.skills.registry import SkillRegistry
from src.skills.base import BaseSkill, ToolResult


# 1. 定义一个简单的 skill
class GreetingSkill(BaseSkill):
    """简单的问候 skill"""

    name = "greeting"
    description = "Greet a person by name"

    async def execute(self, name: str = "World", **kwargs) -> ToolResult:
        """执行问候"""
        message = f"Hello, {name}!"
        return ToolResult(
            result=message,
            success=True,
        )


async def main():
    """主函数"""
    print("=" * 60)
    print("示例 1: 基本使用")
    print("=" * 60)

    # 2. 创建 skill registry 并注册 skill
    print("\n1. 注册 skill...")
    skill_registry = SkillRegistry()
    skill_registry.register_skill(GreetingSkill())
    print(f"   已注册 skills: {skill_registry.list_skills()}")

    # 3. 创建 RuntimeSessionContext
    print("\n2. 创建 RuntimeSessionContext...")
    context = RuntimeSessionContext(
        org_id="org_demo",
        user_id="user_demo",
        agent_id="agent_demo",
        session_id="session_demo",
        agent_config=AgentConfig(
            id="agent_demo",
            name="Demo Agent",
            model="claude-3-5-sonnet-20241022",
            temperature=0.7,
        ),
        available_skills=[
            SkillDefinition(
                id="skill_greeting",
                name="greeting",
                description="Greet a person by name",
                version="1.0.0",
                source="local",
            ),
        ],
        runtime_policy=RuntimePolicy(
            max_iterations=10,
            timeout_seconds=300,
        ),
    )
    print(f"   Context 创建成功")
    print(f"   - Org ID: {context.org_id}")
    print(f"   - Agent ID: {context.agent_id}")
    print(f"   - Session ID: {context.session_id}")

    # 4. 创建能力图
    print("\n3. 构建能力图...")
    capability_graph = CapabilityGraph(context)
    capability_graph.build()
    capabilities = capability_graph.list_capabilities()
    print(f"   可用能力: {capabilities}")

    # 5. 创建统一执行器
    print("\n4. 创建统一执行器...")
    executor = UnifiedActionExecutor(
        runtime_context=context,
        skill_registry=skill_registry,
    )
    print(f"   执行器创建成功")

    # 6. 创建并执行 action
    print("\n5. 执行 action...")
    action = PlanStep(
        id="step_1",
        title="Greet Alice",
        tool="greeting",
        params={"name": "Alice"},
    )
    print(f"   Action: {action.tool}")
    print(f"   Params: {action.params}")

    # 7. 执行
    result = await executor.execute(action)

    # 8. 显示结果
    print("\n6. 执行结果:")
    if result.success:
        print(f"   ✅ 成功")
        print(f"   结果: {result.result}")
        print(f"   元数据: {result.metadata}")
    else:
        print(f"   ❌ 失败")
        print(f"   错误: {result.error}")

    print("\n" + "=" * 60)
    print("示例完成！")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
