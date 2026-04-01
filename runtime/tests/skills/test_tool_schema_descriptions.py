import pytest

from src.skills.code_executor import CodeExecutorTool
from src.skills.file_io import FileIOTool
from src.skills.http_client import HttpClientTool
from src.skills.memory import MemoryTool
from src.skills.search import SearchTool
from src.skills.semi_browser import SemiBrowserTool
from src.skills.synthetic_output import SyntheticOutputTool
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
    assert "Web search tool" in search.description
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
    assert props["operation"]["enum"] == ["brief", "compact", "extract", "slice", "transform"]
    assert props["brief_mode"]["enum"] == ["summary", "brief", "key_points", "compress"]
    assert props["style"]["enum"] == ["neutral", "executive", "bullet"]
    assert props["extract_mode"]["enum"] == ["single_object", "array_of_objects"]
    assert "operation=compact" in tool.description
    assert "operation=brief" in tool.description
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
    assert "auto mode" in TextProcessingTool().description
    synthetic_output = SyntheticOutputTool()
    assert "final schema-bound structured output" in synthetic_output.description
    assert synthetic_output.parameters["required"] == ["schema"]
    assert synthetic_output.parameters["properties"]["value"]["description"].startswith("Structured payload")


def test_pdf_generator_is_marked_as_wrapper() -> None:
    file_generators = pytest.importorskip("src.skills.file_generators")

    assert "Legacy convenience wrapper" in file_generators.PdfGeneratorTool().description
    assert "generated_files" in file_generators.PdfGeneratorTool().description
