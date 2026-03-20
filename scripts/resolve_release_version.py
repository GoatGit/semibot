#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime
import re
import sys
from pathlib import Path


def main() -> int:
    output_root = Path(sys.argv[1] if len(sys.argv) > 1 else ".release").expanduser()
    today_prefix = datetime.now().strftime("%Y.%m.%d")
    pattern = re.compile(rf"^{re.escape(today_prefix)}\.(\d{{2}})$")
    latest_patch = 0

    if output_root.exists():
        for child in output_root.iterdir():
            if not child.is_dir():
                continue
            match = pattern.match(child.name)
            if not match:
                continue
            latest_patch = max(latest_patch, int(match.group(1)))

    print(f"{today_prefix}.{latest_patch + 1:02d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
