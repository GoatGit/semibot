"""Evolution prompt templates."""

EXTRACT_PROMPT = """
基于以下 Agent 执行记录，提取一个可复用的技能定义。

## 执行反思
{reflection}

## 执行计划
{plan}

## 工具调用结果
{tool_results}

## 对话上下文
{messages}

请以 JSON 格式输出技能定义：
{{
    "name": "技能名称（简洁、动词开头）",
    "description": "技能描述（一句话说明用途）",
    "trigger_keywords": ["触发关键词1", "关键词2"],
    "steps": [
        {{"order": 1, "action": "动作描述", "tool": "工具名", "params_template": {{}}}}
    ],
    "tools_used": ["tool1", "tool2"],
    "parameters": {{
        "param_name": {{"type": "string", "description": "参数说明", "required": true}}
    }},
    "preconditions": {{
        "required_tools": ["tool1"],
        "description": "前置条件说明"
    }},
    "expected_outcome": "预期结果描述",
    "reusability_score": 0.8
}}

注意：
1. 只提取具有通用复用价值的技能，不要提取一次性的特定任务
2. 参数化所有可变部分，使技能可以适用于不同输入
3. 步骤描述要足够清晰，让其他 Agent 也能执行
"""

QUALITY_ASSESS_PROMPT = """
评估以下技能的质量和复用价值。

技能名称: {name}
技能描述: {description}
执行步骤: {steps}
使用工具: {tools_used}

请以 JSON 格式输出评估结果：
{{
    "score": 0.0,
    "reusability": 0.0,
    "reasoning": "评估理由"
}}

评估维度：
1. 通用性 — 是否适用于多种场景
2. 完整性 — 步骤是否完整可执行
3. 参数化 — 可变部分是否已参数化
4. 清晰度 — 描述和步骤是否清晰
"""
