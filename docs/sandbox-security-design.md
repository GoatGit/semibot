# 沙箱安全隔离设计方案

> 本文档详细说明 Semibot-S1 的沙箱安全隔离架构设计和实现方案。

## 1. 概述

### 1.1 为什么需要沙箱

AI Agent 执行用户任务时可能涉及：
- **代码执行**：运行用户提供或 AI 生成的代码
- **Shell 命令**：执行系统命令
- **文件操作**：读写文件系统
- **网络请求**：访问外部 API

这些操作存在安全风险：
- 恶意代码执行（病毒、木马）
- 资源耗尽攻击（CPU、内存、磁盘）
- 数据泄露（读取敏感文件）
- 横向移动（攻击其他系统）
- Prompt 注入导致的非预期操作

### 1.2 设计目标

| 目标 | 说明 |
|------|------|
| 进程隔离 | 代码在独立容器中执行，与宿主系统隔离 |
| 资源限制 | 限制 CPU、内存、执行时间 |
| 网络控制 | 默认禁止网络，按需白名单放行 |
| 文件隔离 | 只能访问指定工作目录 |
| 权限最小化 | 非 root 运行，最小权限原则 |
| 审计追踪 | 记录所有操作用于审计 |

### 1.3 技术选型

| 方案 | 隔离级别 | 启动速度 | 资源开销 | 适用场景 |
|------|---------|---------|---------|---------|
| **Docker** | 容器级 | 快 (~100ms) | 低 | 推荐：开发/生产通用 |
| gVisor | 容器+系统调用 | 中等 | 中等 | Kubernetes 环境 |
| Firecracker | 虚拟机级 | 快 (~125ms) | 中等 | 多租户强隔离 |

**本方案采用 Docker 容器**，原因：
1. 启动速度快，适合频繁的工具调用
2. 生态成熟，易于部署和维护
3. 可通过 seccomp 增强安全性
4. 未来可平滑迁移到 gVisor/Firecracker

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Runtime                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    SandboxManager                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │ PolicyEngine│  │ PoolManager │  │ AuditLogger     │   │  │
│  │  │ (权限策略)   │  │ (容器池)    │  │ (审计日志)      │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Container Pool                          │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐      │  │
│  │  │Sandbox-1│  │Sandbox-2│  │Sandbox-3│  │Sandbox-N│      │  │
│  │  │ (idle)  │  │ (busy)  │  │ (idle)  │  │ (busy)  │      │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Docker Engine                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Sandbox Container                                            ││
│  │ ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐││
│  │ │ /workspace  │ │ Executor    │ │ Resource Limits         │││
│  │ │ (隔离目录)   │ │ (执行引擎)  │ │ CPU: 1 core            │││
│  │ │             │ │             │ │ Memory: 512MB          │││
│  │ │ - code/     │ │ - Python    │ │ Timeout: 30s           │││
│  │ │ - data/     │ │ - Node.js   │ │ Network: none          │││
│  │ │ - output/   │ │ - Bash      │ │ User: sandbox (1000)   │││
│  │ └─────────────┘ └─────────────┘ └─────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 职责 |
|------|------|
| **SandboxManager** | 沙箱管理器，对外提供统一接口 |
| **PolicyEngine** | 策略引擎，定义和检查权限规则 |
| **PoolManager** | 容器池管理，复用容器提高性能 |
| **AuditLogger** | 审计日志，记录所有沙箱操作 |
| **Sandbox** | 单个沙箱容器实例 |

### 2.3 执行流程

