"""File generator tools backed by code_executor.

Provide stable `xlsx` / `pdf` capabilities for planner-executed actions.
"""

from __future__ import annotations

from typing import Any

from src.skills.base import BaseTool, ToolResult
from src.skills.code_executor import CodeExecutorTool


class XlsxGeneratorTool(BaseTool):
    @property
    def name(self) -> str:
        return "xlsx"

    @property
    def description(self) -> str:
        return (
            "Generate an XLSX spreadsheet file. "
            "If context_data contains {results:[...]}, it will convert rows to a table."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Output XLSX filename", "default": "report.xlsx"},
                "sheet_name": {"type": "string", "description": "Worksheet name", "default": "Data"},
                "context_data": {
                    "type": "string",
                    "description": "JSON payload. Prefer {results:[{...}]} for tabular export.",
                },
            },
            "required": [],
        }

    async def execute(
        self,
        filename: str = "report.xlsx",
        sheet_name: str = "Data",
        context_data: str | None = None,
        **_: Any,
    ) -> ToolResult:
        safe_filename = (filename or "report.xlsx").strip() or "report.xlsx"
        if not safe_filename.lower().endswith(".xlsx"):
            safe_filename = f"{safe_filename}.xlsx"

        code = f"""
import json
import re
import urllib.request
from openpyxl import Workbook

data = json.load(open('context.json', encoding='utf-8'))
rows = data.get('results', [])
user_request = str(data.get('user_request', '') or '')
if not isinstance(rows, list):
    rows = []

def _to_text(v):
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)

def _parse_numeric(token):
    token = (token or '').replace(',', '').strip()
    if not token:
        return None
    try:
        return float(token)
    except Exception:
        return None

def _extract_time_series_rows(items):
    year_value = {{}}
    year_re = re.compile(r'\\b((?:19|20)\\d{{2}})\\b')
    num_re = re.compile(r'(?<!\\d)(\\d{{1,3}}(?:,\\d{{3}})*(?:\\.\\d+)?)(?!\\d)')

    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get('title', '') or '')
        url = str(item.get('url', '') or '')
        content = str(item.get('content') or item.get('snippet') or '')
        text = "\\n".join([title, content])
        for line in text.splitlines():
            years = year_re.findall(line)
            if not years:
                continue
            numbers = num_re.findall(line)
            if not numbers:
                continue
            parsed_numbers = [_parse_numeric(n) for n in numbers]
            parsed_numbers = [n for n in parsed_numbers if n is not None]
            if not parsed_numbers:
                continue
            for y in years:
                yi = int(y)
                candidates = [n for n in parsed_numbers if int(n) != yi]
                if not candidates:
                    continue
                # pick the largest magnitude in the same line as representative value
                chosen = max(candidates, key=lambda x: abs(x))
                prev = year_value.get(yi)
                if prev is None or abs(chosen) > abs(prev.get('value_num', 0)):
                    year_value[yi] = {{
                        'year': yi,
                        'value': str(chosen),
                        'value_num': chosen,
                        'source_title': title,
                        'source_url': url,
                    }}

    series = [v for _, v in sorted(year_value.items(), key=lambda kv: kv[0])]
    for row in series:
        row.pop('value_num', None)
    return series

def _extract_requested_years(text):
    if not text:
        return None
    for pat in [r'近\\s*(\\d{{1,3}})\\s*年', r'过去\\s*(\\d{{1,3}})\\s*年', r'last\\s*(\\d{{1,3}})\\s*years?']:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            try:
                n = int(m.group(1))
                if n > 0:
                    return n
            except Exception:
                return None
    return None

def _has_year_value_schema(rows):
    if not rows or not isinstance(rows, list):
        return False
    first = rows[0]
    if not isinstance(first, dict):
        return False
    keys = {{str(k).lower() for k in first.keys()}}
    return ('year' in keys or '年份' in keys) and ('value' in keys or '数值' in keys or '值' in keys)

def _fetch_worldbank_series(user_text, years):
    text = (user_text or '').lower()
    indicator = None
    indicator_name = None
    if 'gdp' in text or '国内生产总值' in text:
        if any(k in text for k in ['人民币', 'rmb', 'cny', '元']):
            indicator = 'NY.GDP.MKTP.CN'
            indicator_name = 'GDP (current LCU, CNY)'
        else:
            # Default to USD for cross-country comparability and clearer scale.
            indicator = 'NY.GDP.MKTP.CD'
            indicator_name = 'GDP (current US$)'
    if not indicator:
        return []

    country = None
    if '中国' in user_text or 'china' in text:
        country = 'CHN'
    if not country:
        return []

    # World Bank API returns latest first.
    url = f'https://api.worldbank.org/v2/country/{{country}}/indicator/{{indicator}}?format=json&per_page=200'
    try:
        req = urllib.request.Request(url, headers={{'User-Agent': 'semibot-xlsx-generator'}})
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode('utf-8', errors='ignore')
        if not body:
            return []
        payload = json.loads(body)
        if not isinstance(payload, list) or len(payload) < 2 or not isinstance(payload[1], list):
            return []
        valid_points = []
        for item in payload[1]:
            year = int(item.get('date', 0) or 0)
            value = item.get('value')
            if not year or value in (None, ''):
                continue
            valid_points.append((year, value))
        if not valid_points:
            return []

        latest_available_year = max(y for y, _ in valid_points)
        start_year = latest_available_year - (years or 40) + 1
        out = []
        for year, value in valid_points:
            if year < start_year or year > latest_available_year:
                continue
            out.append({{
                'year': year,
                'value': str(value),
                'indicator': indicator_name,
                'unit': 'US$' if indicator.endswith('.CD') else 'CNY',
                'source_title': 'World Bank Open Data',
                'source_url': url,
            }})
        out.sort(key=lambda r: r['year'])
        # Ensure deterministic "近N年" window if extra rows appear.
        if years and len(out) > years:
            out = out[-years:]
        return out
    except Exception:
        return []

structured_rows = []
if rows and isinstance(rows[0], dict):
    # Prefer existing tabular rows if they look already structured.
    has_year_key = any(
        isinstance(r, dict) and any(str(k).lower() in ('year', '年份') for k in r.keys())
        for r in rows
    )
    if has_year_key:
        structured_rows = rows
    else:
        extracted = _extract_time_series_rows(rows)
        # Use extracted series when it is substantial; otherwise fallback to raw rows.
        if len(extracted) >= 8:
            structured_rows = extracted
        else:
            structured_rows = rows

years_requested = _extract_requested_years(user_request)
min_rows = 0
if years_requested:
    min_rows = 30 if years_requested >= 30 else max(8, years_requested // 2)
is_gdp_request = bool(
    user_request
    and (
        ('gdp' in user_request.lower())
        or ('国内生产总值' in user_request)
    )
)
prefer_worldbank = bool(
    user_request
    and years_requested
    and is_gdp_request
)
if (prefer_worldbank or not structured_rows or len(structured_rows) < min_rows) and user_request:
    wb_rows = _fetch_worldbank_series(user_request, years_requested or 40)
    if wb_rows:
        structured_rows = wb_rows

# For GDP long-range requests, never export raw link/snippet rows as table data.
# Either provide real yearly values or fail fast so planner can retry with a better path.
if is_gdp_request and years_requested:
    looks_like_year_value_table = bool(
        structured_rows
        and isinstance(structured_rows[0], dict)
        and ('year' in structured_rows[0])
        and ('value' in structured_rows[0])
    )
    if (not looks_like_year_value_table) or (len(structured_rows) < min_rows):
        raise RuntimeError(
            f"GDP time-series data unavailable: expected at least {{min_rows}} yearly rows, "
            f"got {{len(structured_rows)}}. Do not fallback to link-only rows."
        )

# Generic acceptance gate for long-range yearly table requests:
# require a real year/value table with enough rows, otherwise fail fast.
if years_requested:
    min_year_rows = min_rows or max(8, years_requested // 2)
    if (not _has_year_value_schema(structured_rows)) or (len(structured_rows) < min_year_rows):
        raise RuntimeError(
            "XLSX acceptance check failed: expected a year/value time-series table "
            f"with >= {{min_year_rows}} rows for a {{years_requested}}-year request, "
            f"but got {{len(structured_rows)}} rows."
        )

wb = Workbook()
ws = wb.active
ws.title = {sheet_name!r}

if structured_rows and isinstance(structured_rows[0], dict):
    headers = []
    seen = set()
    for r in structured_rows:
        if not isinstance(r, dict):
            continue
        for k in r.keys():
            if k not in seen:
                seen.add(k)
                headers.append(k)
    if not headers:
        headers = ["value"]
    ws.append(headers)
    for r in structured_rows:
        if isinstance(r, dict):
            ws.append([_to_text(r.get(h)) for h in headers])
        else:
            ws.append([_to_text(r)])
else:
    ws.append(["message"])
    ws.append(["No structured rows available in context_data.results"])

wb.save({safe_filename!r})
print("xlsx generated")
"""
        executor = CodeExecutorTool()
        return await executor.execute(
            language="python",
            code=code,
            context_data=context_data,
        )


