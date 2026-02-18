# Runtime Integration Example

本文档展示如何在 API 层集成 Runtime 的 RuntimeSessionContext。

## 阶段 A 完成状态

已完成：
- ✅ 创建 `RuntimeSessionContext` 定义
- ✅ 扩展 `AgentState` 添加 `context` 字段
- ✅ 修改 `create_agent_graph()` 接受 `runtime_context` 参数
- ✅ 更新配置常量文件

## API 层集成示例

### 1. 在 chat.service.ts 中构建 RuntimeSessionContext

```typescript
// apps/api/src/services/chat.service.ts

import { spawn } from 'child_process'
import * as path from 'path'

/**
 * 构建 Runtime Session Context
 */
async function buildRuntimeSessionContext(
  orgId: string,
  userId: string,
  agentId: string,
  sessionId: string
): Promise<any> {
  // 获取 Agent 配置
  const agent = await agentService.getAgent(orgId, agentId)

  // 获取绑定的 Skills
  const boundSkills = await skillService.getActiveSkillsByIds(orgId, agent.skills ?? [])

  // 转换为 SkillDefinition 格式
  const availableSkills = boundSkills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: skill.source || 'local',
    schema: skill.config?.schema || {},
    metadata: {
      isActive: skill.isActive,
      createdAt: skill.createdAt,
    },
  }))

  // 获取组织的 MCP Servers（如果有）
  // const mcpServers = await mcpService.getOrgMcpServers(orgId)
  const availableMcpServers: any[] = []

  // 构建 RuntimeSessionContext
  return {
    org_id: orgId,
    user_id: userId,
    agent_id: agentId,
    session_id: sessionId,
    agent_config: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      system_prompt: agent.systemPrompt,
      model: agent.config?.model,
      temperature: agent.config?.temperature ?? 0.7,
      max_tokens: agent.config?.maxTokens ?? 4096,
      metadata: {},
    },
    available_skills: availableSkills,
    available_tools: [],
    available_mcp_servers: availableMcpServers,
    runtime_policy: {
      max_iterations: 10,
      max_replan_attempts: 3,
      enable_parallel_execution: true,
      enable_delegation: true,
      require_approval_for_high_risk: true,
      high_risk_tools: ['code_run', 'shell_exec', 'file_write'],
      metadata: {},
    },
    metadata: {},
  }
}

/**
 * 调用 Python Runtime
 */
async function invokePythonRuntime(
  runtimeContext: any,
  userMessage: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const runtimePath = path.join(__dirname, '../../../../runtime')
    const pythonScript = path.join(runtimePath, 'src/main.py')

    // 构建输入数据
    const input = {
      runtime_context: runtimeContext,
      user_message: userMessage,
    }

    // 启��� Python 进程
    const pythonProcess = spawn('python', [pythonScript], {
      cwd: runtimePath,
      env: {
        ...process.env,
        PYTHONPATH: runtimePath,
      },
    })

    // 发送输入数据
    pythonProcess.stdin.write(JSON.stringify(input))
    pythonProcess.stdin.end()

    let stdout = ''
    let stderr = ''

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString()
      // 可以在这里解析流式输出并发送 SSE 事件
    })

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Python runtime exited with code ${code}: ${stderr}`))
      }
    })
  })
}

/**
 * 处理聊天消息（使用 Runtime）
 */
export async function handleChatWithRuntime(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  // 验证消息长度
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    console.warn(
      `[Chat] 消息长度超出限制 - 长度: ${input.message.length}, 限制: ${MAX_MESSAGE_LENGTH}`
    )
    throw createError(VALIDATION_MESSAGE_TOO_LONG)
  }

  // 获取会话
  const session = await sessionService.getSession(orgId, sessionId)

  // 构建 RuntimeSessionContext
  const runtimeContext = await buildRuntimeSessionContext(
    orgId,
    userId,
    session.agentId,
    sessionId
  )

  console.log('[Chat] RuntimeSessionContext 已构建', {
    orgId,
    userId,
    agentId: session.agentId,
    sessionId,
    skillCount: runtimeContext.available_skills.length,
    mcpServerCount: runtimeContext.available_mcp_servers.length,
  })

  // 创建 SSE 连接
  const connection = createSSEConnection(res, sessionId, userId)

  try {
    // 保存用户消息
    await sessionService.addMessage(orgId, sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
    })

    // 发送思考状态
    sendAgent2UIMessage(connection, 'thinking', {
      content: '正在启动 Agent Runtime...',
    })

    // 调用 Python Runtime
    await invokePythonRuntime(runtimeContext, input.message)

    // 发送完成事件
    sendSSEEvent(connection, 'done', {
      sessionId,
    })
  } catch (error) {
    console.error(`[Chat] Runtime 执行失败`, error)

    sendSSEEvent(connection, 'error', {
      code: SSE_STREAM_ERROR,
      message: error instanceof Error ? error.message : 'Runtime 执行失败',
    })
  } finally {
    // 关闭连接
    closeSSEConnection(connection.id)
    res.end()
  }
}
```

### 2. Python Runtime 入口示例

```python
# runtime/src/main.py

import sys
import json
import asyncio
from src.orchestrator import create_agent_graph, create_initial_state
from src.orchestrator.context import RuntimeSessionContext, AgentConfig, SkillDefinition, RuntimePolicy


async def main():
    # 从 stdin 读取输入
    input_data = json.loads(sys.stdin.read())

    runtime_context_data = input_data["runtime_context"]
    user_message = input_data["user_message"]

    # 构建 RuntimeSessionContext
    runtime_context = RuntimeSessionContext(
        org_id=runtime_context_data["org_id"],
        user_id=runtime_context_data["user_id"],
        agent_id=runtime_context_data["agent_id"],
        session_id=runtime_context_data["session_id"],
        agent_config=AgentConfig(**runtime_context_data["agent_config"]),
        available_skills=[
            SkillDefinition(**skill) for skill in runtime_context_data["available_skills"]
        ],
        available_tools=[],
        available_mcp_servers=[],
        runtime_policy=RuntimePolicy(**runtime_context_data["runtime_policy"]),
        metadata=runtime_context_data.get("metadata", {}),
    )

    # 创建执行图
    context = {
        "llm_provider": None,  # TODO: 初始化 LLM provider
        "skill_registry": None,  # TODO: 初始化 skill registry
        "memory_system": None,  # TODO: 初始化 memory system
    }

    graph = create_agent_graph(context, runtime_context)

    # 创建初始状态
    state = create_initial_state(
        session_id=runtime_context.session_id,
        agent_id=runtime_context.agent_id,
        org_id=runtime_context.org_id,
        user_message=user_message,
        context=runtime_context,
    )

    # 执行
    result = await graph.ainvoke(state)

    # 输出结果
    print(json.dumps({
        "success": True,
        "result": result,
    }))


if __name__ == "__main__":
    asyncio.run(main())
```

## 验证清单

阶段 A 完成后，应该能够：

- [x] RuntimeSessionContext 包含所有必需字段
- [x] AgentState 包含 context 字段
- [x] 所有节点都能访问 context（通过 state["context"]）
- [ ] API 层能正确构建和传递 context（需要实际集成）

## 下一步

阶段 B：能力图与 planner 对齐
- 创建 CapabilityGraph 类
- 修改 PlannerAgent 使用 capability_graph
- 添加 action 验证逻辑