```
┌──────────────────────────────────────────────────────────────┐
│                      Tool Execution Flow                      │
│                                                              │
│  1. Tool Call Request                                        │
│     │                                                        │
│     ▼                                                        │
│  2. PolicyEngine.check_permission()                          │
│     │ ├─ DENIED → Return Error                               │
│     │ └─ ALLOWED ↓                                           │
│     ▼                                                        │
│  3. PoolManager.acquire_sandbox()                            │
│     │ ├─ Pool has idle → Reuse                               │
│     │ └─ Pool empty → Create new                             │
│     ▼                                                        │
│  4. Sandbox.prepare_workspace()                              │
│     │ ├─ Mount files                                         │
│     │ └─ Set permissions                                     │
│     ▼                                                        │
│  5. Sandbox.execute()                                        │
│     │ ├─ Run in container                                    │
│     │ ├─ Stream output                                       │
│     │ └─ Enforce timeout                                     │
│     ▼                                                        │
│  6. Sandbox.collect_results()                                │
│     │ ├─ Capture stdout/stderr                               │
│     │ └─ Collect output files                                │
│     ▼                                                        │
│  7. AuditLogger.log()                                        │
│     │                                                        │
│     ▼                                                        │
│  8. PoolManager.release_sandbox()                            │
│     │ ├─ Clean workspace                                     │
│     │ └─ Return to pool                                      │
│     ▼                                                        │
│  9. Return Result                                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 安全策略

### 3.1 工具风险分级

```python
class RiskLevel(Enum):
    LOW = "low"        # 只读操作，无副作用
    MEDIUM = "medium"  # 有限写入，可控范围
    HIGH = "high"      # 系统级操作，需审批
    CRITICAL = "critical"  # 高危操作，禁止或严格审批
```

| 风险级别 | 工具示例 | 执行策略 |
|---------|---------|---------|
| LOW | file_read, search | 直接执行 |
| MEDIUM | file_write, file_edit | 沙箱执行 |
| HIGH | shell_exec, code_run | 沙箱 + 资源限制 |
| CRITICAL | system_admin, network_scan | 需人工审批 |

### 3.2 权限策略配置

```yaml
# sandbox_policy.yaml
policies:
  default:
    sandbox_enabled: true
    max_execution_time: 30s
    max_memory: 512MB
    max_cpu: 1.0
    network_access: false
    filesystem_access: workspace_only

  tools:
    file_read:
      risk_level: low
      sandbox_enabled: false
      allowed_paths:
        - /workspace/**
      denied_paths:
        - /workspace/.env
        - /workspace/**/*.key

    shell_exec:
      risk_level: high
      sandbox_enabled: true
      max_execution_time: 60s
      allowed_commands:
        - ls
        - cat
        - grep
        - find
        - python
        - node
      denied_commands:
        - rm -rf
        - sudo
        - curl
        - wget
        - nc
        - ssh

    code_run:
      risk_level: high
      sandbox_enabled: true
      supported_languages:
        - python
        - javascript
        - typescript
      max_execution_time: 120s
      max_memory: 1GB

    browser_automation:
      risk_level: high
      sandbox_enabled: true
      network_access: true
      allowed_domains:
        - "*.example.com"
      denied_domains:
        - "*.internal.company.com"

  # 按 Agent 角色定制策略
  agent_roles:
    code_assistant:
      inherits: default
      tools:
        - file_read
        - file_write
        - code_run
        - shell_exec

    data_analyst:
      inherits: default
      tools:
        - file_read
        - code_run
      max_memory: 2GB

    web_scraper:
      inherits: default
      tools:
        - browser_automation
      network_access: true
```

### 3.3 网络隔离策略

```yaml
# 网络隔离配置
network:
  # 默认无网络
  default: none

  # 白名单模式
  allowlist:
    enabled: true
    domains:
      - api.openai.com
      - api.anthropic.com
      - "*.githubusercontent.com"
    ips: []

  # 黑名单模式（用于有网络权限的沙箱）
  denylist:
    enabled: true
    domains:
      - "*.internal.*"
      - localhost
      - "127.*"
      - "10.*"
      - "192.168.*"
    ports:
      - 22   # SSH
      - 3306 # MySQL
      - 5432 # PostgreSQL
      - 6379 # Redis
```

---

## 4. 实现细节

### 4.1 目录结构

```
runtime/src/sandbox/
├── __init__.py           # 模块导出
├── manager.py            # SandboxManager 主类
├── policy.py             # PolicyEngine 策略引擎
├── pool.py               # PoolManager 容器池
├── container.py          # Sandbox 容器操作
├── executor.py           # 代码执行器
├── audit.py              # AuditLogger 审计日志
├── exceptions.py         # 异常定义
├── models.py             # 数据模型
└── docker/
    ├── Dockerfile.sandbox    # 沙箱镜像
    ├── seccomp.json         # seccomp 配置
    └── entrypoint.sh        # 容器入口
```

### 4.2 Docker 镜像配置

```dockerfile
# runtime/src/sandbox/docker/Dockerfile.sandbox
FROM python:3.11-slim

