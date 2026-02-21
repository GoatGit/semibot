# 03 - 控制平面详细设计

## 1. 职责定义

控制平面是系统的"大脑管理层"，负责所有不需要在 session 内独立运行的功能：

```
控制平面职责：
├── 用户虚拟机调度 — 分配/回收用户级执行平面资源
├── WebSocket 管理 — 维护与所有执行平面的连接（每用户一条）
├── SSE 转发 — 将执行平面的输出转发给前端
├── Agent/技能管理 — CRUD + 版本 + 绑定关系
├── 长期记忆 — pgvector 向量检索
├── 进化技能治理 — 审核、评分、跨 session 共享
├── 远程 MCP 连接池 — 共享连接、统一认证
├── OAuth/Key 管理 — API Key 注入、OAuth token 管理
├── 审计/计费 — 用量统计、操作日志
└── 认证/权限 — JWT、多租户隔离
```

## 2. 模块架构

### 2.1 现有模块保留

```
apps/api/src/
├── routes/v1/           保留所有现有路由
│   ├── agents.ts        ✅ 不变
│   ├── sessions.ts      ✅ 不变
│   ├── skill-definitions.ts  ✅ 不变
│   ├── evolved-skills.ts     ✅ 不变
│   ├── mcp.ts           ✅ 不变
│   ├── llm-providers.ts ✅ 不变
│   ├── memory.ts        ✅ 不变
│   ├── auth.ts          ✅ 不变
│   ├── organizations.ts ✅ 不变
│   └── chat.ts          ⚠️ 修改（不再直接调 Runtime）
│
├── services/            保留所有现有服务
│   ├── agent.service.ts      ✅ 不变
│   ├── session.service.ts    ✅ 不变
│   ├── skill-install.service.ts  ✅ 不变
│   ├── evolved-skill.service.ts  ✅ 不变
│   ├── mcp.service.ts        ⚠️ 修改（增加连接池共享逻辑）
│   ├── memory.service.ts     ✅ 不变
│   ├── auth.service.ts       ✅ 不变
│   └── chat.service.ts       ⚠️ 修改（改为通过 WS 转发）
│
├── repositories/        ✅ 全部不变
├── middleware/           ✅ 全部不变
└── lib/                 ✅ 全部不变
```

### 2.2 新增模块

```
apps/api/src/
├── ws/                          新增：WebSocket 管理
│   ├── ws-server.ts             WebSocket 服务端
│   ├── vm-connection.ts         用户虚拟机连接管理
│   ├── message-router.ts        消息路由（上行/下行）
│   └── heartbeat.ts             心跳检测
│
├── scheduler/                   新增：用户虚拟机调度
│   ├── vm-scheduler.ts          调度器主逻辑（按用户分配）
│   ├── vm-pool.ts               虚拟机池管理
│   ├── resource-tracker.ts      资源追踪
│   └── recovery.ts              故障恢复
│
├── relay/                       新增：SSE 中转
│   ├── sse-relay.ts             SSE 缓冲转发
│   └── sse-buffer.ts            环形缓冲区（从 lib/ 升级）
│
└── credential/                  新增：凭证管理
    ├── key-injector.ts          API Key 注入
    ├── oauth-manager.ts         OAuth token 管理
    └── vault.ts                 凭证保险箱
```

## 3. 核心模块设计

### 3.1 WebSocket 服务端

