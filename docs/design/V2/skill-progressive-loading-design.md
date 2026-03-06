# Skill Progressive Loading Design (V2)

> 替代 `runtime-skill-manifest-cache-design.md` 的方案。
> 核心理念：**渐进加载、LLM 原生、轻量守卫**。

## 1. 背景

当前 runtime 编排技能存在三个问题：

1. **Replan 时重复理解技能**：SKILL.md 每轮被重新读取/注入，token 浪费。
2. **计划生成与脚本契约不一致**：LLM 生成的脚本命令参数错误、路径虚构。
3. **缺乏 token 预算管理**：技能数量增长时 prompt 膨胀失控。

### 1.1 被替代方案的问题

之前的 `SkillExecutionManifest` 方案试图在 SKILL.md 与 LLM 之间插入一个结构化中间层（manifest），将自由文本解析为 CLI 契约、产物契约等。这带来了三个根本问题：

1. **SKILL.md 是自由格式 Markdown，不存在可靠的确定性解析方式**。manifest 生成本身就需要 LLM 或脆弱正则，成为新的单点故障。
2. **manifest 契约刚性过强**，会阻止 LLM 的灵活执行路径。
3. **额外缓存层复杂度高**，但 context window 本身就是天然缓存。

## 2. 设计原则

| # | 原则 | 说明 |
|---|------|------|
| 1 | **渐进加载** | 三级加载，每级只在需要时才加载 |
| 2 | **LLM 原生** | 信任 LLM 理解 SKILL.md 文本，不做中间层解析 |
| 3 | **轻量守卫** | 安全校验（路径白名单）必须有，参数校验采用分级（可确定必错则阻断） |
| 4 | **token 预算驱动** | 所有注入都受 token budget 约束 |
| 5 | **context + 追踪状态** | context 作为主要载体，追踪状态用于压缩后可恢复与可重注入 |
| 6 | **通用机制** | 适用于 instruction / package / hybrid 三种技能类型 |

## 3. 三级渐进加载模型

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                     Skill Progressive Loading                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Level 1: Skill Index (始终注入 system prompt)                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ • skill_id + name + description + kind + script_files[]          │  │
│  │ • 每个技能 ~80-150 tokens                                        │  │
│  │ • 总预算: 最多 N 个技能, 最多 M chars                             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                    LLM 选择技能后                                        │
│                              ▼                                          │
│  Level 2: SKILL.md Body (首次选中时注入)                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ • 完整 SKILL.md 文本 (截断到 max_skill_md_chars)                  │  │
│  │ • 以 tool-context 消息注入, 后续轮次自动留在 context window       │  │
│  │ • 同一会话不重复注入                                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                    LLM 决定执行脚本时                                    │
│                              ▼                                          │
│  Level 3: Script Execution (执行时按需)                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ • 通过 skill_script_runner 执行                                   │  │
│  │ • 路径白名单校验 (硬性)                                            │  │
│  │ • 脚本存在性校验 + fuzzy 纠错 (已有)                               │  │
│  │ • 参数一致性校验 (新增, 分级: error/warning/info)                  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 4. Level 1: Skill Index

### 4.1 数据结构

每个技能在索引中的表示（`SkillIndexEntry`）：

```python
@dataclass
class SkillIndexEntry:
    skill_id: str
    name: str
    description: str
    kind: Literal["instruction", "package", "hybrid"]
    script_files: list[str]       # e.g. ["scripts/research_engine.py", "scripts/validate_report.py"]
    has_skill_md: bool
    has_references: bool
    has_templates: bool
    enabled: bool = True
```

### 4.2 索引来源

复用已有 `SkillsIndexManager.read_index()` 返回的 `.index.json`，在注入 prompt 时做轻量转换。

**重要**：`script_files`、`has_references`、`has_templates` 等字段在 `reindex()` 时预先扫描并写入 `.index.json`，
`build_skill_index_entries` **不做文件系统扫描**，仅从已有记录中读取。这避免了每次构建 prompt 时对 50+ 技能目录做 I/O 遍历。

```python
def build_skill_index_entries(index_records: list[dict]) -> list[SkillIndexEntry]:
    """将 .index.json 记录转换为 prompt 注入用的索引条目。纯内存操作，不做文件系统扫描。"""
    entries = []
    for record in index_records:
        if not record.get("enabled", True):
            continue
        entries.append(SkillIndexEntry(
            skill_id=record["skill_id"],
            name=record.get("name", record["skill_id"]),
            description=record.get("description", ""),
            kind=record.get("kind", "instruction"),
            script_files=record.get("script_files", []),
            has_skill_md=record.get("has_skill_md", False),
            has_references=record.get("has_references", False),
            has_templates=record.get("has_templates", False),
        ))
    return entries
```

### 4.3 Prompt 注入格式

```xml
<available_skills>
  <skill id="deep-research" kind="hybrid">
    <description>深度研究技能，支持多轮网络调研并生成结构化报告</description>
    <scripts>research_engine.py, validate_report.py, verify_citations.py</scripts>
    <resources>has_skill_md, has_references, has_templates</resources>
  </skill>
  <skill id="pdf-report" kind="package">
    <description>从 Markdown 生成 PDF 报告</description>
    <scripts>generate_pdf.py</scripts>
    <resources>has_templates</resources>
  </skill>
  <!-- ... -->
</available_skills>
```

> 注：token 预算的消耗统计仅在日志中输出，不注入 prompt。内部预算信息对 LLM 无用且可能干扰注意力。

