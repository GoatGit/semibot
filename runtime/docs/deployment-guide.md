# Runtime 统一执行链部署指南

## 目录

- [环境要求](#环境要求)
- [安装步骤](#安装步骤)
- [配置说明](#配置说明)
- [部署模式](#部署模式)
- [监控和日志](#监控和日志)
- [故障恢复](#故障恢复)
- [升级指南](#升级指南)

---

## 环境要求

### 系统要求

- **操作系统**: Linux (Ubuntu 20.04+), macOS 10.15+
- **Python**: 3.11 或更高版本
- **内存**: 最低 2GB，推荐 4GB+
- **磁盘**: 最低 10GB 可用空间

### 依赖服务

- **PostgreSQL**: 13+ (生产环境，用于审计日志存储)
- **Redis**: 6+ (可选，用于缓存)

---

## 安装步骤

### 1. 克隆代码

```bash
git clone https://github.com/your-org/semibot-z3.git
cd semibot-z3/runtime
```

### 2. 创建虚拟环境

```bash
python3 -m venv venv
source venv/bin/activate  # Linux/macOS
# 或
venv\Scripts\activate  # Windows
```

### 3. 安装依赖

```bash
pip install -r requirements.txt
```

### 4. 安装开发依赖（可选）

```bash
pip install -r requirements-dev.txt
```

### 5. 运行测试

```bash
pytest tests/ -v
```

---

## 配置说明

### 环境变量

创建 `.env` 文件：

```bash
# 基本配置
ENVIRONMENT=production  # development, staging, production
LOG_LEVEL=INFO  # DEBUG, INFO, WARNING, ERROR

# 数据库配置（生产环境）
DATABASE_URL=postgresql://user:password@localhost:5432/semibot
DATABASE_POOL_SIZE=10
DATABASE_MAX_OVERFLOW=20

# Redis 配置（可选）
REDIS_URL=redis://localhost:6379/0

# 审计日志配置
AUDIT_STORAGE_TYPE=database  # memory, file, database
AUDIT_BATCH_SIZE=1000
AUDIT_FLUSH_INTERVAL=10.0
AUDIT_RETENTION_DAYS=90

# 文件存储配置（如果使用文件存储）
AUDIT_LOG_DIR=/var/log/semibot/audit
AUDIT_MAX_FILE_SIZE=104857600  # 100MB
AUDIT_MAX_FILES=10

# MCP 配置
MCP_CONNECTION_TIMEOUT=10
MCP_CALL_TIMEOUT=30
MCP_MAX_RETRIES=3

# 能力图配置
CAPABILITY_CACHE_TTL=300
MAX_SKILLS_PER_AGENT=50
MAX_MCP_SERVERS_PER_ORG=20

# 运行时策略
DEFAULT_MAX_ITERATIONS=10
DEFAULT_TIMEOUT_SECONDS=300
DEFAULT_MAX_CONCURRENT_ACTIONS=5
```

### 配置文件

创建 `config/production.yaml`:

```yaml
runtime:
  max_iterations: 10
  timeout_seconds: 300
  require_approval_for_high_risk: true
  high_risk_tools:
    - delete_file
    - execute_code
    - modify_database

audit:
  storage_type: database
  batch_size: 1000
  flush_interval: 10.0
  retention_days: 90

mcp:
  connection_timeout: 10
  call_timeout: 30
  max_retries: 3
  reconnect_delay: 5

capability:
  cache_ttl: 300
  max_skills_per_agent: 50
  max_mcp_servers_per_org: 20
```

---

## 部署模式

### 开发环境

**特点**:
- 使用内存或文件存储
- 详细的日志输出
- 热重载

**配置**:

```bash
# .env.development
ENVIRONMENT=development
LOG_LEVEL=DEBUG
AUDIT_STORAGE_TYPE=file
AUDIT_LOG_DIR=./logs/audit
```

**启动**:

```bash
# 使用开发配置
export ENV_FILE=.env.development
python -m src.main
```

### 测试环境

**特点**:
- 使用测试数据库
- 完整的审计日志
- 模拟 MCP 服务器

**配置**:

```bash
# .env.testing
ENVIRONMENT=testing
LOG_LEVEL=INFO
DATABASE_URL=postgresql://test:test@localhost:5432/semibot_test
AUDIT_STORAGE_TYPE=database
```

**启动**:

```bash
export ENV_FILE=.env.testing
python -m src.main
```

### 生产环境

**特点**:
- 使用生产数据库
- 完整的监控和告警
- 高可用配置

**配置**:

```bash
# .env.production
ENVIRONMENT=production
LOG_LEVEL=INFO
DATABASE_URL=postgresql://prod:password@db.example.com:5432/semibot
AUDIT_STORAGE_TYPE=database
AUDIT_BATCH_SIZE=1000
AUDIT_FLUSH_INTERVAL=10.0
```

**部署步骤**:

1. **准备数据库**

```bash
# 创建数据库
createdb semibot

# 运行迁移
alembic upgrade head
```

2. **配置 systemd 服务**

创建 `/etc/systemd/system/semibot-runtime.service`:

```ini
[Unit]
Description=Semibot Runtime Service
After=network.target postgresql.service

[Service]
Type=simple
User=semibot
Group=semibot
WorkingDirectory=/opt/semibot/runtime
Environment="PATH=/opt/semibot/runtime/venv/bin"
EnvironmentFile=/opt/semibot/runtime/.env.production
ExecStart=/opt/semibot/runtime/venv/bin/python -m src.main
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

3. **启动服务**

```bash
sudo systemctl daemon-reload
sudo systemctl enable semibot-runtime
sudo systemctl start semibot-runtime
sudo systemctl status semibot-runtime
```

4. **配置 Nginx 反向代理**

创建 `/etc/nginx/sites-available/semibot`:

```nginx
upstream semibot_runtime {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name runtime.example.com;

    location / {
        proxy_pass http://semibot_runtime;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用配置:

```bash
sudo ln -s /etc/nginx/sites-available/semibot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 监控和日志

### 日志配置

**日志级别**:
- `DEBUG`: 详细的调试信息
- `INFO`: 一般信息
- `WARNING`: 警告信息
- `ERROR`: 错误信息

**日志位置**:
- 应用日志: `/var/log/semibot/runtime.log`
- 审计日志: `/var/log/semibot/audit/`
- 错误日志: `/var/log/semibot/error.log`

**日志轮转**:

创建 `/etc/logrotate.d/semibot`:

```
/var/log/semibot/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0640 semibot semibot
    sharedscripts
    postrotate
        systemctl reload semibot-runtime > /dev/null 2>&1 || true
    endscript
}
```

### 监控指标

**关键指标**:

1. **执行指标**:
   - Action 执行成功率
   - Action 执行时间
   - Action 执行失败率

2. **审计指标**:
   - 审计事件写入速率
   - 审计缓冲区大小
   - 审计刷新延迟

3. **系统指标**:
   - CPU 使用率
   - 内存使用率
   - 磁盘使用率

**Prometheus 集成**:

```python
from prometheus_client import Counter, Histogram, Gauge

# 定义指标
action_executions = Counter(
    'runtime_action_executions_total',
    'Total number of action executions',
    ['action_name', 'status']
)

action_duration = Histogram(
    'runtime_action_duration_seconds',
    'Action execution duration',
    ['action_name']
)

audit_buffer_size = Gauge(
    'runtime_audit_buffer_size',
    'Current audit buffer size'
)
```

### 健康检查

**端点**: `/health`

**响应**:

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "components": {
    "database": "healthy",
    "audit_logger": "healthy",
    "mcp_client": "healthy"
  },
  "timestamp": "2026-02-09T12:00:00Z"
}
```

**检查脚本**:

```bash
#!/bin/bash
# health_check.sh

HEALTH_URL="http://localhost:8901/health"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_URL)

if [ $RESPONSE -eq 200 ]; then
    echo "Service is healthy"
    exit 0
else
    echo "Service is unhealthy (HTTP $RESPONSE)"
    exit 1
fi
```

---

## 故障恢复

### 常见故障

#### 1. 数据库连接失败

**症状**: 无法连接到数据库

**排查**:

```bash
# 检查数据库状态
sudo systemctl status postgresql

# 测试连接
psql -h localhost -U semibot -d semibot
```

**解决**:

```bash
# 重启数据库
sudo systemctl restart postgresql

# 检查连接配置
cat .env.production | grep DATABASE_URL
```

#### 2. 审计日志写入失败

**症状**: 审计日志无法写入

**排查**:

```bash
# 检查磁盘空间
df -h

# 检查日志目录权限
ls -la /var/log/semibot/audit/

# 检查审计日志
tail -f /var/log/semibot/runtime.log | grep audit
```

**解决**:

```bash
# 清理旧日志
find /var/log/semibot/audit/ -name "*.log" -mtime +90 -delete

# 修复权限
sudo chown -R semibot:semibot /var/log/semibot/
sudo chmod -R 755 /var/log/semibot/
```

#### 3. MCP 服务器连接失败

**症状**: 无法连接到 MCP 服务器

**排查**:

```bash
# 检查 MCP 服务器状态
# (根据具体的 MCP 服务器类型)

# 检查网络连接
ping mcp-server.example.com
telnet mcp-server.example.com 8080
```

**解决**:

```bash
# 重启 MCP 服务器
# (根据具体的 MCP 服务器类型)

# 检查配置
cat config/production.yaml | grep mcp
```

### 备份和恢复

#### 备份审计日志

```bash
#!/bin/bash
# backup_audit_logs.sh

BACKUP_DIR="/backup/semibot/audit"
AUDIT_DIR="/var/log/semibot/audit"
DATE=$(date +%Y%m%d)

# 创建备份目录
mkdir -p $BACKUP_DIR

# 备份审计日志
tar -czf $BACKUP_DIR/audit_logs_$DATE.tar.gz $AUDIT_DIR

# 删除 30 天前的备份
find $BACKUP_DIR -name "audit_logs_*.tar.gz" -mtime +30 -delete
```

#### 恢复审计日志

```bash
#!/bin/bash
# restore_audit_logs.sh

BACKUP_FILE=$1
AUDIT_DIR="/var/log/semibot/audit"

# 停止服务
sudo systemctl stop semibot-runtime

# 恢复审计日志
tar -xzf $BACKUP_FILE -C /

# 启动服务
sudo systemctl start semibot-runtime
```

---

## 升级指南

### 升级前准备

1. **备份数据**

```bash
# 备份数据库
pg_dump semibot > backup_$(date +%Y%m%d).sql

# 备份审计日志
./backup_audit_logs.sh

# 备份配置文件
cp .env.production .env.production.backup
cp config/production.yaml config/production.yaml.backup
```

2. **检查兼容性**

```bash
# 查看变更日志
cat CHANGELOG.md

# 检查配置变更
diff .env.production.backup .env.production
```

### 升级步骤

1. **停止服务**

```bash
sudo systemctl stop semibot-runtime
```

2. **更新代码**

```bash
git fetch origin
git checkout v2.0.0  # 替换为目标版本
```

3. **更新依赖**

```bash
source venv/bin/activate
pip install -r requirements.txt --upgrade
```

4. **运行迁移**

```bash
alembic upgrade head
```

5. **更新配置**

```bash
# 根据 CHANGELOG.md 更新配置文件
vim .env.production
vim config/production.yaml
```

6. **运行测试**

```bash
pytest tests/ -v
```

7. **启动服务**

```bash
sudo systemctl start semibot-runtime
sudo systemctl status semibot-runtime
```

8. **验证升级**

```bash
# 检查健康状态
curl http://localhost:8901/health

# 检查日志
tail -f /var/log/semibot/runtime.log

# 检查版本
curl http://localhost:8901/version
```

### 回滚步骤

如果升级失败，执行回滚：

1. **停止服务**

```bash
sudo systemctl stop semibot-runtime
```

2. **恢复代码**

```bash
git checkout v1.0.0  # 替换为之前的版本
```

3. **恢复依赖**

```bash
pip install -r requirements.txt
```

4. **恢复数据库**

```bash
# 回滚迁移
alembic downgrade -1

# 或恢复备份
psql semibot < backup_20260209.sql
```

5. **恢复配置**

```bash
cp .env.production.backup .env.production
cp config/production.yaml.backup config/production.yaml
```

6. **启动服务**

```bash
sudo systemctl start semibot-runtime
```

---

## 性能调优

### 数据库优化

```sql
-- 创建索引
CREATE INDEX idx_audit_events_session_id ON audit_events(session_id);
CREATE INDEX idx_audit_events_org_id ON audit_events(org_id);
CREATE INDEX idx_audit_events_timestamp ON audit_events(timestamp);
CREATE INDEX idx_audit_events_event_type ON audit_events(event_type);

-- 分区表（可选，用于大量数据）
CREATE TABLE audit_events_2026_02 PARTITION OF audit_events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
```

### 应用优化

```python
# 增加批量大小
AUDIT_BATCH_SIZE=2000

# 增加刷新间隔
AUDIT_FLUSH_INTERVAL=15.0

# 增加数据库连接池
DATABASE_POOL_SIZE=20
DATABASE_MAX_OVERFLOW=40
```

### 系统优化

```bash
# 增加文件描述符限制
ulimit -n 65536

# 增加内存限制
# 在 systemd 服务文件中添加
MemoryLimit=4G
```

---

## 安全加固

### 1. 文件权限

```bash
# 设置正确的文件权限
chmod 600 .env.production
chmod 600 config/production.yaml
chmod 755 /var/log/semibot/
chmod 644 /var/log/semibot/*.log
```

### 2. 网络安全

```bash
# 配置防火墙
sudo ufw allow 8000/tcp  # 应用端口
sudo ufw allow 5432/tcp  # PostgreSQL（仅内网）
sudo ufw enable
```

### 3. 数据库安全

```sql
-- 创建专用用户
CREATE USER semibot WITH PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE semibot TO semibot;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO semibot;

-- 启用 SSL
ALTER SYSTEM SET ssl = on;
```

### 4. 审计日志加密

```python
# 配置审计日志加密
AUDIT_ENCRYPTION_ENABLED=true
AUDIT_ENCRYPTION_KEY=your-encryption-key
```

---

## 相关文档

- [API 参考文档](api-reference.md)
- [架构设计文档](architecture.md)
- [故障排查指南](troubleshooting.md)
- [实施进度总结](implementation-progress.md)
