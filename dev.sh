#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8080}"
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Serving $(pwd) at http://localhost:${PORT}"
python3 -m http.server "${PORT}"
