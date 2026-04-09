#!/usr/bin/env bash
# kill-task.sh — Kill a running OpenAgent task by ID
#
# Usage: kill-task.sh <task-id>
#
# Generates a short-lived admin JWT on-the-fly using JWT_SECRET from the
# environment (or /data/.env), then calls POST /api/tasks/<id>/kill.

set -euo pipefail

TASK_ID="${1:-}"
if [[ -z "$TASK_ID" ]]; then
  echo "Usage: kill-task.sh <task-id>" >&2
  exit 1
fi

API_BASE="${OPENAGENT_API_BASE:-http://localhost:3000}"

# ── Resolve JWT_SECRET ────────────────────────────────────────────────────────
# 1. Already in env
# 2. Load from /data/.env if present
# 3. Fall back to the well-known dev default

if [[ -z "${JWT_SECRET:-}" ]]; then
  if [[ -f /data/.env ]]; then
    # shellcheck disable=SC1091
    source /data/.env 2>/dev/null || true
  fi
fi

JWT_SECRET="${JWT_SECRET:-openagent-dev-secret-change-me}"

# ── Generate JWT using Node.js (available in every OpenAgent container) ───────
TOKEN=$(node - <<'EOF'
const crypto = require('crypto');

const secret = process.env.JWT_SECRET || 'openagent-dev-secret-change-me';

// Build JWT manually (HS256) — avoids needing the jsonwebtoken npm package
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const header  = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
const now     = Math.floor(Date.now() / 1000);
const payload = base64url(Buffer.from(JSON.stringify({
  userId: 1,
  username: 'admin',
  role: 'admin',
  iat: now,
  exp: now + 300,   // valid for 5 minutes
})));

const sig = base64url(
  crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest()
);

console.log(`${header}.${payload}.${sig}`);
EOF
)

# ── Call the kill endpoint ────────────────────────────────────────────────────
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "${API_BASE}/api/tasks/${TASK_ID}/kill")

HTTP_BODY=$(echo "$HTTP_RESPONSE" | head -n -1)
HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -n 1)

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "Task ${TASK_ID} killed successfully."
  echo "$HTTP_BODY" | jq -r '.task | "Status: \(.status)  Result: \(.resultStatus // "n/a")"' 2>/dev/null || echo "$HTTP_BODY"
else
  echo "Failed to kill task ${TASK_ID} (HTTP ${HTTP_STATUS}):" >&2
  echo "$HTTP_BODY" >&2
  exit 1
fi