```typescript
// apps/api/src/ws/ws-server.ts

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

interface ExecutionPlaneConnection {
  ws: WebSocket;
  userId: string;
  orgId: string;
  status: 'initializing' | 'ready' | 'executing' | 'disconnected';
  lastHeartbeat: number;
  pendingRequests: Map<string, PendingRequest>;
  sseBuffers: Map<string, SSEBuffer>;  // 按 session_id 分别缓冲
}

class WSServer {
  private connections: Map<string, ExecutionPlaneConnection> = new Map();
  private wss: WebSocketServer;

  constructor(server: Server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws/vm',
      verifyClient: this.authenticate.bind(this),
    });

    this.wss.on('connection', this.handleConnection.bind(this));
  }

  /**
   * 执行平面连接时的认证（两阶段）
   * 首次连接: /ws/vm?user_id={id}&ticket={one_time_ticket}
   * 重连: /ws/vm?user_id={id} (无 ticket，认证完全依赖首帧 auth 消息)
   * 两种情况都需要首帧 auth 消息携带 JWT
   */
  private authenticate(info: any, callback: Function) {
    const url = new URL(info.req.url, 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    const userId = url.searchParams.get('user_id');

    if (ticket) {
      // 首次连接：验证一次性 ticket（短时效，使用后立即失效）
      // ticket 验证通过后仍需等待首帧 auth 消息
      // ...
    }
    // 无 ticket 时仍允许连接（仅限重连场景）
    // 安全保障完全依赖首帧 auth ���息中的 JWT 验证：
    //   - JWT 必须有效且未过期
    //   - JWT 中的 user_id 必须与 URL 中的 user_id 一致
    //   - 该 user_id 必须存在活跃的 VM 实例（status = 'running'）
    // ticket 仅作为首次连接的额外校验层，不是安全边界
    callback(true);
  }

  /**
   * 处理执行平面的 WebSocket 连接
   * 每个用户一条 WS 连接，VM 内多个 session 进程复用此连接
   */
  private handleConnection(ws: WebSocket, req: any) {
    const userId = extractUserId(req);

    const conn: ExecutionPlaneConnection = {
      ws,
      userId,
      orgId: '', // 待 auth 消息验证后填充
      status: 'initializing',
      lastHeartbeat: Date.now(),
      pendingRequests: new Map(),
      sseBuffers: new Map(),
    };

    // 等待首帧 auth 消息（携带 JWT）
    ws.once('message', async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'auth' || !msg.token) {
        ws.close(4001, 'Authentication failed: expected auth message');
        return;
      }
      // 验证 JWT token
      const payload = await verifyJWT(msg.token);
      if (!payload || payload.user_id !== userId) {
        ws.close(4001, 'Authentication failed: invalid token');
        return;
      }
      // 校验该用户存在活跃 VM 实例
      const activeVM = await this.vmRepo.findActiveByUserId(userId);
      if (!activeVM) {
        ws.close(4003, 'No active VM instance for this user');
        return;
      }
      conn.orgId = payload.org_id;
      this.connections.set(userId, conn);

      // 认证通过，发送 init
      this.sendInit(conn);

      ws.on('message', (data) => this.handleMessage(conn, data));
      ws.on('close', () => this.handleDisconnect(conn));
      ws.on('error', (err) => this.handleError(conn, err));
    });
  }

  /**
   * 发送用户级初始化数据包给执行平面
   * 包含用户身份、组织信息和 API 凭证，不含 session 级数据
   */
  private async sendInit(conn: ExecutionPlaneConnection) {
    const apiKeys = await credentialService.getApiKeys(conn.orgId);

    conn.ws.send(JSON.stringify({
      type: 'init',
      data: {
        user_id: conn.userId,
        org_id: conn.orgId,
        api_keys: apiKeys,           // 加密传输，内存中解密
      },
    }));

    conn.status = 'ready';
  }

  /**
   * 处理执行平面上行消息
   * 所有消息通过 msg.session_id 路由到对应 session
   */
  private handleMessage(conn: ExecutionPlaneConnection, raw: any) {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case 'sse_event': {
        // LLM 输出 → 按 session 缓冲 → SSE 转发给前端
        const sessionId = msg.session_id;
        if (!conn.sseBuffers.has(sessionId)) {
          conn.sseBuffers.set(sessionId, new SSEBuffer(500));
        }
        const eventId = conn.sseBuffers.get(sessionId)!.push(msg.data);
        sseRelay.forward(sessionId, eventId, msg.data);
        break;
      }

      case 'request':
        // 执行平面请求数据（技能文件、长期记忆、MCP 调用等）
        this.handleRequest(conn, msg);
        break;

      case 'fire_and_forget':
        // 单向消息（审计日志、用量上报、进化技能提交）
        this.handleFireAndForget(conn, msg);
        break;

      case 'heartbeat':
        conn.lastHeartbeat = Date.now();
        break;
    }
  }

  /**
   * 处理执行平面的请求（需要响应）
   */
  private async handleRequest(conn: ExecutionPlaneConnection, msg: any) {
    let result: any;
    const sessionId = msg.session_id;

    switch (msg.method) {
      case 'get_skill_files':
        result = await skillService.getSkillFiles(
          msg.params.skill_id,
          msg.params.version
        );
        break;

      case 'memory_search':
        result = await memoryService.searchLongTerm(
          conn.orgId,
          msg.params.query,
          msg.params.top_k
        );
        break;

      case 'mcp_call':
        result = await mcpService.callTool(
          msg.params.server,
          msg.params.tool,
          msg.params.arguments
        );
        break;

      case 'get_config':
        result = await agentService.getAgentConfig(msg.params.agent_id);
        break;

      case 'get_session':
        // VM 内新 session 进程启动时拉取 session 级配置
        result = await sessionService.getSessionWithAgent(sessionId);
        break;
    }

    // 用相同的 id 返回响应
    conn.ws.send(JSON.stringify({
      type: 'response',
      id: msg.id,
      result,
    }));
  }

  /**
   * 处理单向消息
   * 通过 msg.session_id 关联到具体 session
   */
  private handleFireAndForget(conn: ExecutionPlaneConnection, msg: any) {
    const sessionId = msg.session_id;

    switch (msg.method) {
      case 'usage_report':
        usageService.record(sessionId, conn.userId, conn.orgId, msg.params);
        break;

      case 'audit_log':
        auditService.log(sessionId, conn.userId, conn.orgId, msg.params);
        break;

      case 'evolution_submit':
        evolutionService.submitCandidate(conn.orgId, msg.params);
        break;
    }
  }

  /**
   * 向用户 VM 下发启动 session 指令
   * VM 收到后根据 runtime_type 启动对应的 Adapter 进程
   */
  sendStartSession(userId: string, sessionId: string, agentConfig: any, runtimeType: string = 'semibot', openclawConfig?: any) {
    const conn = this.connections.get(userId);
    if (!conn || conn.status !== 'ready') {
      throw new Error('用户 VM 未就绪');
    }

    conn.ws.send(JSON.stringify({
      type: 'start_session',
      data: {
        session_id: sessionId,
        runtime_type: runtimeType,
        agent_config: agentConfig,
        ...(runtimeType === 'openclaw' && openclawConfig ? { openclaw_config: openclawConfig } : {}),
      },
    }));
  }

  /**
   * 向用户 VM 下发停止 session 指令
   */
  sendStopSession(userId: string, sessionId: string) {
    const conn = this.connections.get(userId);
    if (!conn) return;

    conn.ws.send(JSON.stringify({
      type: 'stop_session',
      data: { session_id: sessionId },
    }));

    // 清理该 session 的 SSE 缓冲
    conn.sseBuffers.delete(sessionId);
  }

  /**
   * 执行平面断线处理
   */
  private handleDisconnect(conn: ExecutionPlaneConnection) {
    conn.status = 'disconnected';

    // 不立即删除连接，等待重连
    // 缓存未送达的 MCP 结果
    setTimeout(() => {
      if (conn.status === 'disconnected') {
        // 超时未重连，清理资源
        this.cleanup(conn);
      }
    }, 5 * 60 * 1000); // 5 分钟超时
  }

  /**
   * 执行平面重连时恢复
   */
  async handleReconnect(userId: string, ws: WebSocket, pendingIds: string[]) {
    const oldConn = this.connections.get(userId);
    if (!oldConn) return;

    // 恢复连接
    oldConn.ws = ws;
    oldConn.status = 'ready';
    oldConn.lastHeartbeat = Date.now();

    // 返回断线期间缓存的请求结果
    const results: Record<string, any> = {};
    for (const id of pendingIds) {
      const cached = this.resultCache.get(`${userId}:${id}`);
      results[id] = cached
        ? { status: 'completed', data: cached }
        : { status: 'not_found' };
    }

    ws.send(JSON.stringify({
      type: 'resume_response',
      results,
    }));
  }
}
```

