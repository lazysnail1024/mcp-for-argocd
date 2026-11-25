#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-argocd-mcp-plus:0.9.1}"

echo "==> [Smoke 1] Verify non-root UID 1000"
UID_OUT="$(docker run --rm --entrypoint id "${IMAGE}" -u)"
if [[ "${UID_OUT}" != "1000" ]]; then
  echo "FAIL: expected UID 1000, got ${UID_OUT}" >&2
  exit 1
fi
echo "PASS: container runs as UID ${UID_OUT}"

echo "==> [Smoke 2] Verify clean slim runtime directory (no src/, doc/, tests/, *.test.ts)"
BAD_FILES="$(docker run --rm --entrypoint sh "${IMAGE}" -c 'ls -la /app && test ! -d /app/src && test ! -d /app/doc && test ! -d /app/tests && echo CLEAN')"
echo "${BAD_FILES}"
echo "${BAD_FILES}" | grep -q "CLEAN"
echo "PASS: runtime image directory is clean"

echo "==> [Smoke 3] Verify fail-closed when binding 0.0.0.0 without MCP_AUTH_TOKEN"
set +e
FAIL_OUT="$(docker run --rm -e MCP_BIND_ADDRESS=0.0.0.0 "${IMAGE}" http 2>&1)"
FAIL_CODE=$?
set -e
if [[ "${FAIL_CODE}" -eq 0 ]]; then
  echo "FAIL: container should have exited non-zero without auth token" >&2
  exit 1
fi
echo "${FAIL_OUT}" | grep -q "Refusing to bind to 0.0.0.0"
echo "PASS: fail-closed exit code=${FAIL_CODE}"

echo "==> [Smoke 4] Verify removed 'sse' subcommand exits non-zero"
set +e
SSE_OUT="$(docker run --rm "${IMAGE}" sse 2>&1)"
SSE_CODE=$?
set -e
if [[ "${SSE_CODE}" -eq 0 ]]; then
  echo "FAIL: removed sse subcommand should fail" >&2
  exit 1
fi
echo "PASS: sse subcommand rejected (exit code=${SSE_CODE})"

echo "==> [Smoke 5] Verify default 'http', explicit 'http --stateless', and '--no-stateless' warning + /healthz"
for MODE_LABEL in "default-http" "explicit-stateless" "no-stateless-fallback"; do
  CID="argocd-mcp-smoke-${MODE_LABEL}-$$"
  if [[ "${MODE_LABEL}" == "default-http" ]]; then
    ARGS=("http")
  elif [[ "${MODE_LABEL}" == "explicit-stateless" ]]; then
    ARGS=("http" "--stateless")
  else
    ARGS=("http" "--no-stateless")
  fi

  docker run -d --rm --name "${CID}" \
    -p 127.0.0.1::3000 \
    -e MCP_BIND_ADDRESS=0.0.0.0 \
    -e MCP_AUTH_TOKEN=smoke-token \
    "${IMAGE}" "${ARGS[@]}" >/dev/null

  HOST_PORT="$(docker port "${CID}" 3000/tcp | head -n 1 | awk -F: '{print $NF}')"
  OK=0
  for _ in $(seq 1 20); do
    BODY="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/healthz" 2>/dev/null || true)"
    if echo "${BODY}" | grep -q '"name":"argocd-mcp-plus"' && echo "${BODY}" | grep -q '"version":"0.9.1"'; then
      OK=1
      break
    fi
    sleep 0.25
  done

  LOGS="$(docker logs "${CID}" 2>&1 || true)"
  docker stop "${CID}" >/dev/null 2>&1 || true

  if [[ "${OK}" -ne 1 ]]; then
    echo "FAIL: ${MODE_LABEL} did not answer healthy /healthz. Logs:" >&2
    echo "${LOGS}" >&2
    exit 1
  fi
  if [[ "${MODE_LABEL}" == "no-stateless-fallback" ]]; then
    echo "${LOGS}" | grep -q "Stateful HTTP session mode"
  fi
  echo "PASS: ${MODE_LABEL} healthy on /healthz"
done

echo "ALL TIER 3 CONTAINER SMOKE TESTS PASSED for ${IMAGE}!"
