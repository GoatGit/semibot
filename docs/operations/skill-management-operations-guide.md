# Skills 管理系统运维手册

## 目录

1. [系统概述](#系统概述)
2. [部署指南](#部署指南)
3. [日常运维](#日常运维)
4. [监控与告警](#监控与告警)
5. [故障排查](#故障排查)
6. [备份与恢复](#备份与恢复)
7. [安全运维](#安全运维)
8. [性能优化](#性能优化)
9. [常见问题](#常见问题)

---

## 系统概述

### 架构简介

Skills 管理系统采用两层模型架构：

- **SkillDefinition（管理层）**: 平台级技能定义，管理员管理，全租户可见
- **SkillPackage（执行层）**: 可执行目录包，按版本存储，支持多版本共存

### 核心组件

```
┌─────────────────────────────────────────────────────────┐
│                     API Gateway                          │
└─────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Skill Install│  │ Skill Retry  │  │ Skill        │
│ Service      │  │ Rollback Svc │  │ Validator    │
└──────────────┘  └──────────────┘  └──────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                ┌──────────────────────┐
                │   PostgreSQL DB      │
                │  - skill_definitions │
                │  - skill_packages    │
                │  - skill_install_logs│
                └──────────────────────┘
                            │
                            ▼
                ┌──────────────────────┐
                │   File Storage       │
                │  /var/lib/semibot/   │
                │    skills/           │
                └──────────────────────┘
```

### 关键指标

- **安装成功率**: 目标 > 99%
- **平均安装时间**: < 30 秒
- **并发安装数**: 最大 50
- **存储空间**: 每个技能包 < 100MB

---

## 部署指南

### 前置条件

```bash
# 系统要求
- Node.js >= 18.0.0
- PostgreSQL >= 14.0
- 磁盘空间 >= 10GB（用于技能包存储）
- 内存 >= 4GB

# 权限要求
- 数据库创建权限
- 文件系统读写权限
- 网络访问权限（用于下载技能包）
```

### 数据库初始化

```bash
# 1. 连接到数据库
psql -U postgres -d semibot

# 2. 执行迁移脚本
\i database/migrations/002_skill_packages.sql

# 3. 验证表结构
\dt skill_*

# 预期输出：
# skill_definitions
# skill_packages
# skill_install_logs
```

### 环境变量配置

```bash
# .env 文件
DATABASE_URL=postgresql://user:password@localhost:5432/semibot
SKILL_STORAGE_PATH=/var/lib/semibot/skills
SKILL_MAX_SIZE_MB=100
SKILL_MAX_CONCURRENT_INSTALLS=50
ANTHROPIC_API_KEY=sk-ant-xxx  # 用于下载 Anthropic Skills
```

### 文件系统准备

```bash
# 创建存储目录
sudo mkdir -p /var/lib/semibot/skills
sudo chown -R app:app /var/lib/semibot/skills
sudo chmod 755 /var/lib/semibot/skills

# 创建日志目录
sudo mkdir -p /var/log/semibot/skills
sudo chown -R app:app /var/log/semibot/skills
```

### 服务启动

```bash
# 开发环境
npm run dev

# 生产环境
npm run build
npm run start

# 使用 PM2
pm2 start ecosystem.config.js
pm2 save
```

### 健康检查

```bash
# 检查 API 健康状���
curl http://localhost:3000/health

# 检查数据库连接
curl http://localhost:3000/api/v1/skill-definitions/health

# 预期响应：
# {
#   "status": "healthy",
#   "database": "connected",
#   "storage": "accessible"
# }
```

---

## 日常运维

### 监控检查清单

**每日检查**:
- [ ] 检查安装成功率
- [ ] 检查磁盘空间使用率
- [ ] 检查错误日志
- [ ] 检查数据库连接池状态

**每周检查**:
- [ ] 审查安装失败记录
- [ ] 清理过期的临时文件
- [ ] 检查数据库性能指标
- [ ] 更新技能包索引

**每月检查**:
- [ ] 数据库备��验证
- [ ] 存储空间规划
- [ ] 安全审计
- [ ] 性能优化评估

### 日志管理

```bash
# 查看安装日志
tail -f /var/log/semibot/skills/install.log

# 查看错误日志
tail -f /var/log/semibot/skills/error.log

# 查询数据库日志
psql -U postgres -d semibot -c "
  SELECT * FROM skill_install_logs
  WHERE status = 'failed'
  ORDER BY created_at DESC
  LIMIT 10;
"

# 日志轮转配置（/etc/logrotate.d/semibot-skills）
/var/log/semibot/skills/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 app app
    sharedscripts
    postrotate
        systemctl reload semibot
    endscript
}
```

### 清理任务

```bash
# 清理失败的安装（保留 7 天）
psql -U postgres -d semibot -c "
  DELETE FROM skill_install_logs
  WHERE status = 'failed'
  AND created_at < NOW() - INTERVAL '7 days';
"

# 清理临时文件
find /tmp/skill-* -type d -mtime +1 -exec rm -rf {} \;

# 清理未使用的技能包（需要谨慎）
# 先查询未使用的包
psql -U postgres -d semibot -c "
  SELECT id, skill_definition_id, version
  FROM skill_packages
  WHERE status = 'inactive'
  AND updated_at < NOW() - INTERVAL '30 days';
"
```

---

## 监控与告警

### 关键指标

```sql
-- 1. 安装成功率（最近 24 小时）
SELECT
  COUNT(*) FILTER (WHERE status = 'success') * 100.0 / COUNT(*) as success_rate
FROM skill_install_logs
WHERE created_at > NOW() - INTERVAL '24 hours';

-- 2. 平均安装时间
SELECT
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_install_time_seconds
FROM skill_install_logs
WHERE status = 'success'
AND created_at > NOW() - INTERVAL '24 hours';

-- 3. 失败原因分布
SELECT
  error_message,
  COUNT(*) as count
FROM skill_install_logs
WHERE status = 'failed'
AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY error_message
ORDER BY count DESC;

-- 4. 存储空间使用
SELECT
  skill_definition_id,
  COUNT(*) as version_count,
  SUM(package_size_bytes) / 1024 / 1024 as total_size_mb
FROM skill_packages
GROUP BY skill_definition_id
ORDER BY total_size_mb DESC;

-- 5. 活跃技能统计
SELECT
  COUNT(*) as total_skills,
  COUNT(*) FILTER (WHERE is_active = true) as active_skills,
  COUNT(*) FILTER (WHERE is_public = true) as public_skills
FROM skill_definitions;
```

### Prometheus 指标

```typescript
// 在代码中暴露 Prometheus 指标
import { Counter, Histogram, Gauge } from 'prom-client'

// 安装计数器
const installCounter = new Counter({
  name: 'skill_install_total',
  help: 'Total number of skill installations',
  labelNames: ['status', 'source_type'],
})

// 安装时长直方图
const installDuration = new Histogram({
  name: 'skill_install_duration_seconds',
  help: 'Skill installation duration in seconds',
  buckets: [1, 5, 10, 30, 60, 120],
})

// 存储空间使用
const storageUsage = new Gauge({
  name: 'skill_storage_bytes',
  help: 'Total storage used by skill packages',
})
```

### 告警规则

```yaml
# Prometheus 告警规则
groups:
  - name: skill_management
    rules:
      # 安装成功率低于 95%
      - alert: SkillInstallSuccessRateLow
        expr: |
          (sum(rate(skill_install_total{status="success"}[1h])) /
           sum(rate(skill_install_total[1h]))) < 0.95
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Skill install success rate is below 95%"

      # 安装时间过长
      - alert: SkillInstallDurationHigh
        expr: |
          histogram_quantile(0.95,
            rate(skill_install_duration_seconds_bucket[5m])) > 60
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "95th percentile install duration exceeds 60s"

      # 存储空间不足
      - alert: SkillStorageSpaceLow
        expr: |
          (node_filesystem_avail_bytes{mountpoint="/var/lib/semibot"} /
           node_filesystem_size_bytes{mountpoint="/var/lib/semibot"}) < 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Skill storage space is below 10%"

      # 数据库连接池耗尽
      - alert: DatabaseConnectionPoolExhausted
        expr: |
          pg_stat_database_numbackends{datname="semibot"} > 80
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool is nearly exhausted"
```

---

## 故障排查

### 常见问题诊断

#### 1. 安装失败

```bash
# 查看最近的失败记录
psql -U postgres -d semibot -c "
  SELECT
    id,
    skill_definition_id,
    version,
    status,
    error_message,
    created_at
  FROM skill_install_logs
  WHERE status = 'failed'
  ORDER BY created_at DESC
  LIMIT 10;
"

# 检查文件系统权限
ls -la /var/lib/semibot/skills

# 检查磁盘空间
df -h /var/lib/semibot

# 检查网络连接（如果是远程下载）
curl -I https://api.anthropic.com/v1/skills/test-skill
```

**常见原因**:
- 磁盘空间不足
- 网络连接失败
- 权限不足
- 无效的 manifest.json
- 校验值不匹配

#### 2. 版本回滚失败

```bash
# 检查目标版本是否存在
psql -U postgres -d semibot -c "
  SELECT * FROM skill_packages
  WHERE skill_definition_id = 'xxx'
  AND version = '1.0.0';
"

# 检查包文件是否存在
ls -la /var/lib/semibot/skills/xxx/1.0.0/

# 手动回滚（紧急情况）
psql -U postgres -d semibot -c "
  UPDATE skill_definitions
  SET current_version = '1.0.0'
  WHERE id = 'xxx';
"
```

#### 3. 数据库连接问题

```bash
# 检查数据库状态
systemctl status postgresql

# 检查连接数
psql -U postgres -c "
  SELECT count(*) FROM pg_stat_activity;
"

# 检查慢查询
psql -U postgres -c "
  SELECT pid, now() - pg_stat_activity.query_start AS duration, query
  FROM pg_stat_activity
  WHERE state = 'active'
  AND now() - pg_stat_activity.query_start > interval '5 seconds'
  ORDER BY duration DESC;
"

# 终止长时间运行的查询
psql -U postgres -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE pid = <pid>;
"
```

#### 4. 性能问题

```bash
# 检查 CPU 使用率
top -p $(pgrep -f semibot)

# 检查内存使用
ps aux | grep semibot

# 检查 I/O 等待
iostat -x 1

# 检查数据库性能
psql -U postgres -d semibot -c "
  SELECT schemaname, tablename,
         pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"
```

### 调试模式

```bash
# 启用详细日志
export LOG_LEVEL=debug
npm run start

# 启用 SQL 查询日志
export DEBUG=knex:query
npm run start

# 启用性能分析
export NODE_ENV=development
export ENABLE_PROFILING=true
npm run start
```

---

## 备份与恢复

### 数据库备份

```bash
# 每日备份脚本（/opt/semibot/backup-skills-db.sh）
#!/bin/bash
BACKUP_DIR=/var/backups/semibot/skills
DATE=$(date +%Y%m%d_%H%M%S)

# 创建备份目录
mkdir -p $BACKUP_DIR

# 备份技能相关表
pg_dump -U postgres -d semibot \
  -t skill_definitions \
  -t skill_packages \
  -t skill_install_logs \
  -F c -f $BACKUP_DIR/skills_$DATE.dump

# 压缩备份
gzip $BACKUP_DIR/skills_$DATE.dump

# 删除 30 天前的备份
find $BACKUP_DIR -name "skills_*.dump.gz" -mtime +30 -delete

echo "Backup completed: skills_$DATE.dump.gz"
```

```bash
# 添加到 crontab
crontab -e
# 每天凌晨 2 点执行备份
0 2 * * * /opt/semibot/backup-skills-db.sh
```

### 文件系统备份

```bash
# 备份技能包文件
#!/bin/bash
BACKUP_DIR=/var/backups/semibot/skill-packages
DATE=$(date +%Y%m%d)
SOURCE_DIR=/var/lib/semibot/skills

# 创建增量备份
rsync -av --link-dest=$BACKUP_DIR/latest \
  $SOURCE_DIR/ \
  $BACKUP_DIR/$DATE/

# 更新 latest 符号链接
ln -snf $BACKUP_DIR/$DATE $BACKUP_DIR/latest

# 删除 90 天前的备份
find $BACKUP_DIR -maxdepth 1 -type d -mtime +90 -exec rm -rf {} \;
```

### 恢复流程

```bash
# 1. 恢复数据库
pg_restore -U postgres -d semibot \
  -c -F c /var/backups/semibot/skills/skills_20260209_020000.dump.gz

# 2. 恢复文件系统
rsync -av /var/backups/semibot/skill-packages/latest/ \
  /var/lib/semibot/skills/

# 3. 验证数据完整性
psql -U postgres -d semibot -c "
  SELECT COUNT(*) FROM skill_definitions;
  SELECT COUNT(*) FROM skill_packages;
"

# 4. 重启服务
systemctl restart semibot
```

### 灾难恢复计划

**RTO (Recovery Time Objective)**: 1 小时
**RPO (Recovery Point Objective)**: 24 小时

**恢复步骤**:
1. 评估故障范围
2. 通知相关人员
3. 从最近的备份恢复数据库
4. 从备份恢复文件系统
5. 验证数据完整性
6. 重启服务
7. 执行健康检查
8. 通知恢复完成

---

## 安全运维

### 访问控制

```sql
-- 创建只读用户（用于监控）
CREATE USER skill_monitor WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE semibot TO skill_monitor;
GRANT SELECT ON skill_definitions, skill_packages, skill_install_logs TO skill_monitor;

-- 创建应用用户（最小权限）
CREATE USER skill_app WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE semibot TO skill_app;
GRANT SELECT, INSERT, UPDATE ON skill_definitions, skill_packages, skill_install_logs TO skill_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO skill_app;
```

### 审计日志

```bash
# 启用 PostgreSQL 审计日志
# 编辑 postgresql.conf
log_statement = 'mod'  # 记录所有修改操作
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '

# 重启 PostgreSQL
systemctl restart postgresql

# 查看审计日志
tail -f /var/log/postgresql/postgresql-14-main.log | grep skill_
```

### 安全检查清单

**每周检查**:
- [ ] 审查失败的安装尝试
- [ ] 检查异常的访问模式
- [ ] 验证文件系统权限
- [ ] 检查未授权的 API 调用

**每月检查**:
- [ ] 更新依赖包
- [ ] 安全漏洞扫描
- [ ] 密码轮换
- [ ] 证书更新

### 漏洞扫描

```bash
# 扫描 npm 依赖
npm audit

# 修复已知漏洞
npm audit fix

# 扫描 Docker 镜像（如果使用）
docker scan semibot:latest

# 扫描文件系统
clamscan -r /var/lib/semibot/skills
```

---

## 性能优化

### 数据库优化

```sql
-- 1. 创建索引
CREATE INDEX CONCURRENTLY idx_skill_packages_definition_version
ON skill_packages(skill_definition_id, version);

CREATE INDEX CONCURRENTLY idx_skill_install_logs_definition_created
ON skill_install_logs(skill_definition_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_skill_definitions_active
ON skill_definitions(is_active) WHERE is_active = true;

-- 2. 分析表统计信息
ANALYZE skill_definitions;
ANALYZE skill_packages;
ANALYZE skill_install_logs;

-- 3. 清理死元组
VACUUM ANALYZE skill_definitions;
VACUUM ANALYZE skill_packages;
VACUUM ANALYZE skill_install_logs;

-- 4. 查询优化
EXPLAIN ANALYZE
SELECT * FROM skill_packages
WHERE skill_definition_id = 'xxx'
ORDER BY created_at DESC;
```

### 应用层优化

```typescript
// 1. 启用连接池
const pool = new Pool({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

// 2. 实现缓存
import Redis from 'ioredis'
const redis = new Redis()

async function getSkillDefinition(id: string) {
  // 先查缓存
  const cached = await redis.get(`skill:${id}`)
  if (cached) return JSON.parse(cached)

  // 查数据库
  const skill = await skillDefinitionRepo.findById(id)

  // 写入缓存（TTL 5 分钟）
  await redis.setex(`skill:${id}`, 300, JSON.stringify(skill))

  return skill
}

// 3. 批量操作
async function installMultipleSkills(skills: SkillInput[]) {
  // 使用 Promise.all 并发安装
  const results = await Promise.all(
    skills.map(skill => installSkillPackage(userId, skill))
  )
  return results
}
```

### 文件系统优化

```bash
# 1. 使用 SSD 存储
# 将技能包存储迁移到 SSD

# 2. 启用文件系统缓存
# 编辑 /etc/fstab
/dev/sdb1 /var/lib/semibot ext4 defaults,noatime 0 2

# 3. 定期清理碎片
e4defrag /var/lib/semibot/skills

# 4. 监控 I/O 性能
iostat -x 1 10
```

---

## 常见问题

### Q1: 如何查看某个技能的安装历史？

```sql
SELECT
  version,
  operation,
  status,
  error_message,
  created_at
FROM skill_install_logs
WHERE skill_definition_id = 'your-skill-id'
ORDER BY created_at DESC;
```

### Q2: 如何手动触发版本回滚？

```bash
curl -X POST http://localhost:3000/api/v1/skill-definitions/{id}/rollback \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targetVersion": "1.0.0",
    "reason": "Manual rollback due to bug"
  }'
```

### Q3: 如何清理失败的安装？

```sql
-- 查看失败的安装
SELECT * FROM skill_packages WHERE status = 'failed';

-- 删除失败的包记录
DELETE FROM skill_packages WHERE status = 'failed' AND id = 'xxx';

-- 清理文件系统
rm -rf /var/lib/semibot/skills/xxx/failed-version/
```

### Q4: 如何限制单个组织的技能数量？

```typescript
// 在创建技能前检查
const count = await skillDefinitionRepo.countByOrg(orgId)
if (count >= MAX_SKILLS_PER_ORG) {
  throw new Error('已达到技能数量上限')
}
```

### Q5: 如何迁移技能包到新的存储位置？

```bash
# 1. 停止服务
systemctl stop semibot

# 2. 复制文件
rsync -av /var/lib/semibot/skills/ /new/storage/path/

# 3. 更新环境变量
export SKILL_STORAGE_PATH=/new/storage/path

# 4. 更新数据库中的路径
psql -U postgres -d semibot -c "
  UPDATE skill_packages
  SET package_path = REPLACE(package_path, '/var/lib/semibot/skills', '/new/storage/path');
"

# 5. 启动服务
systemctl start semibot

# 6. 验证
curl http://localhost:3000/api/v1/skill-definitions
```

### Q6: 如何监控安装队列？

```sql
-- 查看正在安装的技能
SELECT
  skill_definition_id,
  version,
  status,
  created_at,
  NOW() - created_at as duration
FROM skill_install_logs
WHERE status = 'installing'
ORDER BY created_at;

-- 查看等待安装的技能
SELECT COUNT(*) FROM skill_packages WHERE status = 'pending';
```

### Q7: 如何处理并发安装冲突？

```typescript
// 使用数据库锁
await pool.query('BEGIN')
try {
  await pool.query(
    'SELECT * FROM skill_packages WHERE skill_definition_id = $1 AND version = $2 FOR UPDATE',
    [definitionId, version]
  )

  // 执行安装
  await installSkillPackage(userId, input)

  await pool.query('COMMIT')
} catch (err) {
  await pool.query('ROLLBACK')
  throw err
}
```

---

## 联系方式

**技术支持**: support@semibot.ai
**紧急联系**: oncall@semibot.ai
**文档更新**: docs@semibot.ai

---

**文档版本**: 1.0.0
**最后更新**: 2026-02-09
**维护者**: SemiBot DevOps Team