### 4.4 Token 预算

| 参数 | 默认值 | 环境变量 |
|------|--------|----------|
| 最大技能数 | 50 | `SEMIBOT_MAX_SKILLS_IN_PROMPT` |
| 最大总字符数 | 8000 | `SEMIBOT_MAX_SKILLS_PROMPT_CHARS` |
| 单技能 description 最大字符 | 200 | `SEMIBOT_MAX_SKILL_DESC_CHARS` |

超出预算时按优先级截断：

1. 用户显式请求的技能（永远保留）
2. 上一轮使用过的技能
3. 按 description 相关度评分排序
4. 截断 description，保留 skill_id + kind

## 5. Level 2: SKILL.md 注入

### 5.1 触发条件

在 `plan_node` 中，当 `_pick_skill_candidate` 命中技能时触发。

### 5.2 注入方式

保留已有 `_inject_skill_md_context_message` 机制（以 tool-context 消息角色注入），但做以下改进：

- 通过 tracker 的 `is_injected` 检查避免重复注入。
- 增加 **mtime 新鲜度检查**：如果 SKILL.md 文件在上次注入后被修改（如用户更新了技能），允许重新注入最新版本。

```python
def inject_skill_md(
    messages: list[Message],
    skill_item: dict,
    session_id: str,
    injection_tracker: SkillInjectionTracker,
) -> bool:
    skill_name = skill_item.get("skill_id") or skill_item.get("name")
    skill_md_path = _resolve_skill_md_path(skill_item)
    current_mtime = skill_md_path.stat().st_mtime if skill_md_path and skill_md_path.exists() else None

    # 已注入且内容未变化则跳过
    if injection_tracker.is_injected(skill_name, current_mtime=current_mtime):
        return False

    content = _load_skill_md(skill_item)
    if not content:
        return False

    # 截断保护
    content = content[:MAX_SKILL_MD_CHARS]
    truncated = len(content) == MAX_SKILL_MD_CHARS

    # 构建注入消息
    header = _build_skill_context_header(skill_name, skill_item, truncated)
    payload = f"{header}\n\n<skill_md>\n{content}\n</skill_md>"

    messages.append({"role": "tool", "name": f"skill_context/{skill_name}", "content": payload})

    injection_tracker.mark_injected(skill_name, chars=len(content), content_mtime=current_mtime)
    return True
```

### 5.3 SkillInjectionTracker

```python
class SkillInjectionTracker:
    """追踪当前会话中哪些技能的 SKILL.md 已注入 context。

    这不是独立缓存层——只是记录已注入状态，
    避免同一 SKILL.md 被重复插入消息列表。

    持久化策略：默认挂在 RuntimeSessionContext 实例属性上（不放入 metadata dict），
    因为 tracker 是会话生命周期对象，不需要跨进程序列化。
    LangGraph 的 AgentState dict 只携带可序列化的计划/消息数据，
    tracker 通过 RuntimeSessionContext 引用在同一会话的所有节点间共享。

    多进程/重启降级策略：
    - 如果 tracker 丢失（新进程无法恢复），调用 rebuild_from_messages() 从消息历史重建：
      扫描 messages 中 role="tool" 且 name 匹配 "skill_context/{skill_id}" 的消息，
      恢复已注入状态。
    - 对同一技能设置 per-skill 重复注入上限（默认每会话 2 次），避免无限重复注入。
    """

    MAX_REINJECTION_PER_SKILL = 2

    def __init__(self) -> None:
        self._injected: dict[str, InjectionRecord] = {}
        self._injection_count: dict[str, int] = {}  # per-skill 注入计数
        self._resource_read: dict[tuple[str, str], ResourceReadRecord] = {}  # (skill_id, file_path) -> 读取缓存

    def is_injected(self, skill_id: str, current_mtime: float | None = None) -> bool:
        record = self._injected.get(skill_id)
        if not record:
            return False
        # 从消息历史重建的记录没有 mtime，不因 mtime 缺失直接失效。
        # 后续首次实际读取时再写入准确 mtime。
        if record.mtime_unknown:
            return True
        if current_mtime is not None and record.content_mtime != current_mtime:
            return False  # 文件已变化，允许重注入
        return True

    def mark_injected(self, skill_id: str, chars: int = 0, content_mtime: float | None = None) -> None:
        self._injected[skill_id] = InjectionRecord(
            skill_id=skill_id,
            injected_at=datetime.now(UTC),
            chars=chars,
            content_mtime=content_mtime,
        )
        # _injection_count 仅用于 tracker 丢失场景的防重复，
        # 正常的压缩→重注入会在 mark_compressed 中回退计数，不占配额。
        self._injection_count[skill_id] = self._injection_count.get(skill_id, 0) + 1

    def can_reinject(self, skill_id: str) -> bool:
        """检查是否还允许重注入（防止 tracker 丢失后的无限重复）。
        正常压缩→重注入不受此限制（mark_compressed 会回退计数）。"""
        return self._injection_count.get(skill_id, 0) < self.MAX_REINJECTION_PER_SKILL

    def get_injected_skills(self) -> list[str]:
        return list(self._injected.keys())

    def total_injected_chars(self) -> int:
        return sum(r.chars for r in self._injected.values())

    @classmethod
    def rebuild_from_messages(cls, messages: list[dict]) -> "SkillInjectionTracker":
        """从消息历史重建 tracker（用于进程重启后的降级恢复）。"""
        tracker = cls()
        for msg in messages:
            if msg.get("role") == "tool" and (msg.get("name") or "").startswith("skill_context/"):
                skill_id = msg["name"].split("/", 1)[1]
                content = msg.get("content", "")
                tracker._injected[skill_id] = InjectionRecord(
                    skill_id=skill_id,
                    injected_at=datetime.now(UTC),
                    chars=len(content),
                    content_mtime=None,
                    mtime_unknown=True,
                )
                tracker._injection_count[skill_id] = tracker._injection_count.get(skill_id, 0) + 1
        return tracker

    # 资源读取缓存 API（供 6.5.3 使用）
    def get_cached_resource(self, skill_id: str, file_path: str, current_mtime: float | None = None) -> str | None:
        record = self._resource_read.get((skill_id, file_path))
        if not record:
            return None
        if current_mtime is not None and record.content_mtime is not None and record.content_mtime != current_mtime:
            return None
        return record.content

    def mark_resource_read(
        self,
        skill_id: str,
        file_path: str,
        content: str,
        *,
        content_mtime: float | None = None,
    ) -> None:
        self._resource_read[(skill_id, file_path)] = ResourceReadRecord(
            skill_id=skill_id,
            file_path=file_path,
            content=content,
            content_mtime=content_mtime,
            read_at=datetime.now(UTC),
        )

@dataclass
class InjectionRecord:
    skill_id: str
    injected_at: datetime
    chars: int
    content_mtime: float | None = None
    mtime_unknown: bool = False

@dataclass
class ResourceReadRecord:
    skill_id: str
    file_path: str
    content: str
    content_mtime: float | None
    read_at: datetime
```

