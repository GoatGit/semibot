#!/usr/bin/env bash
set -euo pipefail

# Upload .release/publish/ contents to Cloudflare R2 (releases.semibot.ai)
#
# Prerequisites:
#   - wrangler CLI installed and authenticated (wrangler login)
#   - R2 bucket "semibot-releases" exists
#
# Usage:
#   ./scripts/publish_to_r2.sh              # upload from default .release/publish/
#   PUBLISH_DIR=/path/to/publish ./scripts/publish_to_r2.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLISH_DIR="${PUBLISH_DIR:-$ROOT_DIR/.release/publish}"
R2_BUCKET="${R2_BUCKET:-semibot-releases}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -d "$PUBLISH_DIR" ]]; then
  echo "[publish-r2] error: publish directory not found: $PUBLISH_DIR" >&2
  echo "[publish-r2] hint: run ./scripts/prepare_release_channel.sh stable first" >&2
  exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "[publish-r2] error: wrangler CLI not found" >&2
  echo "[publish-r2] hint: npm install -g wrangler && wrangler login" >&2
  exit 1
fi

content_type_for() {
  local file="$1"
  case "$file" in
    *.json)   echo "application/json" ;;
    *.sh)     echo "text/plain" ;;
    *.tar.gz) echo "application/gzip" ;;
    *.sha256) echo "text/plain" ;;
    *)        echo "application/octet-stream" ;;
  esac
}

uploaded=0
failed=0

while IFS= read -r -d '' file; do
  key="${file#"$PUBLISH_DIR/"}"
  ct="$(content_type_for "$file")"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[publish-r2] (dry-run) $key  ($ct)"
    uploaded=$((uploaded + 1))
    continue
  fi

  echo "[publish-r2] uploading: $key  ($ct)"
  if wrangler r2 object put "$R2_BUCKET/$key" \
       --file "$file" \
       --content-type "$ct" 2>&1; then
    uploaded=$((uploaded + 1))
  else
    echo "[publish-r2] FAILED: $key" >&2
    failed=$((failed + 1))
  fi
done < <(find "$PUBLISH_DIR" -type f -print0 | sort -z)

echo ""
echo "[publish-r2] done: $uploaded uploaded, $failed failed"
echo "[publish-r2] bucket: $R2_BUCKET"
echo "[publish-r2] verify: curl -I https://releases.semibot.ai/stable/latest.json"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
