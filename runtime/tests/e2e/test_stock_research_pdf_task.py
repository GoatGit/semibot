"""V2 e2e task: research Alibaba stock and generate a PDF report."""

import json
from pathlib import Path

import pytest

from src.skills.bootstrap import create_default_registry
from src.skills.code_executor import set_file_manager
from src.storage.file_manager import FileManager

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_collab, pytest.mark.e2e_research]


@pytest.mark.asyncio
async def test_e2e_alibaba_stock_research_pdf_task(tmp_path: Path):
    files_dir = tmp_path / "generated-files"
    files_dir.mkdir(parents=True, exist_ok=True)
    set_file_manager(FileManager(base_dir=str(files_dir)))

    registry = create_default_registry()

    context_data = {
        "user_request": "研究阿里巴巴股票，并生成PDF报告",
        "generated_at": "2026-02-26 18:00:00 UTC",
        "results": [
            {
                "title": "Alibaba Group Q3 Earnings Snapshot",
                "url": "https://example.com/alibaba-earnings",
                "content": "营收同比增长6%，云业务恢复双位数增长，管理层维持回购计划。",
            },
            {
                "title": "BABA Price Action and Valuation",
                "url": "https://example.com/baba-valuation",
                "content": "近一季度股价波动加大，市场关注利润率改善与国际业务扩张。",
            },
            {
                "title": "Regulatory and Macro Watch",
                "url": "https://example.com/china-macro",
                "content": "监管政策边际改善，但宏观需求恢复节奏仍需跟踪。",
            },
        ],
    }

    result = await registry.execute(
        "pdf",
        {
            "filename": "alibaba_stock_report.pdf",
            "title": "阿里巴巴（BABA）股票研究报告",
            "context_data": json.dumps(context_data, ensure_ascii=False),
        },
    )
    assert result.success is True
    assert result.error is None

    generated = result.metadata.get("generated_files", [])
    assert isinstance(generated, list)
    assert len(generated) >= 1

    pdf_meta = generated[0]
    assert pdf_meta["filename"].endswith(".pdf")
    pdf_path = Path(pdf_meta["path"])
    assert pdf_path.exists()
    assert pdf_path.stat().st_size > 1024
