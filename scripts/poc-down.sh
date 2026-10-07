#!/usr/bin/env bash
# scripts/poc-down.sh — delete the kind cluster
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KIND_BIN="$ROOT/bin/kind.exe"
[[ -x "$KIND_BIN" ]] || KIND_BIN="kind"
"$KIND_BIN" delete cluster --name sre-poc
echo "✓ cluster sre-poc deleted"