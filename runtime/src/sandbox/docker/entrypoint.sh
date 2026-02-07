#!/bin/bash
# Sandbox container entrypoint script
# Provides secure execution environment for AI agent tools

set -e

# Security: Ensure we're running as sandbox user
if [ "$(id -u)" = "0" ]; then
    echo "Error: Container should not run as root" >&2
    exit 1
fi

# Set up environment
export HOME=/home/sandbox
export PATH="/usr/local/bin:/usr/bin:/bin"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1

# Create workspace subdirectories if needed
mkdir -p /workspace/code /workspace/data /workspace/output 2>/dev/null || true

# Resource limits (can be overridden by ulimit in container config)
ulimit -v 536870912 2>/dev/null || true  # 512MB virtual memory
ulimit -t 120 2>/dev/null || true         # 120s CPU time
ulimit -f 104857600 2>/dev/null || true   # 100MB max file size

# Execute the command
exec "$@"