### 5.4 SKILL.md Token 预算

| 参数 | 默认值 | 环境变量 |
|------|--------|----------|
| 单个 SKILL.md 最大字符 | 12000 | `SEMIBOT_MAX_SKILL_MD_CHARS` |
| 同时注入的 SKILL.md 总量 | 20000 | `SEMIBOT_MAX_TOTAL_SKILL_MD_CHARS` |

当总量接近上限时：
1. 优先保留当前轮选中的技能
2. 对已注入但非当前轮使用的技能，在消息历史中做摘要压缩
3. 被压缩技能标记为 `compressed`，该技能再次命中时先重注入完整版再规划

## 6. Level 3: 执行守卫

### 6.1 保留的硬性校验（安全边界）

这些校验必须阻断执行，不可跳过：

```python
class ExecutionGuard:
    """技能执行安全守卫。"""

    def validate_script_path(self, skill_root: Path, script_ref: str) -> ValidationResult:
        """路径必须在 skill_root/scripts/ 下，不可遍历。"""
        resolved = (skill_root / script_ref).resolve()
        scripts_root = (skill_root / "scripts").resolve()
        if scripts_root not in resolved.parents and resolved != scripts_root:
            return ValidationResult(blocked=True, reason="path_traversal")
        if not resolved.exists():
            return ValidationResult(blocked=True, reason="script_not_found",
                                     suggestion=self._fuzzy_suggest(script_ref, skill_root))
        if not resolved.is_file():
            return ValidationResult(blocked=True, reason="script_not_file")
        return ValidationResult(blocked=False)

    def validate_skill_exists(self, skills_root: Path, skill_name: str) -> ValidationResult:
        """技能目录必须存在。"""
        skill_dir = (skills_root / skill_name).resolve()
        if not skill_dir.exists() or not skill_dir.is_dir():
            return ValidationResult(blocked=True, reason="skill_not_found")
        return ValidationResult(blocked=False)
```

### 6.2 新增的参数一致性校验（分级）

参数校验采用分级策略：

1. **error（阻断）**：`--help` 输出格式被识别为标准格式（argparse/click），且出现以下任一情况：
   - 缺少明确标记为 `required` 的参数；
   - 出现 unrecognized flags（默认阻断）。
2. **warning（建议）**：仅当 unknown flag 命中已知 alias / 子命令白名单模式时，降级为 warning。
3. **info（忽略）**：`--help` 不可用或输出格式无法识别。

> `--help` 解析是尽力而为（best-effort）。不同脚本框架（argparse、click、自定义）的输出格式差异极大，
> 无法 100% 可靠。当解析不确定时，**降为 warning 或 info，不阻断**。
> 这是本设计与旧 manifest 方案的核心区别：避免"脆弱解析导致脆弱阻断"。

