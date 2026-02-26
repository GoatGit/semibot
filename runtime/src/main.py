from __future__ import annotations

import asyncio
import os
import sys


def _should_run_execution_plane() -> bool:
    if os.getenv("SEMIBOT_DISABLE_VM_AUTORUN", "").strip() in {"1", "true", "TRUE"}:
        return False
    if len(sys.argv) > 1:
        return False
    return bool(os.getenv("VM_USER_ID", "").strip() and os.getenv("VM_TOKEN", "").strip())


def main() -> None:
    """Semibot runtime entrypoint.

    Compatibility behavior:
    - No CLI args + VM env injected => run execution-plane WS daemon mode
      (used by control-plane bootstrap scripts).
    - Otherwise => run V2 CLI mode.
    """
    if _should_run_execution_plane():
        from src.execution_plane import run_execution_plane

        asyncio.run(run_execution_plane())
        return

    from src.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
