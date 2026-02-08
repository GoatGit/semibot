# Runtime 统一执行链使用示例

本目录包含 Runtime 统一执行链的各种使用示例。

## 示例列表

### 基础示例

1. [基本使用](01_basic_usage.py) - 最简单的使用示例
2. [能力图使用](02_capability_graph.py) - 如何使用 CapabilityGraph
3. [统一执行器](03_unified_executor.py) - 如何使用 UnifiedActionExecutor
4. [审计日志](04_audit_logging.py) - 如何使用 AuditLogger

### 高级示例

5. [审批机制](05_approval_hook.py) - 如何实现审批机制
6. [MCP 集成](06_mcp_integration.py) - 如何集成 MCP 服务器
7. [完整工作流](07_complete_workflow.py) - 完整的端到端工作流

### 最佳实践

8. [错误处理](08_error_handling.py) - 正确的错误处理方式
9. [性能优化](09_performance.py) - 性能优化技巧
10. [测试示例](10_testing.py) - 如何编写测试

## 运行示例

```bash
# 安装依赖
pip install -r requirements.txt

# 运行示例
python examples/01_basic_usage.py
```

## 注意事项

- 所有示例都是独立的，可以单独运行
- 示例使用内存存储，不需要数据库
- 示例包含详细的注释说明