### 3.2 用户虚拟机调度器

```typescript
// apps/api/src/scheduler/vm-scheduler.ts

interface ExecutionPlaneInstance {
  id: string;
  userId: string;
  orgId: string;
  mode: 'firecracker' | 'docker' | 'local';
  ip?: string;
  status: 'starting' | 'running' | 'frozen' | 'failed' | 'terminated';
  diskId?: string;
  createdAt: number;
  lastActivity: number;
}

class VMScheduler {
  private instances: Map<string, ExecutionPlaneInstance> = new Map();
  private vmPool: VMPool;

  constructor(vmPool: VMPool) {
    this.vmPool = vmPool;
    this.startHealthCheckLoop();
    this.startIdleCheckLoop();
  }

  /**
   * 为用户分配执行平面虚拟机
   * 同一用户的多个 session 共享一个 VM
   */
  async allocate(userId: string, orgId: string, mode: string): Promise<ExecutionPlaneInstance> {
    switch (mode) {
      case 'firecracker': {
        // 从预热池取一个虚拟机
        const vm = await this.vmPool.acquire();
        const instance: ExecutionPlaneInstance = {
          id: vm.id,
          userId,
          orgId,
          mode: 'firecracker',
          ip: vm.ip,
          diskId: vm.diskId,
          status: 'starting',
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        this.instances.set(userId, instance);

        // 启动执行平面进程
        await vm.exec('python -m semibot_runtime', {
          env: {
            CONTROL_PLANE_WS: `ws://${CONTROL_PLANE_INTERNAL_IP}:8080/ws/vm`,
            USER_ID: userId,
            VM_TOKEN: await this.generateVMToken(userId, orgId),
            VM_TICKET: await this.generateOneTimeTicket(userId),
          },
        });

        instance.status = 'running';
        return instance;
      }

      case 'docker': {
        const container = await docker.createContainer({
          Image: 'semibot/execution-plane:latest',
          Env: [
            `CONTROL_PLANE_WS=ws://${CONTROL_PLANE_INTERNAL_IP}:8080/ws/vm`,
            `USER_ID=${userId}`,
            `VM_TOKEN=${await this.generateVMToken(userId, orgId)}`,
            `VM_TICKET=${await this.generateOneTimeTicket(userId)}`,
          ],
          HostConfig: {
            Memory: 512 * 1024 * 1024,  // 512MB
            CpuPeriod: 100000,
            CpuQuota: 100000,            // 1 CPU
            NetworkMode: 'bridge',
          },
        });
        await container.start();

        const instance: ExecutionPlaneInstance = {
          id: container.id,
          userId,
          orgId,
          mode: 'docker',
          status: 'running',
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        this.instances.set(userId, instance);
        return instance;
      }

      case 'local': {
        // 本地模式：不分配资源，等待用户本地执行平面连接
        const instance: ExecutionPlaneInstance = {
          id: `local-${userId}`,
          userId,
          orgId,
          mode: 'local',
          status: 'starting', // 等待 WS 连接后变为 running
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        this.instances.set(userId, instance);
        return instance;
      }
    }
  }

  /**
   * 回收用户虚拟机资源
   */
  async release(userId: string) {
    const instance = this.instances.get(userId);
    if (!instance) return;

    switch (instance.mode) {
      case 'firecracker':
        await this.vmPool.release(instance.id);
        break;
      case 'docker':
        await docker.getContainer(instance.id).stop();
        await docker.getContainer(instance.id).remove();
        break;
      case 'local':
        // 本地模式无需回收
        break;
    }

    instance.status = 'terminated';
    this.instances.delete(userId);
  }

  /**
   * 心跳检测循环
   */
  private startHealthCheckLoop() {
    setInterval(async () => {
      for (const [userId, instance] of this.instances) {
        if (instance.status !== 'running') continue;

        const conn = wsServer.getConnection(userId);
        if (!conn || Date.now() - conn.lastHeartbeat > 30_000) {
          // 30s 没心跳
          await this.handleUnhealthy(userId, instance);
        }
      }
    }, 5_000); // 每 5s 检查一次
  }

  /**
   * 处理不健康的执行平面
   */
  private async handleUnhealthy(userId: string, instance: ExecutionPlaneInstance) {
    // 先 ping 一下确认
    const alive = await this.ping(instance);
    if (alive) return; // 只是心跳延迟

    if (instance.mode === 'firecracker' && instance.diskId) {
      // 虚拟机崩溃但磁盘还在 → 分配新虚拟机挂载旧磁盘
      const newVm = await this.vmPool.acquire();
      await newVm.attachDisk(instance.diskId);
      await newVm.exec('python -m semibot_runtime --recover', {
        env: {
          CONTROL_PLANE_WS: `ws://${CONTROL_PLANE_INTERNAL_IP}:8080/ws/vm`,
          USER_ID: userId,
          VM_TOKEN: await this.generateVMToken(userId, instance.orgId),
          VM_TICKET: await this.generateOneTimeTicket(userId),
        },
      });

      instance.id = newVm.id;
      instance.ip = newVm.ip;
      instance.status = 'running';

      // 通知该用户所有活跃 session 的前端重连 SSE
      const conn = wsServer.getConnection(userId);
      if (conn) {
        for (const sessionId of conn.sseBuffers.keys()) {
          sseRelay.notifyReconnect(sessionId);
        }
      }
    } else {
      // 无法恢复，通知该用户所有活跃 session 的前端
      const conn = wsServer.getConnection(userId);
      if (conn) {
        for (const sessionId of conn.sseBuffers.keys()) {
          sseRelay.notifyError(sessionId, 'execution_plane_lost');
        }
      }
    }
  }

  /**
   * 空闲检测循环（用户虚拟机冻结/释放）
   */
  private startIdleCheckLoop() {
    setInterval(async () => {
      for (const [userId, instance] of this.instances) {
        if (instance.mode !== 'firecracker') continue;
        if (instance.status !== 'running') continue;

        if (Date.now() - instance.lastActivity > 30_000) {
          // 30s 无活动，冻结用户虚拟机
          await this.vmPool.freeze(instance.id);
          instance.status = 'frozen';
        }
      }
    }, 10_000);
  }

  /**
   * 唤醒冻结的用户虚拟机
   */
  async wake(userId: string) {
    const instance = this.instances.get(userId);
    if (!instance || instance.status !== 'frozen') return;

    await this.vmPool.thaw(instance.id);
    instance.status = 'running';
    instance.lastActivity = Date.now();
  }
}
```

### 3.3 SSE 中转

```typescript
// apps/api/src/relay/sse-relay.ts

