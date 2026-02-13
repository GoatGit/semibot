"""Runtime server entry point.

Usage:
    uvicorn main:app --host 0.0.0.0 --port 8901
"""

from src.server.app import create_app

app = create_app()
