"""
示例 3: 统一执行器

展示如何使用 UnifiedActionExecutor 执行不同类型的 actions。
"""

import asyncio
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    RuntimePolicy,
)
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.orchestrator.state import PlanStep
from src.skills.registry import SkillRegistry
from src.skills.base import BaseSkill, ToolResult


# 定义多个 skills
class MathSkill(BaseSkill):
    """数学计算 skill"""

    name = "math"
    description = "Perform mathematical calculations"

    async def execute(self, operation: str, a: float, b: float, **kwargs) -> ToolResult:
        """执行数学计算"""
        try:
            if operation == "add":
                result = a + b
            elif operation == "subtract":
                result = a - b
            elif operation == "multiply":
                result = a * b
            elif operation == "divide":
                if b == 0:
                    raise ValueError("Cannot divide by zero")
                result = a / b
            else:
                raise ValueError(f"Unknown operation: {operation}")

            return ToolResult(
                result=result,
                success=True,
            )
        except Exception as e:
            return ToolResult(
                result=None,
                success=False,
                error=str(e),
            )


class StringSkill(BaseSkill):
    """字符串处理 skill"""

    name = "string"
    description = "Perform string operations"

    async def execute(self, operation: str, text: str, **kwargs) -> ToolResult:
        """执行字符串操作"""
        try:
            if operation == "upper":
                result = text.upper()
            elif operation == "lower":
                result = text.lower()
            elif operation == "reverse":
                result = text[::-1]
            elif operation == "length":
                result = len(text)
            else:
                raise ValueError(f"Unknown operation: {operation}")

            return ToolResult(
                result=result,
                success=True,
            )
        except Exception as e:
            return ToolResult(
                result=None,
                success=False,
                error=str(e),
            )


async def main():
    """主函数"""
    print("=" * 60)
    print("示例 3: 统一执行器")
    print("=" * 60)

    # 1. 注册 skills
    print("\n1. 注册 skills...")
    skill_registry = SkillRegistry()
    skill_registry.register_skill(MathSkill())
    skill_registry.register_skill(StringSkill())
    print(f"   已注册: {skill_registry.list_skills()}")

    # 2. 创建 context
    print("\n2. 创建 RuntimeSessionContext...")
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
                id="skill_math",
                name="math",
                description="Perform mathematical calculations",
                version="1.0.0",
            ),
            SkillDefinition(
                id="skill_string",
                name="string",
                description="Perform string operations",
                version="1.0.0",
            ),
        ],
        runtime_policy=RuntimePolicy(
            max_iterations=10,
        ),
    )

    # 3. 创建执行器
    print("\n3. 创建统一执行器...")
    executor = UnifiedActionExecutor(
        runtime_context=context,
        skill_registry=skill_registry,
    )

    # 4. 执行多个 actions
    print("\n4. 执行 actions:")

    actions = [
        PlanStep(
            id="step_1",
            title="Add numbers",
            tool="math",
            params={"operation": "add", "a": 10, "b": 5},
        ),
        PlanStep(
            id="step_2",
            title="Multiply numbers",
            tool="math",
            params={"operation": "multiply", "a": 3, "b": 7},
        ),
        PlanStep(
            id="step_3",
            title="Convert to uppercase",
            tool="string",
            params={"operation": "upper", "text": "hello world"},
        ),
        PlanStep(
            id="step_4",
            title="Reverse string",
            tool="string",
            params={"operation": "reverse", "text": "Python"},
        ),
        PlanStep(
            id="step_5",
            title="Invalid action",
            tool="unknown_tool",
            params={},
        ),
    ]

    for i, action in enumerate(actions, 1):
        print(f"\n   Action {i}: {action.title}")
        print(f"   Tool: {action.tool}")
        print(f"   Params: {action.params}")

        result = await executor.execute(action)

        if result.success:
            print(f"   ✅ 成功: {result.result}")
            if result.metadata:
                print(f"   元数据: {result.metadata}")
        else:
            print(f"   ❌ 失败: {result.error}")

    print("\n" + "=" * 60)
    print("示例完成！")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
