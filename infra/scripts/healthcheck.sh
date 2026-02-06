#!/bin/bash
# =============================================================================
# Semibot Health Check Script
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_ok() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# -----------------------------------------------------------------------------
# Check Service Health
# -----------------------------------------------------------------------------
check_service() {
    local name="$1"
    local url="$2"

    if curl -sf --max-time 5 "$url" > /dev/null 2>&1; then
        log_ok "$name is healthy"
        return 0
    else
        log_fail "$name is not responding"
        return 1
    fi
}

check_container() {
    local name="$1"

    local status=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "not found")

    if [ "$status" == "healthy" ]; then
        log_ok "$name container is healthy"
        return 0
    elif [ "$status" == "not found" ]; then
        log_fail "$name container not found"
        return 1
    else
        log_warn "$name container status: $status"
        return 1
    fi
}

# -----------------------------------------------------------------------------
# Main Health Check
# -----------------------------------------------------------------------------
main() {
    local exit_code=0

    echo "========================================="
    echo "Semibot Health Check"
    echo "========================================="
    echo ""

    echo "Container Health:"
    echo "-----------------------------------------"
    check_container "semibot-api" || exit_code=1
    check_container "semibot-runtime" || exit_code=1
    check_container "semibot-postgres" || exit_code=1
    check_container "semibot-redis" || exit_code=1

    echo ""
    echo "Service Endpoints:"
    echo "-----------------------------------------"

    # Check API health endpoint
    if check_service "API Service" "http://localhost:3001/health"; then
        :
    else
        exit_code=1
    fi

    # Check Runtime health endpoint
    if check_service "Runtime Service" "http://localhost:8000/health"; then
        :
    else
        exit_code=1
    fi

    # Check Nginx (if running)
    if docker ps --format '{{.Names}}' | grep -q "semibot-nginx"; then
        if check_service "Nginx Proxy" "http://localhost:80/nginx-health"; then
            :
        else
            exit_code=1
        fi
    else
        log_warn "Nginx is not running (production only)"
    fi

    echo ""
    echo "========================================="
    if [ $exit_code -eq 0 ]; then
        log_ok "All health checks passed"
    else
        log_fail "Some health checks failed"
    fi
    echo "========================================="

    exit $exit_code
}

main "$@"