```python
class ExecutionAdvisor:
    """基于脚本自描述接口的参数一致性校验（best-effort）。"""

    def __init__(self) -> None:
        # 进程内缓存，按 (skill_id, script_path, mtime) 避免重复执行 --help
        self._help_cache: dict[tuple[str, str, float], str | None] = {}

    def check_script_help(self, skill_root: Path, script_path: str, args: list[str]) -> Advisory:
        """尝试运行 script --help，对比用户提供的参数。"""
        help_text = self._get_cached_help(skill_root, script_path)
        if not help_text:
            return Advisory(level="info", message="script --help unavailable, proceeding as-is")

        # 仅对可识别的标准格式（argparse/click）做结构化解析
        format_recognized, expected_flags, required_flags = self._parse_help_output(help_text)
        if not format_recognized:
            return Advisory(level="info", message="--help output format not recognized, proceeding as-is",
                            help_text_snippet=help_text[:500])

        provided_flags = self._extract_flags(args)
        unknown = provided_flags - expected_flags
        missing_required = required_flags - provided_flags

        issues = []
        level: Literal["ok", "warning", "error"] = "ok"

        if missing_required:
            issues.append(f"missing required flags: {', '.join(sorted(missing_required))}")
            level = "error"  # 标准格式明确标记 required → 可信阻断
        if unknown:
            issues.append(f"unrecognized flags: {', '.join(sorted(unknown))}")
            # 默认阻断；仅白名单 alias/子命令模式降级 warning
            if self._all_unknown_flags_are_aliases(unknown, script_path):
                if level != "error":
                    level = "warning"
            else:
                level = "error"

        if issues:
            return Advisory(level=level, message="; ".join(issues), help_text_snippet=help_text[:500])
        return Advisory(level="ok", message="args look consistent with --help")

    def _get_cached_help(self, skill_root: Path, script_path: str) -> str | None:
        full_path = skill_root / script_path
        try:
            mtime = full_path.stat().st_mtime
        except OSError:
            return None
        cache_key = (str(skill_root), script_path, mtime)
        if cache_key in self._help_cache:
            return self._help_cache[cache_key]
        result = self._run_help(full_path)
        self._help_cache[cache_key] = result
        return result

    def _parse_help_output(self, help_text: str) -> tuple[bool, set[str], set[str]]:
        """解析 --help 输出。返回 (格式是否识别, 所有 flags, 必填 flags)。
        仅对 argparse/click 等标准格式返回 True；自定义格式返回 False。"""
        ...
```

### 6.3 ValidationResult / Advisory

```python
@dataclass
class ValidationResult:
    blocked: bool
    reason: str = ""
    suggestion: str | None = None

@dataclass
class Advisory:
    level: Literal["ok", "info", "warning", "error"]
    message: str
    help_text_snippet: str | None = None
```

### 6.4 执行流程

```text
LLM 生成 skill_script_runner 调用
          │
          ▼
    ┌──────────────┐
    │ 硬性校验      │──── blocked ──→ 返回结构化错误，触发 replan
    │ (path/exist) │
    └──────┬───────┘
           │ pass
           ▼
    ┌──────────────┐
    │ 参数一致性校验 │──── error ─────→ 返回结构化错误，触发 replan
    │ (--help 对比) │──── warning ───→ 附加 advisory 到执行结果
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │ 执行脚本      │
    │ (subprocess)  │
    └──────────────┘
```

### 6.5 非 scripts 资源文件处理

skill 目录下的非脚本资源（如 `reference/`、`templates/`、`assets/`）需要专门处理，但遵循轻量规则：

1. 默认不预加载：除 `SKILL.md` 外，不自动注入资源目录内容。
2. 按需读取：仅在 `SKILL.md` 明确引用且当前步骤确实需要时读取。
3. 只读访问：通过 `file_io(action='read_skill_file')` 或等价只读能力加载，不可执行。
4. 与脚本执行链分离：`scripts/*` 才可由 `skill_script_runner` 执行；非 scripts 资源不得进入执行链。

#### 6.5.1 目录白名单与安全边界

允许读取目录（相对 skill root）：

- `reference/`
- `references/`
- `templates/`
- `assets/`

拒绝规则：

1. 任何 `..` 路径穿越。
2. 任何越出 `skill_root` 的符号链接解析结果。
3. 目录外绝对路径访问。

#### 6.5.2 资源类型语义

1. `reference/*`：知识参考材料，仅用于上下文理解。
2. `templates/*`：内容模板输入，不可执行。
3. `assets/*`：静态资源（样式/图片等），按需读取。
4. `tests/*`：默认不注入；仅在显式调试/验证模式下允许读取。激活方式：`runtime_policy.skill_debug = true`（由 API 层在会话创建时根据用户权限设置），或环境变量 `SEMIBOT_SKILL_DEBUG=1`（仅开发环境）。

#### 6.5.3 预算与缓存

1. 单文件读取上限：`SEMIBOT_MAX_SKILL_RESOURCE_FILE_CHARS`（默认 6000 chars）。
2. 单轮资源总注入上限：`SEMIBOT_MAX_SKILL_RESOURCE_TOTAL_CHARS`（默认 12000 chars）。
3. 同会话重复读取命中缓存时复用，避免重复 I/O 与 token 浪费。缓存由 `SkillInjectionTracker` 统一管理（扩展 `_resource_read` 记录），与 SKILL.md 注入追踪共用同一 tracker 实例，不引入独立缓存层。
4. 超出预算时优先“标题+关键段落”摘要，不整文件注入。

## 7. Planner 技能约束注入

### 7.1 系统指令

在 system prompt 中固定的技能使用规则：

```text
## Skills

你可以使用 <available_skills> 中列出的技能。使用规则：

1. 如果恰好一个技能明确匹配用户需求：必须遵循其 SKILL.md 指引。
2. 如果多个技能可能匹配：选择最具体的一个。
3. 如果没有技能匹配：不要读取任何 SKILL.md，使用通用工具处理。

技能执行约束：
- kind=instruction 的技能没有脚本，仅作为知识参考。
- kind=package 或 hybrid 的技能包含可执行脚本，通过 skill_script_runner 调用。
- 脚本命令必须引用 <scripts> 中列出的文件。不要虚构不存在的脚本路径。
- 当 SKILL.md 已预加载到上下文中时，不要再添加读取 SKILL.md 的执行步骤。
- 当 SKILL.md 未预加载且 file_io 可用时，可先读取 SKILL.md 再执行。
```

### 7.2 动态约束消息

当选中技能后，在 plan_node 中注入约束消息（改进已有的 `_inject_skill_constraints_message`）：

