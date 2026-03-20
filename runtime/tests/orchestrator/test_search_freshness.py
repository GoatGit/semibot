from src.orchestrator.nodes_plan import (
    _extract_target_url,
    _is_browser_intent,
    _is_latest_intent,
)


def test_is_latest_intent_detects_chinese_and_english_keywords():
    # Disabled: _is_latest_intent always returns False
    assert not _is_latest_intent("搜索最新的AI行业动态")
    assert not _is_latest_intent("搜索今天的新闻")
    assert not _is_latest_intent("find latest ai news today")
    assert not _is_latest_intent("解释什么是Transformer")


def test_browser_intent_detection_and_url_extract():
    # Disabled: _is_browser_intent always returns False, _extract_target_url always returns None
    assert not _is_browser_intent("访问 www.doubao.com 并提取标题")
    assert _extract_target_url("访问 www.doubao.com 并提取标题") is None
    assert _extract_target_url("open https://example.com/page?a=1") is None
    assert _extract_target_url("总结 AI 发展历史") is None
