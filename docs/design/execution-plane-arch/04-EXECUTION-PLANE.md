# 04 - 执行平面 (Execution Plane) 详细设计

> 执行平面是每个用户独立的虚拟机环境（= 个人电脑），负责实际的 Agent 执行。每个用户分配一个执行平面实例，多个 session 作为独立进程共享同一文件系统，通过一条 WebSocket 与控制平面通信。执行平面支持双运行时：SemiGraph（Python/LangGraph）和 OpenClaw（Node.js），每个 session 可独立选择 runtime，通过 RuntimeAdapter 抽象层统一管理。

---

## 目录

1. [职责概述](#1-职责概述)
2. [模块架构迁移方案](#2-模块架构迁移方案)
3. [新增模块设计](#3-新增模块设计)
4. [RuntimeAdapter 抽象层与双运行时](#4-runtimeadapter-抽象层与双运行时)
5. [主入口启动流程](#5-主入口启动流程)
6. [文件系统与目录规划](#6-文件系统与目录规划)
7. [LangGraph 节点改造](#7-langgraph-节点改造)
8. [Skill 加载流程](#8-skill-加载流程)
9. [LLM 调用流程](#9-llm-调用流程)
10. [离线/降级模式](#10-离线降级模式)
11. [重构后目录结构](#11-重构后目录结构)

---

## 1. 职责概述

执行平面承担以下核心职责：

| 职责 | 说明 |
|------|------|
| Session 进程管理 | 每个 session 作为独立进程运行，由虚拟机内的主进程统一管理 |
| 双运行时支持 | 通过 RuntimeAdapter 抽象层支持 SemiGraph（Python/LangGraph）和 OpenClaw（Node.js）两种 runtime，每个 session 二选一 |
| LangGraph 编排 | 运行 Agent 的完整推理-行动-反思循环（SemiGraph runtime） |
| OpenClaw Bridge | Node.js 桥接进程，驱动 OpenClaw 原生运行并翻译事件格式（OpenClaw runtime） |
| 短期记忆（MD 文件） | 基于本地 MD 文件的会话记忆，替代 Redis |
| 文件系统（用户共享） | 虚拟机 = 用户的个人电脑，所有 session 共享同一文件系统 |
| 代码执行 | 直接在执行平面内执行用户代码（虚拟机本身即隔离边界） |
| 本地 MCP（STDIO） | 通过 STDIO 协议调用本地 MCP 工具 |
| LLM 直连 | 直接调用 OpenAI/Anthropic API，不经过控制平面 |
| Checkpoint 持久化 | LangGraph 状态检查点保存到本地文件 |

### 设计原则

- **用户级隔离**：每个用户一个虚拟机，不同用户之间完全隔离；同一用户的多个 session 共享文件系统
- **虚拟机 = 个人电脑**：文件系统不做 session 间隔离，就像用户在自己电脑上开多个终端窗口
- **本地优先**：短期记忆、checkpoint、skill 缓存均存储在本地文件系统
- **控制平面代理**：长期记忆搜索、远程 MCP、用量上报等通过 WebSocket 委托控制平面
- **断线容错**：WebSocket 断开时，本地资源继续可用，远程功能优雅降级

---

## 2. 模块架构迁移方案

### 2.1 保留模块（KEEP）

以下模块是执行平面的核心，直接保留：

| 模块 | 路径 | 说明 |
|------|------|------|
| orchestrator/ | `orchestrator/` | LangGraph graph、nodes、state、edges、context — 执行平面的核心 |
| agents/ | `agents/` | Agent 定义与执行逻辑 |
| skills/ | `skills/` | Skill 执行逻辑（仅执行，不含管理） |
| llm/ | `llm/` | LLM provider 直连（OpenAI、Anthropic 等） |
| ~~sandbox/~~ | ~~`sandbox/`~~ | 移除：执行平面本身即隔离环境，不再需要额外沙箱 |
| mcp/ | `mcp/` | MCP 客户端（仅保留 STDIO 模式） |

### 2.2 移除模块（REMOVE）

以下模块在新架构中不再属于执行平面：

| 模块 | 原路径 | 迁移去向 | 原因 |
|------|--------|----------|------|
| server/ | `server/` | 移除，由 WS client 替代 | HTTP 服务器不再需要，执行平面作为 WS 客户端连接控制平面 |
| memory/short_term.py | `memory/short_term.py` | 移除，由 local_memory.py 替代 | Redis 短期记忆 → 本地 MD 文件 |
| memory/long_term.py | `memory/long_term.py` | 迁移至控制平面 | 长期记忆（向量搜索）由控制平面统一管理 |
| memory/embedding.py | `memory/embedding.py` | 迁移至控制平面 | Embedding 计算由控制平面统一管理 |
| queue/ | `queue/` | 移除 | 任务队列由控制平面管理 |
| evolution/ | `evolution/` | 迁移至控制平面 | 仅保留通过 WS 提交的接口 |

### 2.3 新增模块（NEW）

| 模块 | 路径 | 说明 |
|------|------|------|
| ws/client.py | `ws/client.py` | WebSocket 客户端 + 消息路由（单连接多 session 多路复用） |
| ws/message_types.py | `ws/message_types.py` | 消息类型定义 |
| memory/local_memory.py | `memory/local_memory.py` | 基于 MD 文件的短期记忆 |
| checkpoint/local_checkpointer.py | `checkpoint/local_checkpointer.py` | 基于本地文件的 LangGraph checkpoint |
| session/manager.py | `session/manager.py` | Session 进程管理器，根据 `runtime_type` 选择 Adapter |
| session/runtime_adapter.py | `session/runtime_adapter.py` | RuntimeAdapter ABC — 双运行时抽象层 |
| session/semigraph_adapter.py | `session/semigraph_adapter.py` | SemiGraphAdapter — 包装现有 SessionProcess |
| session/openclaw_adapter.py | `session/openclaw_adapter.py` | OpenClawBridgeAdapter — 启动 Node.js Bridge 进程 |
| openclaw-bridge/ | `openclaw-bridge/` | Node.js Bridge 进程（IPC + 事件翻译 + Skill 加载） |

---

## 3. 新增模块设计

### 3.1 WebSocket 客户端 — `ws/client.py`

WebSocket 客户端是执行平面与控制平面的唯一通信通道。每个虚拟机一条 WebSocket 连接，多 session 通过 session_id 多路复用。支持三种通信模式：

- **request/response**：请求-响应模式，用于需要返回结果的操作（如长期记忆搜索、远程 MCP 调用）
- **fire_and_forget**：单向发送，用于不需要返回结果的操作（如用量上报、审计日志）
- **SSE 事件转发**：将 LLM 流式 token 通过 WS 转发给控制平面，再由控制平面推送到前端

```python
import asyncio
import json
import websockets
from uuid import uuid4

class ControlPlaneClient:
    """WebSocket client connecting to control plane (one per VM, multi-session multiplexed)"""

    def __init__(self, control_plane_url: str, user_id: str, ticket: str, token: str):
        self.base_url = control_plane_url
        self.user_id = user_id
        self.connect_url = f"{control_plane_url}?user_id={user_id}&ticket={ticket}"
        self.reconnect_url = f"{control_plane_url}?user_id={user_id}"  # 重连不带 ticket
        self.token = token  # JWT，通过首帧 auth 消息传输
        self.ws = None
        self.pending_requests: dict[str, asyncio.Future] = {}
        self.message_handlers: dict[str, dict[str, callable]] = {}  # session_id -> {type -> handler}
        self._reconnect_delays = [1, 2, 4, 8, 16, 30, 30, 30]

    async def connect(self):
        self.ws = await websockets.connect(self.connect_url)
        # 首帧发送 auth 消息（JWT 不通过 URL 传递，避免泄露到日志）
        await self.ws.send(json.dumps({'type': 'auth', 'token': self.token}))
        init_msg = json.loads(await self.ws.recv())
        assert init_msg['type'] == 'init'
        asyncio.create_task(self._listen_loop())
        asyncio.create_task(self._heartbeat_loop())
        return init_msg['data']
    
    async def _listen_loop(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                session_id = msg.get('session_id')
                if msg['type'] == 'response':
                    future = self.pending_requests.pop(msg['id'], None)
                    if future and not future.done():
                        future.set_result(msg['result'])
                elif msg['type'] == 'user_message':
                    handlers = self.message_handlers.get(session_id, {})
                    handler = handlers.get('user_message')
                    if handler:
                        asyncio.create_task(handler(msg['data']))
                elif msg['type'] == 'cancel':
                    handlers = self.message_handlers.get(session_id, {})
                    handler = handlers.get('cancel')
                    if handler:
                        asyncio.create_task(handler())
                elif msg['type'] == 'start_session':
                    # 控制平面要求启动新 session 进程
                    handler = self.message_handlers.get('__vm__', {}).get('start_session')
                    if handler:
                        asyncio.create_task(handler(msg['data']))
                elif msg['type'] == 'stop_session':
                    handler = self.message_handlers.get('__vm__', {}).get('stop_session')
                    if handler:
                        asyncio.create_task(handler(msg['data']))
        except websockets.ConnectionClosed:
            await self._reconnect()
    
    async def _heartbeat_loop(self):
        while self.ws and self.ws.open:
            await self.ws.send(json.dumps({'type': 'heartbeat'}))
            await asyncio.sleep(10)
    
    async def _reconnect(self):
        for delay in self._reconnect_delays:
            try:
                # 重连不带 ticket（ticket 一次性，已失效），仅靠 auth 首帧认证
                self.ws = await websockets.connect(self.reconnect_url)
                # 重连后也需要首帧 auth
                await self.ws.send(json.dumps({'type': 'auth', 'token': self.token}))
                # 等待 init 消息
                init_msg = json.loads(await self.ws.recv())
                assert init_msg['type'] == 'init'
                # 收到 init 后再发送 resume
                pending_ids = list(self.pending_requests.keys())
                await self.ws.send(json.dumps({
                    'type': 'resume',
                    'pending_ids': pending_ids,
                }))
                resume_resp = json.loads(await self.ws.recv())
                assert resume_resp['type'] == 'resume_response'
                for msg_id, result in resume_resp.get('results', {}).items():
                    future = self.pending_requests.get(msg_id)
                    if future and not future.done():
                        if result['status'] == 'completed':
                            future.set_result(result['data'])
                        else:
                            future.set_exception(Exception('Request lost during reconnect'))
                asyncio.create_task(self._listen_loop())
                asyncio.create_task(self._heartbeat_loop())
                return
            except Exception:
                await asyncio.sleep(delay)
        for future in self.pending_requests.values():
            if not future.done():
                future.set_exception(ConnectionError('Control plane unreachable'))
        self.pending_requests.clear()
    
    async def request(self, session_id: str, method: str, **params) -> any:
        msg_id = str(uuid4())
        future = asyncio.get_event_loop().create_future()
        self.pending_requests[msg_id] = future
        await self.ws.send(json.dumps({
            'type': 'request',
            'id': msg_id,
            'session_id': session_id,
            'method': method,
            'params': params,
        }))
        try:
            return await asyncio.wait_for(future, timeout=60)
        except asyncio.TimeoutError:
            # 超时后必须清理 pending_requests，避免内存泄漏和重连时发送过期 ID
            self.pending_requests.pop(msg_id, None)
            raise

    async def send_sse_event(self, session_id: str, data: str):
        await self.ws.send(json.dumps({
            'type': 'sse_event',
            'session_id': session_id,
            'data': data,
        }))

    async def fire_and_forget(self, session_id: str, method: str, **params):
        await self.ws.send(json.dumps({
            'type': 'fire_and_forget',
            'session_id': session_id,
            'method': method,
            'params': params,
        }))

    async def get_skill_package(self, session_id: str, skill_id: str, version: str = 'latest'):
        return await self.request(session_id, 'get_skill_package', skill_id=skill_id, version=version)

    async def search_long_term_memory(self, session_id: str, query: str, top_k: int = 5):
        return await self.request(session_id, 'memory_search', query=query, top_k=top_k)

    async def call_remote_mcp(self, session_id: str, server: str, tool: str, arguments: dict):
        return await self.request(session_id, 'mcp_call', server=server, tool=tool, arguments=arguments)

    async def report_usage(self, session_id: str, model: str, tokens_in: int, tokens_out: int):
        await self.fire_and_forget(session_id, 'usage_report', model=model, tokens_in=tokens_in, tokens_out=tokens_out)

    async def submit_evolution(self, session_id: str, skill_data: dict):
        await self.fire_and_forget(session_id, 'evolution_submit', **skill_data)

    async def log_audit(self, session_id: str, event: str, details: dict):
        await self.fire_and_forget(session_id, 'audit_log', event=event, details=details)

    def register_session(self, session_id: str, handlers: dict[str, callable]):
        """注册 session 的消息处理器"""
        self.message_handlers[session_id] = handlers

    def unregister_session(self, session_id: str):
        """注销 session 的消息处理器"""
        self.message_handlers.pop(session_id, None)
```

#### 通信协议说明

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `init` | 控制平面 → 执行平面 | 连接建立后发送初始化数据（user_id、api_keys） |
| `start_session` | 控制平面 → 执行平面 | 要求启动新 session 进程（agent_config、skill_index、file_inventory） |
| `stop_session` | 控制平面 → 执行平面 | 要求停止 session 进程 |
| `request` | 执行平面 → 控制平面 | 请求-响应模式，带唯一 msg_id 和 session_id |
| `response` | 控制平面 → 执行平面 | 对 request 的响应，通过 msg_id 匹配请求 |
| `fire_and_forget` | 执行平面 → 控制平面 | 单向发送，无需响应，携带 session_id |
| `sse_event` | 执行平面 → 控制平面 | SSE 事件转发（LLM 流式 token），携带 session_id |
| `user_message` | 控制平面 → 执行平面 | 用户发送的新消息，携带 session_id 路由到对应进程 |
| `cancel` | 控制平面 → 执行平面 | 取消当前执行，携带 session_id |
| `heartbeat` | 执行平面 → 控制平面 | 心跳保活（每 10 秒，虚拟机级别） |
| `resume` | 执行平面 → 控制平面 | 重连后恢复未完成的请求 |

#### 重连策略

- 指数退避：`[1, 2, 4, 8, 16, 30, 30, 30]` 秒
- 重连后发送 `resume` 消息，携带所有未完成的 `pending_ids`
- 控制平面返回已完成的请求结果，未完成的标记为 lost
- 所有重试耗尽后，将所有 pending future 设置为 `ConnectionError`

---

### 3.2 本地短期记忆 — `memory/local_memory.py`

基于 MD 文件的短期记忆，替代原有的 Redis 短期记忆。所有数据存储在 session 目录下的 `memory/` 子目录中。

```python
import os
import json
from datetime import datetime
from pathlib import Path

class LocalShortTermMemory:
    """Short-term memory stored as MD files in session directory"""
    
    def __init__(self, session_dir: str):
        self.memory_dir = Path(session_dir) / 'memory'
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.conversation_file = self.memory_dir / 'conversation.md'
        self.context_file = self.memory_dir / 'context.json'
        self.scratch_file = self.memory_dir / 'scratchpad.md'
    
    async def save_message(self, role: str, content: str):
        timestamp = datetime.now().isoformat()
        entry = f"\n## [{role}] {timestamp}\n\n{content}\n"
        with open(self.conversation_file, 'a', encoding='utf-8') as f:
            f.write(entry)
    
    async def get_conversation(self) -> str:
        if not self.conversation_file.exists():
            return ''
        return self.conversation_file.read_text(encoding='utf-8')
    
    async def save_context(self, key: str, value: any):
        ctx = {}
        if self.context_file.exists():
            ctx = json.loads(self.context_file.read_text())
        ctx[key] = {'value': value, 'updated_at': datetime.now().isoformat()}
        self.context_file.write_text(json.dumps(ctx, ensure_ascii=False, indent=2))
    
    async def get_context(self, key: str = None):
        if not self.context_file.exists():
            return None if key else {}
        ctx = json.loads(self.context_file.read_text())
        if key:
            entry = ctx.get(key)
            return entry['value'] if entry else None
        return {k: v['value'] for k, v in ctx.items()}
    
    async def write_scratchpad(self, content: str):
        self.scratch_file.write_text(content, encoding='utf-8')
    
    async def read_scratchpad(self) -> str:
        if not self.scratch_file.exists():
            return ''
        return self.scratch_file.read_text(encoding='utf-8')
    
    async def get_all_for_snapshot(self) -> dict:
        return {
            'conversation': await self.get_conversation(),
            'context': await self.get_context(),
            'scratchpad': await self.read_scratchpad(),
        }
```

#### 存储文件说明

| 文件 | 格式 | 用途 |
|------|------|------|
| `conversation.md` | Markdown | 对话历史，按时间追加，每条消息一个 `## [role] timestamp` 段落 |
| `context.json` | JSON | 键值对上下文，存储 Agent 执行过程中的中间状态 |
| `scratchpad.md` | Markdown | Agent 的草稿板，用于多步推理时的临时记录 |

#### 与 Redis 短期记忆的对比

| 维度 | Redis 短期记忆（旧） | 本地 MD 文件（新） |
|------|----------------------|-------------------|
| 存储位置 | Redis 集群 | 本地文件系统 |
| 生命周期 | TTL 过期自动清理 | 随 session 目录一起清理 |
| 跨实例共享 | 支持 | 不支持（单 session 独占） |
| 持久化 | 依赖 Redis 持久化配置 | 天然持久化 |
| 性能 | 网络 I/O | 本地磁盘 I/O（更快） |
| 断线影响 | 不可用 | 不受影响 |

---

### 3.3 本地 Checkpoint — `checkpoint/local_checkpointer.py`

LangGraph 的 checkpoint 机制用于保存图执行状态，支持中断恢复。本实现将 checkpoint 存储为本地 JSON 文件。

```python
import json
import time
import os
from pathlib import Path
from glob import glob

class LocalCheckpointer:
    """LangGraph checkpoint stored as local JSON files"""
    
    def __init__(self, session_dir: str):
        self.checkpoint_dir = Path(session_dir) / 'checkpoints'
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
    
    async def put(self, config: dict, checkpoint: dict, metadata: dict):
        data = {
            'config': config,
            'checkpoint': checkpoint,
            'metadata': metadata,
            'timestamp': time.time(),
        }
        checkpoint_id = checkpoint.get('id', str(int(time.time() * 1000)))
        filepath = self.checkpoint_dir / f'{checkpoint_id}.json'
        tmp_path = filepath.with_suffix('.tmp')
        tmp_path.write_text(json.dumps(data, ensure_ascii=False, default=str))
        tmp_path.rename(filepath)  # atomic write
        self._cleanup_old()
    
    async def get_latest(self) -> dict | None:
        files = sorted(self.checkpoint_dir.glob('*.json'), key=lambda f: f.stat().st_mtime, reverse=True)
        if not files:
            return None
        return json.loads(files[0].read_text())
    
    async def get_all_for_snapshot(self) -> dict | None:
        return await self.get_latest()
    
    def _cleanup_old(self, keep: int = 10):
        files = sorted(self.checkpoint_dir.glob('*.json'), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in files[keep:]:
            f.unlink()
```

#### 设计要点

- **原子写入**：先写 `.tmp` 文件，再 `rename` 为正式文件，避免写入中断导致数据损坏
- **自动清理**：默认保留最近 10 个 checkpoint，自动删除旧文件
- **快照同步**：`get_all_for_snapshot()` 返回最新 checkpoint，供定期同步到控制平面

---

## 4. RuntimeAdapter 抽象层与双运行时

执行平面通过 `RuntimeAdapter` 抽象层支持多种运行时。`SessionManager` 根据 `start_session` 消息中的 `runtime_type` 字段选择对应的 Adapter，对上层完全透明。

### 4.1 架构概览

```
SessionManager (Python, VM 级守护进程)
    │
    ├── Session A (runtime_type=semigraph)
    │   └── SemiGraphAdapter → LangGraph 进程（现有逻辑不变）
    │
    └── Session B (runtime_type=openclaw)
        └── OpenClawBridgeAdapter → Node.js Bridge 进程
            └── OpenClaw Brain/Skills/Memory（原生运行）
```

两种 runtime 共享：
- 同一条 WebSocket 连接（通过 session_id 多路复用）
- 同一个文件系统（`/home/user/workspace/`）
- 同一份 Skill 缓存（`/home/user/.semibot/skills/`）
- 同一套 API Key（由控制平面通过 `init` 消息注入）

控制平面和前端**无需感知** runtime 差异——SSE 事件格式统一。

### 4.2 RuntimeAdapter ABC

```python
# runtime/src/session/runtime_adapter.py
from abc import ABC, abstractmethod

class RuntimeAdapter(ABC):
    """双运行时抽象层 — 每个 session 对应一个 Adapter 实例"""

    @abstractmethod
    async def start(self, session_id: str, config: dict) -> None:
        """启动 runtime，初始化执行环境"""
        ...

    @abstractmethod
    async def send_message(self, data: dict) -> None:
        """发送用户消息到 runtime"""
        ...

    @abstractmethod
    async def cancel(self) -> None:
        """取消当前执行"""
        ...

    @abstractmethod
    async def stop(self) -> None:
        """优雅关闭 runtime"""
        ...

    @abstractmethod
    async def get_snapshot(self) -> dict:
        """获取当前状态快照（用于定期同步到控制平面）"""
        ...
```

### 4.3 SemiGraphAdapter

包装现有 `SessionProcess`，逻辑零改动：

```python
# runtime/src/session/semigraph_adapter.py
from session.runtime_adapter import RuntimeAdapter
from orchestrator.graph import create_agent_graph
from memory.local_memory import LocalShortTermMemory
from checkpoint.local_checkpointer import LocalCheckpointer

class SemiGraphAdapter(RuntimeAdapter):
    """SemiGraph runtime — 包装现有 SessionProcess（Python/LangGraph）"""

    def __init__(self, client, memory_dir: str):
        self.client = client
        self.memory_dir = memory_dir
        self.memory = None
        self.checkpointer = None
        self.graph = None
        self.session_id = None

    async def start(self, session_id: str, config: dict) -> None:
        self.session_id = session_id
        self.memory = LocalShortTermMemory(self.memory_dir)
        self.checkpointer = LocalCheckpointer(self.memory_dir)
        self.graph = create_agent_graph(
            agent_config=config.get('agent_config', {}),
            checkpointer=self.checkpointer,
            control_plane=self.client,
            session_id=session_id,
            memory=self.memory,
        )

    async def send_message(self, data: dict) -> None:
        await self.memory.save_message('user', data['message'])
        result = await self.graph.ainvoke({
            'user_message': data['message'],
            'history_messages': data.get('history', []),
            'session_id': self.session_id,
        })
        await self.memory.save_message('assistant', result.get('response', ''))

    async def cancel(self) -> None:
        """取消当前执行：中断 LLM 流式调用，保存 checkpoint"""
        if self.graph and hasattr(self.graph, 'acancel'):
            await self.graph.acancel()
        # 保存当前状态，下次对话可从中断点继续
        if self.checkpointer:
            snapshot = await self.get_snapshot()
            await self.client.fire_and_forget(self.session_id, 'snapshot_sync', **snapshot)
        # 通知前端执行已取消
        await self.client.send_sse_event(self.session_id, json.dumps({
            'type': 'execution_complete',
            'cancelled': True,
        }))

    async def stop(self) -> None:
        # 最终快照
        snapshot = await self.get_snapshot()
        await self.client.fire_and_forget(self.session_id, 'snapshot_sync', **snapshot)

    async def get_snapshot(self) -> dict:
        return {
            'checkpoint': await self.checkpointer.get_all_for_snapshot(),
            'short_term_memory': await self.memory.get_all_for_snapshot(),
        }
```

### 4.4 OpenClawBridgeAdapter

启动 Node.js Bridge 进程，通过 Unix Domain Socket 通信：

```python
# runtime/src/session/openclaw_adapter.py
import asyncio
import json
import os
import tempfile
from pathlib import Path
from session.runtime_adapter import RuntimeAdapter
from utils.logging import get_logger

logger = get_logger(__name__)

class OpenClawBridgeAdapter(RuntimeAdapter):
    """OpenClaw runtime — 启动 Node.js Bridge 进程，通过 Unix Domain Socket 通信"""

    BRIDGE_SCRIPT = Path('/opt/openclaw-bridge/dist/main.js')

    def __init__(self, client, memory_dir: str):
        self.client = client
        self.memory_dir = memory_dir
        self.session_id = None
        self.process = None
        self.reader = None
        self.writer = None
        self.socket_path = None
        self._listen_task = None

    async def start(self, session_id: str, config: dict) -> None:
        self.session_id = session_id

        # 创建 Unix Domain Socket
        self.socket_path = f'/tmp/openclaw-{session_id}.sock'
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

        # 启动 IPC 服务端（Python 侧）
        server_ready = asyncio.Event()

        async def handle_bridge_connection(reader, writer):
            self.reader = reader
            self.writer = writer
            server_ready.set()

        self._unix_server = await asyncio.start_unix_server(
            handle_bridge_connection, path=self.socket_path
        )

        # 启动 Node.js Bridge 进程
        self.process = await asyncio.create_subprocess_exec(
            'node', str(self.BRIDGE_SCRIPT),
            env={
                **os.environ,
                'SOCKET_PATH': self.socket_path,
                'SESSION_ID': session_id,
                'SKILLS_CACHE_DIR': '/home/user/.semibot/skills',
                'MEMORY_DIR': os.path.join(self.memory_dir, 'openclaw-memory'),
            },
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # 等待 Bridge 连接
        await asyncio.wait_for(server_ready.wait(), timeout=10)

        # 发送初始化指令
        await self._send({
            'type': 'start',
            'agent_config': config.get('agent_config', {}),
            'skill_index': config.get('skill_index', []),
            'api_keys': config.get('api_keys', {}),
            'openclaw_config': config.get('openclaw_config', {}),
        })

        # 等待 ready 响应
        ready_msg = await self._recv()
        if ready_msg.get('type') != 'ready':
            raise RuntimeError(f'OpenClaw Bridge 初始化失败: {ready_msg}')

        # 启动消息监听循环
        self._listen_task = asyncio.create_task(self._listen_loop())

        logger.info(f'[OpenClaw] Bridge 启动成功', extra={'session_id': session_id})

    async def send_message(self, data: dict) -> None:
        await self._send({
            'type': 'user_message',
            'data': data,
        })

    async def cancel(self) -> None:
        await self._send({'type': 'cancel'})

    async def stop(self) -> None:
        try:
            await self._send({'type': 'stop'})
            if self.process:
                await asyncio.wait_for(self.process.wait(), timeout=5)
        except Exception:
            if self.process:
                self.process.kill()
        finally:
            if self._listen_task:
                self._listen_task.cancel()
            if self._unix_server:
                self._unix_server.close()
            if self.socket_path and os.path.exists(self.socket_path):
                os.unlink(self.socket_path)

    async def get_snapshot(self) -> dict:
        # OpenClaw 的状态由 Bridge 管理，通过 IPC 获取
        return {
            'runtime_type': 'openclaw',
            'session_id': self.session_id,
        }

    # ---- IPC 通信 ----

    async def _send(self, msg: dict):
        """发送 JSON-line 消息到 Bridge"""
        line = json.dumps(msg, ensure_ascii=False) + '\n'
        self.writer.write(line.encode())
        await self.writer.drain()

    async def _recv(self) -> dict:
        """接收一条 JSON-line 消息"""
        line = await self.reader.readline()
        return json.loads(line.decode())

    async def _listen_loop(self):
        """监听 Bridge 上行消息，转发到控制平面"""
        try:
            while True:
                line = await self.reader.readline()
                if not line:
                    break
                msg = json.loads(line.decode())
                await self._handle_bridge_message(msg)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f'[OpenClaw] Bridge 监听异常', extra={
                'session_id': self.session_id, 'error': str(e)
            })

    async def _handle_bridge_message(self, msg: dict):
        """处理 Bridge 上行消息"""
        msg_type = msg.get('type')

        if msg_type == 'sse_event':
            # 翻译后的 SSE 事件，直接转发到控制平面
            await self.client.send_sse_event(self.session_id, msg['data'])

        elif msg_type == 'request':
            # Bridge 需要控制平面处理的请求（memory_search、get_skill_package、mcp_call）
            try:
                result = await self.client.request(
                    self.session_id, msg['method'], **msg.get('params', {})
                )
                await self._send({
                    'type': 'response',
                    'id': msg['id'],
                    'result': result,
                })
            except Exception as e:
                await self._send({
                    'type': 'response',
                    'id': msg['id'],
                    'error': str(e),
                })

        elif msg_type == 'fire_and_forget':
            # 单向通知（usage_report、audit_log）
            await self.client.fire_and_forget(
                self.session_id, msg['method'], **msg.get('params', {})
            )

        elif msg_type == 'error':
            logger.error(f'[OpenClaw] Bridge 报错', extra={
                'session_id': self.session_id, 'error': msg.get('message')
            })
            await self.client.send_sse_event(self.session_id, json.dumps({
                'type': 'execution_error',
                'error': msg.get('message', 'OpenClaw Bridge error'),
            }))
```

### 4.5 OpenClaw Bridge 进程（Node.js）

Bridge 是一个 Node.js 进程，职责：
- 通过 Unix Domain Socket 接收 Python SessionManager 的指令
- 驱动 OpenClaw 的 Brain/Skills/Memory 原生运行
- 将 OpenClaw 事件翻译为 Semibot SSE 事件格式
- 代理控制平面请求（长期记忆搜索、远程 MCP、Skill 包拉取）

```
Python SessionManager ←→ Unix Socket (JSON-line) ←→ Node.js Bridge ←→ OpenClaw
```

#### IPC 协议（JSON-line，每行一个 JSON 对象）

**Python → Bridge：**

| type | 用途 |
|------|------|
| `start` | 初始化 OpenClaw，传入 agent_config、skill_index、api_keys |
| `user_message` | 用户消息 |
| `cancel` | 取消当前执行 |
| `stop` | 优雅关闭 |
| `response` | 控制平面请求的响应（memory_search、mcp_call 等） |

**Bridge → Python：**

| type | 用途 |
|------|------|
| `ready` | 初始化完成 |
| `sse_event` | 翻译后的 SSE 事件（text_chunk、tool_call_start 等） |
| `request` | 需要控制平面处理的请求（memory_search、get_skill_package、mcp_call） |
| `fire_and_forget` | 单向通知（usage_report、audit_log） |
| `error` | 错误 |

#### Bridge 目录结构

```
runtime/openclaw-bridge/
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts              # 入口：连接 Unix Socket，初始化 OpenClaw
    ├── bridge.ts            # IPC 客户端：JSON-line 协议收发
    ├── event-translator.ts  # 事件格式翻译：OpenClaw → Semibot SSE
    └── skill-loader.ts      # Skill 缓存集成：优先本地，未命中走 IPC
```

### 4.6 SSE 事件翻译

Bridge 内置事件翻译器，将 OpenClaw 事件映射为 Semibot 格式：

| OpenClaw 事件 | → Semibot SSE 事件 |
|--------------|-------------------|
| LLM token stream | `text_chunk` |
| tool_use | `tool_call_start` |
| tool_result | `tool_call_complete` |
| skill invocation | `skill_call_start` / `skill_call_complete` |
| thinking | `thinking` (stage="openclaw") |
| done | `execution_complete` |
| error | `execution_error` |

翻译后的事件通过 IPC 发送到 Python 侧，再由 `client.send_sse_event(session_id, data)` 转发到控制平面，最终推送到前端。控制平面和前端完全无感。

```typescript
// runtime/openclaw-bridge/src/event-translator.ts

interface SemibotSSEEvent {
  type: string;
  [key: string]: unknown;
}

export function translateEvent(openclawEvent: any): SemibotSSEEvent | null {
  switch (openclawEvent.type) {
    case 'token':
      return { type: 'text_chunk', content: openclawEvent.content };

    case 'tool_use':
      return {
        type: 'tool_call_start',
        tool_name: openclawEvent.name,
        tool_input: openclawEvent.input,
      };

    case 'tool_result':
      return {
        type: 'tool_call_complete',
        tool_name: openclawEvent.name,
        result: openclawEvent.output,
      };

    case 'skill_invoke':
      return {
        type: 'skill_call_start',
        skill_name: openclawEvent.skill,
        arguments: openclawEvent.args,
      };

    case 'skill_result':
      return {
        type: 'skill_call_complete',
        skill_name: openclawEvent.skill,
        result: openclawEvent.output,
      };

    case 'thinking':
      return { type: 'thinking', content: openclawEvent.content, stage: 'openclaw' };

    case 'done':
      return { type: 'execution_complete', content: openclawEvent.response };

    case 'error':
      return { type: 'execution_error', error: openclawEvent.message };

    default:
      return null; // 未知事件，跳过
  }
}
```

### 4.7 Skill 兼容

两个 runtime 都使用 SKILL.md 格式，共享同一份缓存目录 `/home/user/.semibot/skills/`。缓存的是**完整技能包目录**（SKILL.md + scripts/ + REFERENCE.md 等），而非单个文件，以支持 ClawHub 技能包的 scripts/ 执行。

- **SemiGraph**：通过现有的 `load_skill_with_cache()` 加载（见第 8 节）
- **OpenClaw**：Bridge 重写 OpenClaw 的 skill loader，优先从缓存读取，缓存未命中时通过 IPC → Python → WS 从控制平面拉取

#### ClawHub 技能包兼容

Semibot 的目标是**直接运行 ClawHub 上的技能包**，无需任何适配。兼容性保障：

| 维度 | ClawHub 技能包 | Semibot 处理 |
|------|--------------|-------------|
| 元数据 | SKILL.md frontmatter（仅 name + description） | 控制平面安装时自动补全 skill_id（slug 化 name）、version（时间戳） |
| 目录结构 | SKILL.md + scripts/ + REFERENCE.md + ... | 完整目录缓存到 VM，保持原始结构 |
| scripts/ 执行 | LLM 通过 bash 调用 `python scripts/xxx.py` | VM 内 bash 工具直接执行缓存目录下的脚本 |
| 依赖检查 | `metadata.requires`（二进制、环境变量） | Session 启动时校验 `skill_index[].requires`，不满足的 skill 标记为 unavailable |
| 懒加载 | OpenClaw 原生支持 | 索引注入 + `get_skill_package` 按需拉取完整目录 |

#### 缓存目录结构

```
/home/user/.semibot/skills/
├── pdf/                          # 完整技能包目录（与 ClawHub 原始结构一致）
│   ├── SKILL.md
│   ├── REFERENCE.md
│   ├── FORMS.md
│   ├── scripts/
│   │   ├── check_fillable_fields.py
│   │   ├── fill_pdf_form_with_annotations.py
│   │   └── extract_form_field_info.py
│   └── LICENSE.txt
├── xlsx/
│   ├── SKILL.md
│   └── scripts/
│       └── recalc.py
└── web-search/
    └── SKILL.md
```

#### Skill 加载器（完整目录缓存）

```typescript
// runtime/openclaw-bridge/src/skill-loader.ts
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const SKILLS_CACHE_DIR = process.env.SKILLS_CACHE_DIR || '/home/user/.semibot/skills';

export async function loadSkill(
  skillId: string,
  requestFn: (method: string, params: any) => Promise<any>
): Promise<string> {
  const skillDir = join(SKILLS_CACHE_DIR, skillId);
  const skillMdPath = join(skillDir, 'SKILL.md');

  // 缓存命中（目录存在且 SKILL.md 存在）
  if (existsSync(skillMdPath)) {
    return readFileSync(skillMdPath, 'utf-8');
  }

  // 缓存未命中，通过 IPC 请求控制平面拉取完整技能包
  const result = await requestFn('get_skill_package', { skill_id: skillId });

  // 写入完整目录（保持原始结构）
  mkdirSync(skillDir, { recursive: true });
  for (const file of result.package.files) {
    const filePath = join(skillDir, file.path);
    mkdirSync(join(filePath, '..'), { recursive: true });
    if (file.encoding === 'base64') {
      writeFileSync(filePath, Buffer.from(file.content, 'base64'));
    } else {
      writeFileSync(filePath, file.content, 'utf-8');
    }
  }

  return readFileSync(skillMdPath, 'utf-8');
}
```

### 4.8 记忆兼容

- **短期记忆**：各 runtime 使用独立子目录，互不干扰
  - SemiGraph：`.semibot/sessions/{session_id}/memory/`
  - OpenClaw：`.semibot/sessions/{session_id}/openclaw-memory/`
- **长期记忆**：两者都通过 WS `memory_search` 请求控制平面，Bridge 代理此调用

### 4.9 配置优先级

`runtime_type` 字段加入配置层级（优先级从高到低）：

1. `sessions.runtime_type` — session 级覆盖
2. `agents.runtime_type` — agent 默认值
3. `users.default_runtime_type` — 用户偏好
4. `organizations.default_runtime_type` — 组织默认
5. 系统默认：`'semigraph'`

> **混合 runtime 支持**：同一用户的不同 session 允许使用不同的 `runtime_type`（硬需求）。例如用户可以同时拥有一个 `semigraph` session 和一个 `openclaw` session，由 `SessionManager` 为每个 session 独立创建对应的 `RuntimeAdapter`。

控制平面在构造 `start_session` 消息时解析此优先级链，执行平面只需读取消息中的 `runtime_type` 字段。

### 4.10 错误处理

- **Bridge 崩溃不影响其他 session**（进程隔离）
- **不做自动 fallback**：OpenClaw session 失败不会切换到 SemiGraph（执行模型完全不同，自动切换会导致不可预期的行为）
- **健康检查**新增 `openclaw_available` 字段，检测 Node.js 和 OpenClaw 是否可用
- **Bridge 进程监控**：`OpenClawBridgeAdapter` 监控子进程退出码，异常退出时上报 `execution_error` 事件

---

## 5. 主入口启动流程

执行平面作为虚拟机级别的守护进程启动（每用户一个），通过环境变量接收配置，连接控制平面后管理多个 session 进程。

```python
# runtime/src/main.py
import asyncio
import os
from ws.client import ControlPlaneClient
from session.manager import SessionManager

async def main():
    user_id = os.environ['USER_ID']
    token = os.environ['VM_TOKEN']
    ticket = os.environ['VM_TICKET']
    control_plane_url = os.environ['CONTROL_PLANE_WS']

    # 1. Connect to control plane (one WS per VM)
    client = ControlPlaneClient(control_plane_url, user_id, ticket, token)
    init_data = await client.connect()

    # 2. Initialize session manager
    session_mgr = SessionManager(client, init_data)

    # 3. Register VM-level message handlers
    client.message_handlers['__vm__'] = {
        'start_session': session_mgr.start_session,
        'stop_session': session_mgr.stop_session,
    }

    # 4. Periodic snapshot sync (VM-level, 通过 RuntimeAdapter 统一接口)
    async def snapshot_loop():
        while True:
            await asyncio.sleep(60)
            for sid, adapter in session_mgr.active_sessions.items():
                snapshot = await adapter.get_snapshot()
                if snapshot:  # OpenClaw 可能返回空 dict，跳过
                    await client.fire_and_forget(sid, 'snapshot_sync', **snapshot)

    asyncio.create_task(snapshot_loop())

    # 5. Keep running
    await asyncio.Event().wait()

if __name__ == '__main__':
    asyncio.run(main())
```

### Session 进程管理器

`SessionManager` 通过 `RuntimeAdapter` 抽象层管理 session，根据 `runtime_type` 路由到不同的运行时实现。

```python
# runtime/src/session/manager.py
import asyncio
import logging
from session.runtime_adapter import RuntimeAdapter
from session.semigraph_adapter import SemiGraphAdapter
from session.openclaw_adapter import OpenClawBridgeAdapter

logger = logging.getLogger(__name__)

# ── 工厂函数 ──────────────────────────────────────────────

SUPPORTED_RUNTIME_TYPES = {'semigraph', 'openclaw'}

def create_adapter(runtime_type: str, client, memory_dir: str) -> RuntimeAdapter:
    """根据 runtime_type 创建对应的 RuntimeAdapter 实例

    注意：此时只创建实例，不初始化运行时。
    调用方必须随后调用 adapter.start(session_id, config) 完成初始化。

    Raises:
        ValueError: runtime_type 不在支持列表中时拒绝创建，不做静默回落
    """
    if runtime_type not in SUPPORTED_RUNTIME_TYPES:
        raise ValueError(
            f"不支持的 runtime_type: '{runtime_type}'，"
            f"允许值: {SUPPORTED_RUNTIME_TYPES}"
        )
    if runtime_type == 'openclaw':
        return OpenClawBridgeAdapter(client=client, memory_dir=memory_dir)
    return SemiGraphAdapter(client=client, memory_dir=memory_dir)


# ── SessionManager ───────────────────────────────────────

class SessionManager:
    """管理虚拟机内的多个 session，通过 RuntimeAdapter 屏蔽运行时差异"""

    def __init__(self, client, init_data: dict):
        self.client = client
        self.init_data = init_data
        self.active_sessions: dict[str, RuntimeAdapter] = {}

    async def start_session(self, data: dict):
        session_id = data['session_id']
        agent_config = data['agent_config']
        runtime_type = data.get('runtime_type', 'semigraph')  # 控制平面已解析好
        skill_index = data.get('skill_index')

        memory_dir = f'/home/user/.semibot/sessions/{session_id}'

        # 1. 通过工厂函数创建对应的 Adapter（仅实例化，未初始化）
        adapter = create_adapter(runtime_type, self.client, memory_dir)

        # 2. 初始化运行时（SemiGraph: 创建 LangGraph；OpenClaw: 启动 Bridge 进程）
        await adapter.start(session_id, config={
            'agent_config': agent_config,
            'skill_index': skill_index,
            'api_keys': self.init_data.get('api_keys', {}),
            'openclaw_config': data.get('openclaw_config', {}),
        })

        self.active_sessions[session_id] = adapter

        logger.info('session %s started with runtime=%s', session_id, runtime_type)

        # 3. 注册该 session 的消息处理器（统一接口）
        self.client.register_session(session_id, {
            'user_message': adapter.send_message,
            'cancel': adapter.cancel,
        })

    async def stop_session(self, data: dict):
        session_id = data['session_id']
        adapter = self.active_sessions.pop(session_id, None)
        if adapter:
            # 优雅关闭（Adapter 内部处理快照上报）
            await adapter.stop()
            self.client.unregister_session(session_id)
            logger.info('session %s stopped', session_id)
```

> **变更要点**：
> - `active_sessions` 的值类型从 `SessionProcess` 改为 `RuntimeAdapter`
> - `create_adapter()` 仅实例化，随后必须调用 `adapter.start(session_id, config)` 初始化运行时
> - `start_session` 读取 `runtime_type` 字段，通过工厂函数路由，并将 `api_keys` 从 `init_data` 注入 config
> - 消息处理器绑定到 `adapter.send_message`（非 execute），`cancel` 绑定到 `adapter.cancel()`
> - `stop_session` 调用 `adapter.stop()`，由各 Adapter 自行处理快照上报和资源清理

### 启动流程时序

```
环境变量注入 (USER_ID, VM_TOKEN, CONTROL_PLANE_WS)
        │
        ▼
WebSocket 连接控制平面 → 接收 init 消息 (user_id, api_keys)
        │
        ▼
初始化 SessionManager
        │
        ▼
注册 VM 级消息处理器 (start_session, stop_session)
        │
        ▼
启动定期快照同步 (每 60 秒)
        │
        ▼
进入消息循环等待
        │
        ▼ (收到 start_session)
根据 runtime_type 创建 RuntimeAdapter（SemiGraphAdapter / OpenClawBridgeAdapter）
        │
        ▼
调用 adapter.start(session_id, config) 初始化运行时
        │
        ▼
注册该 session 的消息处理器 (user_message → adapter.send_message, cancel → adapter.cancel)
        │
        ▼ (收到 user_message with session_id)
路由到对应 RuntimeAdapter → adapter.send_message()
```

### 环境变量

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `USER_ID` | 是 | 用户唯一标识 |
| `VM_TOKEN` | 是 | 虚拟机认证 JWT，由控制平面签发，通过首帧 auth 消息传输 |
| `VM_TICKET` | 是 | 一次性连接票据，由控制平面在调度 VM 时生成，有效期 30 秒 |
| `CONTROL_PLANE_WS` | 是 | 控制平面 WebSocket 地址 |

### init_data 结构

控制平面在 WebSocket 连接建立后发送的初始化数据（虚拟机级别）：

```json
{
  "type": "init",
  "data": {
    "user_id": "user-uuid",
    "org_id": "org-uuid",
    "api_keys": {
      "openai": "sk-...",
      "anthropic": "sk-ant-..."
    }
  }
}
```

### start_session 消息结构

控制平面要求启动新 session 时发送：

```json
{
  "type": "start_session",
  "data": {
    "session_id": "session-uuid",
    "agent_config": {
      "id": "agent-uuid",
      "name": "My Agent",
      "system_prompt": "...",
      "model": "gpt-4o",
      "temperature": 0.7,
      "max_tokens": 4096,
      "tools": ["code_execution", "web_search"]
    },
    "skill_index": [
      {"id": "skill-1", "name": "数据分析", "description": "..."},
      {"id": "skill-2", "name": "代码生成", "description": "..."}
    ],
    "mcp_servers": [],
    "sub_agents": [],
    "session_config": {
      "max_turns": 50,
      "timeout_seconds": 3600
    }
  }
}
```

---

## 6. 文件系统与目录规划

虚拟机 = 用户的个人电脑。所有 session 共享同一文件系统，不做 session 间隔离。

### 目录结构

```
/home/user/
├── .semibot/                         # Semibot 内部目录
│   ├── config.json                   # 虚拟机级配置
│   ├── sessions/                     # 各 session 的运行时数据
│   │   ├── {session_id}/
│   │   │   ├── memory/
│   │   │   │   ├── conversation.md   # 对话历史
│   │   │   │   ├── context.json      # 键值对上下文
│   │   │   │   └── scratchpad.md     # Agent 草稿板
│   │   │   └── checkpoints/
│   │   │       ├── {id}.json         # LangGraph checkpoint
│   │   │       └── ...
│   │   └── ...
│   └── skills/                       # Skill 文件缓存（所有 session 共享）
│       ├── {skill_id}/
│       │   └── SKILL.md
│       └── ...
├── workspace/                        # 用户可见的工作区（所有 session 共享）
│   ├── projects/
│   │   ├── my-app/
│   │   └── data-analysis/
│   └── downloads/
└── ...
```

### 目录说明

| 目录 | 可见性 | 共享范围 | 说明 |
|------|--------|----------|------|
| `.semibot/config.json` | 内部 | 虚拟机级 | 虚拟机配置（user_id 等） |
| `.semibot/sessions/{id}/memory/` | 内部 | 单 session | 该 session 的短期记忆 |
| `.semibot/sessions/{id}/checkpoints/` | 内部 | 单 session | 该 session 的 LangGraph 状态 |
| `.semibot/skills/` | 内部 | 所有 session | Skill 文件缓存，按需从控制平面拉取 |
| `workspace/` | 用户可见 | 所有 session | 用户文件，就像个人电脑的工作目录 |

### 设计原则

- **无 session 隔离**：多个 session 可以读写同一个文件，就像在电脑上开多个终端窗口
- **短期记忆隔离**：每个 session 的对话历史和 checkpoint 是独立的（在 `.semibot/sessions/` 下）
- **Skill 缓存共享**：同一个 skill 只缓存一份，所有 session 共用
- **用户数据持久化**：`workspace/` 目录在 session 结束后保留，虚拟机冻结/恢复后仍然存在
- **Session 清理**：session 结束后只清理 `.semibot/sessions/{id}/`，不影响用户文件

---

## 7. LangGraph 节点改造

每个 SemiGraph session 拥有独立的 LangGraph 实例（在 `SemiGraphAdapter` 内部创建）。节点通过 `config` 获取 `session_id`、`memory`、`control_plane` 等上下文。OpenClaw session 不使用 LangGraph，由 Bridge 进程内部管理。

### 7.1 start_node 改造

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| 短期记忆加载 | 从 Redis 读取 | 从本地 MD 文件读取（session 独立） |
| 长期记忆加载 | 直接查询 PostgreSQL + 向量搜索 | 通过 WS request 请求控制平面搜索 |
| 上下文构建 | 合并 Redis + PostgreSQL 结果 | 合并本地文件 + WS 响应结果 |

```python
async def start_node(state, config):
    session_id = config['session_id']
    memory = config['memory']          # LocalShortTermMemory (per session)
    client = config['control_plane']   # ControlPlaneClient (shared)

    # 本地短期记忆（session 独立）
    conversation = await memory.get_conversation()
    context = await memory.get_context()

    # 远程长期记忆（通过 WS，带 session_id）
    try:
        long_term = await client.search_long_term_memory(
            session_id=session_id,
            query=state['user_message'],
            top_k=5,
        )
    except (ConnectionError, asyncio.TimeoutError):
        long_term = []  # 降级：无长期记忆

    return {
        **state,
        'conversation_history': conversation,
        'context': context,
        'long_term_memories': long_term,
    }
```

### 7.2 act_node 改造

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| Skill 调用 | 直接调用 skill_registry | 本地 `.semibot/skills/` 缓存（所有 session 共享），缓存未命中时通过 WS 拉取 |
| MCP 调用 | 直接调用 MCP client | 本地 STDIO MCP 保持不变，远程 MCP 通过 WS 代理 |
| 代码执行 | 直接执行 | 移除沙箱，虚拟机本身即隔离边界 |

```python
async def act_node(state, config):
    session_id = config['session_id']
    client = config['control_plane']

    results = []
    for tool_call in state['pending_tool_calls']:
        if tool_call.type == 'skill':
            # 本地缓存优先（skill 缓存所有 session 共享）
            skill_files = await load_skill_with_cache(
                tool_call.skill_id, client
            )
            result = await execute_skill(skill_files, tool_call.arguments)

        elif tool_call.type == 'mcp':
            if tool_call.transport == 'stdio':
                result = await local_mcp_call(tool_call)
            else:
                result = await client.call_remote_mcp(
                    session_id=session_id,
                    server=tool_call.server,
                    tool=tool_call.tool,
                    arguments=tool_call.arguments,
                )

        elif tool_call.type == 'code_execution':
            # 直接执行（虚拟机本身即隔离边界）
            result = await execute_code(tool_call.code)

        results.append(result)

    return {**state, 'tool_results': results}
```

### 7.3 reflect_node 改造

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| 短期记忆写入 | 写入 Redis | 写入本地 MD 文件（session 独立） |
| Evolution 提交 | 调用本地 evolution engine | 通过 WS fire_and_forget 提交到控制平面 |

```python
async def reflect_node(state, config):
    session_id = config['session_id']
    memory = config['memory']
    client = config['control_plane']

    # 写入本地短期记忆（session 独立）
    await memory.save_context('last_action', state['last_action'])
    await memory.write_scratchpad(state['reflection_notes'])

    # 提交 evolution（如果有新发现）
    if state.get('evolution_candidate'):
        await client.submit_evolution(
            session_id=session_id,
            candidate=state['evolution_candidate'],
        )

    return state
```

### 7.4 respond_node 改造

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| 响应发送 | 通过 HTTP SSE 直接推送到前端 | 通过 WS send_sse_event 发送到控制平面（带 session_id），再由控制平面推送到前端 |

```python
async def respond_node(state, config):
    session_id = config['session_id']
    client = config['control_plane']

    # 流式发送响应（带 session_id 路由）
    # 事件类型使用统一 SSE 规范：text_chunk / execution_complete
    for token in state['response_tokens']:
        await client.send_sse_event(session_id, json.dumps({
            'type': 'text_chunk',
            'content': token,
        }))

    # 发送完成事件
    await client.send_sse_event(session_id, json.dumps({
        'type': 'execution_complete',
        'content': state['final_response'],
    }))

    # 上报用量
    await client.report_usage(
        session_id=session_id,
        model=state['model'],
        tokens_in=state['usage']['input_tokens'],
        tokens_out=state['usage']['output_tokens'],
    )

    return state
```

---

## 8. Skill 加载流程

Skill 采用懒加载策略，首次使用时从控制平面拉取**完整技能包目录**并缓存到虚拟机本地。缓存在 `.semibot/skills/` 下，所有 session 共享。

### 设计目标

直接运行 ClawHub 上的技能包，无需任何适配。技能包的完整目录结构（SKILL.md + scripts/ + REFERENCE.md 等）原样缓存到 VM，LLM 可通过 bash 工具直接调用 scripts/ 下的脚本。

### 流程图

```
Session 启动 → 控制平面发送 skill_index（名称 + 描述 + file_inventory + requires）
                                    │
                                    ▼
                          依赖检查（requires.binaries / requires.env_vars）
                          不满足的 skill 标记为 unavailable，不注入索引
                                    │
                                    ▼
Agent 需要 Skill X → 检查 .semibot/skills/{skill_id}/SKILL.md 缓存
                                    │
                          ┌─────────┴─────────┐
                          │                   │
                     缓存命中              缓存未命中
                          │                   │
                          ▼                   ▼
                  读取 SKILL.md      WS request: get_skill_package(skill_id)
                  按指令执行                   │
                                              ▼
                                    控制平面返回完整技能包
                                    {files: [{path, content, encoding}]}
                                              │
                                              ▼
                                    写入 .semibot/skills/{skill_id}/
                                    （保���原始目录结构）
                                              │
                                              ▼
                                    读取 SKILL.md → 按指令执行
                                    scripts/ 通过 bash 工具调用
```

### 缓存策略

- **首次加载**：从控制平面拉取完整技能包目录（所有文件）
- **缓存有效期**：虚拟机生命周期内有效（所有 session 共享），不主动失效
- **版本控制**：`get_skill_package` 支持 `version` 参数，默认 `latest`
- **缓存目录**：`/home/user/.semibot/skills/{skill_id}/`（完整目录结构）
- **缓存判断**：目录存在且 `SKILL.md` 文件存在即视为缓存命中

### 依赖检查

Session 启动时，执行平面根据 `skill_index[].requires` 校验 VM 环境：

```python
import shutil
import os

def check_skill_requirements(skill_entry: dict) -> tuple[bool, list[str]]:
    """检查 skill 依赖是否满足，返回 (satisfied, missing_items)"""
    missing = []
    requires = skill_entry.get('requires', {})

    for binary in requires.get('binaries', []):
        if not shutil.which(binary):
            missing.append(f'binary:{binary}')

    for env_var in requires.get('env_vars', []):
        if not os.environ.get(env_var):
            missing.append(f'env:{env_var}')

    return len(missing) == 0, missing
```

不满足依赖的 skill 不注入 `<available_skills>` 索引，避免 LLM 尝试调用不可用的技能。

### 索引注入格式

```
<available_skills>
  <skill name="pdf" path="/home/user/.semibot/skills/pdf/">
    处理 PDF 文件（读取、合并、拆分、表单填写等）
    文件: SKILL.md, REFERENCE.md, FORMS.md, scripts/(8个脚本)
  </skill>
  <skill name="xlsx" path="/home/user/.semibot/skills/xlsx/">
    处理 Excel 文件（创建、编辑、公式、图表等）
    文件: SKILL.md, scripts/recalc.py
  </skill>
</available_skills>

当任务匹配某个技能时，先用 read_skill_file 工具读取对应的 SKILL.md 获取完整指南。
如需执行技能中的脚本，使用 bash 工具运行。脚本位于技能目录的 scripts/ 下。
```

### 代码示例

```python
SKILLS_CACHE_DIR = Path('/home/user/.semibot/skills')

async def load_skill_with_cache(skill_id: str, client: ControlPlaneClient) -> str:
    """加载完整技能包目录，返回 SKILL.md 内容"""
    skill_dir = SKILLS_CACHE_DIR / skill_id
    skill_md_path = skill_dir / 'SKILL.md'

    if skill_md_path.exists():
        return skill_md_path.read_text(encoding='utf-8')

    # 缓存未命中，从控制平面拉取完整技能包
    pkg = await client.get_skill_package(skill_id)

    # 写入完整目录（保持原始结构）
    for file_entry in pkg['package']['files']:
        file_path = skill_dir / file_entry['path']
        file_path.parent.mkdir(parents=True, exist_ok=True)
        if file_entry.get('encoding') == 'base64':
            file_path.write_bytes(base64.b64decode(file_entry['content']))
        else:
            file_path.write_text(file_entry['content'], encoding='utf-8')

    return skill_md_path.read_text(encoding='utf-8')
```

---

## 9. LLM 调用流程

LLM 调用是执行平面直接与 LLM 提供商通信，不经过控制平面中转，以减少延迟。

### 流程图

```
LangGraph 节点需要 LLM → 使用 init_data 中的 api_key（内存中）
                                    │
                                    ▼
直接调用 OpenAI/Anthropic API（不经过控制平面）
                                    │
                                    ▼
流式 token → client.send_sse_event(session_id, token) → WS → 控制平面 → SSE → 前端
                                    │
                                    ▼
调用完成 → client.report_usage(session_id, model, tokens_in, tokens_out)
```

### 设计要点

| 要点 | 说明 |
|------|------|
| API Key 来源 | 控制平面在 init 消息中下发（虚拟机级别），存储在内存中 |
| 直连原因 | 减少延迟，避免控制平面成为 LLM 调用瓶颈 |
| 流式转发 | LLM 流式 token 通过 WS 转发到控制平面（带 session_id 路由），再推送到前端 |
| 用量上报 | 调用完成后通过 fire_and_forget 上报用量（带 session_id），不阻塞主流程 |
| 错误处理 | LLM 调用失败由执行平面本地处理（重试、降级） |

### LLM Provider 改造

```python
# llm/base.py 改造：添加 session_id 和 usage reporting callback
class BaseLLMProvider:
    def __init__(self, api_key: str, session_id: str, usage_callback=None):
        self.api_key = api_key
        self.session_id = session_id
        self.usage_callback = usage_callback

    async def generate(self, messages, **kwargs):
        response = await self._call_api(messages, **kwargs)

        # 上报用量（带 session_id）
        if self.usage_callback:
            await self.usage_callback(
                session_id=self.session_id,
                model=kwargs.get('model', self.default_model),
                tokens_in=response.usage.input_tokens,
                tokens_out=response.usage.output_tokens,
            )

        return response
```

---

## 10. 离线/降级模式

当 WebSocket 连接断开时，执行平面进入降级模式，本地资源继续可用，远程功能优雅降级。

### 降级矩阵

| 功能 | 正常模式 | 降级模式 | 说明 |
|------|----------|----------|------|
| 短期记忆 | 本地 MD 文件 | 正常工作 | 不依赖 WS |
| Checkpoint | 本地 JSON 文件 | 正常工作 | 不依赖 WS |
| LLM 调用 | 直连 LLM API | 正常工作 | 不依赖 WS（API Key 已在内存中） |
| 本地 MCP (STDIO) | 本地执行 | 正常工作 | 不依赖 WS |
| 代码执行 | 本地执行 | 正常工作 | 不依赖 WS |
| 长期记忆搜索 | WS → 控制平面 | 返回空结果 | 降级：无长期记忆辅助 |
| 远程 MCP 调用 | WS → 控制平面 | 返回错误，LangGraph 重新规划 | 降级：跳过远程工具 |
| 未缓存 Skill 加载 | WS → 控制平面 | 返回错误 | 降级：无法使用未缓存的 Skill |
| 已缓存 Skill | 本地 `.semibot/skills/` | 正常工作 | 不依赖 WS |
| 用量上报 | WS fire_and_forget | 本地队列暂存，重连后发送 | 降级：延迟上报 |
| SSE 事件转发 | WS → 控制平面 → 前端 | 本地缓存，重连后补发 | 降级：前端暂时无响应 |
| 快照同步 | WS fire_and_forget | 跳过本次同步 | 降级：下次同步时补上 |

### 降级处理策略

```python
# 通用降级包装器
async def with_degradation(coro, fallback, feature_name: str):
    """执行远程操作，失败时降级到 fallback"""
    try:
        return await coro
    except (ConnectionError, asyncio.TimeoutError) as e:
        logger.warn(f'[Degraded] {feature_name} 不可用，使用降级方案: {e}')
        return fallback

# 使用示例
long_term = await with_degradation(
    client.search_long_term_memory(query, top_k=5),
    fallback=[],
    feature_name='长期记忆搜索',
)
```

### 本地用量队列

```python
class LocalUsageQueue:
    """WS 断开时暂存用量数据，重连后批量发送"""

    def __init__(self, base_dir: str = '/home/user/.semibot'):
        self.queue_file = Path(base_dir) / 'usage_queue.jsonl'

    async def enqueue(self, session_id: str, model: str, tokens_in: int, tokens_out: int):
        entry = json.dumps({
            'session_id': session_id,
            'model': model,
            'tokens_in': tokens_in,
            'tokens_out': tokens_out,
            'timestamp': datetime.now().isoformat(),
        })
        with open(self.queue_file, 'a') as f:
            f.write(entry + '\n')

    async def flush(self, client: ControlPlaneClient):
        if not self.queue_file.exists():
            return
        entries = self.queue_file.read_text().strip().split('\n')
        for entry in entries:
            data = json.loads(entry)
            sid = data.pop('session_id')
            await client.fire_and_forget(sid, 'usage_report', **data)
        self.queue_file.unlink()
```

---

## 11. 重构后目录结构

以下是执行平面重构后的完整目录结构，标注了每个文件的状态（KEEP / MODIFY / NEW / REMOVE）。

```
runtime/src/
├── main.py                    NEW: VM 级守护进程入口
├── session/                   NEW: Session 进程管理
│   ├── manager.py             SessionManager + create_adapter 工厂
│   ├── runtime_adapter.py     NEW: RuntimeAdapter 抽象基类
│   ├── semigraph_adapter.py     NEW: SemiGraphAdapter（包装 SessionProcess）
│   └── openclaw_adapter.py    NEW: OpenClawBridgeAdapter（Unix Socket IPC）
├── ws/                        NEW: WebSocket 客户端
│   ├── client.py              控制平面客户端（多 session 多路复用）
│   └── message_types.py       消息类型定义
├── memory/
│   ├── base.py                KEEP（接口定义）
│   ├── local_memory.py        NEW: 基于 MD 文件的短期记忆
│   ├── long_term.py           REMOVE（迁移至控制平面）
│   ├── short_term.py          REMOVE（由 local_memory 替代）
│   └── embedding.py           REMOVE（迁移至控制平面）
├── checkpoint/
│   └── local_checkpointer.py  NEW: 本地文件 checkpoint
├── orchestrator/              KEEP（执行平面核心）
│   ├── graph.py               MODIFY: 接受 control_plane client 参数
│   ├── nodes.py               MODIFY: 远程调用改为通过 WS
│   ├── state.py               KEEP
│   ├── edges.py               KEEP
│   ├── context.py             MODIFY: 添加 control_plane 引用
│   └── ...
├── agents/                    KEEP
├── skills/                    KEEP（仅执行逻辑）
│   ├── base.py                KEEP
│   ├── registry.py            MODIFY: 懒加载，通过 WS 拉取
│   ├── code_executor.py       KEEP
│   └── web_search.py          KEEP
├── llm/                       KEEP（直连 LLM）
│   ├── base.py                MODIFY: 添加 usage reporting 回调
│   ├── anthropic_provider.py  KEEP
│   ├── openai_provider.py     KEEP
│   └── router.py              KEEP
├── sandbox/                   REMOVE（执行平面本身即隔离环境）
├── mcp/                       KEEP（仅 STDIO）
│   ├── client.py              MODIFY: 远程调用走 WS 代理
│   └── models.py              KEEP
├── audit/                     MODIFY: 通过 WS 发送，不再本地存储
├── server/                    REMOVE（由 WS client 替代）
├── queue/                     REMOVE
├── evolution/                 REMOVE（仅保留 WS 提交接口）
└── constants/
    └── config.py              MODIFY: 添加 WS 配置，移除 server 配置

runtime/openclaw-bridge/                NEW: OpenClaw Bridge（Node.js）
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts                入口：连接 Unix Socket，初始化 OpenClaw
    ├── bridge.ts              IPC 客户端：JSON-line 协议收发
    ├── event-translator.ts    事件格式翻译：OpenClaw → Semibot SSE
    └── skill-loader.ts        Skill 缓存集成：优先本地，未命中走 IPC
```

### 模块状态统计

| 状态 | 数量 | 说明 |
|------|------|------|
| KEEP | 14 | 保持不变，直接复用 |
| MODIFY | 7 | 需要改造，适配 WS 通信 |
| NEW | 10 | 新增模块（含 session/ 4 文件 + openclaw-bridge/ 4 文件） |
| REMOVE | 7 | 移除或迁移至控制平面 |

### 依赖关系

```
main.py
  ├── session/manager.py        → SessionManager (管理多 session 进程)
  ├── ws/client.py              → websockets (多 session 多路复用)
  ├── memory/local_memory.py    → (无外部依赖, per session)
  ├── checkpoint/local_checkpointer.py → (无外部依赖, per session)
  ├── orchestrator/graph.py     → langgraph (per session 实例)
  │   ├── orchestrator/nodes.py → ws/client.py (远程调用)
  │   │                         → memory/local_memory.py (短期记忆)
  │   │                         → skills/registry.py (skill 执行)
  │   │                         → llm/*.py (LLM 调用)
  │   │                         → skills/code_executor.py (代码直接执行)
  │   │                         → mcp/client.py (MCP 调用)
  │   ├── orchestrator/state.py
  │   └── orchestrator/edges.py
  └── llm/base.py              → ws/client.py (用量上报)
```

### constants/config.py 改造

```python
# 移除的配置（原 server 相关）
# SERVER_HOST = '0.0.0.0'        # REMOVE
# SERVER_PORT = 8000              # REMOVE
# REDIS_URL = '...'              # REMOVE
# POSTGRES_URL = '...'           # REMOVE

# 新增的配置（WS 相关）
WS_HEARTBEAT_INTERVAL = 10       # 心跳间隔（秒）
WS_REQUEST_TIMEOUT = 60          # 请求超时（秒）
WS_RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30, 30, 30]  # 重连退避（秒）
SNAPSHOT_SYNC_INTERVAL = 60      # 快照同步间隔（秒）
CHECKPOINT_KEEP_COUNT = 10       # 保留的 checkpoint 数量

# 保留的配置
CODE_EXECUTION_TIMEOUT = 30      # 代码执行超时（秒）
MAX_TOOL_CALLS_PER_TURN = 10    # 每轮最大工具调用数
LLM_MAX_RETRIES = 3             # LLM 调用最大重试次数
LLM_RETRY_DELAYS = [1, 2, 4]   # LLM 重试退避（秒）
```

---

## 附录：关键设计决策

### A. 为什么短期记忆从 Redis 改为本地 MD 文件？

| 考量 | Redis | 本地 MD 文件 |
|------|-------|-------------|
| 会话隔离 | 需要 key 前缀隔离 | 天然目录隔离 |
| 断线影响 | 不可用 | 不受影响 |
| 运维成本 | 需要 Redis 集群 | 无额外依赖 |
| 性能 | 网络 I/O | 本地磁盘 I/O |
| 数据可见性 | 需要 Redis CLI 查看 | 直接查看文件 |
| 生命周期 | 需要 TTL 管理 | 随 session 目录清理 |

结论：执行平面的短期记忆是 session 级别的，不需要跨实例共享，本地文件更简单、更可靠。

### B. 为什么 LLM 直连而不经过控制平面？

- **延迟**：LLM 流式响应对延迟敏感，多一跳中转会显著影响用户体验
- **带宽**：LLM 响应数据量大，控制平面不应成为带宽瓶颈
- **可靠性**：控制平面故障不应影响正在进行的 LLM 对话
- **安全性**：API Key 在 init 时一次性下发，存储在执行平面内存中，不持久化

### C. 为什么 Checkpoint 存储在本地而不是控制平面？

- **频率**：Checkpoint 在每个 LangGraph 节点执行后都会写入，频率高
- **大小**：Checkpoint 包含完整图状态，数据量可能较大
- **延迟**：Checkpoint 写入不应阻塞图执行
- **恢复**：Session 恢复时，控制平面可以从定期快照中恢复 checkpoint
- **折中**：本地写入 + 定期快照同步到控制平面（每 60 秒）
