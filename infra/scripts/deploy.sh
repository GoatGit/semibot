#!/bin/bash
# =============================================================================
# Semibot Production Deployment Script
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKER_DIR="$PROJECT_ROOT/infra/docker"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# -----------------------------------------------------------------------------
# Pre-flight Checks
# -----------------------------------------------------------------------------
preflight_checks() {
    log_info "Running pre-flight checks..."

    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi

    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi

    # Check .env file
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        log_error ".env file not found. Copy .env.example to .env and configure it."
        exit 1
    fi

    # Check required environment variables
    source "$PROJECT_ROOT/.env"

    local required_vars=("POSTGRES_USER" "POSTGRES_PASSWORD" "POSTGRES_DB" "REDIS_PASSWORD" "JWT_SECRET" "SESSION_SECRET")
    for var in "${required_vars[@]}"; do
        if [ -z "${!var:-}" ]; then
            log_error "Required environment variable $var is not set"
            exit 1
        fi
    done

    log_info "Pre-flight checks passed"
}

# -----------------------------------------------------------------------------
# Build Images
# -----------------------------------------------------------------------------
build_images() {
    log_info "Building Docker images..."

    cd "$DOCKER_DIR"

    docker-compose -f docker-compose.yml -f docker-compose.prod.yml build --no-cache

    log_info "Docker images built successfully"
}

# -----------------------------------------------------------------------------
# Deploy Stack
# -----------------------------------------------------------------------------
deploy() {
    log_info "Deploying Semibot stack..."

    cd "$DOCKER_DIR"

    # Pull latest images for base images
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull postgres redis nginx

    # Start services
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

    log_info "Waiting for services to be healthy..."
    sleep 10

    # Check health
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml ps

    log_info "Deployment completed"
}

# -----------------------------------------------------------------------------
# Health Check
# -----------------------------------------------------------------------------
healthcheck() {
    log_info "Running health checks..."

    local services=("semibot-api" "semibot-runtime" "semibot-postgres" "semibot-redis")
    local all_healthy=true

    for service in "${services[@]}"; do
        local health=$(docker inspect --format='{{.State.Health.Status}}' "$service" 2>/dev/null || echo "not found")
        if [ "$health" == "healthy" ]; then
            log_info "$service: healthy"
        else
            log_warn "$service: $health"
            all_healthy=false
        fi
    done

    if [ "$all_healthy" = true ]; then
        log_info "All services are healthy"
    else
        log_warn "Some services are not healthy"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# Stop Stack
# -----------------------------------------------------------------------------
stop() {
    log_info "Stopping Semibot stack..."

    cd "$DOCKER_DIR"
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml down

    log_info "Stack stopped"
}

# -----------------------------------------------------------------------------
# View Logs
# -----------------------------------------------------------------------------
logs() {
    local service="${1:-}"

    cd "$DOCKER_DIR"

    if [ -n "$service" ]; then
        docker-compose -f docker-compose.yml -f docker-compose.prod.yml logs -f "$service"
    else
        docker-compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
    fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    local command="${1:-deploy}"

    case "$command" in
        preflight)
            preflight_checks
            ;;
        build)
            preflight_checks
            build_images
            ;;
        deploy)
            preflight_checks
            deploy
            healthcheck
            ;;
        healthcheck)
            healthcheck
            ;;
        stop)
            stop
            ;;
        logs)
            logs "${2:-}"
            ;;
        *)
            echo "Usage: $0 {preflight|build|deploy|healthcheck|stop|logs [service]}"
            exit 1
            ;;
    esac
}

main "$@"