# 安全加固
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# 创建非 root 用户
RUN groupadd -g 1000 sandbox \
    && useradd -u 1000 -g sandbox -s /bin/bash -m sandbox

# 创建工作目录
RUN mkdir -p /workspace /output \
    && chown -R sandbox:sandbox /workspace /output

# 安装常用 Python 包（可选）
COPY requirements-sandbox.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements-sandbox.txt

# 切换到非 root 用户
USER sandbox
WORKDIR /workspace

# 入口脚本
COPY --chown=sandbox:sandbox entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

### 4.3 Seccomp 安全配置

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "close", "stat", "fstat", "lstat",
        "poll", "lseek", "mmap", "mprotect", "munmap", "brk",
        "rt_sigaction", "rt_sigprocmask", "ioctl", "access",
        "pipe", "select", "sched_yield", "mremap", "msync",
        "mincore", "madvise", "dup", "dup2", "nanosleep",
        "getpid", "socket", "connect", "accept", "sendto",
        "recvfrom", "sendmsg", "recvmsg", "shutdown", "bind",
        "listen", "getsockname", "getpeername", "socketpair",
        "setsockopt", "getsockopt", "clone", "fork", "vfork",
        "execve", "exit", "wait4", "kill", "uname", "fcntl",
        "flock", "fsync", "fdatasync", "truncate", "ftruncate",
        "getdents", "getcwd", "chdir", "rename", "mkdir", "rmdir",
        "creat", "link", "unlink", "symlink", "readlink", "chmod",
        "fchmod", "chown", "fchown", "lchown", "umask", "gettimeofday",
        "getrlimit", "getrusage", "times", "getuid", "getgid",
        "geteuid", "getegid", "setpgid", "getppid", "getpgrp",
        "setsid", "setreuid", "setregid", "getgroups", "setgroups",
        "setresuid", "getresuid", "setresgid", "getresgid",
        "sigaltstack", "utime", "statfs", "fstatfs", "sysinfo",
        "prctl", "arch_prctl", "futex", "set_tid_address",
        "clock_gettime", "clock_getres", "exit_group",
        "epoll_wait", "epoll_ctl", "tgkill", "openat", "mkdirat",
        "newfstatat", "unlinkat", "renameat", "readlinkat",
        "fchownat", "futimesat", "fchmodat", "faccessat",
        "pselect6", "ppoll", "set_robust_list", "get_robust_list",
        "epoll_pwait", "eventfd", "eventfd2", "epoll_create1",
        "dup3", "pipe2", "preadv", "pwritev", "getrandom",
        "memfd_create", "preadv2", "pwritev2"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["ptrace", "process_vm_readv", "process_vm_writev"],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1
    }
  ]
}
```

---

## 5. 使用示例

### 5.1 基本使用

```python
from src.sandbox import SandboxManager, SandboxConfig

# 创建沙箱管理器
manager = SandboxManager(
    docker_url="unix:///var/run/docker.sock",
    pool_size=5,
    policy_file="sandbox_policy.yaml",
)

# 执行 Python 代码
result = await manager.execute_code(
    language="python",
    code="""
import math
print(f"Pi = {math.pi}")
result = sum(range(100))
print(f"Sum = {result}")
""",
    timeout=30,
)

print(result.stdout)  # "Pi = 3.141592653589793\nSum = 4950\n"
print(result.exit_code)  # 0
```

### 5.2 执行 Shell 命令

```python
# 执行 shell 命令
result = await manager.execute_shell(
    command="ls -la /workspace",
    timeout=10,
)

# 带输入文件
result = await manager.execute_shell(
    command="python analyze.py data.csv",
    files={
        "analyze.py": b"import pandas as pd\n...",
        "data.csv": b"a,b,c\n1,2,3\n",
    },
    timeout=60,
)
```

### 5.3 与 Agent 集成

```python
# runtime/src/orchestrator/nodes.py
from src.sandbox import SandboxManager