class PdfGeneratorTool(BaseTool):
    @property
    def name(self) -> str:
        return "pdf"

    @property
    def description(self) -> str:
        return (
            "Generate a PDF file from context data. "
            "If context_data has results, they are summarized into the document."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Output PDF filename", "default": "report.pdf"},
                "title": {"type": "string", "description": "PDF title", "default": "Report"},
                "context_data": {
                    "type": "string",
                    "description": "JSON payload. Prefer {results:[...]} for summary content.",
                },
            },
            "required": [],
        }

    async def execute(
        self,
        filename: str = "report.pdf",
        title: str = "Report",
        context_data: str | None = None,
        **_: Any,
    ) -> ToolResult:
        safe_filename = (filename or "report.pdf").strip() or "report.pdf"
        if not safe_filename.lower().endswith(".pdf"):
            safe_filename = f"{safe_filename}.pdf"

        code = f"""
import json
from fpdf import FPDF

data = json.load(open('context.json', encoding='utf-8'))
rows = data.get('results', [])
user_request = str(data.get('user_request', '') or '')
generated_at = str(data.get('generated_at', '') or '')
if not isinstance(rows, list):
    rows = []

pdf = FPDF()
pdf.add_page()
pdf.set_margins(10, 10, 10)
pdf.set_auto_page_break(auto=True, margin=15)
font_path = '/System/Library/Fonts/Hiragino Sans GB.ttc'
use_cjk = False
try:
    pdf.add_font('HiraginoGB', '', font_path)
    pdf.set_font('HiraginoGB', size=16)
    use_cjk = True
except Exception:
    pdf.set_font('Helvetica', size=16)

pdf.cell(0, 10, text={title!r}, new_x='LMARGIN', new_y='NEXT')

if use_cjk:
    pdf.set_font('HiraginoGB', size=11)
else:
    pdf.set_font('Helvetica', size=11)

if user_request:
    pdf.multi_cell(0, 7, text='User request: ' + user_request[:300])
if generated_at:
    pdf.multi_cell(0, 7, text='Generated at: ' + generated_at[:40])
pdf.ln(2)

if rows:
    limit = min(len(rows), 20)
    for i, row in enumerate(rows[:limit], start=1):
        if isinstance(row, dict):
            title_text = str(row.get('title') or row.get('name') or f'Result {{i}}')
            url = str(row.get('url') or '')
            content = str(row.get('content') or row.get('snippet') or '')
            content = content.replace('\\n', ' ').strip()
            if len(content) > 400:
                content = content[:400] + '...'
            pdf.multi_cell(0, 7, text=f'{{i}}. ' + title_text[:160])
            if content:
                pdf.multi_cell(0, 7, text=content)
            if url:
                shown = url[:120]
                pdf.cell(0, 7, text=shown, link=url, new_x='LMARGIN', new_y='NEXT')
            pdf.ln(1)
        else:
            raw = str(row).replace('\\n', ' ')
            if len(raw) > 300:
                raw = raw[:300] + '...'
            pdf.multi_cell(0, 7, text=f'{{i}}. ' + raw)
else:
    pdf.multi_cell(0, 7, text='No structured rows available in context_data.results')

pdf.output({safe_filename!r})
print("pdf generated")
"""
        executor = CodeExecutorTool()
        return await executor.execute(
            language="python",
            code=code,
            context_data=context_data,
        )
