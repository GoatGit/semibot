"""
示例 5: 审批机制

展示如何实现高风险操作的审批机制。
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


# 定义一个高风险 skill
class FileOperationSkill(BaseSkill):
    """文件操作 skill（高风险）"""

    name = "file_operation"
    description = "Perform file operations"

    async def execute(self, operation: str, path: str, **kwargs) -> ToolResult:
        """执行文件操作"""
        # 这里只是模拟，不实际操作文件
        return ToolResult(
            result=f"Performed {operation} on {path}",
            success=True,
        )


# 定义一个普通 skill
class SafeSkill(BaseSkill):
    """安全的 skill"""

    name = "safe_operation"
    description = "Perform safe operations"

    async def execute(self, message: str, **kwargs) -> ToolResult:
        """执行安全操作"""
        return ToolResult(
            result=f"Safe: {message}",
            success=True,
        )


# 审批钩子函数
async def approval_hook(tool_name: str, params: dict) -> bool:
    """
    审批钩子函数

    在实际应用中，这里会弹出 UI 让用户确认。
    这里我们模拟用户的决策。
    """
    print(f"\n   ⚠️  审批请求:")
    print(f"   工具: {tool_name}")
    print(f"   参数: {params}")

    # 模拟用户决策
    # 在实际应用中，这里会等待用户输入
    if params.get("operation") == "delete":
        print(f"   ❌ 用户拒绝了删除操作")
        return False
    else:
        print(f"   ✅ 用户批准了操作")
        return True


async def main():
    """主函数"""
    print("=" * 60)
    print("示例 5: 审批机制")
    print("=" * 60)

    # 1. 注册 skills
    print("\n1. 注册 skills...")
    skill_registry = SkillRegistry()
    skill_registry.register_skill(FileOperationSkill())
    skill_registry.register_skill(SafeSkill())

    # 2. 创建 context（配置高风险工具）
    print("\n2. 创建 RuntimeSessionContext（配置审批策略）...")
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
                id="skill_file",
                name="file_operation",
                description="Perform file operations",
            ),
            SkillDefinition(
                id="skill_safe",
                name="safe_operation",
                description="Perform safe operations",
            ),
        ],
        runtime_policy=RuntimePolicy(
            require_approval_for_high_risk=True,  # 启用审批
            high_risk_tools=["file_operation"],  # 标记高风险工具
        ),
    )
    print(f"   审批策略:")
    print(f"   - 需要审批: {context.runtime_policy.require_approval_for_high_risk}")
    print(f"   - 高风险工具: {context.runtime_policy.high_risk_tools}")

    # 3. 创建执行器（带审批钩子）
    print("\n3. 创建统一执行器（带审批钩子）...")
    executor = UnifiedActionExecutor(
        runtime_context=context,
        skill_registry=skill_registry,
        approval_hook=approval_hook,  # 传入审批钩子
    )

    # 4. 执行 actions
    print("\n4. 执行 actions:")

    actions = [
        # 安全操作（不需要审批）
        PlanStep(
            id="step_1",
            title="Safe operation",
            tool="safe_operation",
            params={"message": "Hello"},
        ),
        # 高风险操作 - 读取（会触发审批，但会被批准）
        PlanStep(
            id="step_2",
            title="Read file",
            tool="file_operation",
            params={"operation": "read", "path": "/tmp/test.txt"},
        ),
        # 高风险操作 - 写入（会触发审批，但会被批准）
        PlanStep(
            id="step_3",
            title="Write file",
            tool="file_operation",
            params={"operation": "write", "path": "/tmp/test.txt"},
        ),
        # 高风险操作 - 删除（会触发审批，会被拒绝）
        PlanStep(
            id="step_4",
            title="Delete file",
            tool="file_operation",
            params={"operation": "delete", "path": "/tmp/test.txt"},
        ),
    ]

    for i, action in enumerate(actions, 1):
        print(f"\n{'=' * 50}")
        print(f"Action {i}: {action.title}")
        print(f"Tool: {action.tool}")
        print(f"Params: {action.params}")

        result = await executor.execute(action)

        print(f"\n   结果:")
        if result.success:
            print(f"   ✅ 成功: {result.result}")
        else:
            print(f"   ❌ 失败: {result.error}")

        if result.metadata:
            print(f"   元数据:")
            print(f"   - 需要审批: {result.metadata.get('requires_approval', False)}")
            print(f"   - 高风险: {result.metadata.get('is_high_risk', False)}")

    print("\n" + "=" * 60)
    print("示例完成！")
    print("\n总结:")
    print("- 安全操作直接执行，不需要审批")
    print("- 高风险操作触发审批流程")
    print("- 用户可以批准或拒绝操作")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