```python
def build_skill_constraints(
    skill_item: dict,
    *,
    skill_md_preloaded: bool,
    available_tool_names: set[str],
) -> str:
    skill_name = skill_item.get("skill_id") or skill_item.get("name")
    kind = skill_item.get("kind", "instruction")
    script_files = skill_item.get("script_files", [])

    lines = [
        f"[SYSTEM] Selected skill: {skill_name} (kind={kind})",
    ]

    if skill_md_preloaded:
        lines.append("- SKILL.md 已在上下文中，不要在计划中添加读取步骤。")
    elif "file_io" in available_tool_names:
        lines.append("- SKILL.md 未预加载，可先通过 file_io 读取后再执行。")

    if kind in ("package", "hybrid") and script_files:
        lines.append(f"- 可用脚本: {', '.join(script_files)}")
        if "skill_script_runner" in available_tool_names:
            lines.append("- 执行脚本时使用 skill_script_runner，命令中引用上述脚本路径。")
            lines.append("- 如需了解脚本参数，可先执行 --help 查看用法。")

    if kind == "hybrid":
        lines.append("- 此技能为混合型：遵循 SKILL.md 文档指导 + 调用脚本执行具体步骤。")
        lines.append("- 不要将技能名当作工具直接调用。")

    return "\n".join(lines)
```

## 8. 多技能协同

### 8.1 设计策略

不强制“主+辅”模式，但要求步骤级技能归属，避免冲突扩散：

```text
多技能使用规则：
- 同一计划中可以使用多个技能，但每个技能的 SKILL.md 独立遵循。
- 冲突处理：按步骤绑定技能来源（step-level provenance），同一步骤只允许一个技能来源生效。
- 若同一步骤存在冲突指令：优先更具体且可执行的指令，无法判定时触发 replan。
- SKILL.md 按需读取：只读取实际会用到的技能文档。
```

### 8.1.1 Step-level Provenance 实现

步骤级技能归属通过在 plan 数据结构中标记每个步骤的来源技能实现：

```python
@dataclass
class PlanStep:
    action: str
    tool: str
    args: dict
    skill_source: str | None = None  # 标记此步骤遵循哪个技能的指引

# plan_node 的约束消息中指引 LLM 输出 skill_source：
#   "每个步骤需标注 skill_source 字段，值为该步骤所遵循的技能 id。
#    若步骤不属于任何技能（通用工具调用），skill_source 为 null。"
```

冲突检测逻辑（plan 后处理**硬性 gate**，至少对 `skill_script_runner` 步骤强制）：

```python
def validate_plan_provenance(steps: list[PlanStep]) -> tuple[bool, list[str]]:
    """检查步骤的技能归属是否一致。返回 (是否通过, 错误列表)。"""
    errors = []
    for i, step in enumerate(steps):
        if step.tool == "skill_script_runner":
            # 脚本步骤必须声明 skill_source
            if not step.skill_source:
                errors.append(f"step {i}: skill_script_runner step missing skill_source")
                continue
            if not _script_belongs_to_skill(step.args.get("command", ""), step.skill_source):
                errors.append(f"step {i}: script does not belong to declared skill_source '{step.skill_source}'")
    return (len(errors) == 0, errors)
```

Provenance 校验失败时的处理流程：

1. `plan_node` 在生成计划后调用 `validate_plan_provenance`。
2. 若返回失败，将 errors 列表格式化为 replan 消息注入 context：
   ```python
   if not passed:
       replan_msg = "[SYSTEM] REPLAN: plan provenance validation failed.\n" + "\n".join(errors)
       replan_msg += "\nFix: ensure every skill_script_runner step declares skill_source matching the skill that owns the script."
       messages.append({"role": "system", "content": replan_msg})
       # 触发 replan，不执行当前计划
   ```
3. 最多重试 2 次（`MAX_PROVENANCE_REPLAN = 2`），超过则**终止当前执行并返回结构化错误**（不放行冲突计划），避免“带病执行”。

### 8.2 注入追踪

`SkillInjectionTracker` 天然支持多技能。当第二个技能被选中时：

1. 检查 `total_injected_chars()` 是否在预算内。
2. 在预算内：正常注入。
3. 超预算：仅注入新技能的索引摘要 + 脚本列表，提示 LLM 按需读取。

## 9. Replan 行为

### 9.1 技能上下文复用

Replan 时复用已注入内容，但必须先检查该技能是否已被压缩：

```text
Turn 1: [user] "用 deep-research 分析竞品"
         [tool_context/deep-research] <skill_md>...</skill_md>    ← Level 2 注入
         [assistant] plan: step1=research, step2=validate...
         [tool_results] ...

Turn 2 (replan): [user] [SYSTEM] REPLAN: step2 failed
         ↑ skill_md 已在 Turn 1 的消息中，LLM 直接可见
         [assistant] revised plan: step2=validate with --format md
```

`SkillInjectionTracker.is_injected()` 确保不重复注入同一 SKILL.md。若该技能标记为 `compressed`，再次命中时先重注入完整版。

### 9.2 技能切换

如果 replan 时 LLM 选择了不同技能：

1. `_pick_skill_candidate` 返回新技能。
2. `inject_skill_md` 检查 tracker → 未注入 → 注入新技能的 SKILL.md。
3. 旧技能的 SKILL.md 仍在消息历史中（不主动删除，因为可能仍有参考价值）。

### 9.3 长对话压缩

当消息历史过长（超过 `SEMIBOT_MAX_CONTEXT_CHARS`），在消息压缩阶段：

