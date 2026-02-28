"""Builtin template-based PDF report generator."""

from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from fpdf import FPDF

from src.skills.base import BaseTool, ToolResult
from src.storage.file_manager import FileManager

_file_manager = FileManager()
_DEFAULT_FONT_PATH = Path("/System/Library/Fonts/Hiragino Sans GB.ttc")


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except Exception:
        return None


def _coerce_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    return []


def _load_json_if_needed(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        return json.loads(text)
    return value


class PdfReportTool(BaseTool):
    """Generate structured PDF reports from section templates."""

    def __init__(self) -> None:
        self.default_filename = str(os.getenv("SEMIBOT_PDF_REPORT_FILENAME", "report.pdf")).strip() or "report.pdf"

    @property
    def name(self) -> str:
        return "pdf_report"

    @property
    def description(self) -> str:
        return "Generate template-based PDF report with sections/tables/charts/conclusion."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "default": "report.pdf"},
                "title": {"type": "string", "description": "Report title."},
                "subtitle": {"type": "string", "description": "Optional subtitle."},
                "summary": {"type": "string", "description": "Executive summary paragraph."},
                "sections": {
                    "type": "array",
                    "description": (
                        "Section list. Section supports: heading, text, paragraphs, bullet_points, "
                        "table:{headers,rows}, chart:{title,labels,values,type}."
                    ),
                },
                "conclusion": {"type": "string", "description": "Conclusion paragraph."},
                "context_data": {"description": "Optional JSON string/object used to auto-build sections."},
            },
            "required": [],
        }

    def _ensure_pdf_extension(self, filename: str | None) -> str:
        safe = (filename or self.default_filename or "report.pdf").strip() or "report.pdf"
        safe = safe.replace("\\", "_").replace("/", "_")
        if not safe.lower().endswith(".pdf"):
            safe = f"{safe}.pdf"
        return safe

    def _setup_font(self, pdf: FPDF) -> bool:
        if _DEFAULT_FONT_PATH.exists():
            pdf.add_font("HiraginoGB", "", str(_DEFAULT_FONT_PATH))
            pdf.set_font("HiraginoGB", size=11)
            return True
        pdf.set_font("Helvetica", size=11)
        return False

    def _set_font(self, pdf: FPDF, use_cjk: bool, size: int) -> None:
        if use_cjk:
            pdf.set_font("HiraginoGB", size=size)
        else:
            pdf.set_font("Helvetica", size=size)

    def _render_table(self, pdf: FPDF, use_cjk: bool, table: dict[str, Any]) -> None:
        headers = [str(item) for item in _coerce_list(table.get("headers"))]
        rows = _coerce_list(table.get("rows"))
        if not headers and rows and isinstance(rows[0], dict):
            headers = [str(key) for key in rows[0].keys()]
        if not headers:
            return

        max_cols = min(6, len(headers))
        visible_headers = headers[:max_cols]
        col_width = 190 / max_cols

        self._set_font(pdf, use_cjk, 10)
        for header in visible_headers:
            pdf.cell(col_width, 8, text=header[:24], border=1)
        pdf.ln(8)

        max_rows = min(30, len(rows))
        for row in rows[:max_rows]:
            for header in visible_headers:
                value = row.get(header) if isinstance(row, dict) else None
                text = str(value) if value is not None else ""
                pdf.cell(col_width, 8, text=text[:24], border=1)
            pdf.ln(8)
        pdf.ln(1)

    def _render_chart(self, pdf: FPDF, use_cjk: bool, chart: dict[str, Any]) -> None:
        labels = [str(item) for item in _coerce_list(chart.get("labels"))]
        values = [_to_float(item) for item in _coerce_list(chart.get("values"))]
        filtered: list[tuple[str, float]] = []
        for idx, label in enumerate(labels):
            if idx >= len(values):
                break
            value = values[idx]
            if value is None:
                continue
            filtered.append((label, value))
        if not filtered:
            return

        chart_title = str(chart.get("title") or "Chart").strip()
        if chart_title:
            self._set_font(pdf, use_cjk, 11)
            pdf.multi_cell(0, 7, text=chart_title, new_x="LMARGIN", new_y="NEXT")

        max_value = max(value for _, value in filtered) or 1.0
        bar_max_width = 120.0
        row_height = 8.0
        self._set_font(pdf, use_cjk, 10)
        for label, value in filtered[:12]:
            if pdf.get_y() > 260:
                pdf.add_page()
                self._set_font(pdf, use_cjk, 10)
            normalized = max(0.0, min(1.0, value / max_value))
            width = bar_max_width * normalized
            pdf.cell(48, row_height, text=label[:20], border=0)
            x = pdf.get_x()
            y = pdf.get_y() + 1
            pdf.set_fill_color(160, 210, 185)
            pdf.rect(x, y, width, row_height - 2, style="F")
            pdf.cell(bar_max_width + 2, row_height, text=f"{value:.2f}", border=0)
            pdf.ln(row_height)
        pdf.ln(1)

    def _auto_sections_from_context(self, context_data: Any) -> list[dict[str, Any]]:
        parsed = _load_json_if_needed(context_data)
        if not isinstance(parsed, dict):
            return []
        rows = parsed.get("results")
        if not isinstance(rows, list) or not rows:
            return []

        sections: list[dict[str, Any]] = []
        bullet_points: list[str] = []
        for item in rows[:8]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or item.get("name") or "").strip()
            content = str(item.get("content") or item.get("snippet") or "").strip()
            if title:
                bullet_points.append(title)
            if content:
                bullet_points.append(content[:150])

        if bullet_points:
            sections.append(
                {
                    "heading": "Key Findings",
                    "bullet_points": bullet_points[:12],
                }
            )

        table_rows: list[dict[str, Any]] = []
        for item in rows[:10]:
            if isinstance(item, dict):
                table_rows.append({k: item.get(k) for k in list(item.keys())[:4]})
        if table_rows:
            sections.append(
                {
                    "heading": "Data Snapshot",
                    "table": {"rows": table_rows},
                }
            )
        return sections

    async def execute(
        self,
        filename: str | None = None,
        title: str | None = None,
        subtitle: str | None = None,
        summary: str | None = None,
        sections: list[dict[str, Any]] | None = None,
        conclusion: str | None = None,
        context_data: Any = None,
        **_: Any,
    ) -> ToolResult:
        safe_filename = self._ensure_pdf_extension(filename)
        report_title = (title or "Report").strip() or "Report"
        report_sections = sections if isinstance(sections, list) else []
        if not report_sections and context_data is not None:
            report_sections = self._auto_sections_from_context(context_data)

        try:
            with TemporaryDirectory(prefix="semibot-pdf-report-") as tmpdir:
                out_path = Path(tmpdir) / safe_filename
                pdf = FPDF()
                pdf.add_page()
                pdf.set_margins(10, 10, 10)
                pdf.set_auto_page_break(auto=True, margin=15)
                use_cjk = self._setup_font(pdf)

                self._set_font(pdf, use_cjk, 18)
                pdf.cell(0, 12, text=report_title, new_x="LMARGIN", new_y="NEXT", align="C")

                if subtitle:
                    self._set_font(pdf, use_cjk, 12)
                    pdf.cell(0, 8, text=str(subtitle)[:200], new_x="LMARGIN", new_y="NEXT", align="C")
                pdf.ln(2)

                if summary:
                    self._set_font(pdf, use_cjk, 11)
                    pdf.multi_cell(0, 7, text=str(summary), new_x="LMARGIN", new_y="NEXT")
                    pdf.ln(1)

                for section in report_sections:
                    if not isinstance(section, dict):
                        continue
                    heading = str(section.get("heading") or section.get("title") or "").strip()
                    if heading:
                        self._set_font(pdf, use_cjk, 13)
                        pdf.multi_cell(0, 8, text=heading, new_x="LMARGIN", new_y="NEXT")
                    self._set_font(pdf, use_cjk, 11)

                    text = section.get("text")
                    if isinstance(text, str) and text.strip():
                        pdf.multi_cell(0, 7, text=text.strip(), new_x="LMARGIN", new_y="NEXT")

                    for paragraph in _coerce_list(section.get("paragraphs")):
                        para_text = str(paragraph).strip()
                        if para_text:
                            pdf.multi_cell(0, 7, text=para_text, new_x="LMARGIN", new_y="NEXT")

                    for bullet in _coerce_list(section.get("bullet_points"))[:20]:
                        bullet_text = str(bullet).strip()
                        if bullet_text:
                            pdf.multi_cell(0, 7, text=f"- {bullet_text}", new_x="LMARGIN", new_y="NEXT")

                    table = section.get("table")
                    if isinstance(table, dict):
                        self._render_table(pdf, use_cjk, table)

                    chart = section.get("chart")
                    if isinstance(chart, dict):
                        self._render_chart(pdf, use_cjk, chart)
                    pdf.ln(1)

                if conclusion:
                    self._set_font(pdf, use_cjk, 13)
                    pdf.multi_cell(0, 8, text="Conclusion", new_x="LMARGIN", new_y="NEXT")
                    self._set_font(pdf, use_cjk, 11)
                    pdf.multi_cell(0, 7, text=str(conclusion), new_x="LMARGIN", new_y="NEXT")

                pdf.output(str(out_path))
                meta = _file_manager.persist_file(out_path)
                generated_files = [meta] if meta else []
                return ToolResult.success_result(
                    {
                        "filename": safe_filename,
                        "title": report_title,
                        "sections_count": len(report_sections),
                    },
                    generated_files=generated_files,
                )
        except Exception as exc:
            return ToolResult.error_result(f"pdf_report failed: {exc}")