class SSERelay {
  private frontendConnections: Map<string, SSEConnection[]> = new Map();

  /**
   * 前端建立 SSE 连接
   * GET /api/v1/sessions/{id}/stream?last_event_id=0
   */
  async connect(sessionId: string, res: Response, lastEventId: string) {
    // 设置 SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const conn: SSEConnection = {
      id: crypto.randomUUID(),
      res,
      sessionId,
      isActive: true,
    };

    // 注册连接
    if (!this.frontendConnections.has(sessionId)) {
      this.frontendConnections.set(sessionId, []);
    }
    this.frontendConnections.get(sessionId)!.push(conn);

    // 断点续传：重放缓冲区中断点之后的事件
    if (lastEventId !== '0') {
      const wsConn = wsServer.getConnectionByUserId(
        await sessionService.getUserId(sessionId)
      );
      if (wsConn) {
        const sseBuffer = wsConn.sseBuffers.get(sessionId);
        if (sseBuffer) {
          try {
            for (const [eid, data] of sseBuffer.replayAfter(lastEventId)) {
              res.write(`id: ${eid}\ndata: ${data}\n\n`);
            }
          } catch (e) {
            // 缓冲区溢出，通知前端全量刷新
            res.write(`event: resync\ndata: {}\n\n`);
          }
        }
      }
    }