async def act_node(state: AgentState, context: dict) -> dict:
    """ACT 节点 - 执行工具"""

    sandbox_manager: SandboxManager = context.get("sandbox_manager")
    pending_actions = state["pending_actions"]

    results = []
    for action in pending_actions:
        if action.tool == "code_run":
            # 使用沙箱执行代码
            result = await sandbox_manager.execute_code(
                language=action.params.get("language", "python"),
                code=action.params["code"],
                timeout=action.params.get("timeout", 30),
            )
        elif action.tool == "shell_exec":
            # 使用沙箱执行命令
            result = await sandbox_manager.execute_shell(
                command=action.params["command"],
                timeout=action.params.get("timeout", 30),
            )
        else:
            # 其他工具直接执行
            result = await execute_tool(action)

        results.append(result)

    return {"tool_results": results}
```

---

## 6. 监控与审计

### 6.1 审计日志格式

```json
{
  "timestamp": "2025-02-07T12:00:00Z",
  "event_type": "sandbox_execution",
  "session_id": "sess_abc123",
  "agent_id": "agent_456",
  "org_id": "org_789",
  "sandbox_id": "sandbox_xyz",
  "tool": "code_run",
  "language": "python",
  "code_hash": "sha256:abc123...",
  "execution_time_ms": 1234,
  "exit_code": 0,
  "memory_used_mb": 128,
  "cpu_time_ms": 500,
  "network_bytes_sent": 0,
  "network_bytes_recv": 0,
  "files_read": ["/workspace/input.txt"],
  "files_written": ["/workspace/output.txt"],
  "result": "success",
  "error": null
}
```

### 6.2 监控指标

```python
# Prometheus 指标
sandbox_executions_total{tool, language, status}  # 执行总数
sandbox_execution_duration_seconds{tool}          # 执行耗时
sandbox_memory_usage_bytes{sandbox_id}            # 内存使用
sandbox_cpu_usage_seconds{sandbox_id}             # CPU 使用
sandbox_pool_size{status}                         # 容器池状态
sandbox_policy_violations_total{tool, reason}     # 策略违规
```

---

## 7. 部署配置

### 7.1 Docker Compose

```yaml
# infra/docker-compose.sandbox.yaml
version: '3.8'

services:
  sandbox-manager:
    build:
      context: ../runtime
      dockerfile: src/sandbox/docker/Dockerfile.manager
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - sandbox-workspaces:/workspaces
    environment:
      - SANDBOX_POOL_SIZE=10
      - SANDBOX_MAX_MEMORY=512m
      - SANDBOX_MAX_CPU=1.0
      - SANDBOX_NETWORK=none
    networks:
      - sandbox-network
    deploy:
      resources:
        limits:
          memory: 1G

networks:
  sandbox-network:
    driver: bridge
    internal: true  # 无外网访问

volumes:
  sandbox-workspaces:
    driver: local
```

### 7.2 Kubernetes 配置（可选）

```yaml
# infra/k8s/sandbox-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sandbox-manager
spec:
  replicas: 3
  template:
    spec:
      serviceAccountName: sandbox-sa
      containers:
        - name: sandbox-manager
          image: semibot/sandbox-manager:latest
          securityContext:
            runAsNonRoot: true
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            limits:
              memory: "1Gi"
              cpu: "1"
            requests:
              memory: "512Mi"
              cpu: "500m"
```

---

## 8. 安全检查清单

### 8.1 部署前检查

- [ ] Docker 镜像已构建并扫描漏洞
- [ ] seccomp 配置已应用
- [ ] 非 root 用户运行
- [ ] 网络隔离已配置
- [ ] 资源限制已设置
- [ ] 审计日志已启用
- [ ] 策略文件已配置

### 8.2 运行时检查

- [ ] 容器池健康状态
- [ ] 资源使用在限制内
- [ ] 无异常网络连接
- [ ] 审计日志正常写入
- [ ] 策略违规告警正常

### 8.3 定期审计

- [ ] 审计日志分析
- [ ] 容器镜像更新
- [ ] 策略规则审查
- [ ] 渗透测试
- [ ] 依赖安全扫描

---

## 9. 参考资料

- [Docker Security Best Practices](https://docs.docker.com/engine/security/)
- [Seccomp Security Profiles](https://docs.docker.com/engine/security/seccomp/)
- [gVisor Container Sandbox](https://gvisor.dev/)
- [Firecracker MicroVMs](https://firecracker-microvm.github.io/)
- [AI Agent Security Best Practices 2025](https://futureagi.com)
- [MCP Docker Code Sandbox](https://mcpmarket.com)
