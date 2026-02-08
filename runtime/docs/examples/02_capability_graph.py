"""
示例 2: 能力图使用

展示如何使用 CapabilityGraph 管理和查询能力。
"""

import asyncio
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
)
from src.orchestrator.capability import CapabilityGraph
from src.mcp.models import McpConnectionStatus


async def main():
    """主函数"""
    print("=" * 60)
    print("示例 2: 能力图使用")
    print("=" * 60)

    # 1. 创建包含多种能力的 context
    print("\n1. 创建 RuntimeSessionContext...")
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
                id="skill_1",
                name="search_web",
                description="Search the web",
                version="1.0.0",
                source="local",
            ),
            SkillDefinition(
                id="skill_2",
                name="read_file",
                description="Read a file",
                version="1.0.0",
                source="local",
            ),
        ],
        available_tools=[
            ToolDefinition(
                id="tool_1",
                name="calculator",
                description="Perform calculations",
            ),
        ],
        available_mcp_servers=[
            McpServerDefinition(
                id="mcp_1",
                name="File System",
                endpoint="stdio",
                transport="stdio",
                connection_status=McpConnectionStatus.CONNECTED,
                available_tools=[
                    {
                        "name": "list_files",
                        "description": "List files in directory",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                            },
                        },
                    },
                ],
            ),
            McpServerDefinition(
                id="mcp_2",
                name="Database",
                endpoint="http://localhost:8080",
                transport="http",
                connection_status=McpConnectionStatus.DISCONNECTED,  # 未连接
                available_tools=[
                    {
                        "name": "query_db",
                        "description": "Query database",
                    },
                ],
            ),
        ],
    )
    print(f"   Context 创建成功")

    # 2. 构建能力图
    print("\n2. 构建能力图...")
    graph = CapabilityGraph(context)
    graph.build()
    print(f"   能力图构建完成")

    # 3. 列出所有能力
    print("\n3. 列出所有能力:")
    capabilities = graph.list_capabilities()
    for cap_name in capabilities:
        capability = graph.get_capability(cap_name)
        print(f"   - {cap_name} ({capability.capability_type})")

    # 4. 按类型查询能力
    print("\n4. 按类型查询能力:")

    skills = graph.get_capabilities_by_type("skill")
    print(f"   Skills ({len(skills)}):")
    for skill in skills:
        print(f"   - {skill.name}: {skill.description}")

    tools = graph.get_capabilities_by_type("tool")
    print(f"   Tools ({len(tools)}):")
    for tool in tools:
        print(f"   - {tool.name}: {tool.description}")

    mcp_tools = graph.get_capabilities_by_type("mcp")
    print(f"   MCP Tools ({len(mcp_tools)}):")
    for mcp_tool in mcp_tools:
        print(f"   - {mcp_tool.name}: {mcp_tool.description}")

    # 5. 验证 action
    print("\n5. 验证 actions:")
    test_actions = [
        "search_web",
        "read_file",
        "calculator",
        "list_files",
        "query_db",  # 这个应该失败（服务器未连接）
        "unknown_tool",  # 这个应该失败（不存在）
    ]

    for action_name in test_actions:
        is_valid = graph.validate_action(action_name)
        status = "✅" if is_valid else "❌"
        print(f"   {status} {action_name}")

    # 6. 获取 planner schemas
    print("\n6. 生成 planner schemas:")
    schemas = graph.get_schemas_for_planner()
    print(f"   生成了 {len(schemas)} 个 schemas")
    for schema in schemas[:3]:  # 只显示前 3 个
        print(f"   - {schema['name']}: {schema['description']}")

    # 7. 查询特定能力
    print("\n7. 查询特定能力:")
    capability = graph.get_capability("search_web")
    if capability:
        print(f"   名称: {capability.name}")
        print(f"   类型: {capability.capability_type}")
        print(f"   描述: {capability.description}")
        schema = capability.to_schema()
        print(f"   Schema: {schema}")

    print("\n" + "=" * 60)
    print("示例完成！")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
