import pytest
import os
import tempfile
from src.skills.web_fetch import WebFetchTool
from src.skills.http_client import HttpClientTool

BrowserAutomationTool = pytest.importorskip("src.skills.browser_automation").BrowserAutomationTool

@pytest.mark.asyncio
async def test_e2e_web_fetch():
    tool = WebFetchTool()
    # 临时覆盖可能存在的任何本地严格白名单策略
    tool.allowed_domains = [] 
    tool.blocked_domains = ["localhost", "127.0.0.1", "::1", "0.0.0.0"]
    
    result = await tool.execute(url="https://example.com", mode="raw")
    assert not result.error, f"web_fetch check failed expected success: {result.error}"
    data = result.result
    assert "Example Domain" in data.get("title", ""), f"Unexpected title: {data.get('title')}"
    assert "text/html" in data.get("content_type", "").lower()
    assert len(data.get("text", "")) > 10

@pytest.mark.asyncio
async def test_e2e_http_client():
    tool = HttpClientTool()
    tool.allowed_domains = []
    tool.blocked_domains = ["localhost", "127.0.0.1", "::1", "0.0.0.0"]
    
    result = await tool.execute(
        method="GET", 
        url="https://httpbin.org/get", 
        query={"e2e_test": "hello_world"},
        headers={"User-Agent": "Semibot-E2E-Test/1.0"}
    )
    assert not result.error, f"http_client check failed expected success: {result.error}"
    data = result.result
    response_info = data["response"]
    assert response_info["status_code"] == 200
    
    # Verify the JSON payload has our query args and headers
    json_data = response_info.get("json", {})
    assert json_data is not None, "Response JSON should not be None"
    assert json_data.get("args", {}).get("e2e_test") == "hello_world"
    assert "Semibot-E2E-Test/1.0" in json_data.get("headers", {}).get("User-Agent", "")

@pytest.mark.asyncio
async def test_e2e_browser_automation():
    tool = BrowserAutomationTool()
    tool.allowed_domains = []
    tool.blocked_domains = ["localhost", "127.0.0.1", "::1", "0.0.0.0"]
    tool.default_headless = True
    
    # 1. 打开测试网站
    res_open = await tool.execute(action="open", url="https://example.com", wait_until="domcontentloaded")
    assert not res_open.error, f"browser_automation open failed: {res_open.error}"
    assert "Example Domain" in res_open.result.get("title", "")
    
    # 2. 提取文本验证无头浏览器渲染正确
    res_extract = await tool.execute(action="extract_text", selector="h1")
    assert not res_extract.error, f"browser_automation extract_text failed: {res_extract.error}"
    assert "Example Domain" in res_extract.result.get("text", "")
    
    # 3. 抓取截图验证功能完整与文件落盘
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
        
    try:
        res_shot = await tool.execute(action="screenshot", path=tmp_path, full_page=True)
        assert not res_shot.error, f"browser_automation screenshot failed: {res_shot.error}"
        assert res_shot.result["bytes"] > 500  # Valid Image File Bytes Ensure
        assert os.path.exists(tmp_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    
    # 4. 安全关闭浏览器资源
    res_close = await tool.execute(action="close")
    assert not res_close.error, f"browser_automation close failed: {res_close.error}"
