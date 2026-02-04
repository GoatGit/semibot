# 错误码规范

## 1. 错误码格式

错误码遵循统一格式：`{CATEGORY}_{SPECIFIC_ERROR}`

```json
{
    "success": false,
    "error": {
        "code": "AUTH_INVALID_TOKEN",
        "message": "The provided token is invalid or expired",
        "status": 401,
        "details": {}
    }
}
```

## 2. 错误码分类

### 2.1 认证错误 (AUTH_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| AUTH_MISSING_TOKEN | 401 | 缺少认证 Token |
| AUTH_INVALID_TOKEN | 401 | Token 无效或已过期 |
| AUTH_INVALID_API_KEY | 401 | API Key 无效 |
| AUTH_EXPIRED_API_KEY | 401 | API Key 已过期 |
| AUTH_INVALID_CREDENTIALS | 401 | 用户名或密码错误 |
| AUTH_PERMISSION_DENIED | 403 | 权限不足 |
| AUTH_ACCOUNT_DISABLED | 403 | 账户已禁用 |

### 2.2 资源错误 (RESOURCE_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| RESOURCE_NOT_FOUND | 404 | 资源不存在 |
| RESOURCE_ALREADY_EXISTS | 409 | 资源已存在 |
| RESOURCE_CONFLICT | 409 | 资源冲突 |
| RESOURCE_LOCKED | 423 | 资源被锁定 |

### 2.3 验证错误 (VALIDATION_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| VALIDATION_FAILED | 400 | 请求参数验证失败 |
| VALIDATION_REQUIRED_FIELD | 400 | 缺少必填字段 |
| VALIDATION_INVALID_FORMAT | 400 | 格式无效 |
| VALIDATION_OUT_OF_RANGE | 400 | 值超出范围 |

### 2.4 配额错误 (QUOTA_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| QUOTA_EXCEEDED | 429 | 配额已用完 |
| QUOTA_TOKENS_EXCEEDED | 429 | Token 配额超限 |
| QUOTA_API_CALLS_EXCEEDED | 429 | API 调用次数超限 |
| QUOTA_AGENTS_EXCEEDED | 429 | Agent 数量超限 |

### 2.5 执行错误 (EXECUTION_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| EXECUTION_TIMEOUT | 504 | 执行超时 |
| EXECUTION_FAILED | 500 | 执行失败 |
| EXECUTION_TOOL_ERROR | 500 | 工具调用失败 |
| EXECUTION_LLM_ERROR | 502 | LLM 服务错误 |
| EXECUTION_SKILL_NOT_FOUND | 400 | Skill 不存在 |
| EXECUTION_TOOL_NOT_FOUND | 400 | Tool 不存在 |

### 2.6 系统错误 (SYSTEM_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| SYSTEM_INTERNAL_ERROR | 500 | 内部服务器错误 |
| SYSTEM_SERVICE_UNAVAILABLE | 503 | 服务暂时不可用 |
| SYSTEM_DATABASE_ERROR | 500 | 数据库错误 |
| SYSTEM_REDIS_ERROR | 500 | Redis 连接错误 |

### 2.7 速率限制 (RATE_LIMIT_*)

| 错误码 | HTTP 状态码 | 说明 |
| ------ | ----------- | ---- |
| RATE_LIMIT_EXCEEDED | 429 | 请求频率超限 |
| RATE_LIMIT_CHAT | 429 | 对话接口频率超限 |
| RATE_LIMIT_API | 429 | API 接口频率超限 |

## 3. 错误响应示例

### 3.1 验证错误

```json
{
    "success": false,
    "error": {
        "code": "VALIDATION_FAILED",
        "message": "Invalid request parameters",
        "status": 400,
        "details": [
            {
                "field": "name",
                "message": "Name is required"
            },
            {
                "field": "email",
                "message": "Invalid email format"
            }
        ]
    }
}
```

### 3.2 执行错误

```json
{
    "success": false,
    "error": {
        "code": "EXECUTION_TOOL_ERROR",
        "message": "Tool execution failed",
        "status": 500,
        "details": {
            "tool_name": "web_search",
            "original_error": "Connection timeout",
            "execution_id": "exec_abc123"
        }
    }
}
```

### 3.3 配额错误

```json
{
    "success": false,
    "error": {
        "code": "QUOTA_TOKENS_EXCEEDED",
        "message": "Monthly token quota exceeded",
        "status": 429,
        "details": {
            "limit": 1000000,
            "used": 1000000,
            "reset_at": "2024-02-01T00:00:00Z"
        }
    }
}
```

## 4. 客户端处理建议

```typescript
// 错误处理示例
async function handleApiError(error: ApiError) {
    switch (error.code) {
        case 'AUTH_INVALID_TOKEN':
        case 'AUTH_EXPIRED_API_KEY':
            // 重新登录或刷新 Token
            await refreshToken();
            break;
            
        case 'RATE_LIMIT_EXCEEDED':
            // 等待后重试
            const retryAfter = error.headers?.['Retry-After'] || 60;
            await delay(retryAfter * 1000);
            break;
            
        case 'QUOTA_EXCEEDED':
            // 提示用户升级
            showUpgradePrompt();
            break;
            
        case 'EXECUTION_TIMEOUT':
            // 可以重试
            await retryWithBackoff();
            break;
            
        default:
            // 显示通用错误
            showErrorMessage(error.message);
    }
}
```
