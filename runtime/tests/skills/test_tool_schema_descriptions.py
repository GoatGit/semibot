import pytest

from src.skills.code_executor import CodeExecutorTool
from src.skills.file_io import FileIOTool
from src.skills.http_client import HttpClientTool
from src.skills.memory import MemoryTool
from src.skills.search import SearchTool
from src.skills.semi_browser import SemiBrowserTool
from src.skills.sql_query_readonly import SqlQueryReadonlyTool
from src.skills.text_processing import TextProcessingTool
from src.skills.web_fetch import WebFetchTool


def test_file_io_schema_removes_exec_and_operation() -> None:
    tool = FileIOTool()

    props = tool.parameters["properties"]
    assert "operation" not in props
    assert props["action"]["enum"] == ["read", "write", "list", "edit"]
    assert "structured results" in tool.description


def test_code_executor_schema_exposes_workdir_and_timeout() -> None:
    tool = CodeExecutorTool()

    props = tool.parameters["properties"]
    assert props["workdir"]["type"] == "string"
    assert props["timeout_ms"]["type"] == "integer"
    assert "Shell uses bash" in tool.description


def test_search_description_and_schema() -> None:
    search = SearchTool()
    assert "Stable search alias" in search.description
    assert "timeout_ms" in search.parameters["properties"]


def test_http_and_fetch_schema_descriptions_are_clear() -> None:
    assert "response includes status_code" in HttpClientTool().description
    assert "does not perform browser interaction" in WebFetchTool().description
    assert "JS-rendered or stateful pages" in SemiBrowserTool().description


def test_text_processing_schema_exposes_compact_extract_slice_and_transform() -> None:
    tool = TextProcessingTool()
    props = tool.parameters["properties"]

    assert props["text"]["type"] == "string"
    assert props["schema"]["type"] == "object"
    assert props["operation"]["enum"] == ["compact", "extract", "slice", "transform"]
    assert props["extract_mode"]["enum"] == ["single_object", "array_of_objects"]
    assert "operation=compact" in tool.description
    assert "returns a deterministic slice wrapped in a slices array" in tool.description
    assert "operation=transform" in tool.description


def test_memory_tool_schema_exposes_snapshot_target_session_and_budget() -> None:
    tool = MemoryTool()
    props = tool.parameters["properties"]

    assert props["operation"]["enum"] == [
        "search_long_term",
        "save_long_term",
        "get_short_term_snapshot",
        "compact_short_term",
        "get_short_term_budget",
    ]
    assert "target_session_id" not in props
    assert props["content"]["type"] == "string"
    assert props["importance"]["type"] == "number"
    assert "only operates on the current runtime session" in tool.description
    assert "operation=get_short_term_snapshot" in tool.description
    assert "operation=search_long_term" in tool.description


def test_data_tools_descriptions_capture_mode_boundaries() -> None:
    csv_xlsx = pytest.importorskip("src.skills.csv_xlsx")
    pdf_report = pytest.importorskip("src.skills.pdf_report")

    assert "auto mode" in TextProcessingTool().description
    assert "SQLite or PostgreSQL" in SqlQueryReadonlyTool().description
    assert "preview rows plus total_rows/truncated" in csv_xlsx.CsvXlsxTool().description
    assert "generated_files" in pdf_report.PdfReportTool().description


def test_legacy_file_generators_are_marked_as_wrappers() -> None:
    file_generators = pytest.importorskip("src.skills.file_generators")

    assert "Legacy convenience wrapper" in file_generators.XlsxGeneratorTool().description
    assert "Prefer csv_xlsx" in file_generators.XlsxGeneratorTool().description
    assert "Legacy convenience wrapper" in file_generators.PdfGeneratorTool().description
    assert "Prefer pdf_report" in file_generators.PdfGeneratorTool().description