1. 旧的 `<skill_md>` 块被标记为可压缩区域。
2. 压缩为摘要：`"[已读取 deep-research SKILL.md，指引要点：1)... 2)... 3)...]"`
3. tracker 中该技能标记为 `compressed`，如果后续轮次再次需要完整内容，重新注入。

#### 压缩摘要生成策略

采用**规则提取**（非 LLM）生成压缩摘要，降低成本和延迟：

```python
def compress_skill_md(skill_id: str, skill_md_content: str) -> str:
    """从 SKILL.md 提取关键要点作为压缩摘要。

    规则：提取所有 ## / ### 标题 + 每个标题下的第一个段落/列表项，
    截断到 MAX_COMPRESSED_CHARS (默认 500)。
    不使用 LLM 做摘要，因为压缩发生在 token 已紧张的场景，
    额外的 LLM 调用会加重延迟和成本。
    """
    headings = _extract_headings_with_first_paragraph(skill_md_content)
    summary_lines = [f"[已读取 {skill_id} SKILL.md，指引要点：]"]
    for heading, first_para in headings:
        summary_lines.append(f"- {heading}: {first_para}")
    summary = "\n".join(summary_lines)
    return summary[:MAX_COMPRESSED_CHARS]
```

```python
class SkillInjectionTracker:
    # ... 已有方法 ...

    def mark_compressed(self, skill_id: str) -> None:
        """标记为已压缩，允许重新注入完整版。
        回退 injection_count，因为压缩→重注入是正常生命周期，不应占用防重复配额。"""
        if skill_id in self._injected:
            del self._injected[skill_id]
        if self._injection_count.get(skill_id, 0) > 0:
            self._injection_count[skill_id] -= 1
```

## 10. 与现有代码的集成方案

### 10.1 改动点列表

| 文件 | 改动 | 说明 |
|------|------|------|
| `runtime/src/skills/skill_index_prompt.py` | **新建** | `SkillIndexEntry`, `build_skill_index_entries`, `format_skills_for_prompt` |
| `runtime/src/skills/skill_injection_tracker.py` | **新建** | `SkillInjectionTracker`, `InjectionRecord` |
| `runtime/src/skills/execution_guard.py` | **新建** | `ExecutionGuard`, `ExecutionAdvisor`, `Advisory` |
| `runtime/src/orchestrator/nodes.py` | **修改** | `plan_node` 中替换技能注入逻辑，使用新的三级加载 |
| `runtime/src/skills/skill_script_runner.py` | **修改** | 集成 `ExecutionAdvisor` 的建议性校验 |
| `runtime/src/skills/index_manager.py` | **修改** | `reindex` 时扫描并持久化 `script_files`、`has_skill_md`、`has_references`、`has_templates` 到 `.index.json`，prompt 构建时不再做文件系统 I/O |
| `runtime/src/orchestrator/context.py` | **小改** | `RuntimeSessionContext` 增加 `skill_injection_tracker` 实例属性（非 metadata dict，不需序列化） |

### 10.2 plan_node 核心改动

```python
# 当前代码 (简化)
selected_skill = _pick_skill_candidate(runtime_context, user_text)
selected_skill_md_content, truncated = _load_skill_md_for_planner(selected_skill)
_inject_skill_md_context_message(messages, selected_skill, session_id)
_inject_skill_constraints_message(messages, selected_skill, ...)

# 改为
selected_skill = _pick_skill_candidate(runtime_context, user_text)
tracker = _get_or_create_tracker(runtime_context)
skill_name = selected_skill.get("skill_id") or selected_skill.get("name") if selected_skill else ""

# Level 2: 仅在未注入时注入
injected = inject_skill_md(messages, selected_skill, session_id, tracker)

# 约束消息: 使用新的结构化约束
constraints = build_skill_constraints(
    selected_skill,
    skill_md_preloaded=injected or tracker.is_injected(skill_name),
    available_tool_names=available_tool_names,
)
messages.append({"role": "system", "content": constraints})
```

### 10.3 skill_script_runner 改动

```python
# 在 execute() 方法中，校验通过后、实际执行前
advisory = self.advisor.check_script_help(skill_root, script_path, args)
if advisory.level == "error":
    return ToolResult.error_result(
        advisory.message,
        advisory=advisory.message,
        script_help=advisory.help_text_snippet,
    )

result = await self._run_subprocess(...)
if advisory.level in ("warning", "info"):
    result.metadata["advisory"] = advisory.message
    if advisory.help_text_snippet:
        result.metadata["script_help"] = advisory.help_text_snippet
return result
```

## 11. Token 预算全局视图