    // 心跳
    const heartbeat = setInterval(() => {
      if (conn.isActive) {
        res.write(`: heartbeat\n\n`);
      }
    }, 30_000);

    // 清理
    res.on('close', () => {
      conn.isActive = false;
      clearInterval(heartbeat);
      const conns = this.frontendConnections.get(sessionId);
      if (conns) {
        const idx = conns.indexOf(conn);
        if (idx >= 0) conns.splice(idx, 1);
      }
    });
  }

  /**
   * 将执行平面的输出转发给前端
   * 由 WSServer.handleMessage 调用
   */
  forward(sessionId: string, eventId: string, data: string) {
    const conns = this.frontendConnections.get(sessionId);
    if (!conns) return;

    const payload = `id: ${eventId}\ndata: ${data}\n\n`;

    for (const conn of conns) {
      if (conn.isActive) {
        try {
          conn.res.write(payload);
        } catch {
          conn.isActive = false;
        }
      }
    }
  }

  /**
   * 通知前端重连
   */
  notifyReconnect(sessionId: string) {
    this.forward(sessionId, '', JSON.stringify({
      type: 'reconnect',
      message: '执行平面已恢复，请重连',
    }));
  }

  /**
   * 通知前端错误
   */
  notifyError(sessionId: string, code: string) {
    this.forward(sessionId, '', JSON.stringify({
      type: 'error',
      code,
    }));
  }
}
```

### 3.4 Chat Service 改造

```typescript
// apps/api/src/services/chat.service.ts（改造后）

