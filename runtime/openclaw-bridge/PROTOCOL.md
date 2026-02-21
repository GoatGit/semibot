# OpenClaw Bridge Protocol

## 1. Bridge stdin commands

Each line is a JSON object:

- `start`
  - fields: `type`, `session_id`, `payload`
- `user_message`
  - fields: `type`, `session_id`, `payload.message`
- `cp_response`
  - fields: `type`, `id`, `result?`, `error?`
  - note: `session_id` is optional
- `cancel`
  - fields: `type`, `session_id`
- `stop`
  - fields: `type`

## 2. Bridge stdout messages

- UI events:
  - `thinking`
  - `text`
  - `tool_call`
  - `tool_result`
  - `execution_complete`
  - `execution_error`
- Control-plane proxy:
  - `cp_request`
  - `cp_fire_and_forget`

## 3. OPENCLAW_SDK_CMD protocol

When `OPENCLAW_RUNNER_MODE=sdk`, bridge can call external command through `OPENCLAW_SDK_CMD`.

### 3.1 Command stdin payload (JSON)

```json
{
  "message": "user input",
  "memory_context": ["memory text 1", "memory text 2"],
  "loaded_skill_count": 1,
  "model": "gpt-4o",
  "tool_profile": "coding"
}
```

### 3.2 Command stdout payload (JSON recommended)

```json
{
  "text": "assistant final text",
  "usage": {
    "tokens_in": 123,
    "tokens_out": 45
  }
}
```

If stdout is plain text (not JSON), bridge treats it as `text`.

### 3.3 Error handling

- Non-zero exit code: bridge emits `execution_error` and includes stderr/stdout summary.
- Invalid JSON stdout: bridge falls back to plain-text mode.
- Missing `text`: bridge emits fallback `"OpenClaw SDK returned empty response"`.

### 3.4 Bridge error codes for SDK path

- `SDK_COMMAND_SPAWN_FAILED`
  - failed to spawn shell command
- `SDK_COMMAND_TIMEOUT`
  - command did not complete within `OPENCLAW_SDK_TIMEOUT_MS` (default `15000`)
- `SDK_COMMAND_FAILED`
  - command exited with non-zero code
- `SDK_OUTPUT_INVALID`
  - command completed but returned empty output
