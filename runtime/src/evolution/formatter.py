"""Format evolved skills for LLM prompt injection."""


def format_skills_for_prompt(skills: list[dict]) -> str:
    """将进化技能格式化为 LLM prompt 上下文"""
    if not skills:
        return ""

    lines = ["## 可复用的进化技能\n"]
    for i, skill in enumerate(skills, 1):
        use_count = skill.get("use_count", 0)
        success_count = skill.get("success_count", 0)
        success_rate = (
            f"{success_count / use_count:.0%}" if use_count > 0 else "N/A"
        )

        lines.append(
            f"### 技能 {i}: {skill['name']} "
            f"(相似度: {skill.get('similarity', 0):.2f})"
        )
        lines.append(f"描述: {skill['description']}")
        lines.append(f"步骤: {_format_steps(skill.get('steps', []))}")
        lines.append(f"使用次数: {use_count}, 成功率: {success_rate}")
        lines.append(f"技能ID: {skill['id']}")
        lines.append("")

    return "\n".join(lines)


def _format_steps(steps: list[dict]) -> str:
    """格式化步骤列表"""
    if not steps:
        return "无"
    return " → ".join(
        f"{s.get('order', i + 1)}. {s.get('action', '未知')}"
        for i, s in enumerate(steps)
    )