class ChatService {
  /**
   * 处理用户消息（改造前：直接调 Runtime HTTP API）
   * 改造后：通过 WebSocket 转发给用户 VM，由 VM 内对应 session 进程处理
   */
  async handleChat(sessionId: string, message: string, userId: string, orgId: string) {
    // 1. 保存用户消息（不变）
    await messageRepository.create({
      sessionId,
      role: 'user',
      content: message,
    });

    // 2. 获取历史消息（不变）
    const history = await messageRepository.getRecent(sessionId, 20);

    // 3. 检查用户 VM 是否就绪
    const conn = wsServer.getConnection(userId);
    if (!conn || conn.status !== 'ready') {
      // 用户 VM 未连接，可能需要唤醒或分配
      const instance = scheduler.getInstance(userId);

      if (instance?.status === 'frozen') {
        await scheduler.wake(userId);
        // 等待 WS 重连
        await this.waitForConnection(userId, 10_000);
      } else if (!instance) {
        // 没有用户 VM，需要分配
        await scheduler.allocate(userId, orgId, 'firecracker');
        await this.waitForConnection(userId, 30_000);
      } else {
        throw new Error('用户 VM 不可用');
      }
    }

    // 4. 检查 session 是否已在 VM 内启动，未启动则先下发 start_session
    const activeConn = wsServer.getConnection(userId)!;
    if (!activeConn.sseBuffers.has(sessionId)) {
      const session = await sessionService.getSession(sessionId);
      const agent = await agentService.getAgent(session.agentId);

      // 解析 runtime_type（优先级：session > agent > user > org > 系统默认）
      const runtimeType = session.runtimeType
        ?? agent.runtimeType
        ?? user.defaultRuntimeType
        ?? org.defaultRuntimeType
        ?? 'semibot';

      wsServer.sendStartSession(userId, sessionId, {
        system_prompt: agent.systemPrompt,
        model: agent.config.model,
        temperature: agent.config.temperature,
        max_tokens: agent.config.maxTokens,
        skills: await skillService.getSkillIndex(agent.skills),
        mcp_servers: agent.mcpServers,
        sub_agents: agent.subAgents,
      }, runtimeType, agent.openclawConfig);
      // 等待 session 进程就绪
      await this.waitForSessionReady(userId, sessionId, 5_000);
    }

    // 5. 通过 WebSocket 下发消息给用户 VM，携带 session_id 路由
    //   （改造前：HTTP POST 到 Runtime /api/v1/execute/stream）
    wsServer.send(userId, {
      type: 'user_message',
      session_id: sessionId,
      data: {
        message,
        history: history.map(m => ({
          role: m.role,
          content: m.content,
        })),
      },
    });

    // 6. SSE 输出由 WSServer → SSERelay 自动转发
    //    不再需要 RuntimeAdapter 解析 SSE 流
  }
}
```

## 4. 数据模型变更

### 4.1 新增表

```sql
-- 用户虚拟机实例
CREATE TABLE user_vm_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  org_id UUID NOT NULL,
  mode VARCHAR(20) NOT NULL,  -- 'firecracker' | 'docker' | 'local'
  status VARCHAR(20) NOT NULL DEFAULT 'starting',
  vm_id VARCHAR(255),
  disk_id VARCHAR(255),
  ip_address VARCHAR(45),
  config JSONB DEFAULT '{}',  -- 资源配置（CPU、内存、网络）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  terminated_at TIMESTAMPTZ
);

CREATE INDEX idx_user_vm_instances_user ON user_vm_instances(user_id);
CREATE INDEX idx_user_vm_instances_status ON user_vm_instances(status) WHERE status != 'terminated';

-- 每用户仅允许一个非终止状态的 VM（防御性约束）
CREATE UNIQUE INDEX idx_user_vm_one_active
  ON user_vm_instances(user_id)
  WHERE status NOT IN ('terminated', 'failed');

-- Session 状态快照（灾难恢复用，快照粒度仍为 session）
CREATE TABLE session_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  org_id UUID NOT NULL,
  checkpoint JSONB,           -- LangGraph checkpoint
  short_term_memory JSONB,    -- 短期记忆内容
  conversation_state JSONB,   -- 对话状态
  file_manifest JSONB,        -- 文件列表（不含内容）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id);
CREATE INDEX idx_session_snapshots_user ON session_snapshots(user_id);
-- 只保留最近 3 个快照
CREATE INDEX idx_session_snapshots_cleanup ON session_snapshots(session_id, created_at DESC);

