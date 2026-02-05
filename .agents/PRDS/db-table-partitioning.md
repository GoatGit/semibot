# Semibot: Database Table Partitioning Strategy

**Priority:** Low
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

为高增长日志表设计分区策略，优化大数据量场景下的查询性能。

## Description

以下表为高增长表，数据量增长迅速：
- `messages` - 消息历史
- `execution_logs` - 执行日志
- `api_key_logs` - API 使用日志
- `usage_records` - 使用量统计

当数据量达到百万级别后，全表扫描和索引维护成本将显著增加。

## Features / Requirements

### 1. 分区策略选择

**按时间范围分区（Range Partitioning）**：
- 适合日志类数据
- 便于历史数据归档和清理
- PostgreSQL 原生支持

### 2. 分区设计

```sql
-- messages 表按月分区
CREATE TABLE messages_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 创建月度分区
CREATE TABLE messages_y2026m01 PARTITION OF messages_partitioned
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE messages_y2026m02 PARTITION OF messages_partitioned
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- execution_logs 表类似设计
-- api_key_logs 表类似设计
```

### 3. 自动分区管理

```sql
-- 创建自动分区函数
CREATE OR REPLACE FUNCTION create_monthly_partition(
    p_table_name TEXT,
    p_year INTEGER,
    p_month INTEGER
) RETURNS VOID AS $$
DECLARE
    v_partition_name TEXT;
    v_start_date DATE;
    v_end_date DATE;
BEGIN
    v_partition_name := p_table_name || '_y' || p_year || 'm' || LPAD(p_month::TEXT, 2, '0');
    v_start_date := make_date(p_year, p_month, 1);
    v_end_date := v_start_date + INTERVAL '1 month';

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_partition_name, p_table_name, v_start_date, v_end_date
    );
END;
$$ LANGUAGE plpgsql;
```

### 4. 数据归档策略

- 保留最近 12 个月热数据
- 超过 12 个月数据归档到冷存储
- 超过 3 年数据可选择性删除

## Migration Plan

1. **Phase 1**: 创建分区表结构（不影响现有数据）
2. **Phase 2**: 迁移历史数据到分区表
3. **Phase 3**: 切换应用使用分区表
4. **Phase 4**: 删除旧表

## Files to Create

- `database/migrations/010_table_partitioning.sql`
- `database/scripts/create_partition.sh` - 自动创建分区脚本
- `database/scripts/archive_old_data.sh` - 数据归档脚本

## Acceptance Criteria

- [ ] 分区表结构创建成功
- [ ] 历史数据迁移完成
- [ ] 查询性能提升（大数据量场景）
- [ ] 自动分区管理脚本可用
- [ ] 数据归档流程文档化
