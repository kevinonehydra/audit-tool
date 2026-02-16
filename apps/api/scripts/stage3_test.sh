#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3001}"

# Zsh history expansion is a common landmine when you have "!" in JSON strings.
# This script runs under bash, so it's safe even if your interactive shell is zsh.

echo "== Health =="
curl -s "$BASE/health" | jq .

echo ""
echo "== Register (ignore error if already exists) =="
curl -s -X POST "$BASE/auth/register" \
  -H "content-type: application/json" \
  -d '{"email":"kevin@test.com","password":"Password123!","role":"auditor"}' | jq . || true

echo ""
echo "== Login =="
LOGIN=$(curl -s -X POST "$BASE/auth/login" \
  -H "content-type: application/json" \
  -d '{"email":"kevin@test.com","password":"Password123!"}')

echo "$LOGIN" | jq .
TOKEN=$(echo "$LOGIN" | jq -r '.token')
if [[ -z "${TOKEN}" || "${TOKEN}" == "null" ]]; then
  echo "ERROR: token is empty. Login failed."
  exit 1
fi
echo "TOKEN_OK"

echo ""
echo "== /auth/me (should be 200) =="
curl -s "$BASE/auth/me" -H "authorization: Bearer $TOKEN" | jq .

echo ""
echo "== Create owned audit (should set userId) =="
ARESP=$(curl -s -X POST "$BASE/audits" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"title":"Stage 3 Owned Audit","standard":"TIA-942","site":"JHB-DC-01","auditor":"Kevin"}')

echo "$ARESP" | jq .
AUDIT_ID=$(echo "$ARESP" | jq -r '.audit.id')
if [[ -z "${AUDIT_ID}" || "${AUDIT_ID}" == "null" ]]; then
  echo "ERROR: AUDIT_ID is empty. Audit create failed."
  exit 1
fi
echo "AUDIT_ID=$AUDIT_ID"

echo ""
echo "== Confirm audit userId is NOT null =="
curl -s "$BASE/audits/$AUDIT_ID" -H "authorization: Bearer $TOKEN" | jq .

echo ""
echo "== Public checks (expect 200 only for /health; others 401) =="
curl -s -o /dev/null -w "/health                -> %{http_code}\n" "$BASE/health"
curl -s -o /dev/null -w "/audits                 -> %{http_code}\n" "$BASE/audits"
curl -s -o /dev/null -w "/auth/me                -> %{http_code}\n" "$BASE/auth/me"
curl -s -o /dev/null -w "/audits/xxx/findings     -> %{http_code}\n" "$BASE/audits/xxx/findings"

echo ""
echo "== Protected checks with token (expect 200) =="
curl -s -o /dev/null -w "GET /audits              -> %{http_code}\n" "$BASE/audits" -H "authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "GET /audits/:id          -> %{http_code}\n" "$BASE/audits/$AUDIT_ID" -H "authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "GET /audits/:id/findings  -> %{http_code}\n" "$BASE/audits/$AUDIT_ID/findings" -H "authorization: Bearer $TOKEN"

echo ""
echo "DONE ✅"