-- 用量记录（从 Redis 改为持久化，保留 session 粒度便于计费）
CREATE TABLE usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  model VARCHAR(100),
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 按月分区
CREATE INDEX idx_usage_records_org ON usage_records(org_id, created_at);
CREATE INDEX idx_usage_records_user ON usage_records(user_id, created_at);
```

### 4.2 现有表修改

```sql
-- organizations 表增加路由模式和虚拟机模式
ALTER TABLE organizations ADD COLUMN routing_mode VARCHAR(20) DEFAULT 'http';
-- 'http' | 'websocket'
ALTER TABLE organizations ADD COLUMN default_vm_mode VARCHAR(20) DEFAULT 'docker';
-- 'firecracker' | 'docker' | 'local'

-- users 表增加路由模式和虚拟机模式覆盖（可选，优先级高于组织默认值）
ALTER TABLE users ADD COLUMN routing_mode VARCHAR(20);
-- NULL 表示使用组织默认值
ALTER TABLE users ADD COLUMN vm_mode VARCHAR(20);
-- NULL 表示使用组织默认值

-- agents 表增加默认虚拟机模式
ALTER TABLE agents ADD COLUMN default_vm_mode VARCHAR(20) DEFAULT 'docker';

-- ============================================================
-- runtime_type 配置（双运行时支持）
-- 优先级：session > agent > user > org > 系统默认('semibot')
-- ============================================================

-- agents 表增加默认运行时类型
ALTER TABLE agents ADD COLUMN runtime_type VARCHAR(20) DEFAULT 'semibot';
-- 'semibot' | 'openclaw'

-- agents 表增加 OpenClaw 特有配置
ALTER TABLE agents ADD COLUMN openclaw_config JSONB;
-- {"tool_profile": "coding", "skills": ["pdf", "web-search"]}

-- sessions 表增加运行时类型（session 级覆盖）
ALTER TABLE sessions ADD COLUMN runtime_type VARCHAR(20);
-- NULL 表示使用 agent 默认值

-- users 表增加默认运行时偏好
ALTER TABLE users ADD COLUMN default_runtime_type VARCHAR(20);
-- NULL 表示使用组织默认值

-- organizations 表增加组织级默认运行时
ALTER TABLE organizations ADD COLUMN default_runtime_type VARCHAR(20);
-- NULL 表示使用系统默认值 'semibot'
```

## 5. 删除的模块

```
删除：
├── apps/api/src/adapters/runtime.adapter.ts
│   → 不再通过 HTTP 调用 Runtime
│   → 改为 WebSocket 通信
│
├── apps/api/src/services/queue.service.ts
│   → 不再使用 Redis Stream 消息队列
│   → 改为 WebSocket 直接通信
│
└── apps/api/src/services/runtime-monitor.service.ts
    → 改为基于 WebSocket 心跳的健康检测
    → 逻辑移入 scheduler/
```

## 6. 配置变更

```typescript
// apps/api/src/constants/config.ts 新增

// WebSocket
export const WS_PATH = '/ws/vm';
export const WS_HEARTBEAT_INTERVAL_MS = 10_000;      // 心跳间隔
export const WS_HEARTBEAT_TIMEOUT_MS = 30_000;        // 心跳超时
export const WS_RECONNECT_TIMEOUT_MS = 5 * 60_000;    // 重连等待
export const WS_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;   // 10MB

// 用户虚拟机调度
export const SCHEDULER_VM_POOL_SIZE = 10;              // 预热虚拟机数
export const SCHEDULER_IDLE_FREEZE_MS = 30_000;        // 空闲冻结时间
export const SCHEDULER_HEALTH_CHECK_INTERVAL_MS = 5_000;
export const MAX_SESSIONS_PER_VM = 20;                 // 每个用户 VM 最大并发 session 数

// SSE 缓冲
export const SSE_BUFFER_SIZE = 500;                    // 环形缓冲区大小（每 session）
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

// 快照
export const SNAPSHOT_INTERVAL_MS = 60_000;            // 快照同步间隔
export const SNAPSHOT_MAX_PER_USER = 5;                // 每用户最多保留

// 删除的配置
// RUNTIME_SERVICE_URL          → 不再需要
// RUNTIME_EXECUTION_TIMEOUT_MS → 不再需要
// RUNTIME_HEALTH_CHECK_TIMEOUT_MS → 不再需要
// RUNTIME_STALL_TIMEOUT_MS     → 不再需要
```