```text
┌─────────────────────────────────────────────────────────────────┐
│                    Context Window Budget                         │
│        (token 以 tokenizer 实测为准，chars 仅作粗略上限)          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  System Prompt (固定)              ~4000 chars                   │
│  ├── 技能使用规则                   ~500 chars                   │
│  └── Level 1: Skill Index          ≤8000 chars (~50 skills)     │
│                                                                  │
│  Messages History (动态)           ~300k chars                   │
│  ├── Level 2: SKILL.md 注入        ≤20000 chars (单次≤12k)      │
│  ├── 资源文件读取 (ref/tpl)         ≤12000 chars (单文件≤6k)     │
│  ├── 对话消息                       ~240k chars                  │
│  └── Tool results                   ~30k chars                   │
│                                                                  │
│  Tool Schemas (固定)               ~8000 chars                   │
│                                                                  │
│  Reserved (安全余量)               ~60k chars                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 12. 验收标准

| # | 标准 | 测试方式 |
|---|------|----------|
| 1 | 同一会话多轮 replan 不重复注入同一技能的 SKILL.md | 检查消息历史中 `<skill_md>` 出现次数 |
| 2 | 技能切换时新技能可正常注入，旧技能保留在 context | 日志验证 `skill_md_context_injected` |
| 3 | 脚本路径错误时返回结构化错误 + fuzzy 建议 | 单元测试 `ExecutionGuard` |
| 4 | 可确定参数错误时阻断并返回结构化错误；不确定时 advisory | 单元测试 `ExecutionAdvisor` |
| 5 | 50 个技能的索引注入不超过 8000 chars | Prompt 长度断言 |
| 6 | SKILL.md 注入总量不超过 20000 chars | `tracker.total_injected_chars()` 断言 |
| 7 | 长对话中旧 skill_md 可被压缩，压缩摘要保留标题结构 | 消息压缩集成测试 |
| 8 | deep-research 完整场景可走通 | E2E 测试 |
| 9 | SKILL.md 文件变更后会话内自动重注入最新版本 | 单元测试 `SkillInjectionTracker` mtime 检查 |
| 10 | `build_skill_index_entries` 不触发文件系统 I/O | 单元测试 mock `Path`，确认无 stat/exists 调用 |
| 11 | `--help` 缓存命中时不重复执行子进程 | 单元测试 `ExecutionAdvisor._get_cached_help` |
| 12 | provenance 校验失败时计划被阻断并触发 replan | plan 后处理集成测试 |
| 13 | unknown flag 默认阻断；命中 alias 白名单可降级 warning | 单元测试 `ExecutionAdvisor` |
| 14 | tracker 丢失后重复注入受上限约束（默认 2 次） | 会话恢复场景测试 |

## 13. 与 OpenClaw 的设计决策对比

| 决策点 | 本设计 | OpenClaw | 取舍原因 |
|--------|--------|----------|----------|
| 索引内容 | id + desc + kind + scripts 列表 | id + desc + 文件路径 | 多出 scripts 列表，帮助 LLM 在 Level 1 就知道可执行什么，减少幻觉 |
| 注入时机 | 选中后由 runtime 主动注入 | LLM 通过 read 工具自行读取 | runtime 主动注入更可控，避免 LLM 遗忘读取步骤 |
| 执行校验 | 路径白名单(硬性) + 参数校验分级(error/warning) | 无校验 | 保留必要安全边界，并避免已知必错命令反复执行 |
| 多技能 | 允许多个，受 token 预算约束 | 一次只读一个 | Semibot 的编排场景更复杂，需要多技能协同 |
| 缓存机制 | 注入追踪器（轻量） | 无（context window 就是缓存） | 基本同理念，但加了追踪器避免重复注入 |

## 14. 风险与降级

| 风险 | 降级策略 |
|------|----------|
| `_pick_skill_candidate` 选错技能 | replan 切换技能；步骤级 provenance 防止跨技能污染 |
| SKILL.md 过大被截断 | 截断处提示 LLM 使用 file_io 读取完整版 |
| 脚本 --help 不可用或格式异常 | `ExecutionAdvisor` 返回 info/warning，不阻断 |
| 技能数量超过 50 | 按优先级截断，日志中输出 warning |
| 消息历史过长导致 skill_md 被压缩/遗忘 | tracker 标记 `compressed`，再次命中时重注入完整版 |
| tracker 在多进程/重启后丢失 | 先按消息历史去重；同一技能重复注入设置上限（默认 2 次/会话） |

## 15. 对齐 OpenClaw 的使用原则

本设计在实现上参考 `openclaw` 的技能注入思路，但不复制其代码结构。这里明确需要对齐的原则，避免 runtime 再次走向“过度解释技能”的老路。

### 15.1 技能首先是文档协议，不是可执行入口

默认假设：

1. 技能的首要协议是 `SKILL.md`
2. skill 的主流程由文档定义，而不是由 `scripts/main.py`、`main.sh` 等入口决定
3. 只有在技能显式声明稳定入口或 runtime 有独立 manifest 时，才允许把技能当作直接可执行单元

因此：

1. 不把“有 scripts 目录”自动等同于“可直接执行 skill”
2. 不预设 `scripts/main.py` 是默认入口
3. 不根据 phase 名自动推导脚本名

### 15.2 先路由技能，再读取正文

系统 prompt 中只注入轻量技能索引：

1. 技能名
2. 描述
3. 类型
4. `SKILL.md` 路径
5. 可用脚本文件列表

模型先完成 skill 选择，再读取目标 `SKILL.md`。

约束：

1. 不要在一开始注入多份 `SKILL.md`
2. 不要在未命中技能前追逐 `reference/`、`templates/`、`scripts/`
3. 如果多个技能都可能相关，优先选择最具体的一个主技能

### 15.3 `SKILL.md` 负责方法论，runtime 负责执行契约

`SKILL.md` 用来传达：

1. 适用场景
2. 阶段流程
3. 资源加载时机
4. 验证步骤
5. 输出格式要求

runtime 用来提供：

1. 可用工具名与 schema
2. 可执行脚本白名单
3. 脚本参数预检
4. artifact 产出与消费契约
5. 执行失败后的 guard / replan 规则

禁止的做法：

1. 用正则从 `SKILL.md` 提取完整 CLI schema
2. 把 `SKILL.md` 中的说明性文字直接当作脚本参数契约
3. 因为文档提到“阶段”就强行生成脚本步骤

### 15.4 不把 phase 名硬翻译成脚本命令

像 `SCOPE / RETRIEVE / TRIANGULATE / SYNTHESIZE / PACKAGE` 这样的词，是流程语义，不是命令接口。

因此：

1. `SCOPE` 不等于必须调用某个脚本
2. `TRIANGULATE` 不等于必须存在 `triangulate_phase.py`
3. `PACKAGE` 不等于应该调用 `research_engine.py --query "generate_final_report ..."`

正确做法：

1. phase 约束 LLM 对步骤的组织方式
2. 是否使用脚本，由以下因素共同决定：
   - `SKILL.md` 是否明确要求
   - 真实脚本是否存在
   - CLI 是否匹配
   - 前置 artifact 是否具备

### 15.5 主流程优先使用通用工具，脚本用于辅助与验证

对于 `deep-research` 这类 hybrid 技能，推荐顺序应是：

1. 读取 `SKILL.md`
2. 按需加载方法论与模板
3. 使用内建搜索/抓取/整理工具完成研究主流程
4. 生成 markdown 主报告
5. 运行验证脚本
6. 再做 HTML / PDF 导出

这意味着：

1. 脚本不是默认主入口
2. 脚本更适合做验证、格式转换、后处理
3. 如果脚本本身不能完成完整产物生成，不能把它伪装成“完整执行 deep-research”

### 15.6 计划阶段必须校验 skill-flow

命中技能后，plan 不能直接放行，必须做 post-plan validation。

对研究型技能至少检查：

1. 是否已经注入或读取 `SKILL.md`
2. 是否包含检索步骤
3. 是否包含综合或报告生成步骤
4. 是否包含验证步骤
5. 如果后续步骤依赖文件，前面是否有明确 artifact 来源

不满足时：

1. 直接 replan
2. 不执行不合格计划
3. 不通过 runtime 硬改写出一套看似合理的伪步骤

### 15.7 引入显式 artifact 契约

后续步骤不能假设本地文件天然存在。

必须明确：

1. 哪一步生成了 artifact
2. artifact 的逻辑类型是什么
3. artifact 的物理路径是什么
4. 下一步消费的是哪一个 artifact

推荐的逻辑 artifact 类型：

1. `search_results`
2. `search_results_json`
3. `report_md`
4. `report_html`
5. `report_pdf`
6. `citation_verification_result`
7. `report_validation_result`

如果脚本要求 `--report /path/to/file.md`：

1. runtime 必须能追溯该文件的来源
2. 前面没有来源时，不能继续执行
3. 应返回结构化错误并触发 replan

### 15.8 脚本仅按真实能力执行

执行脚本前，runtime 只做通用校验：

1. 路径必须落在 `skill/scripts/`
2. 脚本必须真实存在
3. 目标必须是文件，不是目录
4. 参数必须通过 `--help` 或静态解析的预检
5. 脚本声称生成的产物必须真实存在

禁止：

1. 用 phase 名自动映射脚本名
2. 猜测未声明的参数
3. 相信 stdout 中提到的路径必然已生成

### 15.9 减少 runtime 对 skill 的过度解释

runtime 不应替 skill 发明这些东西：

1. 中间文件名
2. 隐含步骤
3. 默认入口脚本
4. 未声明的 phase-to-command 映射

runtime 的职责应收敛为：

1. 技能选择支持
2. 文档注入
3. 资源按需读取
4. 计划合规校验
5. artifact 契约校验
6. 执行安全与失败恢复

### 15.10 失败后优先 replan，而不是继续串错链

以下情况都应阻断并触发 replan：

1. 缺失输入 artifact
2. 脚本参数校验失败
3. 引用不存在脚本
4. 脚本声称生成文件但文件不存在
5. 计划跳过必需验证步骤

### 15.11 多技能时主次分离

单轮允许多技能，但必须有主技能。

规则：

1. 主技能控制主流程
2. 辅技能只承担明确子任务
3. 每个步骤都要有 `skill_source`
4. provenance 冲突不能降级放行

例如：

1. `deep-research` 负责研究与报告结构
2. `generating-pdf` 只负责 PDF 导出

## 16. 对 `deep-research` 的直接含义

按本设计，`deep-research` 的合理执行链应为：

1. 通过技能索引命中 `deep-research`
2. 读取 `SKILL.md`
3. 进入研究流程，按需读 `reference/methodology.md`
4. 使用内建搜索/抓取工具完成 `RETRIEVE`
5. 将检索结果整理为显式 artifact
6. 基于 artifact 生成 markdown 主报告
7. 运行 `verify_citations.py` / `validate_report.py`
8. 成功后生成 HTML / PDF

不应再出现：

1. 直接把 `research_engine.py` 当作完整研究入口
2. 凭空出现 `search_results.json`
3. 让不存在的 `report.md` 进入验证环节
4. `PACKAGE` 阶段只打印 “Report will be saved to ...” 就算成功

## 17. 设计结论

`semibot` 对齐 `openclaw` 的正确方向，不是去模拟每个 skill 的内部实现，而是回到更通用、更克制的机制：

1. 先帮助 LLM 正确选择技能
2. 再让 LLM 读取并遵循 `SKILL.md`
3. 最后由 runtime 提供执行边界、artifact 契约和失败护栏

一句话总结：

**技能的主协议来自 `SKILL.md`，runtime 只负责让这个协议更容易被遵循、更不容易被执行链路误解。**
